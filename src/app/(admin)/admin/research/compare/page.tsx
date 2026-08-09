import type { Metadata } from "next";

import { ResearchApifyKey } from "@/components/admin/research-apify-key";
import { ResearchHub } from "@/components/admin/research-hub";
import { PageContainer } from "@/components/ui/page-container";
import { fetchApifyTokenStatus } from "@/lib/research/apify-token";

export const metadata: Metadata = { title: "Market comparison" };

/**
 * The only view that spends money: it runs Google Trends' comparison mode,
 * which is the sole honest answer to "which market searches more" — stored
 * indices are normalised per market and cannot be compared directly.
 */
export default async function MarketComparisonPage() {
  const token = await fetchApifyTokenStatus();

  return (
    <PageContainer
      title="Market Comparison"
      description="Up to five markets on one shared scale, live from Google Trends. Each run costs roughly $0.05 and is cached, so repeating a comparison is free."
    >
      <div className="space-y-4">
        <ResearchApifyKey configured={token.configured} hint={token.hint} />
        <ResearchHub view="compare" />
      </div>
    </PageContainer>
  );
}
