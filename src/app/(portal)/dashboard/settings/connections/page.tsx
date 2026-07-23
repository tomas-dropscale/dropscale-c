import type { Metadata } from "next";
import { CircleCheck, CircleDashed, Store } from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { ShopifyConnectPanel } from "@/components/portal/shopify-connect-panel";
import { ShopifyLinkForm } from "@/components/portal/shopify-link-form";
import { Badge } from "@/components/ui/badge";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.connections };
}

/**
 * Connections: one card per store, its Google Ads and Shopify link status,
 * and the Shopify credentials flow (validate → encrypt → mask). The Google
 * Ads OAuth connect lives on the account card in Google Ads accounts; here it
 * is status only, so this page stays about wiring stores to data sources.
 */
export default async function ConnectionsPage() {
  const [accounts, { d }] = await Promise.all([fetchAccounts(), getServerDictionary()]);

  // A store maps to ONE ad account; the link form offers only the accounts
  // still free. Connected ones are managed on their own cards below.
  const unlinked = accounts.filter((account) => !account.shopify_connected);
  const linked = accounts.filter((account) => account.shopify_connected);

  return (
    <PageContainer title={d.portal.connections} description={d.portal.connectionsSubtitle}>
      {accounts.length === 0 ? (
        <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
          {d.portal.noAdsAccounts}
        </div>
      ) : (
        <div className="max-w-[720px] space-y-4">
          {unlinked.length > 0 && <ShopifyLinkForm accounts={unlinked} />}

          {linked.map((account) => (
            <section key={account.id} className="panel space-y-4 p-5">
              <header className="flex flex-wrap items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-[10px] bg-[var(--accent-gold-dim)]">
                  <Store className="size-4 text-[var(--accent-gold)]" />
                </div>
                <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--text-primary)]">
                  {account.store_name}
                </h2>
                <div className="flex items-center gap-1.5">
                  <Badge variant={account.google_ads_connected ? "success" : "neutral"}>
                    {account.google_ads_connected ? (
                      <CircleCheck className="size-3" aria-hidden />
                    ) : (
                      <CircleDashed className="size-3" aria-hidden />
                    )}
                    Google Ads
                  </Badge>
                  <Badge variant="success">
                    <CircleCheck className="size-3" aria-hidden />
                    Shopify
                  </Badge>
                </div>
              </header>

              <ShopifyConnectPanel account={account} />
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
