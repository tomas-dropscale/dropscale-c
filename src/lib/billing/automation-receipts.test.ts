import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { BillingAutomationItem, Database } from "@/lib/supabase/types";
import {
  beginBillingAutomationRun,
  claimExpiredSkippedBillingItems,
  skippedBillingRecoveryOutcome,
} from "./automation-receipts";

const ITEM: BillingAutomationItem = {
  id: "item-1",
  client_id: "client-1",
  period_start: "2026-08-03",
  period_end: "2026-08-09",
  state: "processing",
  stage: "preview",
  blocker_code: null,
  safe_message: null,
  invoice_id: null,
  amount_snapshot: null,
  billable_spend_snapshot: null,
  evidence_account_count: 0,
  attempt_count: 2,
  first_seen_at: "2026-08-10T00:00:00.000Z",
  last_attempted_at: "2026-08-12T00:00:00.000Z",
  resolved_at: null,
  last_run_id: "old-run",
  claimed_by_run_id: "old-run",
  claim_version: 2,
  claim_expires_at: "2026-08-12T00:15:00.000Z",
  no_charge_reason: null,
  billing_cycle_skip_id: null,
  updated_at: "2026-08-12T00:00:00.000Z",
};

function client(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SupabaseClient<Database>;
}

describe("skipped billing recovery receipts", () => {
  it("always starts a non-issuance run", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "run-1" }],
      error: null,
    });

    await beginBillingAutomationRun(client(rpc));

    expect(rpc).toHaveBeenCalledWith("begin_billing_automation_run", {
      p_issuance_enabled: false,
    });
  });

  it("uses only the purpose-bound expired-skip claim RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [ITEM], error: null });

    await expect(
      claimExpiredSkippedBillingItems(client(rpc), "run-1", 2),
    ).resolves.toEqual([ITEM]);
    expect(rpc).toHaveBeenCalledWith(
      "claim_expired_skipped_billing_automation_items",
      { p_run_id: "run-1", p_limit: 2 },
    );
  });

  it("preserves positive authoritative spend while waiving the amount", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { account_id: "account-1", billable_gross_micros: "100250000" },
        { account_id: "account-1", billable_gross_micros: "50250000" },
        { account_id: "account-2", billable_gross_micros: "10000000" },
      ],
      error: null,
    });

    await expect(skippedBillingRecoveryOutcome(client(rpc), ITEM)).resolves.toEqual({
      itemId: "item-1",
      claimVersion: 2,
      state: "no_charge",
      stage: "complete",
      code: null,
      invoiceId: null,
      amount: 0,
      billableSpend: 160.5,
      evidenceAccountCount: 2,
    });
  });
});
