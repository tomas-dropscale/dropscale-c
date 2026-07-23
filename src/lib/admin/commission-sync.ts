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
