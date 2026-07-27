import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageContainer } from "@/components/ui/page-container";
import { PaymentsView } from "@/components/portal/payments-view";
import { getSessionClient } from "@/lib/supabase/server";
import { fetchClientInvoices } from "@/lib/billing/invoices";
import { customerHasCard, stripeConfigured } from "@/lib/stripe/client";
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
export default async function PaymentsPage() {
  const { client } = await getSessionClient();
  if (!client) redirect("/login");

  const { d } = await getServerDictionary();
  const invoices = await fetchClientInvoices(client.id);

  // A Stripe customer exists from the first invoice onwards, so it proves
  // nothing about payment: only a default payment method means the weeks
  // settle on their own.
  const hasCardOnFile =
    stripeConfigured() && client.stripe_customer_id
      ? await customerHasCard(client.stripe_customer_id)
      : false;

  return (
    <PageContainer title={d.portal.payments} description={d.payments.subtitle}>
      <PaymentsView
        invoices={invoices}
        hasCardOnFile={hasCardOnFile}
        stripeReady={stripeConfigured()}
      />
    </PageContainer>
  );
}
