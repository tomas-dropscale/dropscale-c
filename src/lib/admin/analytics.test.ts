import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  snapshotIsStale: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  requireClientOnboardingAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/admin/reporting-snapshots", () => ({
  adminReportingSnapshotIsStale: mocks.snapshotIsStale,
}));

import { listAdminAnalyticsClients } from "./analytics";

function query(data: unknown, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>["then"];
  } = {
    select: vi.fn(),
    eq: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.then = (resolve, reject) => Promise.resolve({ data, error }).then(resolve, reject);
  return chain;
}

function service({
  clients = [],
  admins = [],
  accounts = [],
  rollouts = [],
  shopifyConnections = [],
  campaignSnapshots = [],
  errors = {},
}: {
  clients?: unknown[];
  admins?: unknown[];
  accounts?: unknown[];
  rollouts?: unknown[];
  shopifyConnections?: unknown[];
  campaignSnapshots?: unknown[];
  errors?: Partial<Record<string, unknown>>;
}) {
  const queries = {
    portal_clients: query(clients, errors.portal_clients),
    profiles: query(admins, errors.profiles),
    ad_accounts: query(accounts, errors.ad_accounts),
    client_rollout_states: query(rollouts, errors.client_rollout_states),
    client_shopify_connections: query(
      shopifyConnections,
      errors.client_shopify_connections,
    ),
    admin_reporting_range_snapshots: query(
      campaignSnapshots,
      errors.admin_reporting_range_snapshots,
    ),
  };
  return {
    queries,
    client: {
      from: vi.fn((table: keyof typeof queries) => queries[table]),
    },
  };
}

const completeMarker = {
  operational_surface: "v2_active",
  reporting_cutover_at: "2026-08-14T09:00:00Z",
  reporting_cutover_by: "admin-1",
  reporting_cutover_reason: "Reporting cutover",
};
const range = { key: "custom", from: "2026-08-01", to: "2026-08-07" } as const;

describe("admin analytics client catalogue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callOrder.length = 0;
    mocks.snapshotIsStale.mockReturnValue(false);
    mocks.requireAdmin.mockImplementation(async () => {
      mocks.callOrder.push("auth");
      return { id: "admin-1", role: "admin" };
    });
  });

  it("authenticates first, then returns sorted approved non-admin clients with evidence", async () => {
    const setup = service({
      clients: [
        {
          id: "zeta",
          full_name: "Zeta Commerce",
          email: "zeta@example.com",
          approval_status: "approved",
        },
        {
          id: "alpha",
          full_name: "Alpha Studio",
          email: "alpha@example.com",
          approval_status: "approved",
        },
        {
          id: "empty",
          full_name: "Empty Client",
          email: "empty@example.com",
          approval_status: "approved",
        },
        {
          id: "rolled-back",
          full_name: "Rolled Back",
          email: "rollback@example.com",
          approval_status: "approved",
        },
        {
          id: "internal",
          full_name: "Internal Admin",
          email: "admin@example.com",
          approval_status: "approved",
        },
        {
          id: "pending",
          full_name: "Pending Client",
          email: "pending@example.com",
          approval_status: "pending",
        },
      ],
      admins: [{ id: "internal", role: "admin" }],
      accounts: [
        {
          id: "account-1",
          client_id: "zeta",
          store_name: "Alpha Store",
          shopify_url: "alpha.myshopify.com",
        },
        {
          id: "account-2",
          client_id: "zeta",
          store_name: "Beta Store",
          shopify_url: "beta.myshopify.com",
        },
        {
          id: "duplicate-domain",
          client_id: "zeta",
          store_name: "Duplicate Alpha",
          shopify_url: "https://ALPHA.myshopify.com/products/example",
        },
        {
          id: "google-child",
          client_id: "zeta",
          store_name: "Google child",
          shopify_url: null,
        },
        {
          id: "account-admin",
          client_id: "internal",
          store_name: "Admin",
          shopify_url: "admin.myshopify.com",
        },
        {
          id: "account-pending",
          client_id: "pending",
          store_name: "Pending",
          shopify_url: null,
        },
      ],
      rollouts: [
        { client_id: "alpha", ...completeMarker },
        {
          client_id: "empty",
          operational_surface: "v2_active",
          reporting_cutover_at: null,
          reporting_cutover_by: null,
          reporting_cutover_reason: null,
        },
        {
          client_id: "rolled-back",
          ...completeMarker,
          operational_surface: "rollback_legacy",
        },
      ],
      shopifyConnections: [
        {
          client_id: "zeta",
          status: "connected",
          shopify_domain: "alpha.myshopify.com",
          primary_domain: "store.alpha.example",
          last_verified_at: "2026-08-14T09:00:00Z",
          last_error_code: null,
        },
      ],
      campaignSnapshots: [
        {
          scope_account_id: "account-1",
          state: "ready",
          payload: [{ status: "active" }, { status: "paused" }],
          last_success_at: "2026-08-07T09:00:00Z",
          last_error_code: null,
          revision: 1,
        },
      ],
    });
    mocks.createServiceClient.mockImplementation(() => {
      mocks.callOrder.push("service");
      return setup.client;
    });

    await expect(listAdminAnalyticsClients(range)).resolves.toEqual([
      {
        id: "alpha",
        name: "Alpha Studio",
        email: "alpha@example.com",
        storeCount: 0,
        stores: [],
        hasRunningActivity: false,
      },
      {
        id: "zeta",
        name: "Zeta Commerce",
        email: "zeta@example.com",
        storeCount: 2,
        stores: [
          {
            id: "account-2",
            name: "Beta Store",
            domain: "beta.myshopify.com",
          },
          {
            id: "account-1",
            name: "Alpha Store",
            domain: "store.alpha.example",
          },
        ],
        hasRunningActivity: true,
      },
    ]);
    expect(mocks.callOrder).toEqual(["auth", "service"]);
    expect(setup.client.from.mock.calls.map(([table]) => table)).toEqual([
      "portal_clients",
      "profiles",
      "ad_accounts",
      "client_rollout_states",
      "client_shopify_connections",
      "admin_reporting_range_snapshots",
    ]);
    expect(setup.queries.portal_clients.eq).toHaveBeenCalledWith(
      "approval_status",
      "approved",
    );
    expect(setup.queries.profiles.eq).toHaveBeenCalledWith("role", "admin");
    expect(setup.queries.client_shopify_connections.eq).toHaveBeenCalledWith(
      "status",
      "connected",
    );
    expect(setup.queries.admin_reporting_range_snapshots.eq.mock.calls).toEqual([
      ["family", "google_campaigns"],
      ["from_day", range.from],
      ["to_day", range.to],
    ]);
  });

  it("does not infer Running from an active account or an invalid campaign snapshot", async () => {
    const setup = service({
      clients: [
        {
          id: "client-1",
          full_name: "Northwind",
          email: "northwind@example.com",
          approval_status: "approved",
        },
      ],
      accounts: [
        {
          id: "account-1",
          client_id: "client-1",
          store_name: "Northwind Store",
          shopify_url: "northwind.myshopify.com",
          status: "active",
        },
      ],
      campaignSnapshots: [
        {
          scope_account_id: "account-1",
          state: "ready",
          payload: [{ status: "active" }],
          last_success_at: "2026-08-07T09:00:00Z",
          last_error_code: "provider_failed",
          revision: 1,
        },
      ],
    });
    mocks.createServiceClient.mockReturnValue(setup.client);

    const clients = await listAdminAnalyticsClients(range);

    expect(clients[0]?.hasRunningActivity).toBe(false);
  });

  it("does not show Running when the exact-range campaign snapshot is stale", async () => {
    mocks.snapshotIsStale.mockReturnValue(true);
    const setup = service({
      clients: [
        {
          id: "client-1",
          full_name: "Northwind",
          email: "northwind@example.com",
          approval_status: "approved",
        },
      ],
      accounts: [
        {
          id: "account-1",
          client_id: "client-1",
          store_name: "Northwind Store",
          shopify_url: "northwind.myshopify.com",
        },
      ],
      campaignSnapshots: [
        {
          scope_account_id: "account-1",
          state: "partial",
          payload: [{ status: "active" }],
          last_success_at: "2026-08-07T09:00:00Z",
          last_error_code: null,
          revision: 2,
        },
      ],
    });
    mocks.createServiceClient.mockReturnValue(setup.client);

    const clients = await listAdminAnalyticsClients(range);

    expect(clients[0]?.hasRunningActivity).toBe(false);
  });

  it("falls back to the canonical Shopify domain when a public domain is not verified", async () => {
    const setup = service({
      clients: [
        {
          id: "client-1",
          full_name: "Northwind",
          email: "northwind@example.com",
          approval_status: "approved",
        },
      ],
      accounts: [
        {
          id: "account-1",
          client_id: "client-1",
          store_name: "Northwind Store",
          shopify_url: "northwind.myshopify.com",
        },
      ],
      shopifyConnections: [
        {
          client_id: "client-1",
          status: "connected",
          shopify_domain: "northwind.myshopify.com",
          primary_domain: "unverified.example",
          last_verified_at: null,
          last_error_code: null,
        },
      ],
    });
    mocks.createServiceClient.mockReturnValue(setup.client);

    await expect(listAdminAnalyticsClients(range)).resolves.toEqual([
      {
        id: "client-1",
        name: "Northwind",
        email: "northwind@example.com",
        storeCount: 1,
        stores: [
          {
            id: "account-1",
            name: "Northwind Store",
            domain: "northwind.myshopify.com",
          },
        ],
        hasRunningActivity: false,
      },
    ]);
  });

  it("lists healthy connection-only domains as unselectable onboarding stores", async () => {
    const setup = service({
      clients: [
        {
          id: "client-1",
          full_name: "Northwind",
          email: "northwind@example.com",
          approval_status: "approved",
        },
        {
          id: "client-2",
          full_name: "Connection Only",
          email: "connection@example.com",
          approval_status: "approved",
        },
      ],
      accounts: [
        {
          id: "account-1",
          client_id: "client-1",
          store_name: "Existing Store",
          shopify_url: "existing.myshopify.com",
        },
      ],
      shopifyConnections: [
        {
          client_id: "client-1",
          status: "connected",
          shopify_domain: "other.myshopify.com",
          primary_domain: "other.example",
          last_verified_at: "2026-08-15T10:00:00Z",
          last_error_code: null,
        },
        {
          client_id: "client-2",
          status: "connected",
          shopify_domain: "only.myshopify.com",
          primary_domain: "only.example",
          last_verified_at: "2026-08-15T10:00:00Z",
          last_error_code: null,
        },
      ],
    });
    mocks.createServiceClient.mockReturnValue(setup.client);

    await expect(listAdminAnalyticsClients(range)).resolves.toEqual([
      {
        id: "client-2",
        name: "Connection Only",
        email: "connection@example.com",
        storeCount: 1,
        stores: [{ id: null, name: "only.example", domain: "only.example" }],
        hasRunningActivity: false,
      },
      {
        id: "client-1",
        name: "Northwind",
        email: "northwind@example.com",
        storeCount: 2,
        stores: [
          {
            id: "account-1",
            name: "Existing Store",
            domain: "existing.myshopify.com",
          },
          { id: null, name: "other.example", domain: "other.example" },
        ],
        hasRunningActivity: false,
      },
    ]);
  });

  it("does not construct the service client when admin reauthentication fails", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("Forbidden"));

    await expect(listAdminAnalyticsClients(range)).rejects.toThrow("Forbidden");
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("fails closed on a partial reporting marker", async () => {
    const setup = service({
      rollouts: [
        {
          client_id: "client-1",
          operational_surface: "v2_active",
          reporting_cutover_at: completeMarker.reporting_cutover_at,
          reporting_cutover_by: null,
          reporting_cutover_reason: null,
        },
      ],
    });
    mocks.createServiceClient.mockReturnValue(setup.client);

    await expect(listAdminAnalyticsClients(range)).rejects.toThrow("inconsistent");
  });

  it.each([
    { operational_surface: "unknown", reporting_cutover_at: null },
    { operational_surface: "v2_active", reporting_cutover_at: "not-a-date" },
  ])("fails closed on unknown rollout authority", async (rollout) => {
    const setup = service({
      rollouts: [
        {
          client_id: "client-1",
          reporting_cutover_by: rollout.reporting_cutover_at ? "admin-1" : null,
          reporting_cutover_reason: rollout.reporting_cutover_at ? "cutover" : null,
          ...rollout,
        },
      ],
    });
    mocks.createServiceClient.mockReturnValue(setup.client);

    await expect(listAdminAnalyticsClients(range)).rejects.toThrow("inconsistent");
  });

  it("fails closed when a catalogue read fails", async () => {
    const setup = service({ errors: { ad_accounts: { code: "42501" } } });
    mocks.createServiceClient.mockReturnValue(setup.client);

    await expect(listAdminAnalyticsClients(range)).rejects.toThrow("unavailable");
  });
});
