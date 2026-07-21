import type { Metadata } from "next";
import { fetchAccounts } from "@/lib/portal/data";
import { AdAccountSettingsCard } from "@/components/portal/ad-account-settings-card";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.adsAccounts };
}

export default async function AccountsSettingsPage() {
  const [accounts, { d }] = await Promise.all([fetchAccounts(), getServerDictionary()]);

  return (
    <PageContainer title={d.portal.adsAccounts} description={d.portal.adsAccountsSubtitle}>
      {accounts.length === 0 ? (
        <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
          {d.portal.noAdsAccounts}
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
