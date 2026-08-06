import type { Metadata } from "next";
import { ChevronRight, ShieldAlert, Truck, Unplug } from "lucide-react";

import { PageContainer } from "@/components/ui/page-container";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CommissionRate } from "@/components/admin/commission-rate";
import { StoreName } from "@/components/admin/store-name";
import { ClientDashboardDialog } from "@/components/admin/client-dashboard-dialog";
import { RangePicker } from "@/components/portal/range-picker";
import { fetchAdminCampaigns } from "@/lib/admin/campaigns";
import { daysRunning, parseRange } from "@/lib/portal/range";
import { collectionHandleFromUrl } from "@/lib/finance/rev-share";
import { money, percent } from "@/lib/format-intl";
import { multiplier } from "@/lib/format";
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
      {/* ---- what the book of business did ----
          Above the operational counters on purpose: revenue, profit and return
          are the questions this page gets opened with, and ad spend only means
          something once you know what it bought. Gold marks them as the
          business line, the same treatment the client report gives revenue.

          Google only, like every revenue figure in the admin zone — so this
          strip and the sum of the individual reports agree. */}
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
            // Our fee is excluded on purpose — it is the clients' trading
            // result, and the commission has its own card below.
            hint: "after COGS, shipping and ad spend · before our fee",
            negative: overview.totals.profit !== null && overview.totals.profit < 0,
          },
          {
            label: "Average ROAS",
            value: multiplier(overview.totals.roas),
            // Named so nobody reads it as the mean of the per-store ratios:
            // it is the portfolio's own return, weighted by spend.
            hint: `${money(overview.totals.revenue ?? 0, intl)} ÷ ${money(overview.totals.rollupSpend, intl)}`,
            negative: false,
          },
        ].map((item) => (
          <div
            key={item.label}
            className={
              // Red wins over gold: a book of business that lost money must not
              // be dressed in the same colour as one that made money.
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
            /* Collapsed by default: a client can run a dozen stores, and an
               always-open list buries the next client. Plain <details>, so the
               page stays a Server Component and works without hydration. */
            <details key={client.clientId} className="panel group/client overflow-hidden">
              <summary className="transition-smooth flex cursor-pointer list-none flex-wrap items-center gap-3 px-5 py-4 hover:bg-[var(--bg-panel-hover)] [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)] transition-transform group-open/client:rotate-90" />
                <Avatar name={client.clientName} seed={client.clientId} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                    {client.clientName}
                  </p>
                  <p className="truncate text-[12px] text-[var(--text-muted)]">
                    {client.clientEmail}
                  </p>
                </div>
                <Badge variant="neutral">
                  {client.accounts.length} {client.accounts.length === 1 ? "store" : "stores"}
                </Badge>

                {/* Already inside HST — i.e. the supplier books commission for
                    this client. Shown only on a real link (CRM record or an
                    exact name match), never on a guess: the whole point is
                    knowing who still has to be added. */}
                {client.inHst && (
                  <Badge variant="gold" title="HST já paga comissão deste cliente">
                    <Truck className="size-3" aria-hidden />
                    HST
                  </Badge>
                )}

                {/* How this client is billed, readable without expanding: the
                    ad-spend fee always, plus rev share when any store has it. */}
                {(() => {
                  const rates = [
                    ...new Set(client.accounts.map((e) => Number(e.account.commission_rate))),
                  ];
                  const revShare = client.accounts.some((e) => e.account.revenue_share_enabled);
                  return (
                    <>
                      <Badge variant="neutral">
                        {rates.length === 1 ? `${rates[0]}% ad spend` : "mixed ad spend %"}
                      </Badge>
                      {revShare && <Badge variant="success">+ rev share</Badge>}
                    </>
                  );
                })()}

                <div className="text-right">
                  <p className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                    {money(client.spend, intl)}
                  </p>
                  <p className="text-[11.5px] text-[var(--accent-gold)]">
                    {money(client.commission, intl)} commission
                  </p>
                </div>

                {/* The one interactive island in this row. It stops its own
                    click so opening the dashboard doesn't also toggle the
                    <details> it sits inside. */}
                <ClientDashboardDialog
                  clientId={client.clientId}
                  clientName={client.clientName}
                  clientEmail={client.clientEmail}
                  range={range}
                />
              </summary>

              {/* Accounts — each one its own drop-down, so ten stores read as
                  ten lines until you ask for one. */}
              {client.accounts.map((entry) => (
                <details
                  key={entry.account.id}
                  className="group/store border-t border-[var(--border-subtle)]"
                >
                  <summary className="transition-smooth flex cursor-pointer list-none flex-wrap items-center gap-2.5 px-5 py-3 hover:bg-[var(--bg-panel-hover)] [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)] transition-transform group-open/store:rotate-90" />
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: entry.account.color_dot }}
                      aria-hidden
                    />
                    <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
                      {entry.account.store_name}
                    </p>
                    {/* Three different states, three different actions: the
                        client must reconnect, nobody has connected yet, or
                        Google is simply misbehaving and it will retry. */}
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
                    {entry.cached && (
                      <Badge variant="neutral">Cached totals</Badge>
                    )}
                    {entry.failed && !entry.authRevoked && !entry.cached && (
                      <Badge variant="danger">Query failed</Badge>
                    )}
                    <span className="text-[12.5px] text-[var(--text-secondary)]">
                      {money(entry.spend, intl, entry.account.currency)}
                    </span>
                    <span className="text-[12.5px] text-[var(--accent-gold)]">
                      {money(entry.commission, intl, entry.account.currency)}
                    </span>
                  </summary>

                  {/* These controls live here, not in the summary: a click on
                      one inside <summary> would toggle the panel shut. */}
                  <div className="flex flex-wrap items-start gap-2 px-5 pt-1 pb-2">
                    <CommissionRate
                      rate={Number(entry.account.commission_rate)}
                      listRate={Number(entry.account.list_commission_rate)}
                      revenueShareEnabled={entry.account.revenue_share_enabled}
                      revenueShareRate={Number(entry.account.revenue_share_rate)}
                    />
                    <StoreName
                      accountId={entry.account.id}
                      name={entry.account.store_name}
                    />
                  </div>

                  {entry.campaigns.length > 0 && (
                    <div className="overflow-x-auto px-5 pb-4">
                      <table className="w-full min-w-[640px] text-[12.5px]">
                        <thead>
                          <tr className="label-caps text-left">
                            <th className="py-2 pr-4 font-medium">Campaign</th>
                            <th className="py-2 pr-4 font-medium">Status</th>
                            <th className="py-2 pr-4 text-right font-medium">Running</th>
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
                              <td className="max-w-[280px] py-2.5 pr-4 text-[var(--text-primary)]">
                                <span className="block truncate">{campaign.name}</span>
                                {/* The collection this campaign advertises, read
                                    out of its own name — the same parse that
                                    attributes revenue share. Shown because "how
                                    long has this been running" is a question
                                    about the collection, not about the string. */}
                                {collectionHandleFromUrl(campaign.name) && (
                                  <span className="block truncate text-[11px] text-[var(--accent-gold)]">
                                    /collections/{collectionHandleFromUrl(campaign.name)}
                                  </span>
                                )}
                              </td>
                              <td className="py-2.5 pr-4">
                                <Badge variant={STATUS_BADGE[campaign.status].variant}>
                                  {STATUS_BADGE[campaign.status].label}
                                </Badge>
                              </td>
                              <td className="py-2.5 pr-4 text-right whitespace-nowrap text-[var(--text-secondary)]">
                                {(() => {
                                  const days = daysRunning(campaign.startDate, range.to);
                                  // An em dash, never "0 days": Google not
                                  // reporting a start date is not the same as a
                                  // campaign that started today.
                                  if (days === null) return "—";
                                  return (
                                    <>
                                      {days}
                                      <span className="text-[var(--text-muted)]">
                                        {days === 1 ? " day" : " days"}
                                      </span>
                                    </>
                                  );
                                })()}
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
                </details>
              ))}
            </details>
          ))}
        </div>
      )}

      {/* Internal accounts, last and deliberately colourless. Names only — an
          admin's stores are not part of the agency's book of business, and
          listing them here invites reading them as one. */}
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
