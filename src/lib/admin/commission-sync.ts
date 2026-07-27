import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fetchLiveDailySpend } from "@/lib/google-ads/portal";
import { markIfAuthRevoked } from "@/lib/google-ads/revoked";
import type { AdAccount } from "@/lib/supabase/types";

/**
 * Turns connected accounts' Google Ads spend into real finance rows: one
 * commissions entry per account per day (gross = spend, amount = spend ×
 * commission_rate), tagged with ad_account_id so synced rows never mix with
 * hand-entered ones.
 *
 * Three things run it:
 *   · an admin opening a finance page — throttled, so navigation stays cheap;
 *   · the "Sync now" button — forced, for an exact match with what
 *     /admin/campaigns computes live from Google;
 *   · the hourly cron — forced, with the service-role client, so the ledger
 *     stays current even in a week nobody opens the panel.
 *
 * A 7-day window per run heals gaps. Page loads ride the admin's own session
 * and RLS; only the cron uses the service key, because it has no session and
 * `commissions` is admin-only.
 */

const SOURCE_NAME = "Google Ads Management";

/**
 * How many days back each run re-reads from Google, today included.
 *
 * It is a healing window, not just a fetch: Google restates recent days (fraud
 * filtering, late conversions), and the ledger updates any day whose spend has
 * moved. Widen it and the overview covers more history at the cost of a larger
 * response per account per sync.
 */
const SPEND_WINDOW_DAYS = 7;
/**
 * How stale a page load will tolerate the ledger being.
 *
 * Was an hour, which is why the overview's commission could sit €0.75 below
 * what /admin/campaigns computed live: campaigns asks Google on every render,
 * the ledger was a snapshot up to 60 minutes old. Two minutes keeps ordinary
 * navigation cheap while making the two figures agree in practice. `force` —
 * the Sync now button and the cron — skips it entirely for an exact match.
 */
const THROTTLE_MS = 2 * 60 * 1000;

type Supa = Awaited<ReturnType<typeof createClient>>;

/** Options every ledger sync takes. */
type SyncOpts = {
  /** Ignore both throttles — an explicit "do it now". */
  force?: boolean;
  /**
   * Supabase to work through. Page loads pass nothing and ride the admin's own
   * session; the cron has no session and passes the service-role client, since
   * `commissions` is admin-only under RLS.
   */
  client?: Supa;
};

/**
 * Client-login ids that belong to staff-admins. Their OWN ad accounts are
 * internal/test — the agency doesn't bill itself, so those accounts must never
 * book agency revenue.
 */
async function adminClientIds(supabase: Supa): Promise<Set<string>> {
  const { data } = await supabase.from("profiles").select("id").eq("role", "admin");
  return new Set((data ?? []).map((row) => row.id));
}

let lastPurgeAt = 0;

/**
 * Delete EVERY synced commission booked for an admin-owned ad account — past
 * and present, any source, any connection status. Admin accounts are internal,
 * so their revenue must not exist in the ledger at all. Throttled; after the
 * first pass there is nothing left to remove (the ledgers stop booking them).
 */
export async function purgeAdminAccountRevenue(opts?: SyncOpts): Promise<void> {
  if (!opts?.force && Date.now() - lastPurgeAt < THROTTLE_MS) return;

  try {
    const supabase = opts?.client ?? (await createClient());
    const adminIds = await adminClientIds(supabase);
    if (adminIds.size === 0) {
      lastPurgeAt = Date.now();
      return;
    }

    const { data: adminAccounts } = await supabase
      .from("ad_accounts")
      .select("id")
      .in("client_id", [...adminIds]);
    const ids = (adminAccounts ?? []).map((row) => row.id);
    if (ids.length > 0) {
      await supabase.from("commissions").delete().in("ad_account_id", ids);
    }
    lastPurgeAt = Date.now();
  } catch (error) {
    console.error("Admin-account revenue purge failed:", error);
  }
}

// Per-isolate memo so a burst of admin navigation doesn't even hit the
// database to discover it has nothing to do.
let lastRunAt = 0;

export async function syncCommissionLedger(opts?: SyncOpts): Promise<void> {
  if (!hasGoogleAdsEnv()) return;
  if (!opts?.force && Date.now() - lastRunAt < THROTTLE_MS) return;

  try {
    const supabase = opts?.client ?? (await createClient());

    // Cross-instance throttle: the newest synced row's updated_at tells us
    // when ANY admin's isolate last ran this.
    const { data: newest } = await supabase
      .from("commissions")
      .select("updated_at")
      .not("ad_account_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (newest && Date.now() - new Date(newest.updated_at).getTime() < THROTTLE_MS) {
      lastRunAt = Date.now();
      return;
    }

    const { data: source } = await supabase
      .from("revenue_sources")
      .select("id")
      .eq("name", SOURCE_NAME)
      .maybeSingle();
    if (!source) {
      // Migration 0007 seeds it; without the seed there is nowhere to book to.
      console.error("Commission sync: revenue source missing — run migration 0007.");
      return;
    }

    const { data: accountRows } = await supabase
      .from("ad_accounts")
      .select(
        "id, client_id, store_name, google_ads_customer_id, google_ads_connected, " +
          "google_ads_refresh_token, commission_rate, currency",
      )
      .eq("google_ads_connected", true)
      .not("google_ads_customer_id", "is", null);

    // The typed client cannot parse a concatenated column string, so it types
    // the rows as an error sentinel; the columns above match this Pick exactly.
    const accounts = (accountRows ?? []) as unknown as Pick<
      AdAccount,
      | "id"
      | "client_id"
      | "store_name"
      | "google_ads_customer_id"
      | "google_ads_connected"
      | "google_ads_refresh_token"
      | "commission_rate"
      | "currency"
    >[];
    if (accounts.length === 0) {
      lastRunAt = Date.now();
      return;
    }

    // Admins' own ad accounts are internal — never agency revenue. Exclude
    // them from billing here; past rows are removed by purgeAdminAccountRevenue.
    const adminIds = await adminClientIds(supabase);
    const billable = accounts.filter((account) => !adminIds.has(account.client_id));
    if (billable.length === 0) {
      lastRunAt = Date.now();
      return;
    }

    // Portal login → CRM record, for the finance rows' client attribution.
    const { data: portalClients } = await supabase
      .from("portal_clients")
      .select("id, crm_client_id")
      .in("id", [...new Set(billable.map((account) => account.client_id))]);
    const crmByLogin = new Map(
      (portalClients ?? []).map((row) => [row.id, row.crm_client_id]),
    );

    // Seven days INCLUDING today. Today matters most: it is the figure an admin
    // compares against /admin/campaigns, which reads Google live. The previous
    // `DURING LAST_7_DAYS` literal excluded it, which is why the overview's
    // commission was stuck below the campaigns page no matter how often the
    // ledger re-synced.
    const to = isoDay(0);
    const from = isoDay(-(SPEND_WINDOW_DAYS - 1));

    await Promise.all(
      billable.map(async (account) => {
        try {
          if (!account.google_ads_refresh_token) return;
          const token = await decryptToken(account.google_ads_refresh_token);
          const days = await fetchLiveDailySpend(
            account.google_ads_customer_id!,
            token,
            from,
            to,
          );

          const withSpend = days.filter((day) => day.spend > 0);
          const { data: existingRows } = await supabase
            .from("commissions")
            .select("id, occurred_on, gross_amount")
            .eq("ad_account_id", account.id)
            .eq("source_id", source.id)
            .in("occurred_on", days.map((day) => day.date));
          const existing = new Map(
            (existingRows ?? []).map((row) => [row.occurred_on, row]),
          );

          const rate = Number(account.commission_rate);

          for (const day of withSpend) {
            const current = existing.get(day.date);
            const amount = (day.spend * rate) / 100;

            if (!current) {
              // Unique index (ad_account_id, occurred_on) makes a concurrent
              // duplicate insert fail loudly instead of double-booking — that
              // error is safe to swallow.
              await supabase.from("commissions").insert({
                source_id: source.id,
                client_id: crmByLogin.get(account.client_id) ?? null,
                ad_account_id: account.id,
                occurred_on: day.date,
                gross_amount: day.spend,
                rate,
                amount,
                currency: account.currency,
                status: "confirmed",
                notes: `Auto-synced from Google Ads · ${account.store_name}`,
              });
            } else if (Math.abs(Number(current.gross_amount) - day.spend) > 0.01) {
              // Google restates recent days (fraud filtering, late clicks).
              await supabase
                .from("commissions")
                .update({
                  gross_amount: day.spend,
                  rate,
                  amount,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", current.id);
            }
          }
        } catch (error) {
          // A revoked authorisation is permanent: flag it so the client is
          // asked to reconnect, instead of this failing on every finance page
          // load forever. Anything else stays a plain log and retries.
          if (!(await markIfAuthRevoked(supabase, account.id, error))) {
            console.error(`Commission sync failed for ${account.id}:`, error);
          }
        }
      }),
    );

    lastRunAt = Date.now();
  } catch (error) {
    // The ledger must never take a finance page down with it.
    console.error("Commission sync failed:", error);
  }
}

// ---------------------------------------------------------------------------
// Revenue-share ledger
// ---------------------------------------------------------------------------

const REV_SHARE_SOURCE = "Revenue Share";
const REV_SHARE_WINDOW_DAYS = 90;
let lastRevShareRunAt = 0;

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Books the collection-based revenue share into the finance ledger: one
 * commissions row per rev-share account per day, read straight from the
 * daily_metrics the sync already computed (revenue_share_amount). No external
 * calls — attribution happened at sync time — so this is a cheap DB pass that
 * rides the admin's session, throttled and idempotent like the ad-spend ledger.
 */
export async function syncRevenueShareLedger(opts?: SyncOpts): Promise<void> {
  if (!opts?.force && Date.now() - lastRevShareRunAt < THROTTLE_MS) return;

  try {
    const supabase = opts?.client ?? (await createClient());

    const { data: source } = await supabase
      .from("revenue_sources")
      .select("id")
      .eq("name", REV_SHARE_SOURCE)
      .maybeSingle();
    if (!source) {
      console.error("Rev-share sync: revenue source missing — run migration 0010.");
      return;
    }

    const { data: accountRows } = await supabase
      .from("ad_accounts")
      .select("id, client_id, store_name, currency, revenue_share_enabled")
      .eq("revenue_share_enabled", true);
    const accounts = (accountRows ?? []) as unknown as Pick<
      AdAccount,
      "id" | "client_id" | "store_name" | "currency" | "revenue_share_enabled"
    >[];
    if (accounts.length === 0) {
      lastRevShareRunAt = Date.now();
      return;
    }

    // Admins' own accounts don't book agency revenue — exclude here (past rows
    // are removed by purgeAdminAccountRevenue).
    const adminIds = await adminClientIds(supabase);
    const billable = accounts.filter((account) => !adminIds.has(account.client_id));
    if (billable.length === 0) {
      lastRevShareRunAt = Date.now();
      return;
    }

    const { data: portalClients } = await supabase
      .from("portal_clients")
      .select("id, crm_client_id")
      .in("id", [...new Set(billable.map((account) => account.client_id))]);
    const crmByLogin = new Map((portalClients ?? []).map((row) => [row.id, row.crm_client_id]));

    const from = isoDay(-REV_SHARE_WINDOW_DAYS);
    const accountIds = billable.map((account) => account.id);

    // The days that actually carry a rev-share amount, straight from the rollup.
    const { data: metricRows } = await supabase
      .from("daily_metrics")
      .select("ad_account_id, day, revenue_share_base, revenue_share_amount")
      .in("ad_account_id", accountIds)
      .gte("day", from)
      .gt("revenue_share_amount", 0);
    if (!metricRows || metricRows.length === 0) {
      lastRevShareRunAt = Date.now();
      return;
    }

    // Existing rev-share rows in the window, keyed (account|day), to update in place.
    const { data: existingRows } = await supabase
      .from("commissions")
      .select("id, ad_account_id, occurred_on, amount")
      .eq("source_id", source.id)
      .in("ad_account_id", accountIds)
      .gte("occurred_on", from);
    const existing = new Map(
      (existingRows ?? []).map((row) => [`${row.ad_account_id}|${row.occurred_on}`, row]),
    );

    const accountById = new Map(billable.map((account) => [account.id, account]));

    await Promise.all(
      metricRows.map(async (metric) => {
        const account = accountById.get(metric.ad_account_id);
        if (!account) return;

        const base = Number(metric.revenue_share_base);
        const amount = Number(metric.revenue_share_amount);
        const rate = base > 0 ? (amount / base) * 100 : 0; // blended, for display
        const current = existing.get(`${metric.ad_account_id}|${metric.day}`);

        try {
          if (!current) {
            await supabase.from("commissions").insert({
              source_id: source.id,
              client_id: crmByLogin.get(account.client_id) ?? null,
              ad_account_id: account.id,
              occurred_on: metric.day,
              gross_amount: base,
              rate,
              amount,
              currency: account.currency,
              status: "confirmed",
              notes: `Auto-synced revenue share · ${account.store_name}`,
            });
          } else if (Math.abs(Number(current.amount) - amount) > 0.01) {
            await supabase
              .from("commissions")
              .update({ gross_amount: base, rate, amount, updated_at: new Date().toISOString() })
              .eq("id", current.id);
          }
        } catch (error) {
          console.error(`Rev-share book failed for ${account.id} ${metric.day}:`, error);
        }
      }),
    );

    lastRevShareRunAt = Date.now();
  } catch (error) {
    console.error("Rev-share sync failed:", error);
  }
}
