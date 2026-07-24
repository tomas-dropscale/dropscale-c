import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/google-ads/crypto";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { fetchLiveDailySpend } from "@/lib/google-ads/portal";
import type { AdAccount } from "@/lib/supabase/types";

/**
 * Turns connected accounts' Google Ads spend into real finance rows: one
 * commissions entry per account per day (gross = spend, amount = spend ×
 * commission_rate), tagged with ad_account_id so synced rows never mix with
 * hand-entered ones.
 *
 * Runs when an admin opens a finance page — there is no cron on this stack —
 * and self-throttles to once an hour, so most page loads cost nothing. A
 * 7-day window per run heals gaps from days when nobody opened the panel.
 * Everything rides the admin's own session and RLS; no service key.
 */

const SOURCE_NAME = "Google Ads Management";
const THROTTLE_MS = 60 * 60 * 1000;

// Per-isolate memo so a burst of admin navigation doesn't even hit the
// database to discover it has nothing to do.
let lastRunAt = 0;

export async function syncCommissionLedger(): Promise<void> {
  if (!hasGoogleAdsEnv()) return;
  if (Date.now() - lastRunAt < THROTTLE_MS) return;

  try {
    const supabase = await createClient();

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

    // Portal login → CRM record, for the finance rows' client attribution.
    const { data: portalClients } = await supabase
      .from("portal_clients")
      .select("id, crm_client_id")
      .in("id", [...new Set(accounts.map((account) => account.client_id))]);
    const crmByLogin = new Map(
      (portalClients ?? []).map((row) => [row.id, row.crm_client_id]),
    );

    await Promise.all(
      accounts.map(async (account) => {
        try {
          if (!account.google_ads_refresh_token) return;
          const token = await decryptToken(account.google_ads_refresh_token);
          const days = await fetchLiveDailySpend(account.google_ads_customer_id!, token);

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
          console.error(`Commission sync failed for ${account.id}:`, error);
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
export async function syncRevenueShareLedger(): Promise<void> {
  if (Date.now() - lastRevShareRunAt < THROTTLE_MS) return;

  try {
    const supabase = await createClient();

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

    const { data: portalClients } = await supabase
      .from("portal_clients")
      .select("id, crm_client_id")
      .in("id", [...new Set(accounts.map((account) => account.client_id))]);
    const crmByLogin = new Map((portalClients ?? []).map((row) => [row.id, row.crm_client_id]));

    const from = isoDay(-REV_SHARE_WINDOW_DAYS);
    const accountIds = accounts.map((account) => account.id);

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

    const accountById = new Map(accounts.map((account) => [account.id, account]));

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
