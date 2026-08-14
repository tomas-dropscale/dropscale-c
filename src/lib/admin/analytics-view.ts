import type {
  AdminClientOverview,
  AdminStoreOverview,
} from "@/lib/admin/client-overview";
import type { CampaignActionHistory } from "@/lib/admin/campaigns-view";
import type { RangeSelection } from "@/lib/portal/range";

export type AnalyticsMetric = {
  key: "revenue" | "spend" | "roas" | "profit" | "orders" | "agency";
  label: string;
  value: number | null;
  format: "money" | "multiplier" | "integer";
  hint: string;
  tone?: "gold" | "positive" | "negative";
};

export type AnalyticsScope = {
  selectedStore: AdminStoreOverview | null;
  invalidStoreSelection: boolean;
  updatedAt: string | null;
  currency: string;
  label: string;
  description: string;
  metrics: AnalyticsMetric[];
};

function verifiedMetrics(
  metrics: AnalyticsMetric[],
  updatedAt: string | null,
): AnalyticsMetric[] {
  if (updatedAt) return metrics;
  return metrics.map((metric) => ({
    ...metric,
    value: null,
    hint: "No verified rollup rows are available for this scope",
    tone: undefined,
  }));
}

function verifiedTimestamp(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function clientMetrics(overview: AdminClientOverview): AnalyticsMetric[] {
  const { totals } = overview;

  return [
    {
      key: "revenue",
      label: "Google revenue",
      value: totals.googleRevenue,
      format: "money",
      hint:
        totals.googleOrders === null
          ? "Awaiting attribution sync"
          : `${totals.googleOrders} attributed orders`,
      tone: "gold",
    },
    {
      key: "spend",
      label: "Ad spend",
      value: totals.adSpend,
      format: "money",
      hint: "Across all mapped Google accounts",
    },
    {
      key: "roas",
      label: "Real ROAS",
      value: totals.roas,
      format: "multiplier",
      hint: `${totals.trackedRoas.toFixed(2)}x tracked by Google`,
      tone: "gold",
    },
    {
      key: "profit",
      label: "Client profit",
      value: totals.profit,
      format: "money",
      hint: "Before the agency fee",
      tone:
        totals.profit === null
          ? undefined
          : totals.profit < 0
            ? "negative"
            : "positive",
    },
    {
      key: "agency",
      label: "Agency billing",
      value: totals.agencyRevenue,
      format: "money",
      hint: "Ad-spend fee and revenue share",
      tone: "gold",
    },
  ];
}

function storeMetrics(store: AdminStoreOverview): AnalyticsMetric[] {
  return [
    {
      key: "revenue",
      label: "Google revenue",
      value: store.googleRevenue,
      format: "money",
      hint:
        store.googleOrders === null
          ? "Awaiting attribution sync"
          : `${store.googleOrders} attributed orders`,
      tone: "gold",
    },
    {
      key: "spend",
      label: "Ad spend",
      value: store.adSpend,
      format: "money",
      hint: "Mapped Google accounts",
    },
    {
      key: "roas",
      label: "Real ROAS",
      value: store.roas,
      format: "multiplier",
      hint: `${store.trackedRoas.toFixed(2)}x tracked by Google`,
      tone: "gold",
    },
    {
      key: "orders",
      label: "Google orders",
      value: store.googleOrders,
      format: "integer",
      hint: "Excludes Meta-referred orders",
    },
    {
      key: "agency",
      label: "Agency billing",
      value: store.commission + store.revShare,
      format: "money",
      hint:
        store.revShare > 0
          ? "Ad-spend fee and revenue share"
          : `${store.commissionRate}% of ad spend`,
      tone: "gold",
    },
  ];
}

/** Projects one already-authorised overview without changing its metric scope. */
export function projectAnalyticsScope(
  overview: AdminClientOverview,
  selectedStoreId: string | null,
): AnalyticsScope {
  const selectedStore = selectedStoreId
    ? overview.stores.find((store) => store.accountId === selectedStoreId) ?? null
    : null;

  if (selectedStore) {
    const updatedAt = verifiedTimestamp(selectedStore.updatedAt);
    return {
      selectedStore,
      invalidStoreSelection: false,
      updatedAt,
      currency: selectedStore.currency,
      label: selectedStore.storeName,
      description: "Selected store and its mapped Google accounts",
      metrics: verifiedMetrics(storeMetrics(selectedStore), updatedAt),
    };
  }

  const updatedAt = verifiedTimestamp(overview.updatedAt);
  return {
    selectedStore: null,
    invalidStoreSelection: Boolean(selectedStoreId),
    updatedAt,
    currency: overview.currency,
    label: "All stores",
    description: `${overview.stores.length} ${overview.stores.length === 1 ? "store" : "stores"} in this client`,
    metrics: verifiedMetrics(clientMetrics(overview), updatedAt),
  };
}

function occurredAt(entry: CampaignActionHistory): number {
  const value = Date.parse(entry.occurredAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Newest first, without mutating the server-provided, already-scoped list. */
export function sortAnalyticsActivity(
  activity: CampaignActionHistory[],
): CampaignActionHistory[] {
  return activity
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        occurredAt(right.entry) - occurredAt(left.entry) || left.index - right.index,
    )
    .map(({ entry }) => entry);
}

/** URL for leaving a selected client while keeping the reporting window. */
export function analyticsBaseHref(range: RangeSelection): string {
  const params = new URLSearchParams({
    range: range.key,
    from: range.from,
    to: range.to,
  });
  return `/admin/analytics?${params.toString()}`;
}
