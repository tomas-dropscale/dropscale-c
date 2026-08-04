import {
  stripeInvoiceRecoveryMode,
  type StripeInvoiceRecoveryMode,
} from "./invoice-delivery";
import type { Invoice } from "@/lib/supabase/types";

/** The two review-view fields the delivery plan actually keys on. */
export type HistoricalRolloverRef = {
  rollover_id: string;
  invoice_id: string | null;
};

/**
 * The delivery-state fields the planner needs from a rollover's invoice
 * receipt. The review view deliberately exposes only a summary of its joined
 * invoice, so the caller bulk-loads the referenced `invoices` rows and the
 * plan classifies from the same evidence `stripeInvoiceRecoveryMode` trusts —
 * never from a parallel, weaker definition of "issued" or "sent".
 */
export type HistoricalRolloverReceipt = Pick<
  Invoice,
  | "id"
  | "status"
  | "issued_at"
  | "stripe_invoice_id"
  | "stripe_sent_at"
  | "stripe_delivery_assumed_at"
  | "issue_attempted_at"
  | "issue_error"
>;

export type HistoricalRolloverCandidate<T extends HistoricalRolloverRef> = {
  rollover: T;
  /** Null when no invoice receipt exists yet and one must be created. */
  receipt: HistoricalRolloverReceipt | null;
  recoveryMode: Exclude<StripeInvoiceRecoveryMode, null>;
};

export type HistoricalRolloverPlan<T extends HistoricalRolloverRef> = {
  /** Delivery markers make any further Stripe mutation unsafe. */
  settled: T[];
  /** A recent attempt without a recorded error still owns the invoice. */
  inProgress: T[];
  /** The rollover references an invoice receipt that no longer loads. */
  missingReceipts: T[];
  /** Deliverable rollovers, fairest first. */
  candidates: HistoricalRolloverCandidate<T>[];
};

function attemptedAtMs(receipt: HistoricalRolloverReceipt | null): number | null {
  if (!receipt?.issue_attempted_at) return null;
  return Date.parse(receipt.issue_attempted_at);
}

/**
 * Classify every sealed historical rollover and order the deliverable ones so
 * a permanently failing item cannot starve its siblings: rollovers whose
 * invoice was never attempted go first (stable by rollover id), then failed
 * attempts rotate oldest-first through the durable `issue_attempted_at` stamp
 * each delivery attempt claims before touching Stripe.
 */
export function planHistoricalRolloverDelivery<T extends HistoricalRolloverRef>(
  rollovers: readonly T[],
  receiptsById: ReadonlyMap<string, HistoricalRolloverReceipt>,
  options: { now: number; lockMs: number },
): HistoricalRolloverPlan<T> {
  if (!Number.isFinite(options.now) || !Number.isFinite(options.lockMs)) {
    throw new Error("A finite clock and lock window are required.");
  }

  const plan: HistoricalRolloverPlan<T> = {
    settled: [],
    inProgress: [],
    missingReceipts: [],
    candidates: [],
  };

  for (const rollover of rollovers) {
    if (!rollover.invoice_id) {
      plan.candidates.push({ rollover, receipt: null, recoveryMode: "draft" });
      continue;
    }

    const receipt = receiptsById.get(rollover.invoice_id);
    if (!receipt) {
      plan.missingReceipts.push(rollover);
      continue;
    }

    const recoveryMode = stripeInvoiceRecoveryMode(receipt);
    if (recoveryMode === null) {
      plan.settled.push(rollover);
      continue;
    }

    const attemptedAt = attemptedAtMs(receipt);
    if (
      !receipt.issue_error &&
      attemptedAt !== null &&
      options.now - attemptedAt < options.lockMs
    ) {
      plan.inProgress.push(rollover);
      continue;
    }

    plan.candidates.push({ rollover, receipt, recoveryMode });
  }

  plan.candidates.sort((left, right) => {
    const leftAttempted = attemptedAtMs(left.receipt);
    const rightAttempted = attemptedAtMs(right.receipt);
    if ((leftAttempted === null) !== (rightAttempted === null)) {
      return leftAttempted === null ? -1 : 1;
    }
    if (leftAttempted === null && rightAttempted === null) {
      // A recorded error without an attempt stamp means the invoice fails
      // before it ever reaches the claim (for example a sealed-snapshot
      // mismatch). Demote it behind clean work so it cannot permanently head
      // the queue and burn the invocation's budget every run.
      const leftErrored = left.receipt?.issue_error ? 1 : 0;
      const rightErrored = right.receipt?.issue_error ? 1 : 0;
      if (leftErrored !== rightErrored) return leftErrored - rightErrored;
    }
    if (
      leftAttempted !== null &&
      rightAttempted !== null &&
      leftAttempted !== rightAttempted
    ) {
      return leftAttempted - rightAttempted;
    }
    return left.rollover.rollover_id.localeCompare(right.rollover.rollover_id);
  });

  return plan;
}
