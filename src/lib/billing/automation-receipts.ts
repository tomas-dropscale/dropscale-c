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

export type SkippedBillingRecoveryOutcome = {
  itemId: string;
  claimVersion: number;
  state: "no_charge";
  stage: "complete";
  code: null;
  invoiceId: null;
  amount: 0;
  billableSpend: number;
  evidenceAccountCount: number;
};

function one<T>(rows: T[] | null, operation: string): T {
  const row = rows?.[0];
  if (!row) throw new Error(`${operation} returned no durable receipt.`);
  return row;
}

export async function beginBillingAutomationRun(
  client: Supabase,
): Promise<BillingAutomationRun> {
  const { data: rows, error } = await client.rpc(
    "begin_billing_automation_run",
    { p_issuance_enabled: false },
  );
  if (error) {
    throw new Error(`begin_billing_automation_run failed: ${error.message}`);
  }
  return one(rows, "begin_billing_automation_run");
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

export async function recordBillingAutomationOutcomes(
  client: Supabase,
  runId: string,
  outcomes: SkippedBillingRecoveryOutcome[],
): Promise<void> {
  for (const outcome of outcomes) {
    const { error } = await client.rpc(
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
