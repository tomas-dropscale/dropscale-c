import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  workspaceAccounts: vi.fn(),
  workspaceMetricScope: vi.fn(),
  fetchDailyMetrics: vi.fn(),
  fetchSchedule: vi.fn(),
  manualReferralRateOnDay: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  requireClientOnboardingAdmin: mocks.requireAdmin,
}));
// The portal's own store list and scope, for a named workspace.
vi.mock("@/lib/portal/data", () => ({
  workspaceAccounts: mocks.workspaceAccounts,
  workspaceMetricScope: mocks.workspaceMetricScope,
}));
// queries.ts drags the whole recompute chain in; the loader only needs the
// metrics read and the ad-spend sum, so both are given here.
vi.mock("@/lib/metrics/queries", () => ({
  fetchDailyMetrics: mocks.fetchDailyMetrics,
  sumMetrics: (rows: Array<{ ad_spend: number | string }>) => ({
    adSpend: rows.reduce((sum, row) => sum + Number(row.ad_spend), 0),
  }),
}));
vi.mock("@/lib/billing/referral-rate-schedule", () => ({
  fetchManualReferralRateScheduleAsAdminOrNull: mocks.fetchSchedule,
}));
vi.mock("@/lib/billing/referrals", () => ({
  manualReferralRateOnDay: mocks.manualReferralRateOnDay,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/portal/currency", () => import("../portal/currency"));
vi.mock("@/lib/portal/pnl", () => import("../portal/pnl"));

import { clampPnlPeriod, fetchAdminClientPnl } from "./client-pnl";

const CLIENT = "70000000-0000-4000-8000-000000000001";
const ANCHOR = "70000000-0000-4000-8000-000000000010";
const CHILD = "70000000-0000-4000-8000-000000000011";
const RETIRED = "70000000-0000-4000-8000-000000000012";
const OTHER_STORE = "70000000-0000-4000-8000-000000000020";
const UNALLOCATED = "70000000-0000-4000-8000-000000000030";

type Account = {
  id: string;
  client_id: string;
  store_name: string;
  currency: string;
  commission_rate: number;
  list_commission_rate: number;
  revenue_share_enabled: boolean;
};

function account(id: string, over: Partial<Account> = {}): Account {
  return {
    id,
    client_id: CLIENT,
    store_name: "Emma Gyor",
    currency: "EUR",
    commission_rate: 10,
    list_commission_rate: 12,
    revenue_share_enabled: false,
    ...over,
  };
}

const ANCHOR_ACCOUNT = account(ANCHOR);
const OTHER_ACCOUNT = account(OTHER_STORE, {
  store_name: "Second store",
  commission_rate: 15,
  list_commission_rate: 15,
});

/** Every physical account the projection knows, retired and unallocated included. */
let catalogue: Account[] = [];

function metricRow(accountId: string, day: string, over: Record<string, unknown> = {}) {
  return {
    ad_account_id: accountId,
    day,
    revenue: 0,
    refunds_amount: 0,
    orders_count: 0,
    units_sold: 0,
    attributed_orders: 0,
    attributed_revenue: 0,
    product_cost: 0,
    payment_fees: 0,
    shipping_cost: 0,
    ad_spend: 0,
    revenue_share_base: 0,
    revenue_share_amount: 0,
    ...over,
  };
}

function session(client: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => client);
  return { from: vi.fn(() => chain) };
}

beforeEach(() => {
  vi.clearAllMocks();
  catalogue = [
    ANCHOR_ACCOUNT,
    account(CHILD, { store_name: "Google child" }),
    account(RETIRED, { store_name: "Retired Google", commission_rate: 12 }),
    OTHER_ACCOUNT,
    account(UNALLOCATED, { store_name: "Unallocated Google" }),
  ];
  mocks.createClient.mockResolvedValue(
    session({ data: { id: CLIENT, full_name: "Paulo & João" }, error: null }),
  );
  mocks.workspaceAccounts.mockResolvedValue([ANCHOR_ACCOUNT, OTHER_ACCOUNT]);
  // The portal's scope, as the projection builds it: a store is its anchor,
  // its Google children AND the accounts a handover retired under it; the
  // unallocated Google bucket joins an all-store scope only.
  mocks.workspaceMetricScope.mockImplementation(
    async (_clientId: string, accounts: Account[], options?: { includeUnallocated?: boolean }) => {
      const byStore = new Map([
        [ANCHOR, [ANCHOR, CHILD, RETIRED]],
        [OTHER_STORE, [OTHER_STORE]],
      ]);
      const requested = accounts.map((row) => row.id);
      if (requested.length === 0) {
        return {
          metricAccountIds: [],
          metricIdsByStore: new Map(),
          metricAccountsById: new Map(),
          unallocatedGoogleAccountIds: [],
        };
      }
      const metricIdsByStore = new Map(requested.map((id) => [id, byStore.get(id) ?? []]));
      const unallocated = options?.includeUnallocated ? [UNALLOCATED] : [];
      const ids = [...new Set([...[...metricIdsByStore.values()].flat(), ...unallocated])];
      return {
        metricAccountIds: ids,
        metricIdsByStore,
        metricAccountsById: new Map(
          ids.map((id) => [id, catalogue.find((row) => row.id === id)]),
        ),
        unallocatedGoogleAccountIds: unallocated,
      };
    },
  );
  mocks.fetchSchedule.mockResolvedValue(null);
  mocks.fetchDailyMetrics.mockResolvedValue([
    metricRow(ANCHOR, "2026-09-01", { revenue: 1000, refunds_amount: 50, product_cost: 300 }),
    metricRow(CHILD, "2026-09-01", { ad_spend: 100 }),
    metricRow(RETIRED, "2026-09-01", { ad_spend: 30 }),
    metricRow(OTHER_STORE, "2026-09-01", { revenue: 500, ad_spend: 40, product_cost: 100 }),
    metricRow(UNALLOCATED, "2026-09-01", { ad_spend: 25 }),
  ]);
});

describe("a client's P&L read by an admin", () => {
  it("authenticates first, then reads the whole business exactly as the portal scopes it", async () => {
    const pnl = await fetchAdminClientPnl({ clientId: CLIENT, storeId: null, year: 2026, month: 9 });

    expect(mocks.requireAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.workspaceAccounts.mock.invocationCallOrder[0]!,
    );
    expect(mocks.workspaceAccounts).toHaveBeenCalledWith(CLIENT);
    expect(mocks.workspaceMetricScope).toHaveBeenCalledWith(
      CLIENT,
      [ANCHOR_ACCOUNT, OTHER_ACCOUNT],
      { includeUnallocated: true },
    );
    // Every physical account of the client - the retired one and the
    // unallocated Google spend included - and nothing the portal would not read.
    expect(mocks.fetchDailyMetrics).toHaveBeenCalledWith(
      [ANCHOR, CHILD, RETIRED, OTHER_STORE, UNALLOCATED],
      "2026-09-01",
      "2026-09-30",
    );
    expect(mocks.fetchSchedule).toHaveBeenCalledWith(CLIENT);
    expect(pnl).toMatchObject({
      clientId: CLIENT,
      clientName: "Paulo & João",
      storeId: null,
      hasUnallocatedGoogle: true,
      unallocatedSpend: 25,
      stores: [
        { accountId: ANCHOR, storeName: "Emma Gyor", currency: "EUR" },
        { accountId: OTHER_STORE, storeName: "Second store", currency: "EUR" },
      ],
    });
    // The portal's arithmetic, untouched: net revenue 1450, spend 195, and the
    // agency fee at each account's own rate: 10% of 100, 12% of 30, 15% of 40,
    // 10% of 25.
    const day = pnl!.sheet.days.find((row) => row.day === "2026-09-01")!;
    expect(day.netRevenue).toBeCloseTo(1450, 6);
    expect(day.adSpend).toBeCloseTo(195, 6);
    expect(day.agencyFee).toBeCloseTo(22.1, 6);
    expect(pnl!.sheet.days).toHaveLength(30);
  });

  it("narrows to one store - its retired history included - and never shows unallocated spend there", async () => {
    mocks.fetchDailyMetrics.mockResolvedValue([
      metricRow(ANCHOR, "2026-09-01", { revenue: 1000, refunds_amount: 50, product_cost: 300 }),
      metricRow(CHILD, "2026-09-01", { ad_spend: 100 }),
      metricRow(RETIRED, "2026-09-01", { ad_spend: 30 }),
    ]);

    const pnl = await fetchAdminClientPnl({ clientId: CLIENT, storeId: ANCHOR, year: 2026, month: 9 });

    expect(mocks.workspaceMetricScope).toHaveBeenCalledWith(CLIENT, [ANCHOR_ACCOUNT], {
      includeUnallocated: false,
    });
    expect(mocks.fetchDailyMetrics).toHaveBeenCalledWith(
      [ANCHOR, CHILD, RETIRED],
      "2026-09-01",
      "2026-09-30",
    );
    expect(pnl).toMatchObject({ storeId: ANCHOR, hasUnallocatedGoogle: false, unallocatedSpend: 0 });
    const day = pnl!.sheet.days[0]!;
    expect(day.netRevenue).toBeCloseTo(950, 6);
    expect(day.agencyFee).toBeCloseTo(13.6, 6);
  });

  it("prices a referred account on the 10% list rate at the manual rate of the day, read as an admin", async () => {
    catalogue = catalogue.map((row) =>
      row.id === CHILD ? { ...row, list_commission_rate: 10 } : row,
    );
    const schedule = [{ effectiveFrom: "2026-08-31", revision: 1, referralCount: 6, referralDiscountRate: 3, feeRate: 7 }];
    mocks.fetchSchedule.mockResolvedValue(schedule);
    mocks.manualReferralRateOnDay.mockReturnValue(7);
    mocks.fetchDailyMetrics.mockResolvedValue([metricRow(CHILD, "2026-09-01", { ad_spend: 100 })]);

    const pnl = await fetchAdminClientPnl({ clientId: CLIENT, storeId: ANCHOR, year: 2026, month: 9 });

    expect(mocks.manualReferralRateOnDay).toHaveBeenCalledWith("2026-09-01", schedule);
    expect(pnl!.sheet.days[0]!.agencyFee).toBeCloseTo(7, 6);
  });

  it("prices such an account's fee at nothing, never at the list rate, when the schedule cannot be read", async () => {
    catalogue = catalogue.map((row) =>
      row.id === CHILD ? { ...row, list_commission_rate: 10 } : row,
    );
    mocks.fetchSchedule.mockResolvedValue(null);
    mocks.fetchDailyMetrics.mockResolvedValue([metricRow(CHILD, "2026-09-01", { ad_spend: 100 })]);

    const pnl = await fetchAdminClientPnl({ clientId: CLIENT, storeId: ANCHOR, year: 2026, month: 9 });

    expect(mocks.manualReferralRateOnDay).not.toHaveBeenCalled();
    expect(pnl!.sheet.days[0]!.agencyFee).toBe(0);
  });

  it("shows the zero sheet the client sees when their portal offers no store", async () => {
    mocks.workspaceAccounts.mockResolvedValue([]);
    mocks.fetchDailyMetrics.mockResolvedValue([]);

    const pnl = await fetchAdminClientPnl({ clientId: CLIENT, storeId: null, year: 2026, month: 9 });

    expect(mocks.fetchDailyMetrics).toHaveBeenCalledWith([], "2026-09-01", "2026-09-30");
    expect(mocks.fetchSchedule).not.toHaveBeenCalled();
    expect(pnl).toMatchObject({ stores: [], hasUnallocatedGoogle: false, unallocatedSpend: 0 });
    expect(pnl!.sheet.days).toHaveLength(30);
    expect(pnl!.sheet.totals.netRevenue).toBe(0);
  });

  it("refuses a store that is not the client's, a client that does not exist, and a failed client read", async () => {
    await expect(
      fetchAdminClientPnl({ clientId: CLIENT, storeId: "70000000-0000-4000-8000-0000000000ff", year: 2026, month: 9 }),
    ).resolves.toBeNull();

    mocks.createClient.mockResolvedValue(session({ data: null, error: null }));
    await expect(
      fetchAdminClientPnl({ clientId: CLIENT, storeId: null, year: 2026, month: 9 }),
    ).resolves.toBeNull();
    expect(mocks.workspaceAccounts).toHaveBeenCalledTimes(1);

    mocks.createClient.mockResolvedValue(session({ data: null, error: { message: "down" } }));
    await expect(
      fetchAdminClientPnl({ clientId: CLIENT, storeId: null, year: 2026, month: 9 }),
    ).rejects.toThrow("The client is unavailable.");
  });

  it("keeps the period inside the years the picker offers, on whole months", () => {
    const now = new Date("2026-09-11T12:00:00Z");
    expect(clampPnlPeriod(2030, 13, now)).toEqual({ year: 2026, month: 12 });
    expect(clampPnlPeriod(2000, 0, now)).toEqual({ year: 2024, month: 1 });
    expect(clampPnlPeriod(Number.NaN, Number.NaN, now)).toEqual({ year: 2024, month: 1 });
    expect(clampPnlPeriod(2026.7, 9.9, now)).toEqual({ year: 2026, month: 9 });
  });
});
