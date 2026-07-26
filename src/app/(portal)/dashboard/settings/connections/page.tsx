import type { Metadata } from "next";
import { CircleCheck, CircleDashed, Hourglass, Store } from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { ShopifyConnectPanel } from "@/components/portal/shopify-connect-panel";
import { ShopifyLinkForm } from "@/components/portal/shopify-link-form";
import { ShopifySetupSteps } from "@/components/portal/shopify-setup-steps";
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
  //
  // Accounts we haven't approved yet are NOT offered — the connect route
  // rejects them anyway, and an enabled form that fails on submit is worse
  // than one that explains the wait. They're listed separately instead.
  const connectable = accounts.filter(
    (account) => !account.shopify_connected && account.status !== "pending",
  );
  const awaitingApproval = accounts.filter(
    (account) => !account.shopify_connected && account.status === "pending",
  );
  const linked = accounts.filter((account) => account.shopify_connected);

  return (
    <PageContainer title={d.portal.connections} description={d.portal.connectionsSubtitle}>
      {accounts.length === 0 ? (
        <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
          {d.portal.noAdsAccounts}
        </div>
      ) : (
        <div className="max-w-[720px] space-y-4">
          {connectable.length > 0 && <ShopifyLinkForm accounts={connectable} />}

          {awaitingApproval.length > 0 && (
            <section className="panel space-y-3 p-5">
              <header className="flex items-center gap-2.5">
                <Hourglass className="size-4 text-[var(--accent-gold)]" />
                <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                  Waiting for team approval
                </h2>
              </header>
              <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                Shopify can be connected once we’ve accepted the store. You’ll be able to link it
                here the moment that happens.
              </p>
              <ul className="flex flex-col gap-1.5">
                {awaitingApproval.map((account) => (
                  <li
                    key={account.id}
                    className="flex items-center gap-2.5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2.5"
                  >
                    <Store className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
                      {account.store_name}
                    </span>
                    <Badge variant="warning">Pending</Badge>
                  </li>
                ))}
              </ul>

              {/* Waiting is the right time to build the app. Approval gates
                  CONNECTING, not knowing what the app has to be able to read —
                  so the scopes belong here too, or the one client who most
                  needs them is the one who can't see them. */}
              <p className="pt-1 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                Meanwhile, you can already set the app up in Shopify — it’ll be ready to link
                straight away:
              </p>
              <ShopifySetupSteps />
            </section>
          )}

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
