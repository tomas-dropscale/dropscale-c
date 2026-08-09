import type { Metadata } from "next";

import { ResearchHub } from "@/components/admin/research-hub";
import { PageContainer } from "@/components/ui/page-container";

export const metadata: Metadata = { title: "Markets overview" };

/** Every tracked market at a glance: persistence, profile, season, position. */
export default function MarketsOverviewPage() {
  return (
    <PageContainer
      title="Markets Overview"
      description="Demand persistence, seasonal profile and structural trend for every keyword in a market, from five years of Google Trends."
    >
      <ResearchHub view="markets" />
    </PageContainer>
  );
}
