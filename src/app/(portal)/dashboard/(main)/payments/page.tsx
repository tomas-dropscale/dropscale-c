import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageContainer } from "@/components/ui/page-container";
import { PaymentsView } from "@/components/portal/payments-view";
import { getSessionClient } from "@/lib/supabase/server";
import {
  ensureWeeklyInvoices,
  fetchClientInvoices,
  reconcileInvoices,
} from "@/lib/billing/invoices";
import { customerHasCard, stripeConfigured } from "@/lib/stripe/client";

export const metadata: Metadata = { title: "Payments" };

/**
 * The client's Payments tab.
 *
 * Generation and reconciliation run before the read, throttled — the same
 * lazy pattern the ledgers use, since this stack has no cron. Opening the tab
 * is therefore enough to see the invoice for a week that has just closed.
 */
export default async function PaymentsPage() {
  const { client } = await getSessionClient();
  if (!client) redirect("/login");

  await ensureWeeklyInvoices();
  await reconcileInvoices();

  const invoices = await fetchClientInvoices(client.id);

  // A Stripe customer exists from the first invoice onwards, so it proves
  // nothing about payment: only a default payment method means the weeks
  // settle on their own.
  const hasCardOnFile =
    stripeConfigured() && client.stripe_customer_id
      ? await customerHasCard(client.stripe_customer_id)
      : false;

  return (
    <PageContainer
      title="Payments"
      description="Your weekly invoices — we bill every Monday for the week that just closed."
    >
      <PaymentsView
        invoices={invoices}
        hasCardOnFile={hasCardOnFile}
        stripeReady={stripeConfigured()}
      />
    </PageContainer>
  );
}
