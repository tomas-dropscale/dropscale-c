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
  RoasEvolutionHover,
  SpendDevelopmentChart,
  type FunnelChartPoint,
  type RoasEvolutionWindows,
} from "@/components/admin/performance-charts";
import {
  buildCampaignProfitLoss,
  buildCollectionCampaign,
  CampaignProfitLossSheet,
} from "./campaign-profit-loss";
import { Badge } from "@/components/ui/badge";
import type {
  AdminAnalyticsCampaign,
  AdminAnalyticsFamily,
  AdminProviderFreshness,
  AdminStoreAnalytics,
  CampaignSheetFees,
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
    return url.protocol === "https:" &&
      url.hostname === "tpc.googlesyndication.com" &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function CreativeThumbnail({ src }: { src: string | null | undefined }) {
  const safeSrc = safeHttpsImageUrl(src);
  const proxySrc = safeSrc
    ? `/api/admin/reporting-asset?url=${encodeURIComponent(safeSrc)}`
    : null;
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showImage = proxySrc !== null && failedSrc !== proxySrc;

  return (
    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated proxy assets have no build-time dimensions
        <img
          src={proxySrc}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(proxySrc)}
          className="size-full object-cover"
        />
      ) : (
        <ImageIcon className="size-4 text-[var(--text-muted)]" aria-hidden />
      )}
    </div>
  );
}

type RoasTimelinePoint = {
  bucket: string;
  spend: number | null | undefined;
  revenue: number | null | undefined;
};

const LISBON_TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The hover's labels are calendar words (Today, Yesterday, 7 days…), so the
 * windows anchor on the real Lisbon day — never on the selected range's end,
 * which after midnight would present yesterday's numbers as "Today".
 */
function lisbonToday(): string {
  return LISBON_TODAY.format(new Date());
}

function offsetUtcDay(day: string, offset: number): string | null {
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  if (new Date(timestamp).toISOString().slice(0, 10) !== day) return null;
  return new Date(timestamp + offset * 86_400_000).toISOString().slice(0, 10);
}

function roasEvolutionWindows(
  points: RoasTimelinePoint[],
  endDay: string,
): RoasEvolutionWindows {
  const daily = new Map<string, { spend: number; revenue: number; complete: boolean }>();

  for (const point of points) {
    const day = point.bucket.slice(0, 10);
    if (offsetUtcDay(day, 0) !== day) continue;
    const current = daily.get(day) ?? { spend: 0, revenue: 0, complete: true };
    if (
      typeof point.spend !== "number" || !Number.isFinite(point.spend) ||
      typeof point.revenue !== "number" || !Number.isFinite(point.revenue)
    ) {
      daily.set(day, { ...current, complete: false });
      continue;
    }
    daily.set(day, {
      spend: current.spend + point.spend,
      revenue: current.revenue + point.revenue,
      complete: current.complete,
    });
  }

  function windowRoas(to: string | null, days: number): number | null {
    if (!to) return null;
    let spend = 0;
    let revenue = 0;
    for (let offset = 1 - days; offset <= 0; offset += 1) {
      const day = offsetUtcDay(to, offset);
      const total = day ? daily.get(day) : null;
      if (!total?.complete) return null;
      spend += total.spend;
      revenue += total.revenue;
    }
    return spend > 0 ? revenue / spend : null;
  }

  const yesterday = offsetUtcDay(endDay, -1);
  return {
    d30: windowRoas(endDay, 30),
    d14: windowRoas(endDay, 14),
    d7: windowRoas(endDay, 7),
    d3: windowRoas(endDay, 3),
    yesterday: windowRoas(yesterday, 1),
    today: windowRoas(endDay, 1),
  };
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

const SNAPSHOT_TIME = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Lisbon",
});

function snapshotTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? SNAPSHOT_TIME.format(timestamp) : null;
}

/**
 * The one line the campaign table needs above it: when the shown snapshot
 * was taken and what the last refresh said. With rows on screen the family's
 * message and the row's error code were rendered nowhere, so a sheet kept
 * from the last good refresh looked like this hour's.
 */
export function snapshotFreshnessLine(
  message: string | null,
  freshness: AdminProviderFreshness | null | undefined,
): string | null {
  const code = freshness?.lastErrorCode ?? null;
  // The stored failure text starts with the RPC's own prefix (0073); the
  // line says "failed" itself.
  const detail = message?.replace(/^Last failure:\s*/i, "").trim() || null;
  if (!detail && !code) return null;
  const parts: string[] = [];
  const taken = snapshotTime(freshness?.refreshedAt);
  if (taken) parts.push(`Snapshot from ${taken}`);
  if (code) {
    const attempted = snapshotTime(freshness?.lastAttemptAt);
    parts.push(
      `last refresh${attempted ? ` ${attempted}` : ""} failed` +
        (detail ? `: ${detail}` : ` (${code}); showing the last good data.`),
    );
  } else if (detail) {
    parts.push(detail);
  }
  return parts.join(" · ");
}

function SnapshotFreshnessNotice({
  message,
  freshness,
}: {
  message: string | null;
  freshness: AdminProviderFreshness | null | undefined;
}) {
  const line = snapshotFreshnessLine(message, freshness);
  if (!line) return null;
  const degraded = Boolean(freshness?.lastErrorCode);
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 border-b border-[var(--border-subtle)] px-5 py-2 text-[11px] text-[var(--text-muted)]",
        degraded && "text-[var(--warning-orange)]",
      )}
    >
      {degraded && <AlertTriangle className="size-3.5 shrink-0" aria-hidden />}
      <p className="min-w-0 truncate" title={line}>{line}</p>
    </div>
  );
}

export function ShopifyFunnel({
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

/**
 * The campaigns grouped by the collection they land on, in the order the
 * collections first appear among the rows; a campaign landing on no
 * collection belongs to no group.
 */
function campaignCollections(
  rows: AdminAnalyticsCampaign[],
): Array<{ handle: string; members: AdminAnalyticsCampaign[] }> {
  const groups = new Map<string, AdminAnalyticsCampaign[]>();
  for (const campaign of rows) {
    if (!campaign.collectionHandle) continue;
    const members = groups.get(campaign.collectionHandle) ?? [];
    members.push(campaign);
    groups.set(campaign.collectionHandle, members);
  }
  return [...groups.entries()].map(([handle, members]) => ({ handle, members }));
}

/**
 * One row per collection the campaigns land on, with the campaigns that
 * land there summed day by day and the ratios taken from the sums: the
 * sheet the client keeps per collection, which the per-campaign sheets only
 * hold shares of. The block is controlled by its parent, which keeps which
 * collection sheets are open next to the campaign ones.
 *
 * The collections family names the collection when it has the handle (it
 * only lists collections that sold in the period); otherwise the handle
 * stands for the title.
 */
export function CampaignCollectionsBlock({
  rows,
  collections = null,
  currency,
  today,
  fees,
  openSheets,
  onToggleSheet,
}: {
  rows: AdminAnalyticsCampaign[];
  collections?: AdminStoreAnalytics["collections"] | null;
  currency: string;
  today: string;
  fees: CampaignSheetFees | null;
  openSheets: ReadonlySet<string>;
  onToggleSheet: (handle: string) => void;
}) {
  // Built once per snapshot, so the sheet below sees the same campaign object
  // across renders and keeps its own memo.
  const groups = React.useMemo(
    () =>
      campaignCollections(rows).flatMap((group) => {
        const campaign = buildCollectionCampaign(group.members);
        return campaign
          ? [{ ...group, campaign, total: buildCampaignProfitLoss(campaign, today, fees).total }]
          : [];
      }),
    [rows, today, fees],
  );
  const titles = React.useMemo(
    () =>
      new Map(
        collections && "data" in collections
          ? collections.data.rows.flatMap((collection) =>
              collection.handle ? [[collection.handle, collection.title] as const] : [],
            )
          : [],
      ),
    [collections],
  );
  if (groups.length === 0) return null;

  const cell = "px-2.5 py-2.5 text-center tabular-nums";
  return (
    <div className="border-b border-[var(--border-subtle)]" role="region" aria-label="Collections landed on by campaigns">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-3 pb-1.5">
        <p className="text-[12px] font-semibold text-[var(--text-primary)]">Collections</p>
        <p className="text-[10.5px] text-[var(--text-muted)]">
          One row per collection the campaigns land on, its campaigns summed day by day, the way the client keeps a sheet per collection. Open its P&amp;L for the collection&apos;s own day-by-day sheet.
        </p>
      </div>
      <table className="w-full min-w-[1180px] text-[11.5px]">
        <thead>
          <tr className="label-caps border-b border-[var(--border-subtle)] text-left">
            <th className="px-5 py-2 font-medium">Collection</th>
            <th className="px-2.5 py-2 text-center font-medium">Spend</th>
            <th className="px-2.5 py-2 text-center font-medium">Clicks</th>
            <th className="px-2.5 py-2 text-center font-medium">Impressions</th>
            <th className="px-2.5 py-2 text-center font-medium">CTR</th>
            <th className="px-2.5 py-2 text-center font-medium">ATC</th>
            <th className="px-2.5 py-2 text-center font-medium">Revenue</th>
            <th className="px-2.5 py-2 text-center font-medium">Orders</th>
            <th className="px-2.5 py-2 text-center font-medium">Units</th>
            <th className="px-2.5 py-2 text-center font-medium">ROAS</th>
            <th className="px-2.5 py-2 text-center font-medium">CPA</th>
            <th className="px-5 py-2 text-center font-medium">Sheet</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const { campaign, total } = group;
            const title = titles.get(group.handle) ?? group.handle;
            const open = openSheets.has(group.handle);
            const memberCount = `${group.members.length} ${group.members.length === 1 ? "campaign" : "campaigns"}`;
            return (
              <React.Fragment key={group.handle}>
                <tr className="transition-smooth border-t border-[var(--border-subtle)] first:border-t-0 hover:bg-[var(--bg-panel-hover)]">
                  <td className="max-w-[300px] px-5 py-2.5">
                    <span className="block truncate font-medium text-[var(--text-primary)]">{title}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
                      /collections/{group.handle} · {memberCount}
                    </span>
                  </td>
                  <td className={cell}>{money(total.spend, currency)}</td>
                  <td className={cell}>{integer(total.clicks)}</td>
                  <td className={cell}>{integer(total.impressions)}</td>
                  <td className={cell}>{percent(total.ctr)}</td>
                  <td className={cell}>{total.addedToCart === null ? "—" : integer(total.addedToCart)}</td>
                  <td className={cell}>{total.revenue === null ? "—" : money(total.revenue, currency)}</td>
                  <td className={cell}>{total.orders === null ? "—" : integer(total.orders)}</td>
                  <td className={cell}>{total.units === null ? "—" : integer(total.units)}</td>
                  <td className={cell}>{total.roas === null ? "—" : multiplier(total.roas)}</td>
                  <td className={cell}>{total.cpa === null ? "—" : money(total.cpa, currency)}</td>
                  <td className="px-5 py-2 text-center">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`P&L: ${open ? "hide" : "show"} ${title} collection profit and loss by day`}
                      onClick={() => onToggleSheet(group.handle)}
                      className={cn(
                        "transition-smooth rounded-[8px] border px-2 py-1 text-[10.5px] font-medium outline-none focus-visible:border-[var(--accent-gold)]",
                        open
                          ? "border-[var(--accent-gold)]/40 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
                          : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]",
                      )}
                    >
                      P&amp;L
                    </button>
                  </td>
                </tr>
                {open ? (
                  <tr className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
                    <td colSpan={12} className="px-5 py-3">
                      <CampaignProfitLossSheet
                        campaign={campaign}
                        currency={currency}
                        today={today}
                        title={`${title} (collection)`}
                        fees={fees}
                      />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CampaignPerformanceSection({
  campaigns,
  collections = null,
  currency,
  rangeEnd,
  freshness = null,
}: {
  campaigns: AdminStoreAnalytics["campaigns"];
  /** The collections family, for the collection rows' titles; absent, the handles stand in. */
  collections?: AdminStoreAnalytics["collections"] | null;
  currency: string;
  rangeEnd: string;
  /** The campaigns family's own row freshness; null for a live build. */
  freshness?: AdminProviderFreshness | null;
}) {
  const [openCampaigns, setOpenCampaigns] = React.useState<Set<string>>(new Set());
  const [openSheets, setOpenSheets] = React.useState<Set<string>>(new Set());
  const [openCollectionSheets, setOpenCollectionSheets] = React.useState<Set<string>>(new Set());
  const hasData = "data" in campaigns;
  const rows = hasData ? campaigns.data.rows : [];
  const fees = hasData ? campaigns.data.fees ?? null : null;
  const today = (hasData ? campaigns.data.storeToday : null) ?? lisbonToday();

  function toggleIn(setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const toggleCampaign = (key: string) => toggleIn(setOpenCampaigns, key);
  const toggleSheet = (key: string) => toggleIn(setOpenSheets, key);
  const toggleCollectionSheet = (handle: string) => toggleIn(setOpenCollectionSheets, handle);

  return (
    <section className="panel overflow-hidden" aria-labelledby="campaign-performance-title">
      <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
        <h2 id="campaign-performance-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
          Campaign Performance
        </h2>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Google delivery and Shopify last-non-direct-click UTM attribution for the selected period. Open a campaign for its assets, or its P&amp;L for the day-by-day sheet; a collection&apos;s P&amp;L sums the campaigns that land there.
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
          <SnapshotFreshnessNotice message={familyMessage(campaigns)} freshness={freshness} />
          <CampaignCollectionsBlock
            rows={rows}
            collections={collections}
            currency={currency}
            today={today}
            fees={fees}
            openSheets={openCollectionSheets}
            onToggleSheet={toggleCollectionSheet}
          />
          <table className="w-full min-w-[1180px] text-[11.5px]">
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
                <th className="px-5 py-2.5 text-center font-medium">Tracking</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((campaign) => {
                const key = `${campaign.accountId}:${campaign.campaignId}`;
                const open = openCampaigns.has(key);
                const sheetOpen = openSheets.has(key);
                const breakdownWarnings = campaign.breakdown.sources
                  .filter((source) => source.state === "failed" || source.state === "unavailable")
                  .map((source) => source.reason)
                  .filter((reason): reason is string => Boolean(reason));
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
                      <td className="px-5 py-2 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <RoasEvolutionHover
                            label="Google ROAS evolution"
                            windows={roasEvolutionWindows(
                              (campaign.trackingTimeline ?? campaign.timeline).map((point) => ({
                                bucket: point.bucket,
                                spend: point.spend,
                                revenue: point.googleRevenue,
                              })),
                              lisbonToday(),
                            )}
                          />
                          <button
                            type="button"
                            aria-expanded={sheetOpen}
                            aria-label={`P&L: ${sheetOpen ? "hide" : "show"} ${campaign.name} profit and loss by day`}
                            onClick={() => toggleSheet(key)}
                            className={cn(
                              "transition-smooth rounded-[8px] border px-2 py-1 text-[10.5px] font-medium outline-none focus-visible:border-[var(--accent-gold)]",
                              sheetOpen
                                ? "border-[var(--accent-gold)]/40 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
                                : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)]",
                            )}
                          >
                            P&amp;L
                          </button>
                        </div>
                      </td>
                    </tr>

                    {sheetOpen ? (
                      <tr className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
                        <td colSpan={11} className="px-5 py-3">
                          <CampaignProfitLossSheet
                            campaign={campaign}
                            currency={currency}
                            today={today}
                            title={campaign.name}
                            fees={fees}
                          />
                        </td>
                      </tr>
                    ) : null}

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
                          <td className="px-5 py-2.5 text-center text-[var(--text-muted)]">—</td>
                        </tr>
                      );
                    })}

                    {open && campaign.breakdown.rows.length === 0 ? (
                      <tr className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)]">
                        <td colSpan={11} className="px-12 py-3 text-[11px] text-[var(--text-muted)]">
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
                        <td colSpan={11} className="px-12 py-2.5 text-[10.5px] text-[var(--warning-orange)]">
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
  rangeEnd,
}: {
  collections: AdminStoreAnalytics["collections"];
  currency: string;
  rangeEnd: string;
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
                <th className="px-5 py-2.5 text-center font-medium">Tracking</th>
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
                        <RoasEvolutionHover
                          windows={roasEvolutionWindows(
                            (collection.trackingTimeline ?? collection.timeline).map((point) => ({
                              bucket: point.bucket,
                              spend: point.spend,
                              revenue: point.revenue,
                            })),
                            lisbonToday(),
                          )}
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
                          <RoasEvolutionHover
                            windows={roasEvolutionWindows(
                              (product.trackingTimeline ?? product.timeline).map((point) => ({
                                bucket: point.bucket,
                                spend: point.spend,
                                revenue: point.revenue,
                              })),
                              lisbonToday(),
                            )}
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
