import type { Metadata } from "next";

import { BillingAdminView } from "@/components/admin/billing-admin-view";
import { PageContainer } from "@/components/ui/page-container";
import { fetchAdminBillingDashboard } from "@/lib/billing/invoices";
import { getServerDictionary } from "@/lib/i18n/server";
import { createServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = { title: "Billing" };

/**
 * The production error page hides the exception behind a digest, so a failing
 * dashboard load persists its cause first — diagnosis stays one SELECT away.
 */
async function loadDashboardOrPersistFailure(week: string | undefined) {
  try {
    return await fetchAdminBillingDashboard(week);
  } catch (error) {
    const service = createServiceClient();
    if (service) {
      await service
        .from("admin_server_errors")
        .insert({
          scope: "admin_billing_dashboard",
          message:
            error instanceof Error ? error.message : String(error ?? "unknown"),
          stack: error instanceof Error ? (error.stack ?? null) : null,
        })
        .then(
          () => undefined,
          () => undefined,
        );
    }
    throw error;
  }
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const [{ week }, { d }] = await Promise.all([
    searchParams,
    getServerDictionary(),
  ]);
  const dashboard = await loadDashboardOrPersistFailure(week);

  return (
    <PageContainer
      title={d.adminBilling.title}
      description={d.adminBilling.subtitle}
    >
      <BillingAdminView dashboard={dashboard} />
    </PageContainer>
  );
}
