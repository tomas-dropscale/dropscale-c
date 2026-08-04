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
