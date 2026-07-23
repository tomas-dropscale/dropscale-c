import type { Metadata } from "next";
import { Unplug } from "lucide-react";

import { PageContainer } from "@/components/ui/page-container";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CommissionRate } from "@/components/admin/commission-rate";
import { RangePicker } from "@/components/portal/range-picker";
import { fetchAdminCampaigns } from "@/lib/admin/campaigns";
import { parseRange } from "@/lib/portal/range";
import { money, percent } from "@/lib/format-intl";
import { getServerDictionary } from "@/lib/i18n/server";
import { intlLocale } from "@/lib/i18n";
import type { CampaignStatus } from "@/lib/supabase/types";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.placeholder.campaigns.title };
}

const STATUS_BADGE: Record<CampaignStatus, { label: string; variant: "success" | "neutral" }> = {
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "neutral" },
  ended: { label: "Ended", variant: "neutral" },
};

/**
 * Admin zone: every client's live Google Ads campaigns, grouped by client,
 * with the agency commission (spend × per-account rate) computed alongside.
 * English-only for now, same as the clients manager.
 */
export default async function AdminCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const range = parseRange(await searchParams);
  const [overview, { d, locale }] = await Promise.all([
    fetchAdminCampaigns(range),
    getServerDictionary(),
  ]);
  const intl = intlLocale(locale);

  return (
    <PageContainer
      title={d.placeholder.campaigns.title}
      description={`All client campaigns and agency commissions · ${range.from} → ${range.to}`}
      actions={<RangePicker current={range} />}
    >
      {/* Totals strip */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "Ad spend", value: money(overview.totals.spend, intl) },
          { label: "Agency commission", value: money(overview.totals.commission, intl) },
          { label: "Active campaigns", value: String(overview.totals.activeCampaigns) },
          {
            label: "Connected accounts",
            value: String(overview.totals.connectedAccounts),
          },
        ].map((item) => (
          <div key={item.label} className="panel p-4">
            <p className="label-caps">{item.label}</p>
            <p className="metric-value mt-1 !text-[24px]">{item.value}</p>
          </div>
        ))}
      </div>

      {!overview.configured && (
        <div className="panel mb-6 px-5 py-4 text-[13px] text-[var(--text-secondary)]">
          Google Ads isn&apos;t configured, so no live campaigns can be shown yet.
        </div>
      )}

      {overview.clients.length === 0 ? (
        <div className="panel px-6 py-14 text-center text-[13px] text-[var(--text-secondary)]">
          No client ad accounts yet.
        </div>
      ) : (
        <div className="space-y-6">
          {overview.clients.map((client) => (
            <section key={client.clientId} className="panel overflow-hidden">
              {/* Client header */}
              <header className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
                <Avatar name={client.clientName} seed={client.clientId} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                    {client.clientName}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">
                    {client.clientEmail}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                    {money(client.spend, intl)}
                  </p>
                  <p className="text-[11.5px] text-[var(--accent-gold)]">
                    {money(client.commission, intl)} commission
                  </p>
                </div>
              </header>

              {/* Accounts */}
              {client.accounts.map((entry) => (
                <div
                  key={entry.account.id}
                  className="border-b border-[var(--border-subtle)] last:border-b-0"
                >
                  <div className="flex flex-wrap items-center gap-2.5 px-5 pt-4 pb-2">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: entry.account.color_dot }}
                      aria-hidden
                    />
                    <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                      {entry.account.store_name}
                    </p>
                    <CommissionRate
                      accountId={entry.account.id}
                      rate={Number(entry.account.commission_rate)}
                    />
                    {!entry.connected && (
                      <Badge variant="warning">
                        <Unplug className="size-3" aria-hidden />
                        Not connected
                      </Badge>
                    )}
                    {entry.failed && <Badge variant="danger">Query failed</Badge>}
                  </div>

                  {entry.campaigns.length > 0 && (
                    <div className="overflow-x-auto px-5 pb-4">
                      <table className="w-full min-w-[640px] text-[12.5px]">
                        <thead>
                          <tr className="label-caps text-left">
                            <th className="py-2 pr-4 font-medium">Campaign</th>
                            <th className="py-2 pr-4 font-medium">Status</th>
                            <th className="py-2 pr-4 text-right font-medium">Spend</th>
                            <th className="py-2 pr-4 text-right font-medium">Clicks</th>
                            <th className="py-2 pr-4 text-right font-medium">CTR</th>
                            <th className="py-2 text-right font-medium">Commission</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entry.campaigns.map((campaign) => (
                            <tr
                              key={campaign.id}
                              className="border-t border-[var(--border-subtle)]"
                            >
                              <td className="max-w-[280px] truncate py-2.5 pr-4 text-[var(--text-primary)]">
                                {campaign.name}
                              </td>
                              <td className="py-2.5 pr-4">
                                <Badge variant={STATUS_BADGE[campaign.status].variant}>
                                  {STATUS_BADGE[campaign.status].label}
                                </Badge>
                              </td>
                              <td className="py-2.5 pr-4 text-right text-[var(--text-secondary)]">
                                {money(campaign.spend, intl, entry.account.currency)}
                              </td>
                              <td className="py-2.5 pr-4 text-right text-[var(--text-secondary)]">
                                {campaign.clicks.toLocaleString(intl)}
                              </td>
                              <td className="py-2.5 pr-4 text-right text-[var(--text-secondary)]">
                                {percent(campaign.ctr, intl)}
                              </td>
                              <td className="py-2.5 text-right text-[var(--accent-gold)]">
                                {money(
                                  (campaign.spend * Number(entry.account.commission_rate)) / 100,
                                  intl,
                                  entry.account.currency,
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {entry.connected && !entry.failed && entry.campaigns.length === 0 && (
                    <p className="px-5 pb-4 text-[12px] text-[var(--text-muted)]">
                      No campaigns with activity in this period.
                    </p>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
