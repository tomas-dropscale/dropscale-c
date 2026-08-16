import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  beginBillingAutomationRun,
  billingCycleIsSkipped,
  claimBillingAutomationItems,
  finishBillingAutomationRun,
  recordBillingAutomationOutcome,
  seedBillingAutomationItems,
  skippedBillingRecoveryOutcome,
  type BillingAutomationOutcome,
} from "@/lib/billing/automation-receipts";
import {
  issueClientWeekAutomatically,
  reconcileInvoices,
} from "@/lib/billing/invoices";
import {
  billingEvidenceIsReady,
  closedWeeks,
} from "@/lib/billing/weekly";
import type {
  BillingAutomationItem,
  Database,
} from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

/** Hard queue bound; unfinished work is retried by the next scheduled run. */
export const AUTOMATIC_BILLING_CLAIM_LIMIT = 10;
/** Small client fan-out bounds Stripe latency without creating a write burst. */
export const AUTOMATIC_BILLING_CONCURRENCY = 3;

export type AutomaticBillingRunResult = {
  alreadyRunning: boolean;
  runId: string | null;
  closedThrough: string;
  seeded: number;
  claimed: number;
  issued: number;
  noCharge: number;
  blocked: number;
  receiptErrors: number;
  reconciliationChecked: number;
  reconciliationUpdated: number;
  reconciliationErrors: number;
  status: "succeeded" | "partial";
};

export class AutomaticBillingRunError extends Error {
  constructor(readonly runId: string | null) {
    super("Automatic billing run failed.");
    this.name = "AutomaticBillingRunError";
  }
}

const GOOGLE_BLOCKERS = new Set([
  "billing_not_started",
  "billing_start_mismatch",
  "billing_end_mismatch",
  "ledger_missing",
  "ledger_stale",
  "evidence_settling",
]);
const PREVIEW_BLOCKERS = new Set([
  "recipient_invalid",
  "referral_term_mismatch",
]);
const STRIPE_BLOCKERS = new Set([
  "stripe_not_configured",
  "issuance_disabled",
  "issue_in_progress",
]);

type IssueErrorShape = Error & {
  code: string;
  preview?: {
    amount: number;
    billableSpend: number;
    stores: unknown[];
  };
};

function issueError(error: unknown): IssueErrorShape | null {
  return error instanceof Error &&
    error.name === "BillingIssueError" &&
    typeof (error as Partial<IssueErrorShape>).code === "string"
    ? (error as IssueErrorShape)
    : null;
}

function blockedOutcome(
  item: BillingAutomationItem,
  error: unknown,
): BillingAutomationOutcome {
  const billingError = issueError(error);
  const sourceCode = billingError?.code ?? "preview_failed";
  const code = GOOGLE_BLOCKERS.has(sourceCode)
    ? sourceCode
    : PREVIEW_BLOCKERS.has(sourceCode)
      ? sourceCode
      : STRIPE_BLOCKERS.has(sourceCode)
        ? sourceCode
        : sourceCode.startsWith("stripe_") ||
            sourceCode.startsWith("issue_") ||
            sourceCode === "draft_claim_failed" ||
            sourceCode === "invoice_create_failed"
          ? "stripe_issue_failed"
          : "preview_failed";
  const stage = GOOGLE_BLOCKERS.has(code)
    ? "google_evidence"
    : STRIPE_BLOCKERS.has(code) || code === "stripe_issue_failed"
      ? "stripe_issue"
      : "preview";

  return {
    itemId: item.id,
    claimVersion: Number(item.claim_version),
    state: "blocked",
    stage,
    code,
    invoiceId: null,
    amount: billingError?.preview?.amount ?? null,
    billableSpend: billingError?.preview?.billableSpend ?? null,
    evidenceAccountCount: billingError?.preview?.stores.length ?? 0,
  };
}

async function outcomeForItem(
  client: Supabase,
  item: BillingAutomationItem,
): Promise<BillingAutomationOutcome> {
  try {
    if (await billingCycleIsSkipped(client, item)) {
      return await skippedBillingRecoveryOutcome(client, item);
    }

    const result = await issueClientWeekAutomatically({
      clientId: item.client_id,
      periodStart: item.period_start,
      client,
    });
    return {
      itemId: item.id,
      claimVersion: Number(item.claim_version),
      state: result.state,
      stage: "complete",
      code: null,
      invoiceId: result.invoice?.id ?? null,
      amount: result.amount,
      billableSpend: result.billableSpend,
      evidenceAccountCount: result.evidenceAccountCount,
    };
  } catch (error) {
    // Migration 0066 serializes the actual invoice insert against a skip. If
    // that decision won after our read hint, repair the receipt as no-charge
    // instead of retrying a client/week that can never become an invoice.
    try {
      if (await billingCycleIsSkipped(client, item)) {
        return await skippedBillingRecoveryOutcome(client, item);
      }
    } catch (skipError) {
      console.error("Could not re-check a billing cycle skip:", skipError);
    }
    return blockedOutcome(item, error);
  }
}

export async function runAutomaticBilling(
  client: Supabase,
  options: { now?: Date; claimLimit?: number } = {},
): Promise<AutomaticBillingRunResult> {
  const now = options.now ?? new Date();
  const claimLimit = options.claimLimit ?? AUTOMATIC_BILLING_CLAIM_LIMIT;
  if (!Number.isSafeInteger(claimLimit) || claimLimit < 1 || claimLimit > 25) {
    throw new RangeError("Automatic billing claim limit must be from 1 to 25.");
  }

  // Around midnight Lisbon may already call a Sunday "closed" before its
  // Monday settling cutoff. Retry the newest *ready* week instead of either
  // certifying it early or giving up reconciliation for the whole run.
  const week = closedWeeks(now, 2).find((candidate) =>
    billingEvidenceIsReady(candidate.end, now),
  );
  if (!week) {
    throw new AutomaticBillingRunError(null);
  }

  const run = await beginBillingAutomationRun(client, true);
  if (!run) {
    return {
      alreadyRunning: true,
      runId: null,
      closedThrough: week.end,
      seeded: 0,
      claimed: 0,
      issued: 0,
      noCharge: 0,
      blocked: 0,
      receiptErrors: 0,
      reconciliationChecked: 0,
      reconciliationUpdated: 0,
      reconciliationErrors: 0,
      status: "succeeded",
    };
  }

  let seeded = 0;
  let claimed: BillingAutomationItem[] = [];
  let issued = 0;
  let noCharge = 0;
  let blocked = 0;
  let receiptErrors = 0;
  let reconciliationChecked = 0;
  let reconciliationUpdated = 0;
  let reconciliationErrors = 0;

  try {
    seeded = await seedBillingAutomationItems(client, run.id, week.end);
    claimed = await claimBillingAutomationItems(client, run.id, claimLimit);

    // Each client becomes its own result. Three at a time bounds Stripe wall
    // time without a broad financial write burst; chunks keep the total claim
    // and scheduled-event work finite.
    for (
      let offset = 0;
      offset < claimed.length;
      offset += AUTOMATIC_BILLING_CONCURRENCY
    ) {
      const results = await Promise.all(
        claimed
          .slice(offset, offset + AUTOMATIC_BILLING_CONCURRENCY)
          .map(async (item) => {
            const outcome = await outcomeForItem(client, item);
            try {
              await recordBillingAutomationOutcome(client, run.id, outcome);
              return outcome.state;
            } catch (error) {
              // The claim stays fenced in processing. A later run can reclaim
              // it and link the same delivered invoice without sending again.
              console.error(
                "Could not record a billing automation item:",
                error,
              );
              return "receipt_error" as const;
            }
          }),
      );
      for (const result of results) {
        if (result === "issued") issued += 1;
        else if (result === "no_charge") noCharge += 1;
        else if (result === "blocked") blocked += 1;
        else receiptErrors += 1;
      }
    }

    const reconciliation = await reconcileInvoices(client);
    reconciliationChecked = reconciliation.checked;
    reconciliationUpdated = reconciliation.updated;
    reconciliationErrors = reconciliation.errors.length;
    const status =
      blocked > 0 || receiptErrors > 0 || reconciliationErrors > 0
        ? "partial"
        : "succeeded";

    await finishBillingAutomationRun(client, run.id, {
      status,
      reconciliationChecked,
      reconciliationUpdated,
      errorCount: receiptErrors + reconciliationErrors,
    });

    return {
      alreadyRunning: false,
      runId: run.id,
      closedThrough: week.end,
      seeded,
      claimed: claimed.length,
      issued,
      noCharge,
      blocked,
      receiptErrors,
      reconciliationChecked,
      reconciliationUpdated,
      reconciliationErrors,
      status,
    };
  } catch (error) {
    try {
      await finishBillingAutomationRun(client, run.id, {
        status:
          issued > 0 || noCharge > 0 || blocked > 0 || receiptErrors > 0
            ? "partial"
            : "failed",
        reconciliationChecked,
        reconciliationUpdated,
        errorCount: receiptErrors + reconciliationErrors + 1,
      });
    } catch (finishError) {
      console.error("Could not close a failed billing automation run:", finishError);
    }
    console.error("Automatic billing failed:", error);
    throw new AutomaticBillingRunError(run.id);
  }
}
