import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  cycleIsSkipped: vi.fn(),
  claim: vi.fn(),
  finish: vi.fn(),
  issue: vi.fn(),
  reconcile: vi.fn(),
  record: vi.fn(),
  seed: vi.fn(),
  skippedOutcome: vi.fn(),
}));

vi.mock("@/lib/billing/automation-receipts", () => ({
  beginBillingAutomationRun: mocks.begin,
  billingCycleIsSkipped: mocks.cycleIsSkipped,
  claimBillingAutomationItems: mocks.claim,
  finishBillingAutomationRun: mocks.finish,
  recordBillingAutomationOutcome: mocks.record,
  seedBillingAutomationItems: mocks.seed,
  skippedBillingRecoveryOutcome: mocks.skippedOutcome,
}));
vi.mock("@/lib/billing/invoices", () => ({
  issueClientWeekAutomatically: mocks.issue,
  reconcileInvoices: mocks.reconcile,
}));
vi.mock("@/lib/billing/weekly", () => ({
  billingEvidenceIsReady: () => true,
  closedWeeks: () => [{ start: "2026-08-10", end: "2026-08-16" }],
}));

import type {
  BillingAutomationItem,
  Database,
  Invoice,
} from "@/lib/supabase/types";
import { runAutomaticBilling } from "./automation";

const SERVICE = {} as SupabaseClient<Database>;
const NOW = new Date("2026-08-17T14:10:00.000Z");

function item(id: string, clientId: string): BillingAutomationItem {
  return {
    id,
    client_id: clientId,
    period_start: "2026-08-10",
    period_end: "2026-08-16",
    state: "processing",
    stage: "preview",
    blocker_code: null,
    safe_message: null,
    invoice_id: null,
    amount_snapshot: null,
    billable_spend_snapshot: null,
    evidence_account_count: 0,
    attempt_count: 1,
    first_seen_at: "2026-08-17T14:05:00.000Z",
    last_attempted_at: "2026-08-17T14:06:00.000Z",
    resolved_at: null,
    last_run_id: "run-1",
    claimed_by_run_id: "run-1",
    claim_version: 3,
    claim_expires_at: "2026-08-17T14:26:00.000Z",
    no_charge_reason: null,
    billing_cycle_skip_id: null,
    updated_at: "2026-08-17T14:06:00.000Z",
  };
}

const BLOCKED = item("item-blocked", "client-blocked");
const DELIVERED = item("item-delivered", "client-delivered");
const ZERO = item("item-zero", "client-zero");
const INVOICE = { id: "invoice-1", amount: 24.5 } as Invoice;

function issueFailure() {
  return Object.assign(new Error("private Stripe detail"), {
    name: "BillingIssueError",
    code: "stripe_issue_failed",
    preview: { amount: 12.34, billableSpend: 123.4, stores: [{}, {}] },
  });
}

describe("automatic billing runtime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.begin.mockResolvedValue({ id: "run-1" });
    mocks.seed.mockResolvedValue(3);
    mocks.claim.mockResolvedValue([BLOCKED, DELIVERED, ZERO]);
    mocks.cycleIsSkipped.mockResolvedValue(false);
    mocks.issue
      .mockRejectedValueOnce(issueFailure())
      .mockResolvedValueOnce({
        state: "issued",
        invoice: INVOICE,
        amount: 24.5,
        billableSpend: 245,
        evidenceAccountCount: 1,
      })
      .mockResolvedValueOnce({
        state: "no_charge",
        invoice: null,
        amount: 0,
        billableSpend: 0,
        evidenceAccountCount: 1,
      });
    mocks.record.mockImplementation(
      async (_client, _runId, outcome: { itemId: string }) => {
        // Delivery committed, but its receipt response fails. Other clients
        // must still run; the fenced claim is safe to repair on a later retry.
        if (outcome.itemId === DELIVERED.id) {
          throw new Error("receipt timeout");
        }
        return {};
      },
    );
    mocks.reconcile.mockResolvedValue({ checked: 2, updated: 1, errors: [] });
    mocks.finish.mockResolvedValue({ id: "run-1" });
  });

  it("isolates clients and leaves a lost receipt safely retryable", async () => {
    await expect(runAutomaticBilling(SERVICE, { now: NOW })).resolves.toEqual({
      alreadyRunning: false,
      runId: "run-1",
      closedThrough: "2026-08-16",
      seeded: 3,
      claimed: 3,
      issued: 0,
      noCharge: 1,
      blocked: 1,
      receiptErrors: 1,
      reconciliationChecked: 2,
      reconciliationUpdated: 1,
      reconciliationErrors: 0,
      status: "partial",
    });

    expect(mocks.issue).toHaveBeenCalledTimes(3);
    expect(mocks.begin).toHaveBeenCalledWith(SERVICE, true);
    expect(mocks.claim).toHaveBeenCalledWith(SERVICE, "run-1", 10);
    expect(mocks.record).toHaveBeenCalledWith(
      SERVICE,
      "run-1",
      expect.objectContaining({
        itemId: BLOCKED.id,
        state: "blocked",
        stage: "stripe_issue",
        code: "stripe_issue_failed",
        amount: 12.34,
        billableSpend: 123.4,
        evidenceAccountCount: 2,
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      SERVICE,
      "run-1",
      expect.objectContaining({
        itemId: DELIVERED.id,
        state: "issued",
        invoiceId: INVOICE.id,
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      SERVICE,
      "run-1",
      expect.objectContaining({ itemId: ZERO.id, state: "no_charge" }),
    );
    expect(mocks.finish).toHaveBeenCalledWith(SERVICE, "run-1", {
      status: "partial",
      reconciliationChecked: 2,
      reconciliationUpdated: 1,
      errorCount: 1,
    });
  });

  it("settles an immutable skipped cycle without touching invoice issue", async () => {
    const skipped = item("item-skip", "client-skip");
    const outcome = {
      itemId: skipped.id,
      claimVersion: 3,
      state: "no_charge",
      stage: "complete",
      code: null,
      invoiceId: null,
      amount: 0,
      billableSpend: 421.39,
      evidenceAccountCount: 1,
    };
    mocks.seed.mockResolvedValue(0);
    mocks.claim.mockResolvedValue([skipped]);
    mocks.cycleIsSkipped.mockResolvedValue(true);
    mocks.skippedOutcome.mockResolvedValue(outcome);
    mocks.record.mockReset().mockResolvedValue({});
    mocks.issue.mockReset();

    await expect(runAutomaticBilling(SERVICE, { now: NOW })).resolves.toMatchObject({
      issued: 0,
      noCharge: 1,
      blocked: 0,
      status: "succeeded",
    });
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(SERVICE, "run-1", outcome);
  });

  it("does no queue or Stripe work when another run owns the mutex", async () => {
    mocks.begin.mockResolvedValue(null);

    await expect(runAutomaticBilling(SERVICE, { now: NOW })).resolves.toMatchObject({
      alreadyRunning: true,
      runId: null,
      claimed: 0,
      issued: 0,
    });
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("never starts more than three client issues at once", async () => {
    const items = [
      item("item-1", "client-1"),
      item("item-2", "client-2"),
      item("item-3", "client-3"),
      item("item-4", "client-4"),
    ];
    const started: string[] = [];
    let release!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.claim.mockResolvedValue(items);
    mocks.issue.mockReset().mockImplementation(async ({ clientId }) => {
      started.push(clientId);
      if (clientId !== "client-4") await firstChunk;
      return {
        state: "no_charge",
        invoice: null,
        amount: 0,
        billableSpend: 0,
        evidenceAccountCount: 1,
      };
    });
    mocks.record.mockReset().mockResolvedValue({});

    const running = runAutomaticBilling(SERVICE, { now: NOW });
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started).toEqual(["client-1", "client-2", "client-3"]);

    release();
    await expect(running).resolves.toMatchObject({
      claimed: 4,
      noCharge: 4,
      status: "succeeded",
    });
    expect(started).toEqual([
      "client-1",
      "client-2",
      "client-3",
      "client-4",
    ]);
  });
});
