import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyMetricRow } from "@/lib/metrics/queries";
import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import type { AdAccount } from "@/lib/supabase/types";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  fetchDailyMetrics: vi.fn(),
  resolveReportingSources: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/portal/data", () => ({ ACCOUNT_COLUMNS: "columns" }));
vi.mock("@/lib/portal/range", () => ({
  rangeDays: (selection: { from: string; to: string }) =>
    Math.round(
      (Date.parse(`${selection.to}T00:00:00Z`) -
        Date.parse(`${selection.from}T00:00:00Z`)) /
        86_400_000,
    ) + 1,
}));
vi.mock("@/lib/portal/currency", () => ({
  currencyScope: (accounts: AdAccount[]) => {
    const currencies = [...new Set(accounts.map((account) => account.currency))];
    return { currencies, mixed: currencies.length > 1 };
  },
  displayCurrency: (scope: { currencies: string[] }) => scope.currencies[0] ?? "EUR",
}));
vi.mock("@/lib/admin/google-attribution", () => ({
  googleRoas: (revenue: number | null, spend: number) =>
    revenue !== null && spend > 0 ? revenue / spend : 0,
  googleShare: (revenue: number | null, grossRevenue: number) =>
    revenue !== null && grossRevenue > 0
      ? Math.min(1, Math.max(0, revenue / grossRevenue))
      : 0,
  googleProfit: (
    revenue: number | null,
    costs: {
      revenue: number;
      refunds: number;
      productCost: number;
      paymentFees: number;
      shippingCost: number;
      adSpend: number;
    },
  ) =>
    revenue === null
      ? null
      : revenue -
        costs.refunds -
        costs.productCost -
        costs.paymentFees -
        costs.shippingCost -
        costs.adSpend,
}));
vi.mock("@/lib/metrics/queries", () => ({
  fetchDailyMetrics: mocks.fetchDailyMetrics,
  groupByAccount: (rows: DailyMetricRow[]) => {
    const grouped = new Map<string, DailyMetricRow[]>();
    for (const row of rows) {
      grouped.set(row.ad_account_id, [...(grouped.get(row.ad_account_id) ?? []), row]);
    }
    return grouped;
  },
  groupByDay: (rows: DailyMetricRow[]) => {
    const grouped = new Map<string, DailyMetricRow[]>();
    for (const row of rows) {
      grouped.set(row.day, [...(grouped.get(row.day) ?? []), row]);
    }
    return grouped;
  },
  sumMetrics: (rows: DailyMetricRow[]) => {
    const totals = rows.reduce(
      (sum, row) => ({
        revenue: sum.revenue + row.revenue,
        refunds: sum.refunds + row.refunds_amount,
        orders: sum.orders + row.orders_count,
        units: sum.units + row.units_sold,
        adSpend: sum.adSpend + row.ad_spend,
        impressions: sum.impressions + row.impressions,
        clicks: sum.clicks + row.clicks,
        conversions: sum.conversions + row.conversions,
        conversionValue: sum.conversionValue + row.conversion_value,
        productCost: sum.productCost + row.product_cost,
        paymentFees: sum.paymentFees + row.payment_fees,
        shippingCost: sum.shippingCost + row.shipping_cost,
      }),
      {
        revenue: 0,
        refunds: 0,
        orders: 0,
        units: 0,
        adSpend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversionValue: 0,
        productCost: 0,
        paymentFees: 0,
        shippingCost: 0,
      },
    );
    const attributed = rows.filter((row) => row.attributed_orders !== null);
    const attributedOrders = attributed.length
      ? attributed.reduce((sum, row) => sum + Number(row.attributed_orders), 0)
      : null;
    const attributedRevenue = attributed.length
      ? attributed.reduce((sum, row) => sum + Number(row.attributed_revenue), 0)
      : null;
    return {
      ...totals,
      attributedOrders,
      attributedRevenue,
      costPerAttributedOrder:
        attributedOrders && attributedOrders > 0
          ? totals.adSpend / attributedOrders
          : 0,
      ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
      cpc: totals.clicks > 0 ? totals.adSpend / totals.clicks : 0,
      costPerConversion:
        totals.conversions > 0 ? totals.adSpend / totals.conversions : 0,
      roas:
        totals.adSpend > 0 ? totals.conversionValue / totals.adSpend : 0,
    };
  },
  freshness: (rows: DailyMetricRow[]) => ({
    updatedAt: rows.length ? rows.at(-1)!.computed_at : null,
    nextUpdateAt: null,
  }),
}));
vi.mock("@/lib/reporting/sources", () => ({
  resolveReportingSources: mocks.resolveReportingSources,
}));

import { fetchClientOverview } from "./client-overview";

function query(data: unknown, error: unknown = null, single: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>["then"];
  } = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.maybeSingle.mockResolvedValue({ data: single, error });
  chain.then = (resolve, reject) => Promise.resolve({ data, error }).then(resolve, reject);
  return chain;
}

function account(id: string, overrides: Partial<AdAccount> = {}): AdAccount {
  return {
    id,
    client_id: "client-1",
    store_name: id,
    google_ads_customer_id: null,
    status: "pending",
    reporting_role: "legacy_hybrid",
    currency: "EUR",
    breakeven_roas: null,
    lifetime_ads_budget_usd: null,
    shopify_url: null,
    shopify_connected: false,
    shopify_client_id: null,
    shopify_scopes: null,
    color_dot: "#fff",
    created_at: "2026-08-01T00:00:00Z",
    google_ads_refresh_token: null,
    google_ads_connected_email: null,
    google_ads_connected: false,
    commission_rate: 10,
    list_commission_rate: 10,
    shopify_admin_token: null,
    shopify_token_last4: null,
    shopify_connected_at: null,
    default_product_cost_pct: 30,
    payment_fee_pct: 2.9,
    payment_fee_fixed: 0.3,
    shipping_cost_per_order: 5,
    revenue_share_enabled: false,
    ...overrides,
  };
}

function source(
  adAccountId: string,
  options: { anchor?: boolean; standalone?: boolean } = {},
): CanonicalReportingSource {
  const anchor = options.anchor === true;
  const standalone = options.standalone === true;
  return {
    bindingId: `binding-${adAccountId}`,
    clientId: "client-1",
    adAccountId,
    kind: anchor ? "shopify_google" : "google_ads",
    group: standalone
      ? {
          id: `binding-${adAccountId}`,
          shopifyAnchorBindingId: null,
          shopifyAnchorAdAccountId: null,
        }
      : {
          id: "binding-anchor",
          shopifyAnchorBindingId: "binding-anchor",
          shopifyAnchorAdAccountId: "anchor",
        },
    shopify: anchor
      ? {
          connectionId: "shopify-1",
          shopId: "gid://shopify/Shop/1",
          shopifyName: "Projected Store",
          domain: "projected.myshopify.com",
          primaryDomain: "STORE.EXAMPLE",
          currency: "EUR",
          credential: null,
        }
      : null,
    googleAds: {
      connectionId: `google-${adAccountId}`,
      windsorAccountId: "111-111-1111",
      accountId: "111-111-1111",
      customerId: "1111111111",
      accountName: `${adAccountId} ads`,
      currency: "EUR",
      timeZone: "Europe/Lisbon",
      dataSourceId: null,
    },
  };
}

function metric(
  adAccountId: string,
  overrides: Partial<DailyMetricRow> = {},
): DailyMetricRow {
  return {
    ad_account_id: adAccountId,
    day: "2026-08-14",
    ad_spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
    revenue: 0,
    orders_count: 0,
    units_sold: 0,
    attributed_orders: null,
    attributed_revenue: null,
    refunds_amount: 0,
    product_cost: 0,
    payment_fees: 0,
    shipping_cost: 0,
    revenue_share_base: 0,
    revenue_share_amount: 0,
    computed_at: "2026-08-14T12:00:00Z",
    ...overrides,
  };
}

function session(accounts: AdAccount[]) {
  const client = {
    id: "client-1",
    full_name: "Client One",
    email: "client@example.com",
  };
  return {
    from: vi.fn((table: string) => {
      if (table === "portal_clients") return query([], null, client);
      if (table === "ad_accounts") return query(accounts);
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

function serviceWithRollout(
  operational_surface: string,
  reporting_cutover_at: string | null,
  complete = true,
  shopifyConnections: unknown[] = [],
) {
  const rolloutQuery = query([], null, {
    operational_surface,
    reporting_cutover_at,
    reporting_cutover_by:
      reporting_cutover_at && complete ? "admin-1" : null,
    reporting_cutover_reason:
      reporting_cutover_at && complete ? "Reporting cutover" : null,
  });
  const shopifyQuery = query(shopifyConnections);
  return {
    from: vi.fn((table: string) =>
      table === "client_shopify_connections" ? shopifyQuery : rolloutQuery,
    ),
  };
}

const range = {
  key: "custom",
  from: "2026-08-01",
  to: "2026-08-14",
} as const;

describe("admin client overview V2 projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchDailyMetrics.mockResolvedValue([]);
  });

  it("shows one Shopify anchor and sums its pair and Google child exactly once", async () => {
    const anchor = account("anchor", {
      reporting_role: "shopify_anchor",
      commission_rate: 10,
    });
    const child = account("child", {
      reporting_role: "google_spend",
      commission_rate: 20,
    });
    const standalone = account("standalone", {
      reporting_role: "google_spend",
      commission_rate: 30,
    });
    mocks.createClient.mockResolvedValue(session([anchor, child, standalone]));
    const service = serviceWithRollout(
      "v2_active",
      "2026-08-14T00:00:00Z",
    );
    mocks.createServiceClient.mockReturnValue(service);
    mocks.resolveReportingSources.mockResolvedValue([
      source("anchor", { anchor: true }),
      source("child"),
      source("standalone", { standalone: true }),
    ]);
    mocks.fetchDailyMetrics.mockResolvedValue([
      metric("anchor", {
        ad_spend: 10,
        impressions: 100,
        clicks: 10,
        conversions: 1,
        conversion_value: 40,
        revenue: 100,
        orders_count: 2,
        attributed_orders: 2,
        attributed_revenue: 100,
      }),
      metric("child", {
        day: "2026-08-13",
        ad_spend: 20,
        impressions: 200,
        clicks: 20,
        conversions: 2,
        conversion_value: 60,
      }),
      metric("standalone", {
        ad_spend: 5,
        impressions: 50,
        clicks: 5,
        conversions: 1,
        conversion_value: 10,
      }),
    ]);

    const overview = await fetchClientOverview("client-1", range);

    expect(mocks.fetchDailyMetrics).toHaveBeenCalledWith(
      expect.arrayContaining(["anchor", "child", "standalone"]),
      range.from,
      range.to,
    );
    expect(overview?.stores).toEqual([
      expect.objectContaining({
        accountId: "anchor",
        activityAccountIds: ["anchor", "child"],
        storeName: "Projected Store",
        connected: true,
        adSpend: 30,
        googleRevenue: 100,
        estimatedCog: 0,
        profit: 70,
        commission: 5,
        storeDomain: "store.example",
        reportingState: "partial",
        reportingCoverage: { rows: 2, expectedRows: 28 },
        days: [
          { day: "2026-08-13", adSpend: 20, revenue: 0 },
          { day: "2026-08-14", adSpend: 10, revenue: 100 },
        ],
      }),
    ]);
    expect(overview?.activityAccountIds).toEqual(["anchor", "child", "standalone"]);
    expect(overview?.totals).toEqual(
      expect.objectContaining({
        adSpend: 35,
        googleRevenue: 100,
        estimatedCog: 0,
        commission: 6.5,
      }),
    );
  });

  it("keeps an old v2_active row without the durable marker on legacy topology", async () => {
    const first = account("first", {
      status: "active",
      shopify_url: "first.myshopify.com",
    });
    const second = account("second", {
      status: "active",
      shopify_url: "second.myshopify.com",
    });
    mocks.createClient.mockResolvedValue(session([first, second]));
    mocks.createServiceClient.mockReturnValue(
      serviceWithRollout("v2_active", null, true, [
        {
          client_id: "client-1",
          status: "connected",
          shopify_domain: "first.myshopify.com",
          primary_domain: "first.example",
          last_verified_at: "2026-08-14T09:00:00Z",
          last_error_code: null,
        },
        {
          client_id: "client-1",
          status: "connected",
          shopify_domain: "second.myshopify.com",
          primary_domain: "second.example",
          last_verified_at: "2026-08-14T09:00:00Z",
          last_error_code: null,
        },
      ]),
    );

    const overview = await fetchClientOverview("client-1", range);

    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
    expect(overview?.stores.map((store) => store.accountId)).toEqual([
      "first",
      "second",
    ]);
    expect(overview?.stores.map((store) => store.storeDomain)).toEqual([
      "first.example",
      "second.example",
    ]);
    expect(mocks.fetchDailyMetrics).toHaveBeenCalledWith(
      ["first", "second"],
      range.from,
      range.to,
    );
  });

  it("marks Running only for an exact grid with valid timestamps and anchor attribution", async () => {
    const store = account("anchor", {
      status: "active",
      shopify_connected: true,
      shopify_url: "anchor.myshopify.com",
      google_ads_connected: true,
    });
    mocks.createClient.mockResolvedValue(session([store]));
    mocks.createServiceClient.mockReturnValue(
      serviceWithRollout("legacy_only", null),
    );
    const ready = metric("anchor", {
      ad_spend: 25,
      attributed_revenue: 100,
      attributed_orders: 2,
    });
    mocks.fetchDailyMetrics
      .mockResolvedValueOnce([ready])
      .mockResolvedValueOnce([{ ...ready, computed_at: "not-a-timestamp" }])
      .mockResolvedValueOnce([{
        ...ready,
        attributed_revenue: null,
        attributed_orders: null,
      }]);
    const oneDay = {
      key: "custom",
      from: "2026-08-14",
      to: "2026-08-14",
    } as const;

    const complete = await fetchClientOverview("client-1", oneDay);
    const invalidTimestamp = await fetchClientOverview("client-1", oneDay);
    const missingAttribution = await fetchClientOverview("client-1", oneDay);

    expect(complete?.stores[0]).toEqual(expect.objectContaining({
      reportingState: "running",
      reportingCoverage: { rows: 1, expectedRows: 1 },
      adSpend: 25,
    }));
    expect(invalidTimestamp?.stores[0]).toEqual(expect.objectContaining({
      reportingState: "partial",
      reportingCoverage: { rows: 0, expectedRows: 1 },
      adSpend: 25,
    }));
    expect(missingAttribution?.stores[0]).toEqual(expect.objectContaining({
      reportingState: "partial",
      reportingCoverage: { rows: 1, expectedRows: 1 },
      adSpend: 25,
    }));
  });

  it("does not fall back when the durable cutover topology is missing", async () => {
    mocks.createClient.mockResolvedValue(session([account("legacy")]));
    mocks.createServiceClient.mockReturnValue(
      serviceWithRollout("v2_active", "2026-08-14T00:00:00Z"),
    );
    mocks.resolveReportingSources.mockResolvedValue([]);

    await expect(fetchClientOverview("client-1", range)).rejects.toThrow(
      "topology is incomplete",
    );
    expect(mocks.fetchDailyMetrics).not.toHaveBeenCalled();
  });

  it("rejects a partially readable marker instead of guessing its authority", async () => {
    mocks.createClient.mockResolvedValue(session([account("legacy")]));
    mocks.createServiceClient.mockReturnValue(
      serviceWithRollout("v2_active", "2026-08-14T00:00:00Z", false),
    );

    await expect(fetchClientOverview("client-1", range)).rejects.toThrow(
      "rollout is inconsistent",
    );
    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
  });
});
