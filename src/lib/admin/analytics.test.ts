import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  requireClientOnboardingAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
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
  errors = {},
}: {
  clients?: unknown[];
  admins?: unknown[];
  accounts?: unknown[];
  rollouts?: unknown[];
  shopifyConnections?: unknown[];
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

describe("admin analytics client catalogue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callOrder.length = 0;
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
    });
    mocks.createServiceClient.mockImplementation(() => {
      mocks.callOrder.push("service");
      return setup.client;
    });

    await expect(listAdminAnalyticsClients()).resolves.toEqual([
      {
        id: "alpha",
        name: "Alpha Studio",
        email: "alpha@example.com",
        storeCount: 0,
        stores: [],
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
      },
    ]);
    expect(mocks.callOrder).toEqual(["auth", "service"]);
    expect(setup.client.from.mock.calls.map(([table]) => table)).toEqual([
      "portal_clients",
      "profiles",
      "ad_accounts",
      "client_rollout_states",
      "client_shopify_connections",
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

    await expect(listAdminAnalyticsClients()).resolves.toEqual([
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
      },
    ]);
  });

  it("does not construct the service client when admin reauthentication fails", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("Forbidden"));

    await expect(listAdminAnalyticsClients()).rejects.toThrow("Forbidden");
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

    await expect(listAdminAnalyticsClients()).rejects.toThrow("inconsistent");
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

    await expect(listAdminAnalyticsClients()).rejects.toThrow("inconsistent");
  });

  it("fails closed when a catalogue read fails", async () => {
    const setup = service({ errors: { ad_accounts: { code: "42501" } } });
    mocks.createServiceClient.mockReturnValue(setup.client);

    await expect(listAdminAnalyticsClients()).rejects.toThrow("unavailable");
  });
});
