import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BillingAutomationItem,
  BillingAutomationRun,
  Database,
} from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

export type BillingAutomationFinish = {
  status: Exclude<BillingAutomationRun["status"], "running">;
  reconciliationChecked: number;
  reconciliationUpdated: number;
  errorCount: number;
};

export type BillingAutomationOutcome = {
  itemId: string;
  claimVersion: number;
  state: "blocked" | "issued" | "no_charge";
  stage: "preview" | "google_evidence" | "stripe_issue" | "complete";
  code: string | null;
  invoiceId: string | null;
  amount: number | null;
  billableSpend: number | null;
  evidenceAccountCount: number;
};

export type SkippedBillingRecoveryOutcome = BillingAutomationOutcome & {
  state: "no_charge";
  stage: "complete";
  code: null;
  invoiceId: null;
  amount: 0;
  billableSpend: number;
};

function one<T>(rows: T[] | null, operation: string): T {
  const row = rows?.[0];
  if (!row) throw new Error(`${operation} returned no durable receipt.`);
  return row;
}

export async function beginBillingAutomationRun(
  client: Supabase,
  issuanceEnabled = false,
): Promise<BillingAutomationRun | null> {
  const { data: rows, error } = await client.rpc(
    "begin_billing_automation_run",
    { p_issuance_enabled: issuanceEnabled },
  );
  if (error) {
    throw new Error(`begin_billing_automation_run failed: ${error.message}`);
  }
  // Migration 0067 returns no row while another fresh run owns the singleton
  // worker. That is a successful idempotent no-op, not a missing receipt.
  return rows?.[0] ?? null;
}

export async function seedBillingAutomationItems(
  client: Supabase,
  runId: string,
  closedThrough: string,
): Promise<number> {
  const { data, error } = await client.rpc("seed_billing_automation_items", {
    p_run_id: runId,
    p_closed_through: closedThrough,
  });
  if (error) {
    throw new Error(`seed_billing_automation_items failed: ${error.message}`);
  }
  if (!Number.isSafeInteger(data) || Number(data) < 0) {
    throw new Error("seed_billing_automation_items returned an invalid count.");
  }
  return Number(data);
}

export async function claimBillingAutomationItems(
  client: Supabase,
  runId: string,
  limit: number,
): Promise<BillingAutomationItem[]> {
  const { data, error } = await client.rpc("claim_billing_automation_items", {
    p_run_id: runId,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`claim_billing_automation_items failed: ${error.message}`);
  }
  return data ?? [];
}

/** A read hint only; migration 0066 remains the race-proof write guard. */
export async function billingCycleIsSkipped(
  client: Supabase,
  item: Pick<BillingAutomationItem, "client_id" | "period_start" | "period_end">,
): Promise<boolean> {
  const { data, error } = await client
    .from("billing_cycle_skips")
    .select("id")
    .eq("client_id", item.client_id)
    .eq("period_start", item.period_start)
    .eq("period_end", item.period_end)
    .maybeSingle();
  if (error) {
    throw new Error(`billing_cycle_skips lookup failed: ${error.message}`);
  }
  return data !== null;
}

/**
 * Purpose-bound reclaim: SQL accepts only expired `processing` items whose
 * exact client/week has an immutable skip and no invoice. It rejects runs
 * with issuance enabled, so this cannot become a general queue worker.
 */
export async function claimExpiredSkippedBillingItems(
  client: Supabase,
  runId: string,
  limit = 2,
): Promise<BillingAutomationItem[]> {
  const { data, error } = await client.rpc(
    "claim_expired_skipped_billing_automation_items",
    { p_run_id: runId, p_limit: limit },
  );
  if (error) {
    throw new Error(
      `claim_expired_skipped_billing_automation_items failed: ${error.message}`,
    );
  }
  return data ?? [];
}

function micros(value: string | number): bigint {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error("Authoritative Google billable spend was not integer micros.");
  }
  return BigInt(text);
}

/** Preserve real waived spend without reimplementing boundary arithmetic. */
export async function skippedBillingRecoveryOutcome(
  client: Supabase,
  item: BillingAutomationItem,
): Promise<SkippedBillingRecoveryOutcome> {
  const { data: rows, error } = await client.rpc(
    "manual_invoice_authoritative_rows",
    {
      p_client_id: item.client_id,
      p_period_start: item.period_start,
      p_period_end: item.period_end,
    },
  );
  if (error) {
    throw new Error(`manual_invoice_authoritative_rows failed: ${error.message}`);
  }

  let totalMicros = BigInt(0);
  const accountIds = new Set<string>();
  for (const row of rows ?? []) {
    totalMicros += micros(row.billable_gross_micros);
    accountIds.add(row.account_id);
  }
  const maxSafeMicros = BigInt(Number.MAX_SAFE_INTEGER);
  if (totalMicros > maxSafeMicros) {
    throw new Error("Authoritative Google billable spend exceeds the safe range.");
  }

  return {
    itemId: item.id,
    claimVersion: Number(item.claim_version),
    state: "no_charge",
    stage: "complete",
    code: null,
    invoiceId: null,
    amount: 0,
    billableSpend: Number(totalMicros) / 1_000_000,
    evidenceAccountCount: accountIds.size,
  };
}

export async function recordBillingAutomationOutcome(
  client: Supabase,
  runId: string,
  outcome: BillingAutomationOutcome,
): Promise<BillingAutomationItem> {
  const { data: rows, error } = await client.rpc(
    "record_billing_automation_item_result",
    {
      p_item_id: outcome.itemId,
      p_run_id: runId,
      p_claim_version: outcome.claimVersion,
      p_state: outcome.state,
      p_stage: outcome.stage,
      p_code: outcome.code,
      p_invoice_id: outcome.invoiceId,
      p_amount: outcome.amount,
      p_billable_spend: outcome.billableSpend,
      p_evidence_account_count: outcome.evidenceAccountCount,
    },
  );
  if (error) {
    throw new Error(
      `record_billing_automation_item_result failed: ${error.message}`,
    );
  }
  return one(rows, "record_billing_automation_item_result");
}

export async function recordBillingAutomationOutcomes(
  client: Supabase,
  runId: string,
  outcomes: readonly BillingAutomationOutcome[],
): Promise<void> {
  for (const outcome of outcomes) {
    await recordBillingAutomationOutcome(client, runId, outcome);
  }
}

export async function finishBillingAutomationRun(
  client: Supabase,
  runId: string,
  result: BillingAutomationFinish,
): Promise<BillingAutomationRun> {
  const { data: rows, error } = await client.rpc(
    "finish_billing_automation_run",
    {
      p_run_id: runId,
      p_status: result.status,
      p_historical_rollovers_checked: 0,
      p_exact_refresh_requested: 0,
      p_exact_refresh_completed: 0,
      p_reconciliation_checked: result.reconciliationChecked,
      p_reconciliation_updated: result.reconciliationUpdated,
      p_error_count: result.errorCount,
    },
  );
  if (error) {
    throw new Error(`finish_billing_automation_run failed: ${error.message}`);
  }
  return one(rows, "finish_billing_automation_run");
}
