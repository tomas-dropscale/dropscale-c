import type { Metadata } from "next";

import { BillingAdminView } from "@/components/admin/billing-admin-view";
import { PageContainer } from "@/components/ui/page-container";
import { fetchAdminBillingDashboard } from "@/lib/billing/invoices";
import { getServerDictionary } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Billing" };

/**
 * Read-only on render. The Monday worker issues eligible closed weeks; this
 * page reports the resulting balances and keeps data refreshes explicit.
 * `periodStart` revisits an older closed cycle without changing live state.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ periodStart?: string }>;
}) {
  const { periodStart } = await searchParams;
  const { d } = await getServerDictionary();
  const dashboard = await fetchAdminBillingDashboard(periodStart);

  return (
    <PageContainer title={d.adminBilling.title} description={d.adminBilling.subtitle}>
      <BillingAdminView dashboard={dashboard} />
    </PageContainer>
  );
}
