import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageContainer } from "@/components/ui/page-container";
import { PaymentsView } from "@/components/portal/payments-view";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { fetchClientInvoices } from "@/lib/billing/invoices";
import { getServerDictionary } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Payments" };

/**
 * The client's Payments tab — a pure read.
 *
 * It deliberately does NOT generate or reconcile during a client page load.
 * The scheduled billing worker issues eligible closed weeks automatically;
 * this page only displays the resulting balance and Stripe-hosted payment link.
 */
export default async function PaymentsPage() {
  // The WORKSPACE's invoices and the WORKSPACE's Stripe customer — a sócio
  // sees what the business is billed, which is the whole point of the role.
  const { owner } = await getWorkspaceContext();
  if (!owner) redirect("/login");

  const { d } = await getServerDictionary();
  const invoices = await fetchClientInvoices(owner.id);

  return (
    <PageContainer title={d.portal.payments} description={d.payments.subtitle}>
      <PaymentsView invoices={invoices} />
    </PageContainer>
  );
}
