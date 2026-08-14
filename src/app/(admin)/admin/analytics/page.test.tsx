import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listClients: vi.fn(),
  fetchOverview: vi.fn(),
  fetchStoreAnalytics: vi.fn(),
  ensureCoverage: vi.fn(),
  parseRange: vi.fn(),
}));

vi.mock("@/components/admin/analytics-view", () => ({
  AnalyticsScopeSelector: () => <div>Scope selector</div>,
  AnalyticsView: ({ storeAnalytics }: { storeAnalytics: { storeAccountId: string } | null }) => (
    <div>{storeAnalytics ? `Analytics for ${storeAnalytics.storeAccountId}` : "All-store analytics"}</div>
  ),
}));

vi.mock("@/components/portal/range-picker", () => ({
  RangePicker: () => <span>Range picker</span>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/page-container", () => ({
  PageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("@/lib/admin/analytics", () => ({
  listAdminAnalyticsClients: mocks.listClients,
}));

vi.mock("@/lib/admin/analytics-view", () => ({
  analyticsClientHref: () => "/admin/analytics?client=client-1",
  analyticsStoreHref: () => "/admin/analytics?client=client-1&store=store-1",
}));

vi.mock("@/lib/admin/client-overview", () => ({
  fetchClientOverview: mocks.fetchOverview,
}));

vi.mock("@/lib/admin/store-analytics", () => ({
  fetchAdminStoreAnalytics: mocks.fetchStoreAnalytics,
  ensureAdminAnalyticsRollupCoverage: mocks.ensureCoverage,
}));

vi.mock("@/lib/i18n/server", () => ({
  getServerDictionary: () => Promise.resolve({ d: { placeholder: { analytics: { title: "Analytics" } } } }),
}));

vi.mock("@/lib/portal/range", () => ({
  parseRange: mocks.parseRange,
}));

import AnalyticsPage from "./page";

describe("Analytics page timeframe integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseRange.mockReturnValue({
      key: "custom",
      from: "2026-07-15",
      to: "2026-08-14",
    });
    mocks.listClients.mockResolvedValue([
      {
        id: "client-1",
        name: "Northwind",
        email: "team@example.test",
        storeCount: 1,
        stores: [{ id: "store-1", name: "Store", domain: "store.example" }],
      },
    ]);
    mocks.fetchOverview.mockResolvedValue({
      clientId: "client-1",
      activityAccountIds: ["store-1", "google-1"],
      stores: [
        {
          accountId: "store-1",
          activityAccountIds: ["store-1", "google-1"],
          currency: "EUR",
          days: [],
        },
      ],
    });
    mocks.fetchStoreAnalytics.mockResolvedValue({
      storeAccountId: "store-1",
      rollupCoverage: {
        state: "ready",
        data: { dayCount: 31, refreshed: false },
      },
    });
    mocks.ensureCoverage.mockResolvedValue({
      state: "ready",
      data: { storeCount: 1, dayCount: 31, refreshed: false },
    });
  });

  it("passes the exact selected dates to the overview and every store analytics family", async () => {
    const params = {
      client: "client-1",
      store: "store-1",
      range: "custom",
      from: "2026-07-15",
      to: "2026-08-14",
    };
    const page = await AnalyticsPage({ searchParams: Promise.resolve(params) });

    expect(renderToStaticMarkup(page)).toContain("Analytics for store-1");
    expect(mocks.parseRange).toHaveBeenCalledWith(params);
    expect(mocks.fetchOverview).toHaveBeenCalledWith("client-1", {
      key: "custom",
      from: "2026-07-15",
      to: "2026-08-14",
    });
    expect(mocks.fetchOverview).toHaveBeenCalledTimes(2);
    expect(mocks.fetchStoreAnalytics).toHaveBeenCalledWith({
      clientId: "client-1",
      store: expect.objectContaining({
        accountId: "store-1",
        activityAccountIds: ["store-1", "google-1"],
      }),
      range: {
        key: "custom",
        from: "2026-07-15",
        to: "2026-08-14",
      },
    });
  });

  it("proves and re-reads the exact rollup for all stores without loading detail families", async () => {
    const params = {
      client: "client-1",
      range: "custom",
      from: "2026-07-15",
      to: "2026-08-14",
    };
    const page = await AnalyticsPage({ searchParams: Promise.resolve(params) });

    expect(renderToStaticMarkup(page)).toContain("All-store analytics");
    expect(mocks.fetchStoreAnalytics).not.toHaveBeenCalled();
    expect(mocks.ensureCoverage).toHaveBeenCalledWith({
      clientId: "client-1",
      stores: [
        expect.objectContaining({
          accountId: "store-1",
          activityAccountIds: ["store-1", "google-1"],
        }),
      ],
      range: {
        key: "custom",
        from: "2026-07-15",
        to: "2026-08-14",
      },
    });
    expect(mocks.fetchOverview).toHaveBeenCalledTimes(2);
  });
});
