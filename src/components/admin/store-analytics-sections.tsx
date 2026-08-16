"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  Image as ImageIcon,
  MousePointerClick,
  Users,
} from "lucide-react";

import {
  FunnelDevelopmentChart,
  SpendDevelopmentChart,
  type FunnelChartPoint,
} from "@/components/admin/performance-charts";
import { Badge } from "@/components/ui/badge";
import type {
  AdminAnalyticsFamily,
  AdminStoreAnalytics,
} from "@/lib/admin/store-analytics";
import { integer, money, multiplier } from "@/lib/format";
import { cn } from "@/lib/utils";

function percent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function familyMessage<T>(family: AdminAnalyticsFamily<T>): string | null {
  return "message" in family ? family.message ?? null : null;
}

function seriesBucket(point: { day?: string; bucket?: string }) {
  return point.bucket ?? point.day ?? "";
}

function safeHttpsImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function CreativeThumbnail({ src }: { src: string | null | undefined }) {
  const safeSrc = safeHttpsImageUrl(src);
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showImage = safeSrc !== null && failedSrc !== safeSrc;

  return (
    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- exact provider asset URLs have unknown Google CDN hosts
        <img
          src={safeSrc}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(safeSrc)}
          className="size-full object-cover"
        />
      ) : (
        <ImageIcon className="size-4 text-[var(--text-muted)]" aria-hidden />
      )}
    </div>
  );
}

function MiniSparkline({
  values,
  label,
}: {
  values: Array<number | null | undefined>;
  label: string;
}) {
  const width = 88;
  const height = 24;
  const padding = 2;
  const finite = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (finite.length === 0) {
    return <span aria-label={`${label}: unavailable`}>—</span>;
  }

  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  const range = maximum - minimum;
  const point = (value: number, index: number) => ({
    x: values.length === 1
      ? width / 2
      : padding + (index / (values.length - 1)) * (width - padding * 2),
    y: range === 0
      ? height / 2
      : padding + ((maximum - value) / range) * (height - padding * 2),
  });
  const segments: Array<Array<{ x: number; y: number }>> = [];
  values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    if (index === 0 || typeof values[index - 1] !== "number" || !Number.isFinite(values[index - 1])) {
      segments.push([]);
    }
    segments.at(-1)?.push(point(value, index));
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-6 w-[88px] overflow-visible text-[var(--accent-gold)]"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {segments.map((segment, index) => segment.length === 1 ? (
        <circle
          key={index}
          cx={segment[0].x}
          cy={segment[0].y}
          r="1.75"
          fill="currentColor"
        />
      ) : (
        <polyline
          key={index}
          points={segment.map(({ x, y }) => `${x},${y}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function campaignTypeLabel(
  campaign: { type: string | null; shoppingFeed: boolean },
): string {
  if (campaign.type === "DEMAND_GEN") return "DGEN";
  if (campaign.type === "PERFORMANCE_MAX") {
    return campaign.shoppingFeed ? "PMAX (SF)" : "PMAX";
  }
  return campaign.type?.replaceAll("_", " ") || "—";
}

function FamilyNotice({
  state,
  message,
  empty,
}: {
  state: AdminAnalyticsFamily<unknown>["state"];
  message: string | null;
  empty: string;
}) {
  if (state === "ready" && !message) return null;
  const unavailable = state === "unavailable" || state === "failed";
  const degraded = unavailable || Boolean(message?.toLowerCase().includes("last refresh failed"));
  return (
    <div
      role={degraded ? "alert" : "status"}
      className={cn(
        "flex min-h-20 items-center justify-center gap-2 px-5 py-5 text-center text-sm text-[var(--text-muted)]",
        degraded && "text-[var(--warning-orange)]",
      )}
    >
      {degraded && <AlertTriangle className="size-4 shrink-0" aria-hidden />}
      <span>{message || empty}</span>
    </div>
  );
}

function ShopifyFunnel({
  funnel,
}: {
  funnel: AdminStoreAnalytics["funnel"];
}) {
  if (!("data" in funnel)) {
    return (
      <section className="panel overflow-hidden" aria-labelledby="shopify-funnel-title">
        <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
          <h2 id="shopify-funnel-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
            Shopify Funnel
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
            Store behaviour across the selected period.
          </p>
        </header>
        <FamilyNotice
          state={funnel.state}
          message={familyMessage(funnel)}
          empty="No Shopify funnel events were returned for this period."
        />
      </section>
    );
  }

  const totals = funnel.data.totals;
  const steps = [
    { label: "Sessions", value: totals.sessions, icon: Users },
    { label: "Add to cart", value: totals.addedToCart, icon: MousePointerClick },
    { label: "Checkout", value: totals.reachedCheckout, icon: CreditCard },
    { label: "Conversions", value: totals.completedCheckout, icon: CheckCircle2 },
  ];

  return (
    <section className="panel p-4" aria-labelledby="shopify-funnel-title">
      <header className="mb-3">
        <h2 id="shopify-funnel-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
          Shopify Funnel
        </h2>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Store behaviour across the selected period.
        </p>
      </header>

      {funnel.state === "ready" && familyMessage(funnel) && (
        <FamilyNotice
          state="ready"
          message={familyMessage(funnel)}
          empty="No Shopify funnel events were returned for this period."
        />
      )}

      {funnel.state === "empty" ? (
        <FamilyNotice
          state="empty"
          message={familyMessage(funnel)}
          empty="No Shopify funnel events were returned for this period."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {steps.map((step, index) => {
            const fromSessions = totals.sessions > 0 ? step.value / totals.sessions : null;
            const Icon = step.icon;
            return (
              <div
                key={step.label}
                className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="label-caps">{step.label}</p>
                  <Icon className="size-3.5 text-[var(--accent-gold)]" aria-hidden />
                </div>
                <p className="mt-1.5 text-[20px] font-semibold tabular-nums text-[var(--text-primary)]">
                  {index === 0 ? integer(step.value) : percent(fromSessions, index === 3 ? 2 : 1)}
                </p>
                <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                  <span
                    className="block h-full rounded-full bg-[var(--accent-gold)]"
                    style={{ width: `${Math.max(0, Math.min(100, (fromSessions ?? 0) * 100))}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
                  {index === 0 ? "100% of visits" : `${integer(step.value)} events`}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function StoreFunnelSections({
  analytics,
}: {
  analytics: AdminStoreAnalytics;
}) {
  const funnel = analytics.funnel;
  const daily = "data" in funnel ? funnel.data.daily : [];
  const points: FunnelChartPoint[] =
    "data" in funnel
      ? daily.map((row) => ({
          date: seriesBucket(row),
          sessions: row.sessions,
          addToCarts: row.addedToCart,
          checkouts: row.reachedCheckout,
          conversions: row.completedCheckout,
        }))
      : [];

  return (
    <>
      {"data" in funnel && funnel.state !== "empty" ? (
        <>
          <FunnelDevelopmentChart
            points={points}
            granularity={funnel.data.granularity ?? "day"}
          />
          {funnel.state === "partial" && (
            <div role="status" className="panel flex items-center gap-2 px-4 py-3 text-xs text-[var(--warning-orange)]">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              {familyMessage(funnel)}
            </div>
          )}
        </>
      ) : (
        <section className="panel overflow-hidden" aria-labelledby="funnel-development-title">
          <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
            <h2 id="funnel-development-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
              Funnel Development
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              Traffic and conversion development · per day
            </p>
          </header>
          <FamilyNotice
            state={funnel.state}
            message={familyMessage(funnel)}
            empty="No Shopify sessions were returned for this period."
          />
        </section>
      )}
      <ShopifyFunnel funnel={funnel} />
    </>
  );
}

export function StoreSpendSection({
  spend,
  currency,
}: {
  spend: AdminStoreAnalytics["spend"];
  currency: string;
}) {
  if ("data" in spend && spend.state !== "empty") {
    const daily = spend.data.daily;
    return (
      <>
        <SpendDevelopmentChart
          points={daily.map((row) => ({
            date: seriesBucket(row),
            googleSpend: row.spend,
          }))}
          currency={currency}
          granularity={spend.data.granularity ?? "day"}
        />
        {spend.state === "partial" && (
          <div role="status" className="panel flex items-center gap-2 px-4 py-3 text-xs text-[var(--warning-orange)]">
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            {familyMessage(spend)}
          </div>
        )}
      </>
    );
  }

  return (
    <section className="panel overflow-hidden" aria-labelledby="google-spend-title">
      <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
        <h2 id="google-spend-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
          Google Spend Development
        </h2>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Verified daily spend across the exact selected period.
        </p>
      </header>
      <FamilyNotice
        state={spend.state}
        message={familyMessage(spend)}
        empty="No Google spend was returned for this period."
      />
    </section>
  );
}

export function CampaignPerformanceSection({
  campaigns,
  currency,
}: {
  campaigns: AdminStoreAnalytics["campaigns"];
  currency: string;
}) {
  const [openCampaigns, setOpenCampaigns] = React.useState<Set<string>>(new Set());
  const hasData = "data" in campaigns;
  const rows = hasData ? campaigns.data.rows : [];

  function toggleCampaign(key: string) {
    setOpenCampaigns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <section className="panel overflow-hidden" aria-labelledby="campaign-performance-title">
      <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
        <h2 id="campaign-performance-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
          Campaign Performance
        </h2>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Google delivery and Shopify last-non-direct-click UTM attribution for the selected period.
        </p>
      </header>

      {!hasData ? (
        <FamilyNotice
          state={campaigns.state}
          message={familyMessage(campaigns)}
          empty="No campaigns were returned for this period."
        />
      ) : rows.length === 0 ? (
        <FamilyNotice
          state="empty"
          message={familyMessage(campaigns)}
          empty="No campaigns were returned for this period."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1370px] text-[11.5px]">
            <thead>
              <tr className="label-caps border-b border-[var(--border-subtle)] text-left">
                <th className="px-5 py-2.5 font-medium">Campaign / asset</th>
                <th className="px-2.5 py-2.5 text-center font-medium">Type</th>
                <th className="px-2.5 py-2.5 text-center font-medium">Status</th>
                <th className="px-2.5 py-2.5 text-center font-medium">Spend</th>
                <th className="px-2.5 py-2.5 text-center font-medium">CPC</th>
                <th className="px-2.5 py-2.5 text-center font-medium">CTR</th>
                <th className="px-2.5 py-2.5 text-center font-medium">CPM</th>
                <th className="px-2.5 py-2.5 text-center font-medium">CPA</th>
                <th className="px-2.5 py-2.5 text-center font-medium">Conv.</th>
                <th className="px-2.5 py-2.5 text-center font-medium">Google ROAS</th>
                <th className="px-2.5 py-2.5 text-center font-medium">REV.</th>
                <th className="px-2.5 py-2.5 text-center font-medium">Real ROAS</th>
                <th className="px-5 py-2.5 text-center font-medium">Evolution</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((campaign) => {
                const key = `${campaign.accountId}:${campaign.campaignId}`;
                const open = openCampaigns.has(key);
                const breakdownWarnings = campaign.breakdown.sources
                  .filter((source) => source.state === "failed" || source.state === "unavailable")
                  .map((source) => source.reason)
                  .filter((reason): reason is string => Boolean(reason));
                const hasRealRoasTimeline = campaign.timeline.some(
                  (point) => point.realRoas !== null && Number.isFinite(point.realRoas),
                );
                const hasGoogleRoasTimeline = campaign.timeline.some(
                  (point) => point.googleRoas !== null && Number.isFinite(point.googleRoas),
                );
                const evolutionSource = hasRealRoasTimeline
                  ? "Real"
                  : hasGoogleRoasTimeline
                    ? "Google"
                    : null;
                return (
                  <React.Fragment key={key}>
                    <tr className="transition-smooth border-t border-[var(--border-subtle)] first:border-t-0 hover:bg-[var(--bg-panel-hover)]">
                      <td className="max-w-[300px] px-5 py-2.5">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => toggleCampaign(key)}
                          className="flex min-h-8 max-w-full items-center gap-2 text-left outline-none focus-visible:text-[var(--accent-gold-strong)]"
                        >
                          <ChevronRight
                            className={cn(
                              "transition-smooth size-3.5 shrink-0 text-[var(--text-muted)]",
                              open && "rotate-90",
                            )}
                            aria-hidden
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-[var(--text-primary)]">
                              {campaign.name}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
                              {campaign.attributionState === "matched"
                                ? `${campaign.shopifySessions === null ? "—" : integer(campaign.shopifySessions)} Shopify sessions · ${campaign.shopifyOrders === null ? "—" : integer(campaign.shopifyOrders)} orders`
                                : campaign.attributionState === "unmatched"
                                  ? "No Shopify UTM match for this Google campaign ID"
                                  : "Shopify attribution unavailable"}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="px-2.5 py-3 text-center"><Badge variant={campaign.type === "DEMAND_GEN" ? "gold" : "neutral"}>{campaignTypeLabel(campaign)}</Badge></td>
                      <td className="px-2.5 py-3 text-center"><Badge variant={campaign.status === "active" ? "success" : "neutral"}>{campaign.status || "—"}</Badge></td>
                      <td className="px-2.5 py-3 text-center tabular-nums">{money(campaign.spend, currency)}</td>
                      <td className="px-2.5 py-3 text-center tabular-nums">{campaign.cpc === null ? "—" : money(campaign.cpc, currency)}</td>
                      <td className="px-2.5 py-3 text-center tabular-nums">{percent(campaign.ctr)}</td>
                      <td className="px-2.5 py-3 text-center tabular-nums">{campaign.cpm === null ? "—" : money(campaign.cpm, currency)}</td>
                      <td className="px-2.5 py-3 text-center tabular-nums">{campaign.cpa === null ? "—" : money(campaign.cpa, currency)}</td>
                      <td className="px-2.5 py-3 text-center tabular-nums">{campaign.conversions === null ? "—" : integer(campaign.conversions)}</td>
                      <td className="px-2.5 py-3 text-center tabular-nums">{campaign.googleRoas === null ? "—" : multiplier(campaign.googleRoas)}</td>
                      <td className="px-2.5 py-3 text-center tabular-nums">{campaign.shopifyRevenue === null ? "—" : money(campaign.shopifyRevenue, currency)}</td>
                      <td className="px-2.5 py-3 text-center font-medium tabular-nums text-[var(--accent-gold-strong)]">{campaign.realRoas === null ? "—" : multiplier(campaign.realRoas)}</td>
                      <td className="px-5 py-2 text-center">
                        <div className="inline-flex flex-col items-center gap-0.5">
                          <MiniSparkline
                            values={campaign.timeline.map((point) =>
                              hasRealRoasTimeline ? point.realRoas : point.googleRoas)}
                            label={`${evolutionSource ?? "Campaign"} ROAS evolution for ${campaign.name}`}
                          />
                          {evolutionSource ? (
                            <span className="text-[9px] leading-none text-[var(--text-muted)]">
                              {evolutionSource} ROAS
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>

                    {open && campaign.breakdown.rows.map((row) => {
                      const cpc = row.spend !== null && row.clicks && row.clicks > 0
                        ? row.spend / row.clicks
                        : null;
                      const ctr = row.clicks !== null && row.impressions && row.impressions > 0
                        ? row.clicks / row.impressions
                        : null;
                      const cpm = row.spend !== null && row.impressions && row.impressions > 0
                        ? (row.spend / row.impressions) * 1_000
                        : null;
                      const cpa = row.spend !== null && row.conversions && row.conversions > 0
                        ? row.spend / row.conversions
                        : null;
                      const googleRoas = row.spend !== null && row.spend > 0 && row.googleRevenue !== null
                        ? row.googleRevenue / row.spend
                        : null;
                      const realRoas = row.spend !== null && row.spend > 0 && row.shopifyRevenue !== null
                        ? row.shopifyRevenue / row.spend
                        : null;
                      return (
                        <tr key={`${row.provider}:${row.kind}:${row.id}`} className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)] hover:bg-[var(--bg-panel-hover)]">
                          <td className="px-5 py-2.5 pl-12">
                            <div className="flex items-center gap-2.5">
                              {row.kind === "creative" ? (
                                <CreativeThumbnail src={row.thumbnailUrl} />
                              ) : null}
                              <div className="min-w-0">
                                <p className="truncate font-medium text-[var(--text-secondary)]">{row.name}</p>
                                <p className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]">
                                  {row.detail || (row.shopifyUnits === null ? row.provider : `${integer(row.shopifyUnits)} Shopify units`)}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-2.5 py-2.5 text-center"><Badge variant="neutral">{row.kind}</Badge></td>
                          <td className="px-2.5 py-2.5 text-center text-[10px] text-[var(--text-muted)]">{row.provider === "google_ads" ? "Google" : "Shopify"}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums">{row.spend === null ? "—" : money(row.spend, currency)}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums">{cpc === null ? "—" : money(cpc, currency)}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums">{percent(ctr)}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums">{cpm === null ? "—" : money(cpm, currency)}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums">{cpa === null ? "—" : money(cpa, currency)}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums">{row.conversions === null ? "—" : integer(row.conversions)}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums">{googleRoas === null ? "—" : multiplier(googleRoas)}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums">{row.shopifyRevenue === null ? "—" : money(row.shopifyRevenue, currency)}</td>
                          <td className="px-2.5 py-2.5 text-center tabular-nums text-[var(--accent-gold-strong)]">{realRoas === null ? "—" : multiplier(realRoas)}</td>
                          <td className="px-5 py-2.5 text-center text-[var(--text-muted)]">—</td>
                        </tr>
                      );
                    })}

                    {open && campaign.breakdown.rows.length === 0 ? (
                      <tr className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
                        <td colSpan={13} className="px-12 py-3 text-[11px] text-[var(--text-muted)]">
                          {campaign.breakdown.reason ||
                            campaign.breakdown.sources
                              .map((source) => source.reason)
                              .filter(Boolean)
                              .join(" ") ||
                            "No asset or product rows were returned for this period."}
                        </td>
                      </tr>
                    ) : null}

                    {open && campaign.breakdown.rows.length > 0 && breakdownWarnings.length > 0 ? (
                      <tr className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
                        <td colSpan={13} className="px-12 py-2.5 text-[10.5px] text-[var(--warning-orange)]">
                          {breakdownWarnings.join(" ")}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CollectionReturnSection({
  collections,
  currency,
}: {
  collections: AdminStoreAnalytics["collections"];
  currency: string;
}) {
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const hasData = "data" in collections;
  const rows = hasData ? collections.data.rows : [];

  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="panel overflow-hidden" aria-labelledby="collection-return-title">
      <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
        <h2 id="collection-return-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
          Return by Collection
        </h2>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Open a collection to see its Shopify products and selected-period sales.
        </p>
      </header>

      {hasData && familyMessage(collections) ? (
        <div
          role="status"
          className="border-b border-[var(--border-subtle)] px-5 py-2 text-[11px] text-[var(--text-muted)]"
        >
          {familyMessage(collections)}
        </div>
      ) : null}

      {!hasData ? (
        <FamilyNotice
          state={collections.state}
          message={familyMessage(collections)}
          empty="No collection sales were returned for this period."
        />
      ) : rows.length === 0 ? (
        <FamilyNotice
          state="empty"
          message={familyMessage(collections)}
          empty="No collection sales were returned for this period."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[930px] text-[11.5px]">
            <thead>
              <tr className="label-caps border-b border-[var(--border-subtle)] text-left">
                <th className="px-5 py-2.5 font-medium">Collection / product</th>
                <th className="px-3 py-2.5 text-center font-medium">Source</th>
                <th className="px-3 py-2.5 text-center font-medium">Units</th>
                <th className="px-3 py-2.5 text-center font-medium">Ad spend</th>
                <th className="px-3 py-2.5 text-center font-medium">Revenue</th>
                <th className="px-3 py-2.5 text-center font-medium">Real ROAS</th>
                <th className="px-5 py-2.5 text-center font-medium">Evolution</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((collection) => {
                const expanded = open.has(collection.collectionId);
                return (
                  <React.Fragment key={collection.collectionId}>
                    <tr className="transition-smooth border-t border-[var(--border-subtle)] first:border-t-0 hover:bg-[var(--bg-panel-hover)]">
                      <td className="px-5 py-2.5">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => toggle(collection.collectionId)}
                          className="flex min-h-8 max-w-[360px] items-center gap-2 text-left font-medium text-[var(--text-primary)] outline-none focus-visible:text-[var(--accent-gold-strong)]"
                        >
                          <ChevronRight className={cn("transition-smooth size-3.5 shrink-0 text-[var(--text-muted)]", expanded && "rotate-90")} aria-hidden />
                          <span className="truncate">{collection.title}</span>
                        </button>
                      </td>
                      <td className="px-3 py-3 text-center"><Badge variant="neutral">Shopify</Badge></td>
                      <td className="px-3 py-3 text-center tabular-nums">{integer(collection.units)}</td>
                      <td className="px-3 py-3 text-center tabular-nums">{collection.spend === null ? "—" : money(collection.spend, currency)}</td>
                      <td className="px-3 py-3 text-center tabular-nums">{money(collection.revenue, currency)}</td>
                      <td className="px-3 py-3 text-center font-medium tabular-nums text-[var(--accent-gold-strong)]">{collection.roas === null ? "—" : multiplier(collection.roas)}</td>
                      <td className="px-5 py-2 text-center">
                        <MiniSparkline
                          values={collection.timeline.map((point) => point.roas)}
                          label={`Real ROAS evolution for ${collection.title}`}
                        />
                      </td>
                    </tr>
                    {expanded && collection.products.map((product) => (
                      <tr key={product.productId} className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)] hover:bg-[var(--bg-panel-hover)]">
                        <td className="px-5 py-2.5 pl-12 font-medium text-[var(--text-secondary)]">{product.title}</td>
                        <td className="px-3 py-2.5 text-center text-[var(--text-muted)]">Product</td>
                        <td className="px-3 py-2.5 text-center tabular-nums">{integer(product.units)}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums text-[var(--text-muted)]">{product.spend === null || product.spend === undefined ? "—" : money(product.spend, currency)}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums">{money(product.revenue, currency)}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums text-[var(--text-muted)]">{product.roas === null || product.roas === undefined ? "—" : multiplier(product.roas)}</td>
                        <td className="px-5 py-2 text-center">
                          <MiniSparkline
                            values={product.timeline.map((point) => point.roas)}
                            label={`Real ROAS evolution for ${product.title}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
