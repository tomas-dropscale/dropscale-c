import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireClientOnboardingAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: class ClientOnboardingError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  requireClientOnboardingAdmin: mocks.requireClientOnboardingAdmin,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/shopify/client", () => ({
  normalizeShopDomain: (input: string) => {
    const domain = input
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
  },
}));

import { listExistingClientRoster } from "./legacy-roster";

const ADMIN = "40000000-0000-4000-8000-000000000001";
const OWNER = "40000000-0000-4000-8000-000000000002";
const PENDING = "40000000-0000-4000-8000-000000000003";
const REJECTED = "40000000-0000-4000-8000-000000000004";
const MEMBER = "40000000-0000-4000-8000-000000000005";
const MEMBER_OWNER = "40000000-0000-4000-8000-000000000006";

type TableName = "portal_clients" | "profiles" | "client_members" | "ad_accounts";
type Result = { data: Record<string, unknown>[]; error: null | { message: string } };
let results: Record<TableName, Result>;

function client(
  id: string,
  fullName: string,
  approvalStatus: "pending" | "approved" | "rejected" = "approved",
) {
  return {
    id,
    full_name: fullName,
    email: `${fullName.toLowerCase().replaceAll(" ", ".")}@example.com`,
    discord_handle: `${fullName.toLowerCase().replaceAll(" ", ".")}`,
    approval_status: approvalStatus,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    client_id: OWNER,
    store_name: "Main Store",
    status: "active",
    currency: "EUR",
    shopify_url: "main-store.myshopify.com",
    shopify_connected: true,
    shopify_scopes: " read_orders,read_products, read_orders, ,",
    shopify_connected_at: "2026-07-01T00:00:00.000Z",
    created_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("existing client roster", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    results = {
      portal_clients: { data: [], error: null },
      profiles: { data: [], error: null },
      client_members: { data: [], error: null },
      ad_accounts: { data: [], error: null },
    };
    mocks.requireClientOnboardingAdmin.mockResolvedValue({ id: ADMIN, role: "admin" });
    mocks.from.mockImplementation((table: TableName) => ({
      select: (columns: string) => {
        mocks.select(table, columns);
        return Promise.resolve(results[table]);
      },
    }));
    mocks.createServiceClient.mockReturnValue({ from: mocks.from });
  });

  it("revalidates the admin before constructing the service client", async () => {
    await listExistingClientRoster();

    expect(mocks.requireClientOnboardingAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createServiceClient.mock.invocationCallOrder[0],
    );

    mocks.requireClientOnboardingAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Unauthorised."), { status: 401 }),
    );
    await expect(listExistingClientRoster()).rejects.toMatchObject({ status: 401 });
    expect(mocks.requireClientOnboardingAdmin).toHaveBeenCalledTimes(2);
    expect(mocks.createServiceClient).toHaveBeenCalledOnce();
  });

  it("selects only explicit roster and Shopify metadata columns", async () => {
    await listExistingClientRoster();

    expect(mocks.select.mock.calls).toEqual([
      [
        "portal_clients",
        "id, full_name, email, discord_handle, approval_status, access_blocked, created_at",
      ],
      ["profiles", "id, role"],
      ["client_members", "client_id, member_id"],
      [
        "ad_accounts",
        "id, client_id, store_name, status, currency, shopify_url, shopify_connected, shopify_scopes, shopify_connected_at, created_at",
      ],
    ]);
    const selectedColumns = mocks.select.mock.calls.map(([, columns]) => columns).join(" ");
    expect(selectedColumns).not.toMatch(/\*|google|token|shopify_client_id|credential/i);
  });

  it("filters identities conservatively and keeps pending clients account-only", async () => {
    results.portal_clients.data = [
      client(PENDING, "Beta Pending", "pending"),
      client(MEMBER_OWNER, "Charlie Owner"),
      client(REJECTED, "Rejected Client", "rejected"),
      client(ADMIN, "Dropscale Admin"),
      client(MEMBER, "Pure Member"),
      client(OWNER, "Alpha Owner"),
    ];
    results.profiles.data = [{ id: ADMIN, role: "admin" }];
    results.client_members.data = [
      { client_id: OWNER, member_id: PENDING },
      { client_id: OWNER, member_id: MEMBER },
      { client_id: OWNER, member_id: MEMBER_OWNER },
    ];
    results.ad_accounts.data = [
      account({
        client_id: MEMBER_OWNER,
        id: "member-owner-store",
        shopify_scopes: null,
      }),
      account({ client_id: REJECTED, id: "rejected-store" }),
      account({ client_id: ADMIN, id: "admin-store" }),
      account(),
    ];

    const roster = await listExistingClientRoster();

    expect(roster.map((entry) => entry.fullName)).toEqual([
      "Alpha Owner",
      "Beta Pending",
      "Charlie Owner",
    ]);
    expect(roster.find((entry) => entry.clientId === PENDING)?.shopify).toEqual([]);
    expect(roster.find((entry) => entry.clientId === PENDING)?.partnerOf).toEqual([
      "Alpha Owner",
    ]);
    expect(roster.find((entry) => entry.clientId === OWNER)?.discordHandle).toBe(
      "alpha.owner",
    );
    expect(roster.find((entry) => entry.clientId === MEMBER_OWNER)?.shopify[0]).toMatchObject({
      id: "member-owner-store",
      grantedScopes: [],
      source: "legacy",
    });
  });

  it("projects only valid active Shopify stores and deduplicates normalized domains", async () => {
    results.portal_clients.data = [client(OWNER, "Alpha Owner")];
    results.ad_accounts.data = [
      account({
        id: "older",
        store_name: "Old label",
        shopify_url: "MAIN-STORE.myshopify.com",
        shopify_connected_at: "2026-06-01T00:00:00.000Z",
      }),
      account({ id: "newer", store_name: "Main Store" }),
      account({ id: "invalid", shopify_url: "main-store.myshopify.com.evil.test" }),
      account({ id: "pending", status: "pending", shopify_url: "pending.myshopify.com" }),
      account({
        id: "disconnected",
        shopify_connected: false,
        shopify_url: "disconnected.myshopify.com",
      }),
      account({
        id: "scope-free",
        store_name: "Another Store",
        shopify_url: "https://another-store.myshopify.com/admin/apps",
        shopify_scopes: null,
        shopify_connected_at: null,
      }),
    ];

    const [owner] = await listExistingClientRoster();

    expect(owner.shopify).toEqual([
      {
        id: "scope-free",
        source: "legacy",
        name: "Another Store",
        domain: "another-store.myshopify.com",
        currency: "EUR",
        grantedScopes: [],
        connectedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "newer",
        source: "legacy",
        name: "Main Store",
        domain: "main-store.myshopify.com",
        currency: "EUR",
        grantedScopes: ["read_orders", "read_products"],
        connectedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
  });
});
