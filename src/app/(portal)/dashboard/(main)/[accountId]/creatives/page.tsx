import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { fetchAccount, fetchCreativeAssets, fetchDeliveries } from "@/lib/portal/data";
import { CreativesGrid } from "@/components/portal/creatives-grid";
import { CreativeAssetsGrid } from "@/components/portal/creative-assets-grid";
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

  const [assets, { d }] = await Promise.all([fetchCreativeAssets(account), getServerDictionary()]);

  return (
    <PageContainer
      title={d.portal.creatives}
      description={fmt(d.portal.creativesSubtitle, { store: account.store_name })}
    >
      {assets === null ? (
        // Google Ads not configured at all → demo deliveries, as before.
        <CreativesGrid deliveries={await fetchDeliveries(account.id)} />
      ) : account.google_ads_connected ? (
        // Connected → the account's real creative library.
        <CreativeAssetsGrid assets={assets} />
      ) : (
        // Configured but this store not connected → say so, show nothing fake.
        <div className="space-y-6">
          <ConnectAdsBanner />
          <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
            Connect Google Ads to see this store&apos;s creatives.
          </div>
        </div>
      )}
    </PageContainer>
  );
}
