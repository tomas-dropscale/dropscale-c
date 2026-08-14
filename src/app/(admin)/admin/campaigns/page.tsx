import type { Metadata } from "next";
import { ChevronRight, ShieldAlert, Truck, Unplug } from "lucide-react";

import { CampaignsView } from "@/components/admin/campaigns-view";
import { ClientDashboardDialog } from "@/components/admin/client-dashboard-dialog";
import { CommissionRate } from "@/components/admin/commission-rate";
import { StoreName } from "@/components/admin/store-name";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PageContainer } from "@/components/ui/page-container";
import { RangePicker } from "@/components/portal/range-picker";
import { listCampaignActionViewState } from "@/lib/admin/campaign-actions";
import { fetchAdminCampaigns } from "@/lib/admin/campaigns";
import {
  campaignActionBindingIds,
  projectAdminCampaignsView,
} from "@/lib/admin/campaigns-view";
import { multiplier } from "@/lib/format";
import { money } from "@/lib/format-intl";
import { intlLocale } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";
import { parseRange } from "@/lib/portal/range";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.placeholder.campaigns.title };
}

/** Every external client's live Google Ads book and its audited controls. */
export default async function AdminCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const range = parseRange(await searchParams);
  const overviewPromise = fetchAdminCampaigns(range);
  const dictionaryPromise = getServerDictionary();
  const overview = await overviewPromise;
  const [{ d, locale }, actionState] = await Promise.all([
    dictionaryPromise,
    listCampaignActionViewState(campaignActionBindingIds(overview)),
  ]);
  const campaignView = projectAdminCampaignsView(overview, actionState);
  const intl = intlLocale(locale);

  return (
    <PageContainer
      title={d.placeholder.campaigns.title}
      description={`All client campaigns and agency commissions · ${range.from} → ${range.to}`}
      actions={<RangePicker current={range} />}
    >
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          {
            label: "Revenue",
            value:
              overview.totals.revenue === null
                ? "—"
                : money(overview.totals.revenue, intl),
            hint: "all stores · excludes Meta referrals",
            negative: false,
          },
          {
            label: "Client profit",
            value:
              overview.totals.profit === null ? "—" : money(overview.totals.profit, intl),
            hint: "after COGS, shipping and ad spend · before our fee",
            negative: overview.totals.profit !== null && overview.totals.profit < 0,
          },
          {
            label: "Average ROAS",
            value: multiplier(overview.totals.roas),
            hint: `${money(overview.totals.revenue ?? 0, intl)} ÷ ${money(overview.totals.rollupSpend, intl)}`,
            negative: false,
          },
        ].map((item) => (
          <div
            key={item.label}
            className={
              item.negative
                ? "panel border-[var(--danger-red)]/40 p-4"
                : "panel border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] p-4"
            }
          >
            <p className="label-caps">{item.label}</p>
            <p
              className={
                item.negative
                  ? "metric-value mt-1 !text-[24px] !text-[var(--danger-red)]"
                  : "metric-value mt-1 !text-[24px] !text-[var(--accent-gold-strong)]"
              }
            >
              {item.value}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{item.hint}</p>
          </div>
        ))}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "Ad spend", value: money(overview.totals.spend, intl) },
          { label: "Agency commission", value: money(overview.totals.commission, intl) },
          { label: "Active campaigns", value: String(overview.totals.activeCampaigns) },
          { label: "Connected accounts", value: String(overview.totals.connectedAccounts) },
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

      <CampaignsView
        clients={campaignView.clients}
        history={campaignView.history}
        historyTruncated={campaignView.historyTruncated}
      />

      {overview.clients.length > 0 && (
        <section className="panel mt-6 overflow-hidden" aria-labelledby="campaign-client-controls">
          <header className="border-b border-[var(--border-subtle)] px-4 py-4 md:px-5">
            <h2
              id="campaign-client-controls"
              className="text-[15px] font-semibold text-[var(--text-primary)]"
            >
              Client controls
            </h2>
            <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
              Commercial terms, store names and full client reports.
            </p>
          </header>

          {overview.clients.map((client) => {
            const rates = [
              ...new Set(client.accounts.map((entry) => Number(entry.account.commission_rate))),
            ];
            const revShare = client.accounts.some(
              (entry) => entry.account.revenue_share_enabled,
            );

            return (
              <details
                key={client.clientId}
                className="group/client-controls border-t border-[var(--border-subtle)] first:border-t-0"
              >
                <summary className="transition-smooth flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3.5 hover:bg-[var(--bg-panel-hover)] md:px-5 [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    className="size-4 shrink-0 text-[var(--text-muted)] transition-transform group-open/client-controls:rotate-90"
                    aria-hidden
                  />
                  <Avatar name={client.clientName} seed={client.clientId} size="sm" />
                  <span className="min-w-48 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                      {client.clientName}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-[var(--text-muted)]">
                      {client.clientEmail}
                    </span>
                  </span>
                  {client.inHst && (
                    <Badge variant="gold" title="HST já paga comissão deste cliente">
                      <Truck className="size-3" aria-hidden />
                      HST
                    </Badge>
                  )}
                  <Badge variant="neutral">
                    {rates.length === 1 ? `${rates[0]}% ad spend` : "mixed ad spend %"}
                  </Badge>
                  {revShare && <Badge variant="success">+ rev share</Badge>}
                  <span className="text-right">
                    <span className="block text-[13px] font-semibold text-[var(--text-primary)]">
                      {money(client.spend, intl)}
                    </span>
                    <span className="block text-[11px] text-[var(--accent-gold)]">
                      {money(client.commission, intl)} commission
                    </span>
                  </span>
                  <ClientDashboardDialog
                    clientId={client.clientId}
                    clientName={client.clientName}
                    clientEmail={client.clientEmail}
                    range={range}
                  />
                </summary>

                {client.accounts.map((entry) => (
                  <div
                    key={entry.account.id}
                    className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 md:px-5"
                  >
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: entry.account.color_dot }}
                        aria-hidden
                      />
                      <p className="min-w-48 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {entry.account.store_name}
                      </p>
                      {entry.authRevoked ? (
                        <Badge variant="danger">
                          <Unplug className="size-3" aria-hidden />
                          Reconnect needed
                        </Badge>
                      ) : (
                        !entry.connected && (
                          <Badge variant="warning">
                            <Unplug className="size-3" aria-hidden />
                            Not connected
                          </Badge>
                        )
                      )}
                      {entry.failed && !entry.authRevoked && (
                        <Badge variant="danger">Query failed</Badge>
                      )}
                      <span className="text-[12px] text-[var(--text-secondary)]">
                        {money(entry.spend, intl, entry.account.currency)} spend
                      </span>
                      <span className="text-[12px] text-[var(--accent-gold)]">
                        {money(entry.commission, intl, entry.account.currency)} commission
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-4">
                      <CommissionRate
                        rate={Number(entry.account.commission_rate)}
                        listRate={Number(entry.account.list_commission_rate)}
                        revenueShareEnabled={entry.account.revenue_share_enabled}
                      />
                      <StoreName accountId={entry.account.id} name={entry.account.store_name} />
                    </div>
                  </div>
                ))}
              </details>
            );
          })}
        </section>
      )}

      {overview.internal.length > 0 && (
        <section className="mt-8 space-y-3 opacity-70">
          <div className="flex items-center gap-2.5 rounded-[var(--radius-card)] border border-dashed border-[var(--border-strong)] bg-[var(--bg-base)] px-4 py-3">
            <ShieldAlert className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              Admin accounts — their stores and campaigns aren’t shown here, and their spend
              never counts towards agency totals.
            </p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {overview.internal.map((client) => (
              <li
                key={client.clientId}
                className="flex items-center gap-2 rounded-full border border-dashed border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-1.5 text-[12.5px] text-[var(--text-muted)]"
              >
                {client.clientName}
                <Badge variant="neutral">Admin</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
