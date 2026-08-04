import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AutomaticBillingOutcome, AutomaticBillingTarget } from "./invoices";
import type {
  BillingAutomationItem as BillingAutomationItemRow,
  BillingAutomationRun as BillingAutomationRunRow,
  Database,
} from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

export type BillingAutomationRun = BillingAutomationRunRow;
export type BillingAutomationItem = BillingAutomationItemRow;
export type BillingAutomationPositionTarget = Pick<
  BillingAutomationItem,
  "client_id" | "period_start" | "period_end"
>;

export type BillingAutomationFinish = {
  status: Exclude<BillingAutomationRun["status"], "running">;
  historicalRolloversChecked: number;
  exactRefreshRequested: number;
  exactRefreshCompleted: number;
  reconciliationChecked: number;
  reconciliationUpdated: number;
  errorCount: number;
};

function one<T>(rows: T[] | null, operation: string): T {
  const row = rows?.[0];
  if (!row) throw new Error(`${operation} returned no durable receipt.`);
  return row;
}

export async function beginBillingAutomationRun(
  client: Supabase,
  issuanceEnabled: boolean,
): Promise<BillingAutomationRun> {
  const { data: rows, error } = await client.rpc(
    "begin_billing_automation_run",
    {
      p_issuance_enabled: issuanceEnabled,
    },
  );
  if (error) {
    throw new Error(`begin_billing_automation_run failed: ${error.message}`);
  }
  return one(rows, "begin_billing_automation_run");
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
  if (data === null) {
    throw new Error("seed_billing_automation_items returned no count.");
  }
  return data;
}

export async function claimBillingAutomationItems(
  client: Supabase,
  runId: string,
  limit = 200,
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

export function automationTargets(
  items: BillingAutomationItem[],
): AutomaticBillingTarget[] {
  return items.map((item) => ({
    itemId: item.id,
    claimVersion: Number(item.claim_version),
    clientId: item.client_id,
    periodStart: item.period_start,
    periodEnd: item.period_end,
  }));
}

export async function recordBillingAutomationOutcomes(
  client: Supabase,
  runId: string,
  outcomes: AutomaticBillingOutcome[],
): Promise<void> {
  // Keep result writes independent: every RPC checks the item/run/fence before
  // changing state, so a delayed worker can never overwrite a newer claim.
  await Promise.all(
    outcomes.map(async (outcome) => {
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
    }),
  );
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
      p_historical_rollovers_checked: result.historicalRolloversChecked,
      p_exact_refresh_requested: result.exactRefreshRequested,
      p_exact_refresh_completed: result.exactRefreshCompleted,
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

export async function fetchBillingAutomationAttentionClientIds(
  client: Supabase,
): Promise<string[]> {
  const { data: rows, error } = await client.rpc(
    "billing_automation_attention_clients",
  );
  if (error) {
    throw new Error(
      `billing_automation_attention_clients failed: ${error.message}`,
    );
  }
  return (rows ?? []).map((row) => row.client_id);
}

/**
 * Durable non-terminal client/weeks that the read-only Billing position may
 * recertify through calculateWeek. Amount snapshots are intentionally absent:
 * blocked work may have observed only a partial Google ledger.
 */
export async function fetchBillingAutomationPositionTargets(
  client: Supabase,
): Promise<BillingAutomationPositionTarget[]> {
  const rows: BillingAutomationPositionTarget[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = client
      .from("billing_automation_items")
      .select("id, client_id, period_start, period_end")
      .in("state", ["pending", "processing", "blocked"])
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) {
      throw new Error(
        `Could not load automatic billing position targets: ${error.message}`,
      );
    }
    const page = data ?? [];
    rows.push(
      ...page.map((row) => ({
        client_id: row.client_id,
        period_start: row.period_start,
        period_end: row.period_end,
      })),
    );
    if (page.length < pageSize) break;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return rows;
}

export async function fetchLatestBillingAutomationRun(
  client: Supabase,
): Promise<BillingAutomationRun | null> {
  const { data: rows, error } = await client.rpc(
    "latest_billing_automation_run",
  );
  if (error) {
    throw new Error(`latest_billing_automation_run failed: ${error.message}`);
  }
  return rows?.[0] ?? null;
}
