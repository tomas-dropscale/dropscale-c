import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ShopifyAuditOnboarding } from "@/components/audit/shopify-audit-onboarding";
import { isAuditConnectionId } from "@/lib/audit/invitations";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect your Shopify store",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ShopifyAuditConnectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isAuditConnectionId(id)) notFound();
  return <ShopifyAuditOnboarding connectionId={id} />;
}
