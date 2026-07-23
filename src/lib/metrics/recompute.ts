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
import { fetchLiveDailyBreakdown, type DailyBreakdown } from "@/lib/google-ads/portal";
import {
  fetchDailySales,
  resolveAdminToken,
  type DailySales,
  type SyncedOrder,
} from "@/lib/shopify/client";
import { fxDailyRates, rateOn } from "@/lib/shopify/fx";
import { orderCogs, paymentFee } from "@/lib/cogs/engine";
import { loadCostContext, registerSoldProducts } from "@/lib/cogs/context";
import type { AdAccount, Database } from "@/lib/supabase/types";

export const RECOMPUTE_INTERVAL_MS = 15 * 60 * 1000;

/** How far back the incremental sync heals on every run. */
const WINDOW_DAYS = 7;

/** Hard cap on how far back a range-driven backfill may reach. */
const BACKFILL_LIMIT_DAYS = 90;

type Supabase = SupabaseClient<Database>;

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
  if (
    hasGoogleAdsEnv() &&
    account.google_ads_connected &&
    account.google_ads_customer_id &&
    secret?.google_ads_refresh_token
  ) {
    const token = await decryptToken(secret.google_ads_refresh_token);
    google = await fetchLiveDailyBreakdown(account.google_ads_customer_id, token, from, to);
  }

  let sales: DailySales[] = [];
  // Per-day cost chain (reporting currency): COGS, payment fees, shipping.
  const costByDay = new Map<string, { product: number; fees: number; shipping: number }>();

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
        return { ...day, revenue: day.revenue * rate, refunds: day.refunds * rate };
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
  }

  if (google.length === 0 && sales.length === 0) return;

  const salesByDay = new Map(sales.map((day) => [day.date, day]));
  const googleByDay = new Map(google.map((day) => [day.date, day]));
  const days = [...new Set([...salesByDay.keys(), ...googleByDay.keys()])];

  const rows = days.map((day) => {
    const ads = googleByDay.get(day);
    const shop = salesByDay.get(day);
    const costs = costByDay.get(day);
    return {
      ad_account_id: account.id,
      day,
      ad_spend: ads?.spend ?? 0,
      impressions: ads?.impressions ?? 0,
      clicks: ads?.clicks ?? 0,
      conversions: ads?.conversions ?? 0,
      conversion_value: ads?.conversionValue ?? 0,
      revenue: shop?.revenue ?? 0,
      orders_count: shop?.orders ?? 0,
      refunds_amount: shop?.refunds ?? 0,
      product_cost: costs?.product ?? 0,
      payment_fees: costs?.fees ?? 0,
      shipping_cost: costs?.shipping ?? 0,
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
export async function recomputeDailyMetrics(accounts: AdAccount[]): Promise<void> {
  const now = Date.now();
  const stale = accounts
    .filter(syncable)
    .filter((account) => now - (lastRunByAccount.get(account.id) ?? 0) >= RECOMPUTE_INTERVAL_MS);
  if (stale.length === 0) return;

  try {
    const supabase = await createClient();

    // Cross-isolate freshness: newest computed_at per account decides.
    const { data: freshRows } = await supabase
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
 * Backfill so the selected range has history to show. Runs once per gap: the
 * next call finds coverage already reaching `from` and does nothing. Ranges
 * older than BACKFILL_LIMIT_DAYS are served from whatever exists.
 */
export async function ensureDailyCoverage(accounts: AdAccount[], from: string): Promise<void> {
  const floor = isoDay(-BACKFILL_LIMIT_DAYS);
  const start = from < floor ? floor : from;
  if (start >= isoDay(0)) return; // today is the recompute window's job

  const candidates = accounts.filter(syncable);
  if (candidates.length === 0) return;

  try {
    const supabase = await createClient();

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
