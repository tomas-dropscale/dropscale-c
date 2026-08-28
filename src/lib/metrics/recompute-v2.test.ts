import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  resolveReportingSources: vi.fn(),
  resolveStagedReportingSource: vi.fn(),
  fetchGoogleReportingDailyMetrics: vi.fn(),
  createShopifyReportingAdapter: vi.fn(),
  decryptToken: vi.fn(),
  hasGoogleAdsEnv: vi.fn(),
  markIfAuthRevoked: vi.fn(),
  fetchCampaignNames: vi.fn(),
  fetchLiveDailyBreakdown: vi.fn(),
  fetchCollectionProductKeys: vi.fn(),
  fetchDailySales: vi.fn(),
  resolveAdminToken: vi.fn(),
  fxDailyRates: vi.fn(),
  rateOn: vi.fn(),
  orderCogs: vi.fn(),
  paymentFee: vi.fn(),
  addHstTariffs: vi.fn().mockResolvedValue(0),
  loadCostContext: vi.fn(),
  registerSoldProducts: vi.fn(),
  dealsFromCampaigns: vi.fn(),
  orderRevShare: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("../reporting/sources", () => ({
  ReportingSourceResolutionError: class ReportingSourceResolutionError extends Error {},
  resolveReportingSources: mocks.resolveReportingSources,
  resolveStagedReportingSource: mocks.resolveStagedReportingSource,
}));
vi.mock("../reporting/google", () => ({
  fetchGoogleReportingDailyMetrics: mocks.fetchGoogleReportingDailyMetrics,
}));
vi.mock("../reporting/shopify", () => ({
  createShopifyReportingAdapter: mocks.createShopifyReportingAdapter,
}));
vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: mocks.decryptToken }));
vi.mock("@/lib/google-ads/env", () => ({ hasGoogleAdsEnv: mocks.hasGoogleAdsEnv }));
vi.mock("@/lib/google-ads/revoked", () => ({ markIfAuthRevoked: mocks.markIfAuthRevoked }));
vi.mock("@/lib/google-ads/portal", () => ({
  fetchCampaignNames: mocks.fetchCampaignNames,
  fetchLiveDailyBreakdown: mocks.fetchLiveDailyBreakdown,
}));
vi.mock("@/lib/shopify/client", () => ({
  fetchCollectionProductKeys: mocks.fetchCollectionProductKeys,
  fetchDailySales: mocks.fetchDailySales,
  resolveAdminToken: mocks.resolveAdminToken,
}));
vi.mock("@/lib/shopify/fx", () => ({
  fxDailyRates: mocks.fxDailyRates,
  rateOn: mocks.rateOn,
}));
vi.mock("@/lib/cogs/engine", () => ({
  orderCogs: mocks.orderCogs,
  paymentFee: mocks.paymentFee,
}));
vi.mock("@/lib/cogs/hst-tariff", () => ({
  addHstTariffs: mocks.addHstTariffs,
}));
vi.mock("@/lib/cogs/context", () => ({
  loadCostContext: mocks.loadCostContext,
  registerSoldProducts: mocks.registerSoldProducts,
}));
vi.mock("@/lib/finance/rev-share", () => ({
  dealsFromCampaigns: mocks.dealsFromCampaigns,
  orderRevShare: mocks.orderRevShare,
}));

import type { DailyMetricRow } from "@/lib/metrics/queries";
import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import type { AdAccount } from "@/lib/supabase/types";
import {
  recomputeDailyMetrics,
  refreshAccountsNow,
  refreshReportingSourcesNow,
  refreshStagedReportingSourceNow,
} from "./recompute";

const CLIENT = "70000000-0000-4000-8000-000000000001";
const ANCHOR = "70000000-0000-4000-8000-000000000002";
const CHILD = "70000000-0000-4000-8000-000000000003";
const ANCHOR_BINDING = "70000000-0000-4000-8000-000000000004";
const CHILD_BINDING = "70000000-0000-4000-8000-000000000005";
const DAY = "2026-08-13";

function account(id: string, overrides: Partial<AdAccount> = {}): AdAccount {
  return {
    id,
    client_id: CLIENT,
    store_name: "Store",
    google_ads_customer_id: null,
    status: "pending",
    reporting_role: "shopify_anchor",
    currency: "EUR",
    breakeven_roas: null,
    lifetime_ads_budget_usd: null,
    shopify_url: null,
    shopify_connected: false,
    shopify_client_id: null,
    shopify_scopes: null,
    color_dot: "#000000",
    created_at: "2026-08-01T00:00:00.000Z",
    google_ads_refresh_token: null,
    google_ads_connected_email: null,
    google_ads_connected: false,
    commission_rate: 10,
    list_commission_rate: 10,
    shopify_admin_token: null,
    shopify_token_last4: null,
    shopify_connected_at: null,
    default_product_cost_pct: 15,
    payment_fee_pct: 0,
    payment_fee_fixed: 0,
    shipping_cost_per_order: 0,
    hst_shop_id: null,
    revenue_share_enabled: false,
    ...overrides,
  };
}

function anchorSource(overrides: Partial<CanonicalReportingSource> = {}): CanonicalReportingSource {
  return {
    bindingId: ANCHOR_BINDING,
    clientId: CLIENT,
    adAccountId: ANCHOR,
    kind: "shopify",
    group: {
      id: ANCHOR_BINDING,
      shopifyAnchorBindingId: ANCHOR_BINDING,
      shopifyAnchorAdAccountId: ANCHOR,
    },
    shopify: {
      connectionId: "70000000-0000-4000-8000-000000000006",
      shopId: "gid://shopify/Shop/123",
      shopifyName: "Store",
      domain: "store.myshopify.com",
      primaryDomain: null,
      currency: "EUR",
      credential: {
        shopifyClientId: "shopify-client",
        clientSecretCiphertext: "ciphertext",
      },
    },
    googleAds: null,
    ...overrides,
  };
}

function childSource(): CanonicalReportingSource {
  return {
    bindingId: CHILD_BINDING,
    clientId: CLIENT,
    adAccountId: CHILD,
    kind: "google_ads",
    group: {
      id: ANCHOR_BINDING,
      shopifyAnchorBindingId: ANCHOR_BINDING,
      shopifyAnchorAdAccountId: ANCHOR,
    },
    shopify: null,
    googleAds: {
      connectionId: "70000000-0000-4000-8000-000000000007",
      windsorAccountId: "111-222-3333",
      accountId: "111-222-3333",
      customerId: "1112223333",
      accountName: "Ads",
      currency: "EUR",
      timeZone: "Europe/Lisbon",
      dataSourceId: "source",
    },
  };
}

function pairedSource(): CanonicalReportingSource {
  return {
    ...anchorSource(),
    kind: "shopify_google",
    googleAds: childSource().googleAds,
  };
}

function stored(overrides: Partial<DailyMetricRow> = {}): DailyMetricRow {
  return {
    ad_account_id: ANCHOR,
    day: DAY,
    ad_spend: 10,
    impressions: 100,
    clicks: 20,
    conversions: 2,
    conversion_value: 30,
    revenue: 50,
    orders_count: 4,
    units_sold: 5,
    attributed_orders: 3,
    attributed_revenue: 40,
    refunds_amount: 1,
    product_cost: 12,
    payment_fees: 2,
    shipping_cost: 3,
    revenue_share_base: 0,
    revenue_share_amount: 0,
    computed_at: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

function fakeDatabase(
  accounts: AdAccount[],
  existing: DailyMetricRow[] = [],
  groupChildren: Record<string, string[]> = {},
  rolloutByClient:
    | Record<
        string,
        | string
        | { operationalSurface: string; reportingCutoverAt: string | null }
      >
    | "error" = { [CLIENT]: "v2_active" },
  secretQuery: "ok" | "error" | "missing" = "ok",
) {
  const upserts: DailyMetricRow[][] = [];
  const receipts: Record<string, unknown>[] = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const events: string[] = [];
  const from = vi.fn((table: string) => {
    if (table === "ad_accounts") {
      return {
        select: vi.fn((columns: string) => {
          const selectingSecrets = columns.includes("google_ads_refresh_token");
          const filters: Array<{ column: string; ids: string[] }> = [];
          const rows = () =>
            accounts.filter((row) =>
              filters.every(({ column, ids }) =>
                ids.includes(String(row[column as keyof AdAccount])),
              ),
            );
          const query = {
            in: vi.fn((column: string, ids: string[]) => {
              filters.push({ column, ids });
              return query;
            }),
            then: (
              resolve: (value: { data: AdAccount[] | null; error: unknown }) => unknown,
            ) =>
              Promise.resolve(
                selectingSecrets && secretQuery === "error"
                  ? { data: null, error: { code: "SECRET_QUERY_FAILED" } }
                  : {
                      data: selectingSecrets && secretQuery === "missing" ? [] : rows(),
                      error: null,
                    },
              ).then(resolve),
          };
          return query;
        }),
      };
    }
    if (table === "client_reporting_bindings") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            in: vi.fn(() => ({
              in: vi.fn(async (_column: string, anchorIds: string[]) => ({
                data: anchorIds.flatMap((id) =>
                  (groupChildren[id] ?? []).map((ad_account_id) => ({ ad_account_id })),
                ),
                error: null,
              })),
            })),
          })),
        })),
      };
    }
    if (table === "client_rollout_states") {
      return {
        select: vi.fn(() => ({
          in: vi.fn(async (_column: string, clientIds: string[]) =>
            rolloutByClient === "error"
              ? { data: null, error: { code: "DB_DOWN" } }
              : {
                  data: clientIds.flatMap((client_id) => {
                    const fixture = rolloutByClient[client_id];
                    if (!fixture) return [];
                    const operational_surface =
                      typeof fixture === "string" ? fixture : fixture.operationalSurface;
                    const reporting_cutover_at =
                      typeof fixture === "string"
                        ? fixture === "v2_active"
                          ? "2026-08-14T01:00:00.000Z"
                          : null
                        : fixture.reportingCutoverAt;
                    return [{ client_id, operational_surface, reporting_cutover_at }];
                  }),
                  error: null,
                },
          ),
        })),
      };
    }
    if (table === "daily_metrics") {
      return {
        select: vi.fn(() => {
          let selectedAccount = "";
          let selectedFrom = "";
          const query = {
            eq: vi.fn((_column: string, value: string) => {
              selectedAccount = value;
              return query;
            }),
            gte: vi.fn((_column: string, value: string) => {
              selectedFrom = value;
              return query;
            }),
            lte: vi.fn(async (_column: string, value: string) => ({
              data: existing.filter(
                (row) =>
                  row.ad_account_id === selectedAccount &&
                  (!selectedFrom || row.day >= selectedFrom) &&
                  row.day <= value,
              ),
              error: null,
            })),
            order: vi.fn(() => query),
            limit: vi.fn(async (count: number) => ({
              data: existing
                .filter((row) => row.ad_account_id === selectedAccount)
                .sort((left, right) => left.day.localeCompare(right.day))
                .slice(0, count)
                .map((row) => ({ day: row.day })),
              error: null,
            })),
          };
          return query;
        }),
        upsert: vi.fn(async (rows: DailyMetricRow[]) => {
          events.push("upsert");
          upserts.push(rows);
          return { error: null };
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  });
  const rpc = vi.fn(
    async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ data: unknown; error: unknown }> => {
      rpcs.push({ name, args });
      if (name === "commit_client_staged_reporting_metrics") {
        events.push("staged_commit");
      } else {
        events.push("receipt");
        receipts.push(args);
      }
      return { data: args.p_binding_id, error: null };
    },
  );
  return { client: { from, rpc }, upserts, receipts, rpcs, events };
}

function successfulShopify(revenue = 100, currency = "EUR") {
  return {
    currency,
    days: [
      {
        date: DAY,
        revenue,
        orders: 1,
        refunds: 0,
        units: 1,
        attributedOrders: 1,
        attributedRevenue: revenue,
      },
    ],
    orders: [],
  };
}

describe("V2 daily-metrics recompute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasGoogleAdsEnv.mockReturnValue(true);
    mocks.decryptToken.mockResolvedValue("legacy-token");
    mocks.markIfAuthRevoked.mockResolvedValue(false);
    mocks.createShopifyReportingAdapter.mockResolvedValue({
      fetchDailySales: vi.fn(async () => successfulShopify()),
      fetchCollectionProductKeys: vi.fn(),
    });
    mocks.fetchGoogleReportingDailyMetrics.mockResolvedValue([
      {
        day: DAY,
        ad_spend: 20,
        impressions: 200,
        clicks: 40,
        conversions: 4,
        conversion_value: 80,
      },
    ]);
  });

  it("syncs pending anchor/child bindings once without duplicating store revenue", async () => {
    const accounts = [account(ANCHOR), account(CHILD, { reporting_role: "google_spend" })];
    const db = fakeDatabase(accounts);
    mocks.createClient.mockResolvedValue(db.client);
    mocks.createServiceClient.mockReturnValue(db.client);
    mocks.resolveReportingSources.mockResolvedValue([anchorSource(), childSource()]);

    await refreshAccountsNow([ANCHOR, CHILD, ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.resolveReportingSources).toHaveBeenCalledWith({
      service: db.client,
      adAccountIds: [ANCHOR, CHILD],
      clientIds: [CLIENT],
    });
    expect(mocks.createShopifyReportingAdapter).toHaveBeenCalledTimes(1);
    expect(mocks.createShopifyReportingAdapter).toHaveBeenCalledWith(anchorSource());
    const rows = db.upserts.flat();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.revenue, 0)).toBe(100);
    expect(rows.find((row) => row.ad_account_id === CHILD)).toMatchObject({
      revenue: 0,
      ad_spend: 20,
    });
    expect(db.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          p_binding_id: ANCHOR_BINDING,
          p_source_type: "shopify",
          p_row_count: 1,
        }),
        expect.objectContaining({
          p_binding_id: CHILD_BINDING,
          p_source_type: "google_ads",
          p_row_count: 1,
        }),
      ]),
    );
    expect(db.events[0]).toBe("upsert");
    expect(db.events.filter((event) => event === "receipt")).toHaveLength(2);
    expect(mocks.fetchLiveDailyBreakdown).not.toHaveBeenCalled();
    expect(mocks.fetchDailySales).not.toHaveBeenCalled();
  });

  it("commits one exact staged pair window before recording every applicable receipt", async () => {
    const source = pairedSource();
    const db = fakeDatabase([
      account(ANCHOR, {
        google_ads_customer_id: "1112223333",
        shopify_url: "store.myshopify.com",
      }),
    ]);
    mocks.resolveStagedReportingSource.mockResolvedValue(source);

    await refreshStagedReportingSourceNow(ANCHOR_BINDING, {
      client: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.resolveStagedReportingSource).toHaveBeenCalledWith({
      service: db.client,
      bindingId: ANCHOR_BINDING,
    });
    expect(db.upserts).toEqual([]);
    expect(db.rpcs.map((call) => call.name)).toEqual([
      "commit_client_staged_reporting_metrics",
      "record_client_staged_reporting_sync_success",
      "record_client_staged_reporting_sync_success",
    ]);
    expect(db.rpcs[0]).toMatchObject({
      args: {
        p_binding_id: ANCHOR_BINDING,
        p_success_from: DAY,
        p_success_to: DAY,
        p_rows: [
          expect.objectContaining({
            ad_account_id: ANCHOR,
            revenue: 100,
            ad_spend: 20,
          }),
        ],
      },
    });
    expect(db.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ p_source_type: "shopify", p_row_count: 1 }),
        expect.objectContaining({ p_source_type: "google_ads", p_row_count: 1 }),
      ]),
    );
    expect(db.events).toEqual(["staged_commit", "receipt", "receipt"]);
  });

  it("writes no staged pair window or receipt when either upstream family fails", async () => {
    const source = pairedSource();
    const db = fakeDatabase([
      account(ANCHOR, {
        google_ads_customer_id: "1112223333",
        shopify_url: "store.myshopify.com",
      }),
    ]);
    mocks.resolveStagedReportingSource.mockResolvedValue(source);
    mocks.fetchGoogleReportingDailyMetrics.mockRejectedValue(new Error("Windsor unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      refreshStagedReportingSourceNow(ANCHOR_BINDING, {
        client: db.client as never,
        from: DAY,
        to: DAY,
      }),
    ).rejects.toThrow(/every staged reporting family/i);

    expect(db.upserts).toEqual([]);
    expect(db.rpcs).toEqual([]);
    expect(db.receipts).toEqual([]);
  });

  it("overwrites every prior restage day in bounded chunks before the final receipt window", async () => {
    const source = anchorSource();
    const old = stored({ day: "2025-01-01", computed_at: "2025-01-02T00:00:00.000Z" });
    const db = fakeDatabase([account(ANCHOR)], [old]);
    mocks.resolveStagedReportingSource.mockResolvedValue(source);
    mocks.createShopifyReportingAdapter.mockResolvedValue({
      fetchDailySales: vi.fn(async (_from: string, to: string) => {
        const result = successfulShopify();
        result.days[0].date = to;
        return result;
      }),
      fetchCollectionProductKeys: vi.fn(),
    });

    await refreshStagedReportingSourceNow(ANCHOR_BINDING, {
      client: db.client as never,
      from: "2026-05-16",
      to: DAY,
    });

    expect(
      db.rpcs
        .filter((call) => call.name === "commit_client_staged_reporting_metrics")
        .map((call) => [call.args.p_success_from, call.args.p_success_to]),
    ).toEqual([
      ["2025-01-01", "2026-01-01"],
      ["2026-01-02", "2026-05-15"],
      ["2026-05-16", DAY],
    ]);
    expect(db.rpcs.at(-1)).toMatchObject({
      name: "record_client_staged_reporting_sync_success",
      args: { p_success_from: "2026-05-16", p_success_to: DAY },
    });
  });

  it("converts Shopify shopMoney into the paired account currency before writing", async () => {
    const pair = pairedSource();
    pair.shopify = { ...pair.shopify!, currency: "JPY" };
    const db = fakeDatabase([
      account(ANCHOR, {
        google_ads_customer_id: "1112223333",
        shopify_url: "store.myshopify.com",
      }),
    ]);
    mocks.createServiceClient.mockReturnValue(db.client);
    mocks.resolveReportingSources.mockResolvedValue([pair]);
    mocks.createShopifyReportingAdapter.mockResolvedValue({
      fetchDailySales: vi.fn(async () => successfulShopify(100, "JPY")),
      fetchCollectionProductKeys: vi.fn(),
    });
    mocks.fxDailyRates.mockResolvedValue([[DAY, 0.006]]);
    mocks.rateOn.mockReturnValue(0.006);

    await refreshReportingSourcesNow([ANCHOR], {
      client: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.fxDailyRates).toHaveBeenCalledWith("JPY", "EUR", DAY, DAY);
    expect(db.upserts.flat()).toEqual([
      expect.objectContaining({
        ad_account_id: ANCHOR,
        revenue: 0.6,
        attributed_revenue: 0.6,
        ad_spend: 20,
      }),
    ]);
    expect(db.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ p_source_type: "shopify" }),
        expect.objectContaining({ p_source_type: "google_ads" }),
      ]),
    );
  });

  it("syncs a preserved legacy identity after its Google binding is upgraded to a pair", async () => {
    const legacyPair = account(ANCHOR, {
      reporting_role: "legacy_hybrid",
      google_ads_customer_id: "1112223333",
      shopify_url: "store.myshopify.com",
    });
    const db = fakeDatabase([legacyPair]);
    mocks.createServiceClient.mockReturnValue(db.client);
    mocks.resolveReportingSources.mockResolvedValue([pairedSource()]);

    await refreshReportingSourcesNow([ANCHOR], {
      client: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(db.upserts.flat()).toEqual([
      expect.objectContaining({
        ad_account_id: ANCHOR,
        revenue: 100,
        ad_spend: 20,
      }),
    ]);
    expect(db.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ p_source_type: "shopify" }),
        expect.objectContaining({ p_source_type: "google_ads" }),
      ]),
    );
  });

  it("continues V2 reporting and receipts for a suspended account with an open billing boundary", async () => {
    const db = fakeDatabase([
      account(ANCHOR, {
        status: "suspended",
        google_ads_customer_id: "1112223333",
        shopify_url: "store.myshopify.com",
      }),
    ]);
    mocks.createServiceClient.mockReturnValue(db.client);
    mocks.resolveReportingSources.mockResolvedValue([pairedSource()]);

    await refreshReportingSourcesNow([ANCHOR], {
      client: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(db.upserts.flat()).toEqual([
      expect.objectContaining({ ad_account_id: ANCHOR, revenue: 100, ad_spend: 20 }),
    ]);
    expect(db.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          p_binding_id: ANCHOR_BINDING,
          p_source_type: "shopify",
        }),
        expect.objectContaining({
          p_binding_id: ANCHOR_BINDING,
          p_source_type: "google_ads",
        }),
      ]),
    );
  });

  it("expands an exact store anchor to its Google children and no other store", async () => {
    const OTHER = "70000000-0000-4000-8000-000000000008";
    const accounts = [
      account(ANCHOR),
      account(CHILD, { reporting_role: "google_spend" }),
      account(OTHER),
    ];
    const db = fakeDatabase(accounts, [], { [ANCHOR_BINDING]: [CHILD] });
    mocks.createServiceClient.mockReturnValue(db.client);
    mocks.resolveReportingSources
      .mockResolvedValueOnce([anchorSource()])
      .mockResolvedValueOnce([childSource()]);

    await recomputeDailyMetrics([accounts[0]], {
      force: true,
      client: db.client as never,
      reportingClient: db.client as never,
    });

    expect(mocks.resolveReportingSources).toHaveBeenNthCalledWith(1, {
      service: db.client,
      adAccountIds: [ANCHOR],
      clientIds: [CLIENT],
    });
    expect(mocks.resolveReportingSources).toHaveBeenNthCalledWith(2, {
      service: db.client,
      adAccountIds: [CHILD],
      clientIds: [CLIENT],
    });
    expect([...new Set(db.upserts.flat().map((row) => row.ad_account_id))].sort()).toEqual(
      [ANCHOR, CHILD].sort(),
    );
    expect(db.upserts.flat().some((row) => row.ad_account_id === OTHER)).toBe(false);
    expect(db.receipts).toHaveLength(2);
  });

  it("preserves a failed family and records only the successful source", async () => {
    const db = fakeDatabase([account(ANCHOR)], [stored()]);
    mocks.createServiceClient.mockReturnValue(db.client);
    mocks.resolveReportingSources.mockResolvedValue([pairedSource()]);
    mocks.fetchGoogleReportingDailyMetrics.mockRejectedValue(new Error("Windsor unavailable"));
    mocks.createShopifyReportingAdapter.mockResolvedValue({
      fetchDailySales: vi.fn(async () => successfulShopify(90)),
      fetchCollectionProductKeys: vi.fn(),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(db.upserts.flat()[0]).toMatchObject({ ad_spend: 10, revenue: 90 });
    expect(db.receipts).toEqual([
      expect.objectContaining({
        p_binding_id: ANCHOR_BINDING,
        p_source_type: "shopify",
      }),
    ]);
  });

  it("fails closed on a first-write family failure and commits no receipt", async () => {
    const db = fakeDatabase([account(ANCHOR)]);
    mocks.createServiceClient.mockReturnValue(db.client);
    mocks.resolveReportingSources.mockResolvedValue([pairedSource()]);
    mocks.fetchGoogleReportingDailyMetrics.mockRejectedValue(new Error("Windsor unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(db.upserts).toEqual([]);
    expect(db.receipts).toEqual([]);
    expect(mocks.fetchLiveDailyBreakdown).not.toHaveBeenCalled();
    expect(mocks.fetchDailySales).not.toHaveBeenCalled();
  });

  it("refuses to erase Shopify facts from a partial legacy Google binding", async () => {
    const legacyGoogle = account(CHILD, { reporting_role: "legacy_hybrid" });
    const db = fakeDatabase(
      [legacyGoogle],
      [
        stored({
          ad_account_id: CHILD,
          revenue: 50,
          orders_count: 2,
          units_sold: 2,
          attributed_orders: 2,
          attributed_revenue: 50,
        }),
      ],
    );
    mocks.resolveReportingSources.mockResolvedValue([childSource()]);

    await expect(
      refreshReportingSourcesNow([CHILD], {
        client: db.client as never,
        from: DAY,
        to: DAY,
      }),
    ).rejects.toThrow("would erase historical facts");

    expect(mocks.fetchGoogleReportingDailyMetrics).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
    expect(db.receipts).toEqual([]);
  });

  it("refuses to erase Google facts from a partial legacy Shopify binding", async () => {
    const legacyShopify = account(ANCHOR, { reporting_role: "legacy_hybrid" });
    const db = fakeDatabase([legacyShopify], [stored({ ad_spend: 10 })]);
    mocks.resolveReportingSources.mockResolvedValue([anchorSource()]);

    await expect(
      refreshReportingSourcesNow([ANCHOR], {
        client: db.client as never,
        from: DAY,
        to: DAY,
      }),
    ).rejects.toThrow("would erase historical facts");

    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
    expect(db.receipts).toEqual([]);
  });

  it("fails closed when the receipt RPC is unavailable after the metric upsert", async () => {
    const db = fakeDatabase([account(ANCHOR)]);
    mocks.resolveReportingSources.mockResolvedValue([anchorSource()]);
    db.client.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "RPC not deployed" },
    });

    await expect(
      refreshReportingSourcesNow([ANCHOR], {
        client: db.client as never,
        from: DAY,
        to: DAY,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "PGRST202" }));

    expect(db.upserts).toHaveLength(1);
    expect(mocks.fetchLiveDailyBreakdown).not.toHaveBeenCalled();
    expect(mocks.fetchDailySales).not.toHaveBeenCalled();
  });

  it("uses V2 explicitly before cutover to create readiness receipts", async () => {
    const db = fakeDatabase([account(ANCHOR)], [], {}, {
      [CLIENT]: "v2_ready_for_cutover",
    });
    mocks.resolveReportingSources.mockResolvedValue([anchorSource()]);

    await refreshReportingSourcesNow([ANCHOR], {
      client: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.createShopifyReportingAdapter).toHaveBeenCalledTimes(1);
    expect(mocks.fetchLiveDailyBreakdown).not.toHaveBeenCalled();
    expect(db.receipts).toEqual([
      expect.objectContaining({
        p_binding_id: ANCHOR_BINDING,
        p_source_type: "shopify",
      }),
    ]);
  });

  it("rejects a missing requested account before resolving or fetching", async () => {
    const missing = "70000000-0000-4000-8000-000000000099";
    const db = fakeDatabase([account(ANCHOR)]);

    await expect(
      refreshReportingSourcesNow([ANCHOR, missing], {
        client: db.client as never,
        from: DAY,
        to: DAY,
      }),
    ).rejects.toThrow("A requested reporting account does not exist.");

    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingDailyMetrics).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it("rejects an unresolved requested binding before fetching", async () => {
    const db = fakeDatabase([account(ANCHOR)]);
    mocks.resolveReportingSources.mockResolvedValue([]);

    await expect(
      refreshReportingSourcesNow([ANCHOR], {
        client: db.client as never,
        from: DAY,
        to: DAY,
      }),
    ).rejects.toThrow("The requested V2 reporting scope is incomplete.");

    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingDailyMetrics).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it("rejects Google reporting without a timezone before fetching", async () => {
    const db = fakeDatabase([account(CHILD, { reporting_role: "google_spend" })]);
    const source = childSource();
    source.googleAds = { ...source.googleAds!, timeZone: null };
    mocks.resolveReportingSources.mockResolvedValue([source]);

    await expect(
      refreshReportingSourcesNow([CHILD], {
        client: db.client as never,
        from: DAY,
        to: DAY,
      }),
    ).rejects.toThrow("A V2 Google Ads source has incomplete reporting metadata.");

    expect(mocks.fetchGoogleReportingDailyMetrics).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
    expect(db.receipts).toEqual([]);
  });

  it("keeps a ready binding on legacy until the rollout gate is active", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      google_ads_customer_id: "1112223333",
      google_ads_connected: true,
      google_ads_refresh_token: "encrypted-token",
    });
    const db = fakeDatabase([legacy], [], {}, {
      [CLIENT]: "v2_ready_for_cutover",
    });
    mocks.resolveReportingSources.mockResolvedValue([pairedSource()]);
    mocks.fetchLiveDailyBreakdown.mockResolvedValue([
      {
        date: DAY,
        spend: 12,
        impressions: 120,
        clicks: 12,
        conversions: 2,
        conversionValue: 30,
      },
    ]);

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
    expect(mocks.fetchLiveDailyBreakdown).toHaveBeenCalledTimes(1);
    expect(mocks.createShopifyReportingAdapter).not.toHaveBeenCalled();
    expect(db.receipts).toEqual([]);
  });

  it("keeps a historical V2-active lifecycle on legacy until reporting is cut over", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      google_ads_customer_id: "1112223333",
      google_ads_connected: true,
      google_ads_refresh_token: "encrypted-token",
    });
    const db = fakeDatabase([legacy], [], {}, {
      [CLIENT]: {
        operationalSurface: "v2_active",
        reportingCutoverAt: null,
      },
    });
    mocks.resolveReportingSources.mockResolvedValue([pairedSource()]);
    mocks.fetchLiveDailyBreakdown.mockResolvedValue([
      {
        date: DAY,
        spend: 12,
        impressions: 120,
        clicks: 12,
        conversions: 2,
        conversionValue: 30,
      },
    ]);

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
    expect(mocks.fetchLiveDailyBreakdown).toHaveBeenCalledTimes(1);
    expect(mocks.fetchGoogleReportingDailyMetrics).not.toHaveBeenCalled();
    expect(db.receipts).toEqual([]);
  });

  it("materialises every selected legacy day when Shopify answers with no rows", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      shopify_url: "store.myshopify.com",
      shopify_connected: true,
      shopify_admin_token: "encrypted-shopify-token",
    });
    const db = fakeDatabase([legacy], [], {}, {
      [CLIENT]: "v2_ready_for_cutover",
    });
    mocks.fetchDailySales.mockResolvedValue({ currency: "EUR", days: [], orders: [] });

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: "2026-08-12",
      to: DAY,
    });

    expect(db.upserts.flat()).toEqual([
      expect.objectContaining({
        ad_account_id: ANCHOR,
        day: "2026-08-12",
        ad_spend: 0,
        revenue: 0,
        attributed_orders: 0,
        attributed_revenue: 0,
      }),
      expect.objectContaining({
        ad_account_id: ANCHOR,
        day: DAY,
        ad_spend: 0,
        revenue: 0,
        attributed_orders: 0,
        attributed_revenue: 0,
      }),
    ]);
  });

  it("uses the Lisbon reporting day for the default incremental window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T23:30:00.000Z"));
    try {
      const legacy = account(ANCHOR, {
        status: "active",
        reporting_role: "legacy_hybrid",
        shopify_url: "store.myshopify.com",
        shopify_connected: true,
        shopify_admin_token: "encrypted-shopify-token",
      });
      const db = fakeDatabase([legacy], [], {}, {
        [CLIENT]: "v2_ready_for_cutover",
      });
      mocks.fetchDailySales.mockResolvedValue({ currency: "EUR", days: [], orders: [] });

      await refreshAccountsNow([ANCHOR], {
        client: db.client as never,
        reportingClient: db.client as never,
      });

      expect(mocks.fetchDailySales).toHaveBeenCalledWith(
        "store.myshopify.com",
        undefined,
        "2026-08-09",
        "2026-08-15",
      );
      expect(db.upserts.flat().at(-1)).toMatchObject({ day: "2026-08-15" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not materialise zero days when no legacy provider answered", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      google_ads_customer_id: "1112223333",
      google_ads_connected: true,
      google_ads_refresh_token: "encrypted-token",
    });
    const db = fakeDatabase([legacy], [], {}, {});
    mocks.hasGoogleAdsEnv.mockReturnValue(false);

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.fetchLiveDailyBreakdown).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it("does not turn an unavailable connected Google family into zero spend", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      google_ads_customer_id: "1112223333",
      google_ads_connected: true,
      google_ads_refresh_token: "encrypted-token",
      shopify_url: "store.myshopify.com",
      shopify_connected: true,
      shopify_admin_token: "encrypted-shopify-token",
    });
    const db = fakeDatabase([legacy], [], {}, {
      [CLIENT]: "v2_ready_for_cutover",
    });
    mocks.hasGoogleAdsEnv.mockReturnValue(false);
    mocks.fetchDailySales.mockResolvedValue({ currency: "EUR", days: [], orders: [] });

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.fetchDailySales).toHaveBeenCalledTimes(1);
    expect(db.upserts).toEqual([]);
  });

  it("performs no sync when rollout authority cannot be established", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      google_ads_customer_id: "1112223333",
      google_ads_connected: true,
      google_ads_refresh_token: "encrypted-token",
    });
    const db = fakeDatabase([legacy], [], {}, "error");

    await expect(
      refreshAccountsNow([ANCHOR], {
        client: db.client as never,
        reportingClient: db.client as never,
        from: DAY,
        to: DAY,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "DB_DOWN" }));

    expect(mocks.resolveReportingSources).not.toHaveBeenCalled();
    expect(mocks.fetchLiveDailyBreakdown).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleReportingDailyMetrics).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it("does not sync when legacy credential lookup fails", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      google_ads_customer_id: "1112223333",
      google_ads_connected: true,
      google_ads_refresh_token: "encrypted-token",
    });
    const db = fakeDatabase([legacy], [], {}, {}, "error");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await recomputeDailyMetrics([legacy], {
      force: true,
      client: db.client as never,
      reportingClient: db.client as never,
    });

    expect(mocks.fetchLiveDailyBreakdown).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it("does not zero Shopify when a connected legacy store has no secret", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      shopify_url: "store.myshopify.com",
      shopify_connected: true,
      shopify_admin_token: null,
    });
    const db = fakeDatabase([legacy], [], {}, {});
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.fetchDailySales).not.toHaveBeenCalled();
    expect(db.upserts).toEqual([]);
  });

  it("leaves an unbound active legacy account on the existing token path", async () => {
    const legacy = account(ANCHOR, {
      status: "active",
      reporting_role: "legacy_hybrid",
      google_ads_customer_id: "1112223333",
      google_ads_connected: true,
      google_ads_refresh_token: "encrypted-token",
    });
    const db = fakeDatabase([legacy], [], {}, {});
    mocks.createServiceClient.mockReturnValue(db.client);
    mocks.resolveReportingSources.mockResolvedValue([]);
    mocks.fetchLiveDailyBreakdown.mockResolvedValue([
      {
        date: DAY,
        spend: 12,
        impressions: 120,
        clicks: 12,
        conversions: 2,
        conversionValue: 30,
      },
    ]);

    await refreshAccountsNow([ANCHOR], {
      client: db.client as never,
      reportingClient: db.client as never,
      from: DAY,
      to: DAY,
    });

    expect(mocks.fetchLiveDailyBreakdown).toHaveBeenCalledWith(
      "1112223333",
      "legacy-token",
      DAY,
      DAY,
      "EUR",
    );
    expect(mocks.fetchGoogleReportingDailyMetrics).not.toHaveBeenCalled();
    expect(db.upserts.flat()[0]).toMatchObject({ ad_spend: 12, revenue: 0 });
    expect(db.receipts).toEqual([]);
  });
});
