/**
 * recomputeDailyMetrics — fills/refreshes the daily_metrics read model.
 *
 * Follows the commission-ledger pattern exactly (lib/admin/commission-sync):
 * no cron, no service key. It runs server-side when someone opens a page that
 * reads metrics, rides THAT viewer's session (RLS lets clients write their
 * own accounts' rows, admins any), and self-throttles per account so most
 * page loads cost zero upstream calls.
 *
 * The 15-minute throttle is also the UI's freshness contract: pages show
 * "next update at ..." as newest computed_at + 15 min.
 *
 * ensureDailyCoverage handles the other axis: a freshly connected store has
 * no history, so a 30-day range would show a near-empty chart. It backfills
 * from the selected range's start (capped) up to where coverage begins —
 * once, because after that the coverage check finds nothing missing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { markIfAuthRevoked } from "@/lib/google-ads/revoked";
import {
  fetchCampaignNames,
  fetchLiveDailyBreakdown,
  type DailyBreakdown,
} from "@/lib/google-ads/portal";
import {
  fetchCollectionProductKeys,
  fetchDailySales,
  resolveAdminToken,
  type DailySales,
  type SyncedOrder,
} from "@/lib/shopify/client";
import { fxDailyRates, rateOn } from "@/lib/shopify/fx";
import { orderCogs, paymentFee } from "@/lib/cogs/engine";
import { loadCostContext, registerSoldProducts } from "@/lib/cogs/context";
import { dealsFromCampaigns, orderRevShare, type AttributionDeal } from "@/lib/finance/rev-share";
import type { AdAccount, Database } from "@/lib/supabase/types";

export const RECOMPUTE_INTERVAL_MS = 15 * 60 * 1000;

/** How far back the incremental sync heals on every run. */
const WINDOW_DAYS = 7;

/** Hard cap on how far back a range-driven backfill may reach. */
const BACKFILL_LIMIT_DAYS = 90;

type Supabase = SupabaseClient<Database>;

/** The Google-sourced columns of daily_metrics, carried forward when Google
 *  can't be reached. Kept as its own type so the carry-forward below can't
 *  silently fall out of step with the row it feeds. */
type DailyMetricAdColumns = {
  ad_spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
};

// Per-isolate memo of the last run per account, so a burst of navigation
// doesn't even query for freshness.
const lastRunByAccount = new Map<string, number>();

function isoDay(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return date.toISOString().slice(0, 10);
}

function dayBefore(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

type SecretColumns = {
  google_ads_refresh_token: string | null;
  shopify_admin_token: string | null;
};

function syncable(account: AdAccount): boolean {
  // Pending accounts are connected but not yet approved by the team — no
  // data flows until an admin activates them (the approval IS the product
  // gate). The lazy sync picks them up on the first page view after
  // activation, history included via the coverage backfill.
  if (account.status === "pending") return false;
  return (
    (account.google_ads_connected && Boolean(account.google_ads_customer_id)) ||
    account.shopify_connected
  );
}

/** The encrypted secrets, fetched on their own — never inside page payloads. */
async function fetchSecrets(
  supabase: Supabase,
  accountIds: string[],
): Promise<Map<string, SecretColumns>> {
  const { data } = await supabase
    .from("ad_accounts")
    .select("id, google_ads_refresh_token, shopify_admin_token")
    .in("id", accountIds);
  return new Map(
    ((data ?? []) as unknown as ({ id: string } & SecretColumns)[]).map((row) => [row.id, row]),
  );
}

/** Pulls [from, to] from Google + Shopify for one account and upserts it. */
async function syncAccountWindow(
  supabase: Supabase,
  account: AdAccount,
  secret: SecretColumns | undefined,
  from: string,
  to: string,
): Promise<void> {
  let google: DailyBreakdown[] = [];
  // Whether Google actually answered for this window. Decides, further down,
  // between "no spend that day" (a real zero) and "we have no idea" (carry the
  // stored figures forward).
  let googleSynced = false;

  if (
    hasGoogleAdsEnv() &&
    account.google_ads_connected &&
    account.google_ads_customer_id &&
    secret?.google_ads_refresh_token
  ) {
    const token = await decryptToken(secret.google_ads_refresh_token);
    try {
      google = await fetchLiveDailyBreakdown(account.google_ads_customer_id, token, from, to);
      googleSynced = true;
    } catch (error) {
      // A revoked authorisation can't be retried, so stop pretending the
      // account is connected — the portal then prompts for a reconnect. Any
      // other Google failure still throws: it may be transient, and swallowing
      // it would let the carry-forward below quietly stand in for real data.
      if (!(await markIfAuthRevoked(supabase, account.id, error))) throw error;
    }
  }

  let sales: DailySales[] = [];
  // Per-day cost chain (reporting currency): COGS, payment fees, shipping.
  const costByDay = new Map<string, { product: number; fees: number; shipping: number }>();
  // Per-day revenue share (reporting currency): base revenue + billed amount.
  const revShareByDay = new Map<string, { base: number; amount: number }>();

  if (account.shopify_connected && account.shopify_url && secret?.shopify_admin_token) {
    // The stored credential may be a direct shpat_ token or the app's shpss_
    // secret; resolveAdminToken exchanges the latter (cached ~24h).
    const credential = await decryptToken(secret.shopify_admin_token);
    const token = await resolveAdminToken(
      account.shopify_url,
      credential,
      account.shopify_client_id,
    );
    const result = await fetchDailySales(account.shopify_url, token, from, to);
    sales = result.days;

    // Order amounts arrive in the STORE's base currency; daily_metrics is
    // kept in the account's reporting currency. Convert with the day's ECB
    // rate. An FX failure throws — this account's sync skips rather than
    // booking forints as euros.
    const needsFx = Boolean(result.currency && result.currency !== account.currency);
    const rates =
      needsFx && (sales.length > 0 || result.orders.length > 0)
        ? await fxDailyRates(result.currency!, account.currency, from, to)
        : null;
    if (rates) {
      sales = sales.map((day) => {
        const rate = rateOn(rates, day.date);
        // Every MONEY field, attributedRevenue included — miss one and a store
        // billing in forints reports that column as if it were euros. Counts
        // (orders, units, attributedOrders) are deliberately untouched.
        return {
          ...day,
          revenue: day.revenue * rate,
          refunds: day.refunds * rate,
          attributedRevenue: day.attributedRevenue * rate,
        };
      });
    }

    // ---- COGS + fees, per ORDER (tiers depend on units bought together) ---
    // The principle: none of this touches revenue. It only writes the cost
    // columns, so a cost edit moves profit by exactly the cost delta.
    if (result.orders.length > 0) {
      await registerSoldProducts(supabase, account.id, result.orders, result.currency ?? account.currency);
      const ctx = await loadCostContext(
        supabase,
        account.id,
        Number(account.default_product_cost_pct),
        account.currency,
      );

      for (const order of result.orders as SyncedOrder[]) {
        const rate = rates ? rateOn(rates, order.date) : 1;
        const lines = order.lines.map((line) => ({
          productKey: line.productKey,
          quantity: line.quantity,
          unitPrice: line.unitPrice * rate,
        }));

        const entry = costByDay.get(order.date) ?? { product: 0, fees: 0, shipping: 0 };
        entry.product += orderCogs(lines, order.date, ctx);
        entry.fees += paymentFee(
          order.total * rate,
          Number(account.payment_fee_pct),
          Number(account.payment_fee_fixed),
        );
        entry.shipping += Number(account.shipping_cost_per_order);
        costByDay.set(order.date, entry);
      }
    }

    // ---- revenue share (collection-based), reporting currency -------------
    // Deals come from the Google Ads campaign NAMES (collection URL + rate);
    // attribution is by collection membership or landing page. Fully isolated:
    // a failure here never blocks the revenue/COGS rollup.
    // Keyed on the RATE, not on `revenue_share_enabled`: the boolean is the
    // legacy pricing flag that hard-blocks v3 weekly fee billing, while a
    // positive rate only opts the account into TRACKING collection revenue
    // share here — invoiced separately, never by the automatic fee engine.
    if (
      Number(account.revenue_share_rate) > 0 &&
      result.orders.length > 0 &&
      hasGoogleAdsEnv() &&
      account.google_ads_connected &&
      account.google_ads_customer_id &&
      secret?.google_ads_refresh_token
    ) {
      try {
        const googleToken = await decryptToken(secret.google_ads_refresh_token);
        const names = await fetchCampaignNames(account.google_ads_customer_id, googleToken);
        const dealMap = dealsFromCampaigns(names);

        if (dealMap.size > 0) {
          const deals: AttributionDeal[] = [];
          for (const deal of dealMap.values()) {
            const productKeys = await fetchCollectionProductKeys(
              account.shopify_url!,
              token,
              deal.handle,
            );
            deals.push({ ...deal, productKeys });
          }

          for (const order of result.orders as SyncedOrder[]) {
            // The revenue share is billed on PAID revenue only.
            if (!order.paid) continue;
            const rate = rates ? rateOn(rates, order.date) : 1;
            const attributed = orderRevShare(
              {
                total: order.total * rate,
                landingPath: order.landingPath,
                lines: order.lines.map((line) => ({
                  productKey: line.productKey,
                  revenue: line.unitPrice * line.quantity * rate,
                })),
              },
              deals,
            );
            if (attributed.amount <= 0 && attributed.base <= 0) continue;
            const entry = revShareByDay.get(order.date) ?? { base: 0, amount: 0 };
            entry.base += attributed.base;
            entry.amount += attributed.amount;
            revShareByDay.set(order.date, entry);
          }
        }
      } catch (error) {
        console.error(`revenue-share sync failed for ${account.id}:`, error);
      }
    }
  }

  if (google.length === 0 && sales.length === 0) return;

  const salesByDay = new Map(sales.map((day) => [day.date, day]));
  const googleByDay = new Map(google.map((day) => [day.date, day]));
  const days = [...new Set([...salesByDay.keys(), ...googleByDay.keys()])];

  /**
   * Ad figures already stored for this window, read ONLY when Google didn't
   * answer.
   *
   * The upsert below replaces whole rows, so a Shopify-only pass would write
   * ad_spend 0 over spend that was synced correctly last week — and the
   * commission ledger and the weekly invoice are both built on that number.
   * A store that is Shopify-connected but not Google-connected legitimately
   * has zero spend; a store whose authorisation just expired does not, and
   * from here the two are indistinguishable. So when we didn't ask Google,
   * we keep what we last knew rather than asserting a zero.
   */
  const carried = new Map<string, DailyMetricAdColumns>();
  if (!googleSynced) {
    const { data } = await supabase
      .from("daily_metrics")
      .select("day, ad_spend, impressions, clicks, conversions, conversion_value")
      .eq("ad_account_id", account.id)
      .gte("day", from)
      .lte("day", to);

    for (const row of data ?? []) {
      carried.set(row.day, {
        ad_spend: Number(row.ad_spend),
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
        conversions: Number(row.conversions),
        conversion_value: Number(row.conversion_value),
      });
    }
  }

  const rows = days.map((day) => {
    const ads = googleByDay.get(day);
    const shop = salesByDay.get(day);
    const costs = costByDay.get(day);
    const rev = revShareByDay.get(day);
    // Empty whenever Google DID answer, so a genuine no-spend day still
    // resolves to 0 rather than resurrecting an older figure.
    const prior = carried.get(day);
    return {
      ad_account_id: account.id,
      day,
      ad_spend: ads?.spend ?? prior?.ad_spend ?? 0,
      impressions: ads?.impressions ?? prior?.impressions ?? 0,
      clicks: ads?.clicks ?? prior?.clicks ?? 0,
      conversions: ads?.conversions ?? prior?.conversions ?? 0,
      conversion_value: ads?.conversionValue ?? prior?.conversion_value ?? 0,
      revenue: shop?.revenue ?? 0,
      orders_count: shop?.orders ?? 0,
      // Units, not money — the FX pass above leaves it alone on purpose.
      units_sold: shop?.units ?? 0,
      // Orders minus the ones Instagram/Facebook referred: the conversions
      // figure the store cards show beside Google ad spend. A day Shopify did
      // not answer for writes 0, not null — null is reserved for "never
      // computed", which is what the backfill below looks for.
      attributed_orders: shop?.attributedOrders ?? 0,
      attributed_revenue: shop?.attributedRevenue ?? 0,
      refunds_amount: shop?.refunds ?? 0,
      product_cost: costs?.product ?? 0,
      payment_fees: costs?.fees ?? 0,
      shipping_cost: costs?.shipping ?? 0,
      revenue_share_base: rev?.base ?? 0,
      revenue_share_amount: rev?.amount ?? 0,
      computed_at: new Date().toISOString(),
    };
  });

  const { error } = await supabase
    .from("daily_metrics")
    .upsert(rows, { onConflict: "ad_account_id,day" });
  if (error) throw error;
}

/**
 * Refresh the recent window for these accounts. Never throws: a dashboard
 * must render with yesterday's numbers rather than die on an upstream error.
 */
export async function recomputeDailyMetrics(
  accounts: AdAccount[],
  opts?: {
    /** Ignore both freshness checks — the nightly close wants today final. */
    force?: boolean;
    /**
     * Supabase to work through. Page loads pass nothing and ride the viewer's
     * session; the cron has none and passes the service-role client, because
     * writing daily_metrics requires owning the account or being an admin, and
     * a request with no session is neither.
     */
    client?: Supabase;
  },
): Promise<void> {
  const now = Date.now();
  const stale = accounts
    .filter(syncable)
    .filter(
      (account) =>
        opts?.force || now - (lastRunByAccount.get(account.id) ?? 0) >= RECOMPUTE_INTERVAL_MS,
    );
  if (stale.length === 0) return;

  try {
    const supabase = opts?.client ?? (await createClient());

    // Cross-isolate freshness: newest computed_at per account decides.
    const { data: freshRows } = opts?.force
      ? { data: [] }
      : await supabase
          .from("daily_metrics")
          .select("ad_account_id, computed_at")
          .in("ad_account_id", stale.map((account) => account.id))
          .gte("computed_at", new Date(now - RECOMPUTE_INTERVAL_MS).toISOString());
    const fresh = new Set((freshRows ?? []).map((row) => row.ad_account_id));

    const toRun = stale.filter((account) => !fresh.has(account.id));
    for (const account of stale) {
      if (fresh.has(account.id)) lastRunByAccount.set(account.id, now);
    }
    if (toRun.length === 0) return;

    const secrets = await fetchSecrets(supabase, toRun.map((account) => account.id));
    const from = isoDay(-(WINDOW_DAYS - 1));
    const to = isoDay(0);

    await Promise.all(
      toRun.map(async (account) => {
        try {
          await syncAccountWindow(supabase, account, secrets.get(account.id), from, to);
          lastRunByAccount.set(account.id, Date.now());
        } catch (error) {
          console.error(`daily_metrics recompute failed for ${account.id}:`, error);
        }
      }),
    );
  } catch (error) {
    console.error("daily_metrics recompute failed:", error);
  }
}

/**
 * Full resync of ONE account, bypassing throttle and coverage checks. For the
 * moment a connection is (re)made: coverage and freshness are tracked per
 * ACCOUNT, so an account that already had rows from one source would
 * otherwise never fetch the newly connected source's history — the gap check
 * sees "covered" and the throttle sees "fresh". An explicit connect is the
 * user asking for their data; sync it now, back to the backfill horizon.
 *
 * Throws on failure — the caller is an API route that wants to surface it.
 */
export async function resyncAccountNow(accountId: string): Promise<void> {
  const supabase = await createClient();

  // Server-side only — the full row (tokens included) never leaves this call.
  const { data: account } = await supabase
    .from("ad_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();
  if (!account || !syncable(account)) return;

  await syncAccountWindow(
    supabase,
    account,
    {
      google_ads_refresh_token: account.google_ads_refresh_token,
      shopify_admin_token: account.shopify_admin_token,
    },
    isoDay(-BACKFILL_LIMIT_DAYS),
    isoDay(0),
  );
  lastRunByAccount.set(accountId, Date.now());
}

/**
 * Force-refresh the RECENT window for a set of accounts NOW, bypassing the
 * 15-minute throttle — this backs the dashboard's "Refresh" button. Lighter
 * than resyncAccountNow: it re-pulls only the incremental window, enough to
 * bring today's revenue and spend current on demand. Never throws per account;
 * one store's upstream hiccup mustn't fail the whole refresh.
 */
export async function refreshAccountsNow(
  accountIds: string[],
  opts?: {
    /**
     * Supabase to work through. A page load passes nothing and rides the
     * viewer's session; a caller with no session at all — the keyed daily
     * report — passes the service-role client, since without it every write
     * here is silently refused by RLS and the refresh "succeeds" over nothing.
     */
    client?: Supabase;
    /** Explicit window. Defaults to the rolling incremental one. */
    from?: string;
    to?: string;
  },
): Promise<void> {
  if (accountIds.length === 0) return;
  const supabase = opts?.client ?? (await createClient());

  const { data: rows } = await supabase.from("ad_accounts").select("*").in("id", accountIds);
  const accounts = ((rows ?? []) as AdAccount[]).filter(syncable);
  if (accounts.length === 0) return;

  const from = opts?.from ?? isoDay(-(WINDOW_DAYS - 1));
  const to = opts?.to ?? isoDay(0);

  await Promise.all(
    accounts.map(async (account) => {
      try {
        await syncAccountWindow(
          supabase,
          account,
          {
            google_ads_refresh_token: account.google_ads_refresh_token,
            shopify_admin_token: account.shopify_admin_token,
          },
          from,
          to,
        );
        lastRunByAccount.set(account.id, Date.now());
      } catch (error) {
        console.error(`manual refresh failed for ${account.id}:`, error);
      }
    }),
  );
}

// Accounts whose historical Shopify columns this isolate has already re-synced.
const backfillAttempted = new Set<string>();

/**
 * Re-sync days written before a Shopify column existed — units_sold (0016) and
 * attributed_orders (0019).
 *
 * Every pre-aggregated table needs this the moment it gains a column, and
 * neither existing path covers it: the rolling 7-day window heals only recent
 * days, and the coverage backfill fills only days EARLIER than the first row.
 * Every day in between keeps its default forever — which is how the cards came
 * to read "0 sold" over months that plainly had orders.
 *
 * Two markers, both meaning "the sync never wrote this day":
 *   attributed_orders IS NULL — exact, which is why 0019 has no default. 0 is a
 *                               real answer (every order came from Meta).
 *   units_sold = 0 with orders — 0016 does have a default, so this leans on an
 *                               order always carrying at least one line item.
 *
 * Attempted at most once per account per isolate, so a store that somehow does
 * have orders with no line items can't turn this into a re-sync on every load.
 */
async function healShopifyColumns(
  supabase: Supabase,
  accounts: AdAccount[],
  from: string,
): Promise<void> {
  const candidates = accounts.filter(
    (account) => account.shopify_connected && !backfillAttempted.has(account.id),
  );
  if (candidates.length === 0) return;

  const { data, error: queryError } = await supabase
    .from("daily_metrics")
    .select("ad_account_id, day")
    .in("ad_account_id", candidates.map((account) => account.id))
    .gte("day", from)
    .lte("day", isoDay(0))
    .gt("orders_count", 0)
    .or("units_sold.eq.0,attributed_orders.is.null");

  // An error here is almost always a column that does not exist yet, i.e. 0016
  // or 0019 has not been applied. Nothing to heal either way.
  if (queryError || !data || data.length === 0) return;

  // One window per account — first to last stale day, so a month of gaps costs
  // one Shopify pass instead of thirty.
  const spans = new Map<string, { from: string; to: string }>();
  for (const row of data) {
    const span = spans.get(row.ad_account_id);
    if (!span) {
      spans.set(row.ad_account_id, { from: row.day, to: row.day });
      continue;
    }
    if (row.day < span.from) span.from = row.day;
    if (row.day > span.to) span.to = row.day;
  }

  const byId = new Map(candidates.map((account) => [account.id, account]));
  const secrets = await fetchSecrets(supabase, [...spans.keys()]);

  await Promise.all(
    [...spans.entries()].map(async ([accountId, span]) => {
      const account = byId.get(accountId);
      if (!account) return;
      // Marked before the attempt, not after: a store whose sync keeps failing
      // must not re-run a 90-day Shopify pass on every page load.
      backfillAttempted.add(accountId);
      try {
        await syncAccountWindow(supabase, account, secrets.get(accountId), span.from, span.to);
      } catch (error) {
        console.error(`Shopify column backfill failed for ${accountId}:`, error);
      }
    }),
  );
}

/**
 * Backfill so the selected range has history to show. Runs once per gap: the
 * next call finds coverage already reaching `from` and does nothing. Ranges
 * older than BACKFILL_LIMIT_DAYS are served from whatever exists.
 */
export async function ensureDailyCoverage(accounts: AdAccount[], from: string): Promise<void> {
  const candidates = accounts.filter(syncable);
  if (candidates.length === 0) return;

  const floor = isoDay(-BACKFILL_LIMIT_DAYS);
  const start = from < floor ? floor : from;

  try {
    const supabase = await createClient();

    // Days that exist but predate a column — a different problem from days that
    // are missing, so it runs whatever the range is, today-only included.
    await healShopifyColumns(supabase, candidates, start);

    if (start >= isoDay(0)) return; // today is the recompute window's job

    // Earliest covered day per account, one query.
    const { data: earliestRows } = await supabase
      .from("daily_metrics")
      .select("ad_account_id, day")
      .in("ad_account_id", candidates.map((account) => account.id))
      .order("day", { ascending: true });
    const earliest = new Map<string, string>();
    for (const row of earliestRows ?? []) {
      if (!earliest.has(row.ad_account_id)) earliest.set(row.ad_account_id, row.day);
    }

    const gaps = candidates
      .map((account) => {
        const covered = earliest.get(account.id);
        // No rows at all → fill start..today; rows → fill start..coveredStart-1.
        if (!covered) return { account, from: start, to: isoDay(0) };
        if (start < covered) return { account, from: start, to: dayBefore(covered) };
        return null;
      })
      .filter((gap): gap is NonNullable<typeof gap> => gap !== null && gap.from <= gap.to);
    if (gaps.length === 0) return;

    const secrets = await fetchSecrets(supabase, gaps.map((gap) => gap.account.id));

    await Promise.all(
      gaps.map(async ({ account, from: gapFrom, to: gapTo }) => {
        try {
          await syncAccountWindow(supabase, account, secrets.get(account.id), gapFrom, gapTo);
        } catch (error) {
          console.error(`daily_metrics backfill failed for ${account.id}:`, error);
        }
      }),
    );
  } catch (error) {
    console.error("daily_metrics backfill failed:", error);
  }
}
