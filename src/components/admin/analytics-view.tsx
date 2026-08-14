import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  History,
  Layers3,
  Store,
} from "lucide-react";

import {
  SpendDevelopmentChart,
  type PerformanceChartPoint,
} from "@/components/admin/performance-charts";
import { DailyPerformanceChart } from "@/components/portal/daily-performance-chart";
import { RangePicker } from "@/components/portal/range-picker";
import { Badge } from "@/components/ui/badge";
import { PageContainer } from "@/components/ui/page-container";
import {
  analyticsBaseHref,
  projectAnalyticsScope,
  sortAnalyticsActivity,
  type AnalyticsMetric,
} from "@/lib/admin/analytics-view";
import type { AdminClientOverview } from "@/lib/admin/client-overview";
import type { CampaignActionHistory } from "@/lib/admin/campaigns-view";
import { integer, money, multiplier } from "@/lib/format";
import type { RangeSelection } from "@/lib/portal/range";
import { cn } from "@/lib/utils";

export type AnalyticsViewProps = {
  overview: AdminClientOverview;
  selectedStoreId: string | null;
  /** Already authorised and scoped by the server to the selected client/store. */
  activity: CampaignActionHistory[];
  activityTruncated: boolean;
  range: RangeSelection;
};

const ACTIVITY_DATE = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Lisbon",
});

function formatMetric(metric: AnalyticsMetric, currency: string): string {
  if (metric.value === null) return "—";
  if (metric.format === "money") return money(metric.value, currency);
  if (metric.format === "integer") return integer(metric.value);
  return multiplier(metric.value);
}

function KpiCard({ metric, currency }: { metric: AnalyticsMetric; currency: string }) {
  return (
    <div
      className={cn(
        "panel min-w-0 p-4",
        metric.tone === "gold" &&
          "border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)]",
        metric.tone === "negative" && "border-[var(--danger-red)]/40",
      )}
    >
      <p className="label-caps">{metric.label}</p>
      <p
        className={cn(
          "mt-1 truncate text-2xl font-semibold tabular-nums text-[var(--text-primary)]",
          metric.tone === "gold" && "text-[var(--accent-gold-strong)]",
          metric.tone === "positive" && "text-[var(--success-green)]",
          metric.tone === "negative" && "text-[var(--danger-red)]",
        )}
      >
        {formatMetric(metric, currency)}
      </p>
      <p className="mt-1 truncate text-xs text-[var(--text-muted)]" title={metric.hint}>
        {metric.hint}
      </p>
    </div>
  );
}

function DailySection({
  overview,
  selectedStoreId,
}: {
  overview: AdminClientOverview;
  selectedStoreId: string | null;
}) {
  const store = selectedStoreId
    ? overview.stores.find((entry) => entry.accountId === selectedStoreId) ?? null
    : null;

  if (store) {
    /* SpendDevelopmentChart reads only date/googleSpend. Keep the unavailable
       funnel/profit fields absent rather than manufacturing zeroes for them. */
    const points = store.days.map((day) => ({
      date: day.day,
      googleSpend: day.adSpend,
    })) as PerformanceChartPoint[];

    return (
      <div className="space-y-2">
        <SpendDevelopmentChart points={points} currency={store.currency} granularity="day" />
        <p className="px-1 text-xs text-[var(--text-muted)]">
          Store-level daily profit is not materialised yet, so this chart shows
          only verified Google spend by day.
        </p>
      </div>
    );
  }

  if (overview.days.length > 0) {
    return <DailyPerformanceChart days={overview.days} currency={overview.currency} />;
  }

  return (
    <section className="panel flex min-h-48 items-center justify-center p-6">
      <div className="text-center">
        <BarChart3 className="mx-auto size-5 text-[var(--text-muted)]" aria-hidden />
        <h2 className="mt-2 text-sm font-semibold text-[var(--text-primary)]">
          Daily performance
        </h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          No attributed daily metrics are available for this range.
        </p>
      </div>
    </section>
  );
}

function activityDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? ACTIVITY_DATE.format(timestamp) : "Unknown date";
}

function activityPresentation(entry: CampaignActionHistory) {
  if (entry.outcome === "requested") {
    return {
      label: "Change requested",
      status: "Pending",
      variant: "warning" as const,
      detail: "Awaiting a durable Google Ads result",
    };
  }
  if (entry.outcome === "failed") {
    return {
      label: "Change failed",
      status: "Not applied",
      variant: "danger" as const,
      detail: "Google Ads did not apply this request",
    };
  }
  if (entry.outcome === "uncertain") {
    return {
      label: "Result uncertain",
      status: "Review required",
      variant: "warning" as const,
      detail: "The final Google Ads state could not be verified",
    };
  }
  switch (entry.action) {
    case "budget_changed":
      return {
        label: "Budget changed",
        status: "Budget updated",
        variant: "gold" as const,
        detail:
          entry.previousDailyBudget === null || entry.nextDailyBudget === null
            ? "Budget value unavailable"
            : `${money(entry.previousDailyBudget, entry.currency)}/day → ${money(entry.nextDailyBudget, entry.currency)}/day`,
      };
    case "campaign_paused":
      return {
        label: "Campaign paused",
        status: "Paused",
        variant: "warning" as const,
        detail: "Campaign delivery stopped",
      };
    case "campaign_enabled":
      return {
        label: "Campaign enabled",
        status: "Active",
        variant: "success" as const,
        detail: "Campaign delivery resumed",
      };
    case "campaign_launched":
      return {
        label: "Campaign launched",
        status: "Launched",
        variant: "success" as const,
        detail: "A new campaign was verified in Google Ads",
      };
  }
}

function StoreActivityLog({
  activity,
  truncated,
  storeName,
}: {
  activity: CampaignActionHistory[];
  truncated: boolean;
  storeName: string | null;
}) {
  const entries = sortAnalyticsActivity(activity);
  const activityGrid =
    "lg:grid-cols-[minmax(150px,.7fr)_minmax(170px,.85fr)_minmax(220px,1.25fr)_minmax(190px,1fr)_minmax(140px,.7fr)]";

  return (
    <section className="panel overflow-hidden" aria-labelledby="store-activity-title">
      <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-4 sm:px-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--accent-gold)]">
          <History className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id="store-activity-title" className="text-sm font-semibold text-[var(--text-primary)]">
            Store Activity Log
          </h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {storeName
              ? `Campaign and budget changes for ${storeName}.`
              : "Campaign and budget changes across all stores in this client."}
          </p>
          {truncated && (
            <p className="mt-1 text-[11px] text-[var(--accent-gold-strong)]">
              Showing the 1,000 most recent verified changes in this scope.
            </p>
          )}
        </div>
      </header>

      {entries.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-[var(--text-muted)]">
          {storeName
            ? "No campaign changes have been recorded for this store yet."
            : "No campaign changes have been recorded across this client’s stores yet."}
        </p>
      ) : (
        <div>
          <div
            className={cn(
              activityGrid,
              "label-caps hidden gap-x-4 border-b border-[var(--border-subtle)] px-5 py-2.5 lg:grid",
            )}
          >
            <span>Date</span>
            <span>Change</span>
            <span>Campaign</span>
            <span>Budget / status</span>
            <span>Actor</span>
          </div>
          <ol>
            {entries.map((entry) => {
              const presentation = activityPresentation(entry);
              return (
                <li
                  key={entry.id}
                  className={cn(
                    activityGrid,
                    "grid grid-cols-1 gap-3 border-t border-[var(--border-subtle)] px-4 py-4 first:border-t-0 sm:grid-cols-2 lg:gap-x-4 lg:px-5",
                  )}
                >
                  <div className="min-w-0">
                    <span className="label-caps mb-1 block lg:hidden">Date</span>
                    <time
                      dateTime={entry.occurredAt}
                      className="text-xs tabular-nums text-[var(--text-secondary)]"
                    >
                      {activityDate(entry.occurredAt)}
                    </time>
                  </div>
                  <div className="min-w-0">
                    <span className="label-caps mb-1 block lg:hidden">Change</span>
                    <Badge variant={presentation.variant}>{presentation.label}</Badge>
                  </div>
                  <div className="min-w-0 sm:col-span-2 lg:col-span-1">
                    <span className="label-caps mb-1 block lg:hidden">Campaign</span>
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {entry.campaignName}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <span className="label-caps mb-1 block lg:hidden">Budget / status</span>
                    <Badge variant={presentation.variant}>{presentation.status}</Badge>
                    <p className="mt-1 truncate text-xs tabular-nums text-[var(--text-muted)]" title={presentation.detail}>
                      {presentation.detail}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <span className="label-caps mb-1 block lg:hidden">Actor</span>
                    <p className="truncate text-xs text-[var(--text-secondary)]">
                      {entry.actorName || "Unknown actor"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}

export function AnalyticsView({
  overview,
  selectedStoreId,
  activity,
  activityTruncated,
  range,
}: AnalyticsViewProps) {
  const scope = projectAnalyticsScope(overview, selectedStoreId);

  return (
    <PageContainer
      title="Analytics"
      description={`Store-first performance · ${range.from} → ${range.to}`}
      actions={<RangePicker current={range} />}
    >
      <div className="space-y-6">
        <section className="panel p-4 sm:p-5" aria-labelledby="analytics-scope-title">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <Link
                href={analyticsBaseHref(range)}
                className="transition-smooth -ml-2 inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/40"
              >
                <ArrowLeft className="size-4" aria-hidden />
                All clients
              </Link>
              <h2 id="analytics-scope-title" className="mt-2 truncate text-base font-semibold text-[var(--text-primary)]">
                {overview.clientName}
              </h2>
              <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                {overview.clientEmail}
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <Store className="size-4 text-[var(--accent-gold)]" aria-hidden />
              <span>{scope.description}</span>
            </div>
          </div>

          <form
            action="/admin/analytics"
            method="get"
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
          >
            <input type="hidden" name="client" value={overview.clientId} />
            <input type="hidden" name="range" value={range.key} />
            <input type="hidden" name="from" value={range.from} />
            <input type="hidden" name="to" value={range.to} />
            <div className="space-y-1.5">
              <label htmlFor="analytics-store" className="label-caps block">
                Store
              </label>
              <select
                id="analytics-store"
                name="store"
                defaultValue={scope.selectedStore?.accountId ?? ""}
                className="transition-smooth h-10 w-full rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 text-sm text-[var(--text-primary)] outline-none hover:border-[var(--border-strong)] focus-visible:border-[var(--accent-gold)]/50 focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/15"
              >
                <option value="">All stores</option>
                {overview.stores.map((store) => (
                  <option key={store.accountId} value={store.accountId}>
                    {store.storeName}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="transition-smooth inline-flex h-10 items-center justify-center rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-4 text-sm font-medium text-[var(--text-primary)] outline-none hover:border-[var(--border-strong)] hover:bg-[var(--bg-panel-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/40"
            >
              View store
            </button>
          </form>

          {scope.invalidStoreSelection && (
            <p role="alert" className="mt-3 flex items-center gap-2 text-xs text-[var(--warning-orange)]">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              That store is not available for this client. Showing all stores.
            </p>
          )}
        </section>

        {overview.mixedCurrency && !scope.selectedStore && (
          <p className="panel border-[var(--warning-orange)]/25 px-4 py-3 text-sm text-[var(--warning-orange)]">
            Mixed currencies ({overview.currencies.join(", ")}). Client totals are not converted.
          </p>
        )}

        {scope.updatedAt === null && (
          <p
            role="status"
            className="panel flex items-center gap-2 border-[var(--warning-orange)]/25 px-4 py-3 text-sm text-[var(--warning-orange)]"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            Reporting data is unavailable for this scope. Zero values are not shown as verified results.
          </p>
        )}

        <section aria-labelledby="analytics-kpis-title">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="analytics-kpis-title" className="text-sm font-semibold text-[var(--text-primary)]">
                {scope.label}
              </h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Google-only performance; Meta-referred orders are excluded.
              </p>
            </div>
            <div className="text-right">
              <Badge variant="neutral">{range.from} → {range.to}</Badge>
              {scope.updatedAt && (
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Synced {ACTIVITY_DATE.format(new Date(scope.updatedAt))}
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {scope.metrics.map((metric) => (
              <KpiCard key={metric.key} metric={metric} currency={scope.currency} />
            ))}
          </div>
        </section>

        <DailySection overview={overview} selectedStoreId={scope.selectedStore?.accountId ?? null} />

        <section className="panel overflow-hidden" aria-labelledby="collection-return-title">
          <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-4 sm:px-5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-muted)]">
              <Layers3 className="size-4" aria-hidden />
            </span>
            <div>
              <h2 id="collection-return-title" className="text-sm font-semibold text-[var(--text-primary)]">
                Return by Collection
              </h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Collection attribution is not materialised in the reporting rollup yet.
              </p>
            </div>
          </header>
          <p className="px-5 py-10 text-center text-sm text-[var(--text-muted)]">
            No collection return is shown until revenue and ad spend can be tied to a verified Shopify collection mapping.
          </p>
        </section>

        <StoreActivityLog
          activity={activity}
          truncated={activityTruncated}
          storeName={scope.selectedStore?.storeName ?? null}
        />
      </div>
    </PageContainer>
  );
}
