import type { Metadata } from "next";

import { ResearchHub } from "@/components/admin/research-hub";
import { PageContainer } from "@/components/ui/page-container";

export const metadata: Metadata = { title: "Keywords by market" };

/** One concept per row, across the markets where it has demand. */
export default function KeywordsByMarketPage() {
  return (
    <PageContainer
      title="Keywords by Market"
      description="One concept per row and the markets where it holds demand. Open a row to compare its five-year shape across markets."
    >
      <ResearchHub view="keywords" />
    </PageContainer>
  );
}
