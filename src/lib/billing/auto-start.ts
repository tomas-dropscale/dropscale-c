import "server-only";

import { addIsoDays, googleLocalDate } from "@/lib/google-ads/billing-start";

/**
 * Owner policy (2026-08-17): a client is billable from the moment they join
 * the platform. As soon as a reporting binding with a Google source is active
 * on an account, the billing start must exist without an admin touch — every
 * Google-local day AFTER the connection instant is billable.
 *
 * The start is an observed_google_counter with a zero baseline dated the first
 * FULL Google-local day after the connection: nothing spent before the client
 * joined is ever billed (the partial entry day is deliberately left out — the
 * legacy OAuth activation flow keeps its intraday counter precision, this
 * automatic path never overcharges instead). Accounts the policy cannot prove
 * (non-EUR, mismatched Google identity, no admin reviewer) are left alone and
 * keep failing closed in billing as before.
 */

type Service = {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

type AccountRow = {
  id: string;
  client_id: string;
  store_name: string;
  status: string;
  currency: string;
  google_ads_customer_id: string | null;
};

type BindingRow = {
  ad_account_id: string;
  bound_by: string | null;
  bound_at: string;
  google_ads_connection_id: string | null;
};

type ConnectionRow = {
  id: string;
  status: string;
  currency: string;
  time_zone: string;
  windsor_account_id: string;
  connected_at: string | null;
  created_at: string;
};

export type AutoBillingStartOutcome = {
  attempted: number;
  started: number;
  activated: number;
  failed: number;
};

function tenDigits(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

export async function ensureAutomaticBillingStarts(
  service: Service,
): Promise<AutoBillingStartOutcome> {
  const outcome: AutoBillingStartOutcome = {
    attempted: 0,
    started: 0,
    activated: 0,
    failed: 0,
  };

  const [accounts, starts, admins, bindings, connections] = await Promise.all([
    service
      .from("ad_accounts")
      .select("id, client_id, store_name, status, currency, google_ads_customer_id")
      .in("status", ["pending", "active"])
      .not("google_ads_customer_id", "is", null),
    service.from("ad_account_billing_starts").select("ad_account_id"),
    service.from("profiles").select("id").eq("role", "admin"),
    service
      .from("client_reporting_bindings")
      .select("ad_account_id, bound_by, bound_at, google_ads_connection_id")
      .eq("status", "active")
      .not("google_ads_connection_id", "is", null),
    service
      .from("client_google_ads_connections")
      .select("id, status, currency, time_zone, windsor_account_id, connected_at, created_at")
      .eq("status", "connected"),
  ]);
  const firstError =
    accounts.error ?? starts.error ?? admins.error ?? bindings.error ?? connections.error;
  if (firstError) throw firstError;

  const adminIds = new Set(
    ((admins.data ?? []) as { id: string }[]).map((row) => row.id),
  );
  const startedAccounts = new Set(
    ((starts.data ?? []) as { ad_account_id: string }[]).map(
      (row) => row.ad_account_id,
    ),
  );
  const connectionById = new Map(
    ((connections.data ?? []) as ConnectionRow[]).map((row) => [row.id, row]),
  );
  const bindingByAccount = new Map(
    ((bindings.data ?? []) as BindingRow[]).map((row) => [row.ad_account_id, row]),
  );

  for (const account of (accounts.data ?? []) as AccountRow[]) {
    if (startedAccounts.has(account.id)) continue;
    // Internal/admin stores are never agency revenue.
    if (adminIds.has(account.client_id)) continue;
    const binding = bindingByAccount.get(account.id);
    if (!binding?.google_ads_connection_id) continue;
    const connection = connectionById.get(binding.google_ads_connection_id);
    if (!connection) continue;

    const customerId = account.google_ads_customer_id
      ? tenDigits(account.google_ads_customer_id)
      : null;
    const connectionCustomerId = tenDigits(connection.windsor_account_id);
    const reviewer =
      binding.bound_by && adminIds.has(binding.bound_by) ? binding.bound_by : null;
    if (
      !customerId ||
      customerId !== connectionCustomerId ||
      account.currency.toUpperCase() !== "EUR" ||
      connection.currency.toUpperCase() !== "EUR" ||
      !connection.time_zone.trim() ||
      !reviewer
    ) {
      continue;
    }

    outcome.attempted += 1;
    try {
      const entryInstant = new Date(
        connection.connected_at ?? connection.created_at ?? binding.bound_at,
      );
      if (Number.isNaN(entryInstant.getTime())) throw new Error("Invalid entry instant.");
      const startDay = addIsoDays(
        googleLocalDate(entryInstant, connection.time_zone),
        1,
      );
      const now = new Date().toISOString();
      const { error: insertError } = await service
        .from("ad_account_billing_starts")
        .insert({
          ad_account_id: account.id,
          google_ads_customer_id: customerId,
          google_local_date: startDay,
          google_time_zone: connection.time_zone,
          currency: "EUR",
          baseline_cost_micros: "0",
          start_basis: "observed_google_counter",
          capture_started_at: now,
          captured_at: now,
          capture_id: crypto.randomUUID(),
          source: "agency",
          reviewed_by: reviewer,
        });
      // A concurrent sync racing this insert loses on the unique index; that
      // account is already handled and must not count as a failure.
      if (insertError && insertError.code !== "23505") throw insertError;
      if (!insertError) outcome.started += 1;

      if (account.status === "pending") {
        const { error: activateError } = await service
          .from("ad_accounts")
          .update({ status: "active" })
          .eq("id", account.id)
          .eq("status", "pending");
        if (activateError) throw activateError;
        outcome.activated += 1;
      }
    } catch (error) {
      outcome.failed += 1;
      console.error(
        `Automatic billing start failed for ${account.store_name} (${account.id}):`,
        error,
      );
    }
  }

  return outcome;
}
