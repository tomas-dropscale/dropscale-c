import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { getSessionClient } from "@/lib/supabase/server";
import { AdAccountSettingsCard } from "@/components/portal/ad-account-settings-card";
import { AddAccountButton } from "@/components/portal/add-account-button";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.adsAccounts };
}

export default async function AccountsSettingsPage() {
  const [accounts, { client }, { d }] = await Promise.all([
    fetchAccounts(),
    getSessionClient(),
    getServerDictionary(),
  ]);

  return (
    <PageContainer
      title={d.portal.adsAccounts}
      description={d.portal.adsAccountsSubtitle}
      // The settings zone has no main sidebar, so the way to add an account has
      // to be on the page itself — this is where the onboarding guide's first
      // step lands, and it used to land on a dead end.
      actions={client ? <AddAccountButton clientId={client.id} /> : undefined}
    >
      {accounts.length === 0 ? (
        <div className="panel flex flex-col items-center gap-4 px-6 py-14 text-center">
          <p className="text-[13px] text-[var(--text-secondary)]">{d.portal.noAdsAccounts}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {client && <AddAccountButton clientId={client.id} />}
            <Link
              href="/dashboard/request-account"
              className="transition-smooth inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent-gold-strong)]"
            >
              {d.portal.requestAccount}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </div>
      ) : (
        <div className="max-w-[720px] space-y-4">
          {accounts.map((account) => (
            <AdAccountSettingsCard key={account.id} account={account} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
