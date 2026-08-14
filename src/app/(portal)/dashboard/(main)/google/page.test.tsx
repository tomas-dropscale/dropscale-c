import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  reportingMetricScope: vi.fn(),
  ensureDailyCoverage: vi.fn(),
  recomputeDailyMetrics: vi.fn(),
  fetchDailyMetrics: vi.fn(),
  fetchManualReferralRateSchedule: vi.fn(),
  getServerDictionary: vi.fn(),
}));

vi.mock("@/lib/portal/data", () => ({
  fetchAccounts: mocks.fetchAccounts,
  reportingMetricScope: mocks.reportingMetricScope,
}));
vi.mock("@/lib/metrics/recompute", () => ({
  ensureDailyCoverage: mocks.ensureDailyCoverage,
  recomputeDailyMetrics: mocks.recomputeDailyMetrics,
}));
vi.mock("@/lib/metrics/queries", () => ({
  fetchDailyMetrics: mocks.fetchDailyMetrics,
  freshness: vi.fn(() => ({ updatedAt: null })),
  groupByAccount: vi.fn(() => new Map()),
  metricSetFromRows: vi.fn(() => ({
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversionValue: 0,
    ctr: 0,
    cpc: 0,
    cpa: 0,
    roas: 0,
    fee: 0,
  })),
  sumMetrics: vi.fn(() => ({
    mer: 0,
    attributedOrders: 0,
    attributedRevenue: 0,
    orders: 0,
    costPerAttributedOrder: 0,
    costPerOrder: 0,
  })),
}));
vi.mock("@/lib/billing/referral-rate-schedule", () => ({
  fetchManualReferralRateSchedule: mocks.fetchManualReferralRateSchedule,
}));
vi.mock("@/lib/i18n/server", () => ({
  getServerDictionary: mocks.getServerDictionary,
}));
vi.mock("@/lib/portal/range", () => ({
  parseRange: vi.fn(() => ({
    key: "custom",
    from: "2026-08-01",
    to: "2026-08-14",
  })),
}));
vi.mock("@/lib/billing/referrals", () => ({
  manualReferralRateOnDay: vi.fn(() => 10),
}));
vi.mock("@/lib/portal/currency", () => ({
  currencyScope: vi.fn(() => ({
    currency: "USD",
    currencies: ["USD"],
    mixed: false,
  })),
  displayCurrency: vi.fn(() => "USD"),
}));
vi.mock("@/lib/format", () => ({ multiplier: vi.fn(() => "0.00x") }));
vi.mock("@/lib/i18n", () => ({
  fmt: vi.fn((template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (match, key: string) =>
      key in values ? String(values[key]) : match,
    ),
  ),
}));
vi.mock("@/components/portal/updated-at", () => ({ UpdatedAt: vi.fn() }));
vi.mock("@/components/portal/mixed-currency-notice", () => ({
  MixedCurrencyNotice: vi.fn(),
}));
vi.mock("@/components/portal/metric-card", () => ({ MetricsGrid: vi.fn() }));
vi.mock("@/components/ui/page-container", () => ({ PageContainer: vi.fn() }));
vi.mock("@/components/portal/range-picker", () => ({ RangePicker: vi.fn() }));
vi.mock("@/components/portal/store-comparison-table", () => ({
  StoreComparisonTable: vi.fn(),
}));

import GoogleAllStoresPage from "./page";

describe("Google all-store physical reporting scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDailyCoverage.mockResolvedValue(undefined);
    mocks.recomputeDailyMetrics.mockResolvedValue(undefined);
    mocks.fetchDailyMetrics.mockResolvedValue([]);
    mocks.fetchManualReferralRateSchedule.mockResolvedValue([]);
    mocks.getServerDictionary.mockResolvedValue({
      d: {
        portal: {
          allStores: "All stores",
          allStoresSubtitle: "Updated {time}",
          noData: "No data",
          roasTotal: "Total ROAS",
          unallocatedGoogleSpend: "Unallocated Google spend",
          unallocatedGoogleTableWarningOne:
            "{count} Google Ads account is not mapped to a store.",
          unallocatedGoogleTableWarningMany:
            "{count} Google Ads accounts are not mapped to a store.",
          unallocatedGoogleTableBody: "Included in client totals.",
        },
      },
    });
  });

  it("refreshes standalone Google accounts in an all-store view", async () => {
    const anchor = {
      id: "anchor-1",
      client_id: "client-1",
      store_name: "Store",
      color_dot: "#fff",
      currency: "USD",
    };
    const standaloneGoogle = {
      id: "google-unallocated",
      client_id: "client-1",
      store_name: "Google",
      color_dot: "#000",
      currency: "USD",
    };
    const physicalAccounts = [anchor, standaloneGoogle];
    mocks.fetchAccounts.mockResolvedValue([anchor]);
    mocks.reportingMetricScope.mockResolvedValue({
      metricAccountIds: ["anchor-1", "google-unallocated"],
      metricIdsByStore: new Map([["anchor-1", ["anchor-1"]]]),
      metricAccountsById: new Map(physicalAccounts.map((account) => [account.id, account])),
      unallocatedGoogleAccountIds: ["google-unallocated"],
    });

    await GoogleAllStoresPage({ searchParams: Promise.resolve({}) });

    expect(mocks.reportingMetricScope).toHaveBeenCalledWith([anchor], {
      includeUnallocated: true,
    });
    expect(mocks.ensureDailyCoverage).toHaveBeenCalledWith(
      physicalAccounts,
      expect.any(String),
    );
    expect(mocks.recomputeDailyMetrics).toHaveBeenCalledWith(physicalAccounts);
  });
});
