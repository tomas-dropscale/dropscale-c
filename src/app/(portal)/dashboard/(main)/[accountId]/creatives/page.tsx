import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  fetchAccount,
  fetchCreativeAssets,
  fetchCreativeSubmissions,
  fetchDeliveries,
} from "@/lib/portal/data";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { CreativesGrid } from "@/components/portal/creatives-grid";
import { CreativeAssetsGrid } from "@/components/portal/creative-assets-grid";
import { CreativeSubmissions } from "@/components/portal/creative-submissions";
import { ConnectAdsBanner } from "@/components/portal/connect-ads-banner";
import { PageContainer } from "@/components/ui/page-container";
import { fmt } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.creatives };
}

export default async function CreativesPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;

  // Scoped to the signed-in client — an admin in the portal zone 404s on any
  // account that isn't personally theirs, exactly like a client would.
  const account = await fetchAccount(accountId);
  if (!account) notFound();

  const [assets, submissions, { viewer }, { d }] = await Promise.all([
    fetchCreativeAssets(account),
    fetchCreativeSubmissions(account.id),
    getWorkspaceContext(),
    getServerDictionary(),
  ]);

  return (
    <PageContainer
      title={d.portal.creatives}
      description={fmt(d.portal.creativesSubtitle, { store: account.store_name })}
    >
      {/* Handing creatives in comes first and is always here: it does not depend
          on Google Ads being connected, and it is the one thing on this page the
          client DOES rather than reads. */}
      {viewer && (
        <div className="mb-6">
          <CreativeSubmissions
            accountId={account.id}
            submittedBy={viewer.id}
            submissions={submissions}
          />
        </div>
      )}

      {assets === null ? (
        // Google Ads not configured at all → demo deliveries, as before.
        <CreativesGrid deliveries={await fetchDeliveries(account.id)} />
      ) : account.google_ads_connected ? (
        // Connected → the account's real creative library.
        <CreativeAssetsGrid assets={assets} />
      ) : (
        // Configured but this store not connected → say so, show nothing fake.
        <div className="space-y-6">
          <ConnectAdsBanner d={d} />
          <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
            Connect Google Ads to see this store&apos;s creatives.
          </div>
        </div>
      )}
    </PageContainer>
  );
}
