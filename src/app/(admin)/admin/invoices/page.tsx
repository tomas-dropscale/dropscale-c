import type { Metadata } from "next";

import { InvoiceRecordView } from "@/components/admin/invoice-record-view";
import { PageContainer } from "@/components/ui/page-container";
import { fetchAdminInvoiceRecord } from "@/lib/billing/invoices";
import { getServerDictionary } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Invoices" };

/** Read-only: the complete agency invoice record for the finance area. */
export default async function InvoicesPage() {
  const { d } = await getServerDictionary();
  const invoices = await fetchAdminInvoiceRecord();

  return (
    <PageContainer
      title={d.adminBilling.invoiceRecordTitle}
      description={d.adminBilling.invoiceRecordSubtitle}
    >
      <InvoiceRecordView invoices={invoices} />
    </PageContainer>
  );
}
