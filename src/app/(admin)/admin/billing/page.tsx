import type { Metadata } from "next";

import { BillingAdminView } from "@/components/admin/billing-admin-view";
import { PageContainer } from "@/components/ui/page-container";
import { fetchAdminBillingDashboard } from "@/lib/billing/invoices";
import { getServerDictionary } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Billing" };

/**
 * Read-only on render. Issuing an invoice and refreshing the ledger are both
 * explicit POST actions in the client component below.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const [{ week }, { d }] = await Promise.all([searchParams, getServerDictionary()]);
  const dashboard = await fetchAdminBillingDashboard(week);

  return (
    <PageContainer title={d.adminBilling.title} description={d.adminBilling.subtitle}>
      <BillingAdminView dashboard={dashboard} />
    </PageContainer>
  );
}
