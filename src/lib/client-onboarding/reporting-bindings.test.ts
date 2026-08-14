import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/http", () => ({
  readSmallJson: (request: Request) => request.json(),
  isExactRecord: (
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
  ) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return (
      required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key))
    );
  },
}));
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
  requireClientOnboardingAdmin: mocks.requireAdmin,
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

import {
  ClientOnboardingError,
} from "@/lib/client-onboarding/sessions";
import {
  commitClientReportingBindingRequest,
  projectReportingBindingQueue,
  type ReportingBindingSnapshot,
} from "./reporting-bindings";

const ADMIN = "54000000-0000-4000-8000-000000000001";
const CLIENT = "54000000-0000-4000-8000-000000000002";
const OTHER_CLIENT = "54000000-0000-4000-8000-000000000003";
const ACCOUNT = "54000000-0000-4000-8000-000000000010";
const SHOPIFY = "54000000-0000-4000-8000-000000000020";
const GOOGLE = "54000000-0000-4000-8000-000000000030";
const GOOGLE_2 = "54000000-0000-4000-8000-000000000031";
const MAPPING = "54000000-0000-4000-8000-000000000040";
const BINDING = "54000000-0000-4000-8000-000000000050";

function snapshot(overrides: Partial<ReportingBindingSnapshot> = {}): ReportingBindingSnapshot {
  return {
    clients: [
      {
        id: CLIENT,
        full_name: "Northwind",
        email: "team@northwind.test",
        approval_status: "approved",
      },
    ],
    profiles: [{ id: CLIENT, role: "client" }],
    rolloutStates: [{ client_id: CLIENT, operational_surface: "v2_ready_for_cutover" }],
    adAccounts: [
      {
        id: ACCOUNT,
        client_id: CLIENT,
        store_name: "Northwind",
        google_ads_customer_id: "1234567890",
        shopify_url: "https://northwind.myshopify.com/admin",
        status: "active",
      },
    ],
    shopifyConnections: [
      {
        id: SHOPIFY,
        client_id: CLIENT,
        status: "connected",
        shopify_name: "Northwind",
        shopify_domain: "northwind.myshopify.com",
      },
    ],
    googleConnections: [
      {
        id: GOOGLE,
        client_id: CLIENT,
        status: "connected",
        windsor_account_id: "123-456-7890",
        account_name: "Northwind Ads",
        last_error_code: null,
      },
    ],
    mappings: [
      {
        id: MAPPING,
        shopify_connection_id: SHOPIFY,
        google_ads_connection_id: GOOGLE,
      },
    ],
    bindings: [],
    ...overrides,
  };
}

function serviceFor(data: ReportingBindingSnapshot) {
  const byTable: Record<string, unknown[]> = {
    portal_clients: data.clients,
    profiles: data.profiles,
    client_rollout_states: data.rolloutStates,
    ad_accounts: data.adAccounts,
    client_shopify_connections: data.shopifyConnections,
    client_google_ads_connections: data.googleConnections,
    client_asset_mappings: data.mappings,
    client_reporting_bindings: data.bindings,
  };
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(async () => ({ data: byTable[table] ?? [], error: null })),
    })),
    rpc: mocks.rpc,
  };
}

function request(candidateId: string) {
  return new Request("http://localhost/api/admin/reporting-bindings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateId }),
  });
}

describe("V2 reporting binding queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: ADMIN, role: "admin" });
  });

  it("offers one commit only for an exact same-owner mapped pair", () => {
    const queue = projectReportingBindingQueue(snapshot());

    expect(queue).toMatchObject({ available: true });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      id: `pair:${SHOPIFY}:${GOOGLE}`,
      assetKind: "shopify_google",
      status: "eligible",
      canCommit: true,
      legacyAccount: { id: ACCOUNT },
    });
  });

  it("never offers a write for a cross-owner identifier match", () => {
    const queue = projectReportingBindingQueue(
      snapshot({
        adAccounts: snapshot().adAccounts.map((account) => ({
          ...account,
          client_id: OTHER_CLIENT,
        })),
      }),
    );

    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "no_exact_legacy_match", canCommit: false }),
        expect.objectContaining({ status: "agency_access_required", canCommit: false }),
      ]),
    );
  });

  it("offers an exact same-owner unmapped Google source for spend continuity", () => {
    const queue = projectReportingBindingQueue(
      snapshot({ shopifyConnections: [], mappings: [] }),
    );

    expect(queue.items).toEqual([
      expect.objectContaining({
        id: `google:${GOOGLE}`,
        status: "eligible",
        canCommit: true,
        legacyAccount: expect.objectContaining({ id: ACCOUNT }),
      }),
    ]);
  });

  it("keeps an unmatched Google source blocked on agency access", () => {
    const queue = projectReportingBindingQueue(
      snapshot({
        adAccounts: [],
        shopifyConnections: [],
        mappings: [],
      }),
    );

    expect(queue.items).toEqual([
      expect.objectContaining({
        id: `google:${GOOGLE}`,
        status: "agency_access_required",
        canCommit: false,
        legacyAccount: null,
      }),
    ]);
  });

  it("prefers unmapped Google over Shopify and exposes one proposal per legacy account", () => {
    const queue = projectReportingBindingQueue(snapshot({ mappings: [] }));
    const proposals = queue.items.filter((item) => item.canCommit);

    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `google:${GOOGLE}`,
          status: "eligible",
          canCommit: true,
          legacyAccount: expect.objectContaining({ id: ACCOUNT }),
        }),
        expect.objectContaining({
          id: `shopify:${SHOPIFY}`,
          status: "legacy_identity_reserved",
          canCommit: false,
          legacyAccount: expect.objectContaining({ id: ACCOUNT }),
        }),
      ]),
    );
    expect(proposals).toHaveLength(1);
    expect(new Set(proposals.map((item) => item.legacyAccount?.id)).size).toBe(
      proposals.length,
    );
  });

  it("fails closed when multiple unmapped Google sources claim one legacy account", () => {
    const duplicate = {
      ...snapshot().googleConnections[0],
      id: GOOGLE_2,
      windsor_account_id: "1234567890",
      account_name: "Northwind Ads Duplicate",
    };
    const queue = projectReportingBindingQueue(
      snapshot({
        googleConnections: [...snapshot().googleConnections, duplicate],
        mappings: [],
      }),
    );

    expect(queue.items.filter((item) => item.canCommit)).toHaveLength(0);
    expect(
      queue.items.filter((item) => item.assetKind === "google_ads"),
    ).toEqual([
      expect.objectContaining({ status: "ambiguous_legacy_match", canCommit: false }),
      expect.objectContaining({ status: "ambiguous_legacy_match", canCommit: false }),
    ]);
  });

  it("keeps the combined mapped pair as the only proposal over an unmapped duplicate", () => {
    const duplicate = {
      ...snapshot().googleConnections[0],
      id: GOOGLE_2,
      windsor_account_id: "1234567890",
      account_name: "Northwind Ads Unmapped",
    };
    const queue = projectReportingBindingQueue(
      snapshot({ googleConnections: [...snapshot().googleConnections, duplicate] }),
    );
    const proposals = queue.items.filter((item) => item.canCommit);

    expect(proposals).toEqual([
      expect.objectContaining({
        id: `pair:${SHOPIFY}:${GOOGLE}`,
        assetKind: "shopify_google",
        legacyAccount: expect.objectContaining({ id: ACCOUNT }),
      }),
    ]);
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `google:${GOOGLE_2}`,
          status: "legacy_identity_reserved",
          canCommit: false,
        }),
      ]),
    );
  });

  it("never offers a proposal for a rejected or archived owner", async () => {
    const rejected = snapshot({
      clients: snapshot().clients.map((client) => ({
        ...client,
        approval_status: "rejected",
      })),
    });
    const queue = projectReportingBindingQueue(rejected);
    expect(queue.items).toEqual([
      expect.objectContaining({ status: "client_not_approved", canCommit: false }),
    ]);

    mocks.createServiceClient.mockReturnValue(serviceFor(rejected));
    await expect(
      commitClientReportingBindingRequest(request(`pair:${SHOPIFY}:${GOOGLE}`)),
    ).rejects.toMatchObject({ code: "invalid_state", status: 409 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("never offers a proposal for an admin-owned internal identity", async () => {
    const internal = snapshot({ profiles: [{ id: CLIENT, role: "admin" }] });
    const queue = projectReportingBindingQueue(internal);
    expect(queue.items).toEqual([
      expect.objectContaining({ status: "internal_owner", canCommit: false }),
    ]);

    mocks.createServiceClient.mockReturnValue(serviceFor(internal));
    await expect(
      commitClientReportingBindingRequest(request(`pair:${SHOPIFY}:${GOOGLE}`)),
    ).rejects.toMatchObject({ code: "invalid_state", status: 409 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("authenticates before constructing service_role or reading a candidate", async () => {
    mocks.requireAdmin.mockRejectedValue(
      new ClientOnboardingError("forbidden", "Forbidden.", 403),
    );
    const bodyRead = vi.fn(async () => ({ done: true as const, value: undefined }));
    const unauthorisedRequest = {
      headers: new Headers(),
      body: { getReader: () => ({ read: bodyRead }) },
    } as unknown as Request;

    await expect(
      commitClientReportingBindingRequest(unauthorisedRequest),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(bodyRead).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("accepts candidateId only and rejects injected source identifiers before service_role", async () => {
    const injected = new Request("http://localhost/api/admin/reporting-bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidateId: `pair:${SHOPIFY}:${GOOGLE}`,
        adAccountId: ACCOUNT,
      }),
    });

    await expect(commitClientReportingBindingRequest(injected)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("recomputes the queue and performs no mutation for a stale or forged candidate", async () => {
    mocks.createServiceClient.mockReturnValue(serviceFor(snapshot()));

    await expect(
      commitClientReportingBindingRequest(
        request("shopify:54000000-0000-4000-8000-000000000099"),
      ),
    ).rejects.toMatchObject({ code: "invalid_state", status: 409 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes only the server-resolved exact proposal to the service-only RPC", async () => {
    mocks.createServiceClient.mockReturnValue(serviceFor(snapshot()));
    mocks.rpc.mockResolvedValue({ data: BINDING, error: null });

    await expect(
      commitClientReportingBindingRequest(request(`pair:${SHOPIFY}:${GOOGLE}`)),
    ).resolves.toEqual({ bindingId: BINDING });
    expect(mocks.rpc).toHaveBeenCalledWith("commit_client_reporting_binding", {
      p_ad_account_id: ACCOUNT,
      p_shopify_connection_id: SHOPIFY,
      p_google_ads_connection_id: GOOGLE,
      p_shopify_anchor_binding_id: null,
      p_idempotency_key: expect.stringMatching(/^bind:v2:[0-9a-f]{64}$/),
      p_admin_id: ADMIN,
      p_reason: "Admin-reviewed exact V2-to-existing reporting match",
    });
  });

  it("commits an exact unmapped Google match as truthful partial coverage", async () => {
    const googleOnly = snapshot({ shopifyConnections: [], mappings: [] });
    mocks.createServiceClient.mockReturnValue(serviceFor(googleOnly));
    mocks.rpc.mockResolvedValue({ data: BINDING, error: null });

    await expect(
      commitClientReportingBindingRequest(request(`google:${GOOGLE}`)),
    ).resolves.toEqual({ bindingId: BINDING });
    expect(mocks.rpc).toHaveBeenCalledWith("commit_client_reporting_binding", {
      p_ad_account_id: ACCOUNT,
      p_shopify_connection_id: null,
      p_google_ads_connection_id: GOOGLE,
      p_shopify_anchor_binding_id: null,
      p_idempotency_key: expect.stringMatching(/^bind:v2:[0-9a-f]{64}$/),
      p_admin_id: ADMIN,
      p_reason: "Admin-reviewed exact V2-to-existing reporting match",
    });
  });
});
