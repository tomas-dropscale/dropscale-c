import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  History,
  ShoppingBag,
  Store,
  Users,
} from "lucide-react";

import {
  CampaignPerformanceSection,
  CollectionReturnSection,
  StoreFunnelSections,
  StoreSpendSection,
} from "@/components/admin/store-analytics-sections";
import { AnalyticsScopeControls } from "./analytics-scope-controls";
import { ReportingSyncButton } from "./reporting-sync-button";
import { RangePicker } from "@/components/portal/range-picker";
import { Badge } from "@/components/ui/badge";
import { PageContainer } from "@/components/ui/page-container";
import {
  analyticsBaseHref,
  analyticsStoreHref,
  projectAnalyticsScope,
  sortAnalyticsActivity,
  type AnalyticsMetric,
} from "@/lib/admin/analytics-view";
import type { AdminAnalyticsClient } from "@/lib/admin/analytics";
import type { AdminClientOverview } from "@/lib/admin/client-overview";
import type { CampaignActionHistory } from "@/lib/admin/campaigns-view";
import type { AdminStoreAnalytics } from "@/lib/admin/store-analytics";
import { integer, money, multiplier } from "@/lib/format";
import type { RangeSelection } from "@/lib/portal/range";
import { cn } from "@/lib/utils";

export type AnalyticsViewProps = {
  clients: AdminAnalyticsClient[];
  overview: AdminClientOverview;
  selectedStoreId: string | null;
  /** Server-only upstream families, revalidated for this exact client/store/range. */
  storeAnalytics: AdminStoreAnalytics | null;
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
        "panel flex min-h-[104px] min-w-0 flex-col justify-between gap-2 p-3.5",
        metric.tone === "gold" &&
          "border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)]",
        metric.tone === "negative" && "border-[var(--danger-red)]/40",
      )}
    >
      <p className="label-caps">{metric.label}</p>
      <p
        className={cn(
          "truncate text-[clamp(19px,1.7vw,24px)] leading-none font-semibold tracking-[-0.02em] tabular-nums text-[var(--text-primary)]",
          metric.tone === "gold" && "text-[var(--accent-gold-strong)]",
          metric.tone === "positive" && "text-[var(--success-green)]",
          metric.tone === "negative" && "text-[var(--danger-red)]",
        )}
      >
        {formatMetric(metric, currency)}
      </p>
      <p className="truncate text-[10.5px] leading-snug text-[var(--text-muted)]" title={metric.hint}>
        {metric.hint}
      </p>
    </div>
  );
}

function validTimestamp(value: string | null): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function freshnessLabel(value: string | null): string {
  return validTimestamp(value)
    ? `Synced ${ACTIVITY_DATE.format(new Date(value))}`
    : "No verified rollup yet";
}

function RunningIndicator({
  store,
}: {
  store: Pick<
    AdminClientOverview["stores"][number],
    "reportingState" | "reportingCoverage" | "updatedAt" | "adSpend"
  >;
}) {
  if (store.reportingState === "running") {
    const title = `${freshnessLabel(store.updatedAt)} · complete selected-period grid${
      store.adSpend > 0 ? " · positive ad spend" : " · valid zero-spend data"
    }`;
    return (
      <Badge variant="success" title={title} aria-label={`Running. ${title}`}>
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
        Running
      </Badge>
    );
  }
  if (store.reportingState === "partial") {
    const coverage = store.reportingCoverage;
    const title = coverage
      ? `Partial selected-period grid: ${coverage.rows} of ${coverage.expectedRows} account-days.`
      : "Partial selected-period reporting grid.";
    return (
      <Badge variant="warning" title={title} aria-label={title}>
        Partial
      </Badge>
    );
  }
  return null;
}

export function AnalyticsScopeSelector({
  clients,
  overview,
  selectedStoreId,
  range,
}: {
  clients: AdminAnalyticsClient[];
  overview?: AdminClientOverview | null;
  selectedStoreId?: string | null;
  range: RangeSelection;
}) {
  const selectedStore = overview && selectedStoreId
    ? overview.stores.find((entry) => entry.accountId === selectedStoreId) ?? null
    : null;
  const context = selectedStore
    ? selectedStore.storeDomain || selectedStore.storeName
    : overview
      ? `${overview.stores.length} ${overview.stores.length === 1 ? "store" : "stores"} in this client`
      : `${clients.length} ${clients.length === 1 ? "client" : "clients"}`;
  const ContextIcon = selectedStore ? Store : overview ? ShoppingBag : Users;
  const updatedAt = selectedStore?.updatedAt ?? overview?.updatedAt ?? null;
  const projectedStores = (overview?.stores ?? []).map((store) => ({
    id: store.accountId,
    name: store.storeName,
    domain: store.storeDomain,
    reportingState: store.reportingState,
    reportingCoverage: store.reportingCoverage,
    updatedAt: store.updatedAt,
    adSpend: store.adSpend,
  }));
  const onboardingOnlyStores = overview
    ? (clients.find((client) => client.id === overview.clientId)?.stores ?? [])
        .filter((store) => store.id === null)
        .map((store) => ({
          ...store,
          reportingState: "not_materialized" as const,
          reportingCoverage: { rows: 0, expectedRows: 0 },
          updatedAt: null,
          adSpend: 0,
        }))
    : [];

  return (
    <section className="panel p-4" aria-labelledby="analytics-scope-title">
      {overview && (
        <Link
          href={analyticsBaseHref(range)}
          className="transition-smooth -ml-2 mb-2 inline-flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/40"
        >
          <ArrowLeft className="size-4" aria-hidden />
          All clients
        </Link>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <AnalyticsScopeControls
          clients={clients}
          clientId={overview?.clientId ?? null}
          stores={[...projectedStores, ...onboardingOnlyStores]}
          storeId={selectedStore?.accountId ?? null}
          range={range}
        />

        <div className="flex min-w-0 items-start gap-2 text-[11.5px] text-[var(--text-muted)] lg:max-w-64 lg:justify-end lg:text-right">
          <ContextIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
          <span className="min-w-0">
            <span className="flex min-w-0 items-center justify-end gap-2" id="analytics-scope-title">
              <span className="truncate">{context}</span>
              {selectedStore && <RunningIndicator store={selectedStore} />}
            </span>
            {overview && <span className="mt-0.5 block text-[10.5px]">{freshnessLabel(updatedAt)}</span>}
          </span>
        </div>
      </div>
    </section>
  );
}

function AllStoresTable({
  overview,
  range,
}: {
  overview: AdminClientOverview;
  range: RangeSelection;
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="all-stores-title">
      <header className="border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
        <h2 id="all-stores-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
          All Stores
        </h2>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          Open a Shopify store to review its funnel, campaigns and collections.
        </p>
      </header>

      {overview.stores.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-[var(--text-muted)]">
          No Shopify stores are available in this client’s reporting scope.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] text-[12px]">
            <thead>
              <tr className="label-caps border-b border-[var(--border-subtle)] text-left">
                <th className="px-5 py-2.5 font-medium">Store URL</th>
                <th className="px-3 py-2.5 text-right font-medium">Revenue</th>
                <th className="px-3 py-2.5 text-right font-medium">Ad spend</th>
                <th className="px-3 py-2.5 text-right font-medium">Est. COG</th>
                <th className="px-3 py-2.5 text-right font-medium">Real ROAS</th>
                <th className="px-3 py-2.5 text-right font-medium">Est. profit</th>
                <th className="px-5 py-2.5"><span className="sr-only">Open store</span></th>
              </tr>
            </thead>
            <tbody>
              {overview.stores.map((store) => {
                const verified = validTimestamp(store.updatedAt);
                const revenue = verified && store.googleRevenue !== null
                  ? money(store.googleRevenue, store.currency)
                  : "—";
                const spend = verified ? money(store.adSpend, store.currency) : "—";
                const estimatedCog = verified && store.estimatedCog !== null
                  ? money(store.estimatedCog, store.currency)
                  : "—";
                const roas = verified && store.googleRevenue !== null && store.adSpend > 0
                  ? multiplier(store.roas)
                  : "—";
                const profit = verified && store.profit !== null
                  ? money(store.profit, store.currency)
                  : "—";

                return (
                  <tr
                    key={store.accountId}
                    className="transition-smooth border-t border-[var(--border-subtle)] first:border-t-0 hover:bg-[var(--bg-panel-hover)]"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-[var(--text-primary)]">
                          {store.storeDomain || store.storeName}
                        </p>
                        <RunningIndicator store={store} />
                      </div>
                      <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                        {store.storeName} · {freshnessLabel(store.updatedAt)}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{revenue}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{spend}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{estimatedCog}</td>
                    <td className="px-3 py-3 text-right font-medium tabular-nums text-[var(--accent-gold-strong)]">{roas}</td>
                    <td
                      className={cn(
                        "px-3 py-3 text-right font-medium tabular-nums",
                        verified && store.profit !== null && store.profit < 0
                          ? "text-[var(--danger-red)]"
                          : verified && store.profit !== null
                            ? "text-[var(--success-green)]"
                            : undefined,
                      )}
                    >
                      {profit}
                    </td>
                    <td className="px-5 py-2 text-right">
                      <Link
                        href={analyticsStoreHref(overview.clientId, store.accountId, range)}
                        aria-label={`Open ${store.storeDomain || store.storeName}`}
                        className="transition-smooth inline-flex size-10 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/40"
                      >
                        <ChevronRight className="size-4" aria-hidden />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
  storeName,
}: {
  activity: AdminStoreAnalytics["activity"];
  storeName: string | null;
}) {
  const available = activity.state === "ready" || activity.state === "empty";
  const entries = sortAnalyticsActivity(available ? activity.data.rows : []);
  const truncated = available ? activity.data.truncated : false;
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

      {!available ? (
        <p className="flex items-center justify-center gap-2 px-5 py-6 text-center text-sm text-[var(--warning-orange)]" role="alert">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          {activity.message}
        </p>
      ) : entries.length === 0 ? (
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
  clients,
  overview,
  selectedStoreId,
  storeAnalytics,
  range,
}: AnalyticsViewProps) {
  const scope = projectAnalyticsScope(overview, selectedStoreId);

  return (
    <PageContainer
      title="Analytics"
      description={`Store-first performance · ${range.from} → ${range.to}`}
      actions={
        <>
          <ReportingSyncButton request={{ scope: "all", range }} />
          <RangePicker current={range} />
        </>
      }
    >
      <div className="space-y-4">
        <AnalyticsScopeSelector
          clients={clients}
          overview={overview}
          selectedStoreId={selectedStoreId}
          range={range}
        />

        {scope.invalidStoreSelection && (
          <p role="alert" className="panel flex items-center gap-2 border-[var(--warning-orange)]/25 px-4 py-3 text-sm text-[var(--warning-orange)]">
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            That store is not available for this client. Showing all stores.
          </p>
        )}

        {overview.mixedCurrency && !scope.selectedStore && (
          <p className="panel border-[var(--warning-orange)]/25 px-4 py-3 text-sm text-[var(--warning-orange)]">
            Mixed currencies ({overview.currencies.join(", ")}). Client totals are not converted.
          </p>
        )}

        <section aria-label={`${scope.label} key performance indicators`}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {scope.metrics.map((metric) => (
              <KpiCard key={metric.key} metric={metric} currency={scope.currency} />
            ))}
          </div>
        </section>

        {scope.selectedStore && storeAnalytics ? (
          <>
            <StoreFunnelSections analytics={storeAnalytics} />
            <StoreSpendSection
              spend={storeAnalytics.spend}
              currency={scope.selectedStore.currency}
            />
            <CampaignPerformanceSection
              campaigns={storeAnalytics.campaigns}
              currency={scope.selectedStore.currency}
            />
            <CollectionReturnSection
              collections={storeAnalytics.collections}
              currency={scope.selectedStore.currency}
            />
            <StoreActivityLog
              activity={storeAnalytics.activity}
              storeName={scope.selectedStore.storeName}
            />
          </>
        ) : (
          <AllStoresTable
            overview={overview}
            range={range}
          />
        )}
      </div>
    </PageContainer>
  );
}
