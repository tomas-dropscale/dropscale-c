import type { Metadata } from "next";
import { fetchAccounts } from "@/lib/portal/data";
import { AdAccountSettingsCard } from "@/components/portal/ad-account-settings-card";

export const metadata: Metadata = { title: "Google Ads Accounts" };

export default async function AccountsSettingsPage() {
  const accounts = await fetchAccounts();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight text-[var(--text-primary)]">
          Google Ads Accounts
        </h1>
        <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
          Per-store targets and Shopify connections.
        </p>
      </div>

      {accounts.length === 0 ? (
        <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
          No accounts linked yet. Add one from the dashboard sidebar.
        </div>
      ) : (
        <div className="max-w-[720px] space-y-4">
          {accounts.map((account) => (
            <AdAccountSettingsCard key={account.id} account={account} />
          ))}
        </div>
      )}
    </div>
  );
}
