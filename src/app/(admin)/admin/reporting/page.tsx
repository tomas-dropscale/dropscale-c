import type { Metadata } from "next";

import { ReportingSourcesManager } from "@/components/admin/reporting-sources-manager";
import { PageContainer } from "@/components/ui/page-container";
import {
  listClientReportingCutoverQueue,
  type ClientReportingCutoverQueue,
} from "@/lib/client-onboarding/reporting-cutover";

export const metadata: Metadata = { title: "Reporting sources" };
export const dynamic = "force-dynamic";

const EMPTY: ClientReportingCutoverQueue = {
  available: false,
  candidates: [],
  clients: [],
};

/**
 * Where a store's reporting sources are added, proven and promoted.
 *
 * The lifecycle behind this page was built in migration 0056 and driven only
 * by the hourly cron until now, which is why a client already live on V2 could
 * never gain a source: nothing could stage one on their behalf.
 */
export default async function AdminReportingPage() {
  const { queue, failed } = await listClientReportingCutoverQueue()
    .then((value) => ({ queue: value, failed: false }))
    .catch(() => ({ queue: EMPTY, failed: true }));

  return (
    <PageContainer
      title="Reporting sources"
      description="Bring a store's Shopify and Google Ads sources into reporting, prove them against 90 days of facts, then promote them live."
    >
      <ReportingSourcesManager initialQueue={queue} loadFailed={failed} />
    </PageContainer>
  );
}
