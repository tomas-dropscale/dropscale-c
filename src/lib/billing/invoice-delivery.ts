import type { Invoice } from "@/lib/supabase/types";

export type StripeInvoiceRecoveryMode = "draft" | "send_only" | null;

type DeliveryRecoveryInvoice = Pick<
  Invoice,
  | "status"
  | "issued_at"
  | "stripe_invoice_id"
  | "stripe_sent_at"
  | "stripe_delivery_assumed_at"
>;

type BillingReviewQueueEntry = {
  clientName: string;
  canIssue: boolean;
  existingInvoice: DeliveryRecoveryInvoice | null;
};

/**
 * Decide whether Stripe mutation is still safe from durable local evidence.
 *
 * Any real or migration-assumed delivery marker is terminal for automatic
 * retry, even when a crash left the local status as `draft`. A late retry must
 * never turn a reconciliation problem into a duplicate invoice email.
 */
export function stripeInvoiceRecoveryMode(
  invoice: DeliveryRecoveryInvoice,
): StripeInvoiceRecoveryMode {
  if (
    invoice.stripe_sent_at !== null ||
    invoice.stripe_delivery_assumed_at !== null
  ) {
    return null;
  }

  if (invoice.status === "draft" && invoice.issued_at === null) {
    return "draft";
  }

  if (invoice.status === "open" && invoice.stripe_invoice_id) {
    return "send_only";
  }

  return null;
}

/**
 * Keep the issue queue actionable: settled/sent invoices live in the position
 * and history sections, while new and safely recoverable issues remain here.
 */
export function billingReviewQueue<T extends BillingReviewQueueEntry>(
  entries: readonly T[],
): T[] {
  return entries
    .filter(
      (entry) =>
        !entry.existingInvoice ||
        stripeInvoiceRecoveryMode(entry.existingInvoice) !== null,
    )
    .sort(
      (left, right) =>
        Number(right.canIssue) - Number(left.canIssue) ||
        left.clientName.localeCompare(right.clientName, "en", {
          sensitivity: "base",
        }),
    );
}
