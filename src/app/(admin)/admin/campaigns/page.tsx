import type { Metadata } from "next";
import { AlertTriangle, ShieldAlert } from "lucide-react";

import { CampaignsView } from "@/components/admin/campaigns-view";
import { CampaignsToolbar } from "@/components/admin/campaigns-toolbar";
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
import { parseRange, presetSelection } from "@/lib/portal/range";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.placeholder.campaigns.title };
}

/** Every external client's live Google Ads book and its audited controls. */
export default async function AdminCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string | string[];
    from?: string | string[];
    to?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const range =
    params.range === undefined && params.from === undefined && params.to === undefined
      ? presetSelection("d7")
      : parseRange(params);
  const overviewPromise = fetchAdminCampaigns(range, { campaignSource: "snapshot" });
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
      description={`Portfolio performance and active campaign controls · ${range.from} → ${range.to}`}
      actions={
        <>
          <CampaignsToolbar range={range} />
          <RangePicker current={range} />
        </>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[
          {
            label: "Revenue",
            value:
              overview.totals.revenue === null || overview.totals.currency === null
                ? "—"
                : money(overview.totals.revenue, intl, overview.totals.currency),
            hint: "Non-Meta Shopify revenue in the reporting rollup",
          },
          {
            label: "Real ROAS",
            value:
              overview.totals.roas === null ? "—" : multiplier(overview.totals.roas),
            hint: "Non-Meta Shopify revenue ÷ rollup ad spend",
          },
        ].map((item) => (
          <div
            key={item.label}
            className="panel min-w-0 border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] p-4"
          >
            <p className="label-caps">{item.label}</p>
            <p className="metric-value mt-1 truncate !text-[24px] !text-[var(--accent-gold-strong)]">
              {item.value}
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {item.hint}
            </p>
          </div>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          {
            label: "Ad spend",
            value:
              overview.totals.spend === null || overview.totals.currency === null
                ? "—"
                : money(overview.totals.spend, intl, overview.totals.currency),
            hint: "Across mapped ad accounts",
          },
          {
            label: "Agency commission",
            value:
              overview.totals.commission === null || overview.totals.currency === null
                ? "—"
                : money(overview.totals.commission, intl, overview.totals.currency),
            hint: "Based on each store rate",
          },
          {
            label: "Active campaigns",
            value:
              overview.totals.activeCampaigns === null
                ? "—"
                : String(overview.totals.activeCampaigns),
            hint:
              overview.totals.activeCampaigns === null
                ? "Not synced for this exact period"
                : "Enabled in Google Ads",
          },
          {
            label: "Connected accounts",
            value: String(overview.totals.connectedAccounts),
            hint: "Available reporting accounts",
          },
        ].map((item) => (
          <div key={item.label} className="panel min-w-0 p-4">
            <p className="label-caps">{item.label}</p>
            <p className="metric-value mt-1 truncate !text-[24px]">{item.value}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {item.hint}
            </p>
          </div>
        ))}
      </div>

      {!overview.configured && (
        <div className="panel mb-4 px-5 py-4 text-[13px] text-[var(--text-secondary)]">
          Google Ads isn&apos;t configured, so no live campaigns can be shown yet.
        </div>
      )}

      {overview.totals.currencies.length > 1 && (
        <div className="panel mb-4 flex items-center gap-2 border-[var(--warning-orange)]/25 px-5 py-3 text-[12.5px] text-[var(--warning-orange)]">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          {`Portfolio totals are unavailable because reporting currencies are mixed (${overview.totals.currencies.join(", ")}).`}
        </div>
      )}

      <CampaignsView
        clients={campaignView.clients}
        history={campaignView.history}
        historyTruncated={campaignView.historyTruncated}
        range={range}
      />

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
