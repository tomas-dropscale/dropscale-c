import type { Metadata } from "next";

import { AuditConnectionsView } from "@/components/admin/audit-connections-view";
import { PageContainer } from "@/components/ui/page-container";
import { listAuditConnections } from "@/lib/audit/connections";

export const metadata: Metadata = { title: "Audit connections" };
export const dynamic = "force-dynamic";

export default async function AuditConnectionsPage() {
  const connections = await listAuditConnections();

  return (
    <PageContainer
      title="Connections"
      description="Generate a secure setup link, then track Shopify stores authorised for internal audits."
    >
      <AuditConnectionsView connections={connections} />
    </PageContainer>
  );
}
