import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getSessionProfile: vi.fn(),
  createServiceClient: vi.fn(),
  fetchPendingCounts: vi.fn(),
  countActiveClients: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.createServiceClient }));
// The reporting day is the real one: what the Lisbon clock says under a frozen
// system time is exactly what these reads have to filter on.
vi.mock("@/lib/portal/range", () => import("../portal/range"));
vi.mock("./approvals", () => ({ fetchPendingCounts: mocks.fetchPendingCounts }));
vi.mock("./active-clients", () => ({ countActiveClients: mocks.countActiveClients }));

import { fetchAdminOperations } from "./operations-overview";

/** Noon UTC is early afternoon in Lisbon, so the day cannot be ambiguous. */
const NOW = "2026-09-15T12:00:00.000Z";
const TODAY = "2026-09-15";

type TableResult = { data?: unknown; count?: number | null; error?: unknown };

function query(result: TableResult) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>["then"];
  } = {
    select: vi.fn(),
    eq: vi.fn(),
    not: vi.fn(),
    or: vi.fn(),
  };
  for (const step of [chain.select, chain.eq, chain.not, chain.or]) {
    step.mockReturnValue(chain);
  }
  chain.then = (resolve, reject) =>
    Promise.resolve({ data: null, count: null, error: null, ...result }).then(
      resolve,
      reject,
    );
  return chain;
}

/**
 * A client that knows only the tables its key is actually allowed to read, so
 * asking the wrong one throws instead of quietly answering. That is the point
 * of splitting the fixtures: the four service-only tables are revoked from
 * `authenticated`, and a test where both clients answer everything could never
 * tell which key the code used.
 */
function session(tables: Record<string, TableResult>) {
  return {
    from: vi.fn((table: string) => {
      const result = tables[table];
      if (!result) throw new Error(`Unexpected table: ${table}`);
      return query(result);
    }),
  };
}

function chainFor(client: ReturnType<typeof session>, table: string) {
  const index = client.from.mock.calls.findIndex(([name]) => name === table);
  return client.from.mock.results[index]?.value as ReturnType<typeof query>;
}

/** What the caller's own session may read: the admin RLS policies cover it. */
const SESSION_TABLES: Record<string, TableResult> = {
  daily_metrics: {
    data: [
      { ad_account_id: "store-a", computed_at: "2026-09-15T11:40:00.000Z" },
      { ad_account_id: "store-a", computed_at: "2026-09-15T11:55:00+00:00" },
      { ad_account_id: "store-b", computed_at: "2026-09-15T10:00:00.000Z" },
      // A legacy account writes metrics today without any binding at all.
      { ad_account_id: "legacy-x", computed_at: "2026-09-15T09:30:00.000Z" },
    ],
  },
};

/** What only the service key may read (migrations 0044, 0054, 0062). */
const SERVICE_TABLES: Record<string, TableResult> = {
  client_shopify_connections: { count: 2 },
  client_google_ads_connections: { count: 1 },
  client_reporting_bindings: {
    data: [
      { ad_account_id: "store-a", shopify_connection_id: "shop-a" },
      // The same store's Google account: its own binding on its own ad account,
      // pointing back at the anchor above. It is not a second store.
      { ad_account_id: "store-a-google", shopify_connection_id: null },
      { ad_account_id: "store-b", shopify_connection_id: "shop-b" },
      { ad_account_id: "store-c", shopify_connection_id: "shop-c" },
    ],
  },
  admin_reporting_range_snapshots: {
    data: [
      { last_success_at: "2026-09-15T11:30:00.000Z", last_error_code: null },
      { last_success_at: "2026-09-15T09:00:00.000Z", last_error_code: null },
      { last_success_at: "2026-09-15T11:50:00.000Z", last_error_code: "windsor_timeout" },
      { last_success_at: null, last_error_code: null },
    ],
  },
};

/** Overrides land on whichever client owns that table, and nowhere else. */
function merged(
  base: Record<string, TableResult>,
  overrides: Record<string, TableResult>,
) {
  const next = { ...base };
  for (const [table, result] of Object.entries(overrides)) {
    if (table in next) next[table] = result;
  }
  return next;
}

function wire(overrides: Record<string, TableResult> = {}) {
  const sessionClient = session(merged(SESSION_TABLES, overrides));
  const serviceClient = session(merged(SERVICE_TABLES, overrides));
  mocks.createClient.mockResolvedValue(sessionClient);
  mocks.createServiceClient.mockReturnValue(serviceClient);
  return { sessionClient, serviceClient };
}

describe("admin operations overview", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getSessionProfile.mockResolvedValue({
      user: { id: "admin-1" },
      profile: { id: "admin-1", role: "admin" },
    });
    mocks.fetchPendingCounts.mockResolvedValue({
      clients: 2,
      accounts: 1,
      requests: 3,
      creatives: 4,
      total: 10,
    });
    mocks.countActiveClients.mockResolvedValue(7);
    wire();
  });

  afterEach(() => {
    vi.useRealTimers();
    logged.mockRestore();
  });

  it("answers with counts and timestamps only, on the Lisbon day", async () => {
    const { sessionClient, serviceClient } = wire();

    await expect(fetchAdminOperations()).resolves.toEqual({
      needsDecision: {
        pendingClients: 2,
        pendingAccounts: 1,
        accountRequests: 3,
        newCreatives: 4,
        failingConnections: 3,
      },
      reporting: {
        storesBound: 3,
        storesReportingToday: 2,
        storesSilentToday: 1,
        lastMetricAt: "2026-09-15T11:55:00+00:00",
      },
      snapshots: {
        fresh: 1,
        total: 4,
        oldestSuccessAt: "2026-09-15T09:00:00.000Z",
      },
      activeClients: 7,
    });

    const metrics = chainFor(sessionClient, "daily_metrics");
    expect(metrics.eq).toHaveBeenCalledWith("day", TODAY);
    expect(metrics.or).toHaveBeenCalledWith("revenue.gt.0,ad_spend.gt.0");

    const snapshots = chainFor(serviceClient, "admin_reporting_range_snapshots");
    expect(snapshots.eq).toHaveBeenCalledWith("family", "store_campaign_performance");
    expect(snapshots.eq).toHaveBeenCalledWith("from_day", TODAY);
    expect(snapshots.eq).toHaveBeenCalledWith("to_day", TODAY);

    const bindings = chainFor(serviceClient, "client_reporting_bindings");
    expect(bindings.eq).toHaveBeenCalledWith("status", "active");

    const shopify = chainFor(serviceClient, "client_shopify_connections");
    expect(shopify.eq).toHaveBeenCalledWith("status", "connected");
    expect(shopify.not).toHaveBeenCalledWith("last_error_code", "is", null);

    expect(logged).not.toHaveBeenCalled();
  });

  it("reads the revoked tables with the service key, never with the caller's session", async () => {
    const { sessionClient, serviceClient } = wire();

    await fetchAdminOperations();

    // A GRANT is checked before RLS, so any of these four on the session client
    // would come back as permission denied rather than as an empty answer.
    const asked = sessionClient.from.mock.calls.map(([table]) => table);
    expect(asked).toEqual(["daily_metrics"]);

    const service = serviceClient.from.mock.calls.map(([table]) => table);
    expect(service).toContain("client_shopify_connections");
    expect(service).toContain("client_google_ads_connections");
    expect(service).toContain("client_reporting_bindings");
    expect(service).toContain("admin_reporting_range_snapshots");
  });

  it("blinds one group and still answers the others", async () => {
    wire({ daily_metrics: { data: null, error: { code: "42501" } } });

    const operations = await fetchAdminOperations();

    expect(operations.reporting).toBeNull();
    expect(operations.needsDecision?.failingConnections).toBe(3);
    expect(operations.snapshots?.total).toBe(4);
    expect(operations.activeClients).toBe(7);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("blinds the pending counts without touching the machine panels", async () => {
    mocks.fetchPendingCounts.mockRejectedValue(new Error("RLS refused the read"));

    const operations = await fetchAdminOperations();

    expect(operations.needsDecision).toBeNull();
    expect(operations.reporting?.storesBound).toBe(3);
    expect(operations.snapshots?.fresh).toBe(1);
    expect(operations.activeClients).toBe(7);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("keeps the counts that are waiting when only the connection health fails", async () => {
    wire({ client_google_ads_connections: { count: null, error: { code: "42501" } } });

    const operations = await fetchAdminOperations();

    // The sidebar badge is answering "six clients waiting" from this very call,
    // so the panel beside it must not go blank over an unrelated count.
    expect(operations.needsDecision).toEqual({
      pendingClients: 2,
      pendingAccounts: 1,
      accountRequests: 3,
      newCreatives: 4,
      failingConnections: null,
    });
    expect(operations.reporting?.storesBound).toBe(3);
    expect(operations.snapshots?.total).toBe(4);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("blinds the active client count on its own", async () => {
    mocks.countActiveClients.mockRejectedValue(
      new Error("The active client projection is unavailable."),
    );

    const operations = await fetchAdminOperations();

    expect(operations.activeClients).toBeNull();
    expect(operations.needsDecision?.pendingClients).toBe(2);
    expect(operations.reporting?.storesReportingToday).toBe(2);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("goes fully blind when there is no session client at all", async () => {
    mocks.createClient.mockRejectedValue(new Error("No cookie store"));

    await expect(fetchAdminOperations()).resolves.toEqual({
      needsDecision: null,
      reporting: null,
      snapshots: null,
      activeClients: null,
    });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("never reaches for the service key when the caller is not an admin", async () => {
    mocks.getSessionProfile.mockResolvedValue({
      user: { id: "client-1" },
      profile: { id: "client-1", role: "client" },
    });

    const operations = await fetchAdminOperations();

    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    // What rides RLS still answers; what needs the service key says so.
    expect(operations.needsDecision?.pendingClients).toBe(2);
    expect(operations.needsDecision?.failingConnections).toBeNull();
    expect(operations.reporting).toBeNull();
    expect(operations.snapshots).toBeNull();
    expect(operations.activeClients).toBe(7);
  });

  it("goes blind on the service panels when the service key is absent", async () => {
    mocks.createServiceClient.mockReturnValue(null);

    const operations = await fetchAdminOperations();

    expect(operations.needsDecision?.failingConnections).toBeNull();
    expect(operations.reporting).toBeNull();
    expect(operations.snapshots).toBeNull();
    expect(operations.activeClients).toBe(7);
  });

  it("counts a store once, by its Shopify anchor", async () => {
    // Three anchors and one Google child. Counting bindings would say four
    // stores are bound and call a metric child of store-a a store of its own.
    await expect(fetchAdminOperations()).resolves.toMatchObject({
      reporting: { storesBound: 3, storesReportingToday: 2, storesSilentToday: 1 },
    });
  });

  it("does not let an unbound account hide a store that went silent", async () => {
    wire({
      daily_metrics: {
        data: [
          { ad_account_id: "store-a", computed_at: "2026-09-15T11:00:00.000Z" },
          { ad_account_id: "store-b", computed_at: "2026-09-15T11:10:00.000Z" },
          // Two legacy accounts, bound to nothing, writing today.
          { ad_account_id: "legacy-x", computed_at: "2026-09-15T11:20:00.000Z" },
          { ad_account_id: "legacy-y", computed_at: "2026-09-15T11:30:00.000Z" },
        ],
      },
    });

    // Subtracting one total from the other would read 3 - 4 and floor to zero,
    // announcing that no store is silent on the morning store-c stopped.
    await expect(fetchAdminOperations()).resolves.toMatchObject({
      reporting: {
        storesBound: 3,
        storesReportingToday: 2,
        storesSilentToday: 1,
        lastMetricAt: "2026-09-15T11:30:00.000Z",
      },
    });
  });

  it("reports no silence when nothing is bound", async () => {
    wire({
      client_reporting_bindings: { data: [] },
      daily_metrics: { data: [] },
    });

    await expect(fetchAdminOperations()).resolves.toMatchObject({
      reporting: {
        storesBound: 0,
        storesReportingToday: 0,
        storesSilentToday: 0,
        lastMetricAt: null,
      },
    });
  });

  it("never draws a ratio with more stores reporting than bound", async () => {
    wire({ client_reporting_bindings: { data: [] } });

    // Nothing is bound, so nothing bound is reporting: the headline reads 0/0
    // rather than the 2/0 that counting every writing account would print.
    await expect(fetchAdminOperations()).resolves.toMatchObject({
      reporting: { storesBound: 0, storesReportingToday: 0, storesSilentToday: 0 },
    });
  });

  it("holds the ninety minute freshness boundary", async () => {
    wire({
      admin_reporting_range_snapshots: {
        data: [
          // Ninety minutes to the millisecond is still fresh.
          { last_success_at: "2026-09-15T10:30:00.000Z", last_error_code: null },
          // One millisecond older is not.
          { last_success_at: "2026-09-15T10:29:59.999Z", last_error_code: null },
        ],
      },
    });

    await expect(fetchAdminOperations()).resolves.toMatchObject({
      snapshots: {
        fresh: 1,
        total: 2,
        oldestSuccessAt: "2026-09-15T10:29:59.999Z",
      },
    });
  });
});
