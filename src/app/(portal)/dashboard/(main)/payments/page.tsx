import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageContainer } from "@/components/ui/page-container";
import { PaymentsView } from "@/components/portal/payments-view";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { fetchClientInvoices } from "@/lib/billing/invoices";
import {
  adoptDefaultPaymentMethod,
  customerHasCard,
  stripeConfigured,
} from "@/lib/stripe/client";
import { getServerDictionary } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Payments" };

/**
 * The client's Payments tab — a pure read.
 *
 * It deliberately does NOT generate or reconcile. Both the commission ledger
 * and the invoices table are admin-only under RLS, so running them on the
 * viewer's own session could only ever fail; the Monday cron
 * (custom-worker.ts → /api/billing/cron) does that work with the service role,
 * and an admin opening /admin/clients is the manual fallback.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string }>;
}) {
  // The WORKSPACE's invoices and the WORKSPACE's Stripe customer — a sócio
  // sees what the business is billed, which is the whole point of the role.
  const { owner } = await getWorkspaceContext();
  if (!owner) redirect("/login");

  const [{ d }, params] = await Promise.all([getServerDictionary(), searchParams]);
  const invoices = await fetchClientInvoices(owner.id);

  /**
   * Coming back from Stripe Checkout, claim the card NOW rather than waiting
   * for the webhook.
   *
   * Stripe redirects the moment the card is saved, but the
   * `checkout.session.completed` webhook that promotes it to the customer's
   * default is a separate request that may not have landed yet. Without this
   * the client returns from saving a card to a page that says "No card saved",
   * which reads as a failure. Idempotent: it no-ops once a default exists, so
   * the webhook arriving afterwards changes nothing.
   */
  if (params.setup === "done" && stripeConfigured() && owner.stripe_customer_id) {
    await adoptDefaultPaymentMethod(owner.stripe_customer_id);
  }

  // A Stripe customer exists from the first invoice onwards, so it proves
  // nothing about payment: only a default payment method means the weeks
  // settle on their own.
  const hasCardOnFile =
    stripeConfigured() && owner.stripe_customer_id
      ? await customerHasCard(owner.stripe_customer_id)
      : false;

  return (
    <PageContainer title={d.portal.payments} description={d.payments.subtitle}>
      <PaymentsView
        invoices={invoices}
        hasCardOnFile={hasCardOnFile}
        stripeReady={stripeConfigured()}
        setupOutcome={
          params.setup === "done" ? "done" : params.setup === "cancelled" ? "cancelled" : null
        }
      />
    </PageContainer>
  );
}
