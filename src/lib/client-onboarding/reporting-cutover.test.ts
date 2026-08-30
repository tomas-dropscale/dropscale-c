import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  refreshReportingSourcesNow: vi.fn(),
  refreshStagedReportingSourceNow: vi.fn(),
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
vi.mock("@/lib/metrics/recompute", () => ({
  refreshReportingSourcesNow: mocks.refreshReportingSourcesNow,
  refreshStagedReportingSourceNow: mocks.refreshStagedReportingSourceNow,
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

import { ClientOnboardingError } from "@/lib/client-onboarding/sessions";
import {
  advanceEligibleClientReportingCutovers,
  executeClientReportingCutoverRequest,
  listClientReportingCutoverQueue,
  projectClientReportingCutover,
  provisionReviewedClientReportingSources,
  type ClientReportingCutoverSnapshot,
} from "./reporting-cutover";

const ADMIN = "65000000-0000-4000-8000-000000000001";
const CLIENT = "65000000-0000-4000-8000-000000000002";
const ACCOUNT = "65000000-0000-4000-8000-000000000010";
const ACCOUNT_2 = "65000000-0000-4000-8000-000000000011";
const SHOPIFY = "65000000-0000-4000-8000-000000000020";
const GOOGLE = "65000000-0000-4000-8000-000000000030";
const GOOGLE_2 = "65000000-0000-4000-8000-000000000031";
const BINDING = "65000000-0000-4000-8000-000000000040";
const NEW_BINDING = "65000000-0000-4000-8000-000000000041";
const BINDING_2 = "65000000-0000-4000-8000-000000000042";
const SESSION = "65000000-0000-4000-8000-000000000050";
const BOUND_AT = "2026-05-01T00:00:00.000Z";

function day(offset: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function account(
  overrides: Partial<ClientReportingCutoverSnapshot["adAccounts"][number]> = {},
): ClientReportingCutoverSnapshot["adAccounts"][number] {
  return {
    id: ACCOUNT,
    client_id: CLIENT,
    store_name: "Northwind legacy shell",
    google_ads_customer_id: null,
    shopify_url: null,
    status: "pending",
    reporting_role: "legacy_hybrid",
    currency: "EUR",
    shopify_connected: false,
    shopify_client_id: null,
    shopify_scopes: null,
    shopify_token_last4: null,
    shopify_connected_at: null,
    google_ads_connected_email: null,
    google_ads_connected: false,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<ClientReportingCutoverSnapshot> = {},
): ClientReportingCutoverSnapshot {
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
    rolloutStates: [
      {
        client_id: CLIENT,
        operational_surface: "v2_ready_for_cutover",
        onboarding_session_id: SESSION,
        reporting_cutover_at: null,
        reporting_cutover_by: null,
        reporting_cutover_reason: null,
      },
    ],
    adAccounts: [],
    shopifyConnections: [
      {
        id: SHOPIFY,
        client_id: CLIENT,
        status: "connected",
        shopify_name: "Northwind",
        shopify_domain: "northwind.myshopify.com",
        shopify_currency: "EUR",
        last_verified_at: "2026-08-14T00:00:00.000Z",
        last_error_code: null,
        updated_at: "2026-08-14T00:00:00.000Z",
      },
    ],
    shopifyCredentials: [{ connection_id: SHOPIFY }],
    googleConnections: [
      {
        id: GOOGLE,
        client_id: CLIENT,
        status: "connected",
        windsor_account_id: "123-456-7890",
        account_name: "Northwind Ads",
        currency: "EUR",
        time_zone: "Europe/Lisbon",
        last_verified_at: "2026-08-14T00:00:00.000Z",
        last_error_code: null,
        updated_at: "2026-08-14T00:00:00.000Z",
      },
    ],
    mappings: [
      { shopify_connection_id: SHOPIFY, google_ads_connection_id: GOOGLE },
    ],
    bindings: [],
    syncStates: [],
    sessions: [
      {
        id: SESSION,
        mode: "new_client",
        requested_assets: ["shopify", "google_ads"],
        status: "reviewed",
        target_client_id: null,
        claimed_user_id: CLIENT,
        reconnect_legacy_ad_account_id: null,
        reconnect_shopify_connection_id: null,
        reconnect_completed_at: null,
      },
    ],
    onboardingEvents: [],
    anchorEvents: [],
    billingStarts: [],
    billingEnds: [],
    ...overrides,
  };
}

function serviceFor(data: ClientReportingCutoverSnapshot, failingTable?: string) {
  const byTable: Record<string, unknown[]> = {
    portal_clients: data.clients,
    profiles: data.profiles,
    client_rollout_states: data.rolloutStates,
    ad_accounts: data.adAccounts,
    client_shopify_connections: data.shopifyConnections,
    client_shopify_credentials: data.shopifyCredentials,
    client_google_ads_connections: data.googleConnections,
    client_asset_mappings: data.mappings,
    client_reporting_bindings: data.bindings,
    client_reporting_sync_states: data.syncStates,
    client_onboarding_sessions: data.sessions,
    client_onboarding_events: data.onboardingEvents,
    client_reporting_anchor_events: data.anchorEvents,
    ad_account_billing_starts: data.billingStarts,
    ad_account_billing_ends: data.billingEnds,
  };
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(async () =>
        table === failingTable
          ? { data: null, error: { code: "42703", message: "column missing" } }
          : { data: byTable[table] ?? [], error: null },
      ),
    })),
    rpc: mocks.rpc,
  };
}

function request(actionId: string, extra?: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/reporting-bindings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionId, ...extra }),
  });
}

function boundSnapshot(receipts = false): ClientReportingCutoverSnapshot {
  return snapshot({
    adAccounts: [
      account({
        status: "pending",
        reporting_role: "shopify_anchor",
        google_ads_customer_id: "1234567890",
        shopify_url: "northwind.myshopify.com",
      }),
    ],
    bindings: [
      {
        id: BINDING,
        client_id: CLIENT,
        ad_account_id: ACCOUNT,
        shopify_connection_id: SHOPIFY,
        google_ads_connection_id: GOOGLE,
        shopify_anchor_binding_id: null,
        status: "active",
        bound_at: BOUND_AT,
      },
    ],
    syncStates: receipts
      ? [
          {
            binding_id: BINDING,
            source_type: "shopify",
            last_success_at: "2026-08-14T01:00:00.000Z",
            last_success_from: day(-90),
            last_success_to: day(-1),
            source_currency: "EUR",
            row_count: 90,
          },
          {
            binding_id: BINDING,
            source_type: "google_ads",
            last_success_at: "2026-08-14T01:00:00.000Z",
            last_success_from: day(-90),
            last_success_to: day(-1),
            source_currency: "EUR",
            row_count: 90,
          },
        ]
      : [],
  });
}

describe("Phase 2 admin reporting cutover workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: ADMIN, role: "admin" });
    mocks.refreshReportingSourcesNow.mockResolvedValue(undefined);
    mocks.refreshStagedReportingSourceNow.mockResolvedValue(undefined);
  });

  it("offers normal provisioning and a separate explicit empty-shell adoption", async () => {
    const data = snapshot({ adAccounts: [account()] });
    data.shopifyConnections[0].shopify_currency = "JPY";
    const queue = await projectClientReportingCutover(data);

    expect(queue.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "provision",
          requiresExplicitReview: false,
          existingAccountName: null,
        }),
        expect.objectContaining({
          kind: "adopt",
          requiresExplicitReview: true,
          existingAccountName: "Northwind legacy shell",
        }),
      ]),
    );
    expect(queue.candidates.every((candidate) => /^rw_[0-9a-f]{64}$/.test(candidate.id))).toBe(
      true,
    );
  });

  it("does not auto-provision a shopify-only shell while a google-only binding is active", async () => {
    // Regression: "Lia Singapura" 2026-08-17 — the client's Google spend
    // already reported through an existing account (google-only binding), and
    // the automatic provisioner still created a second, Shopify-only shell for
    // the same store, splitting spend and sales across two ad accounts.
    const data = snapshot({
      adAccounts: [
        account({
          status: "active",
          google_ads_customer_id: "1234567890",
          google_ads_connected: true,
        }),
      ],
      mappings: [],
      bindings: [
        {
          id: BINDING,
          client_id: CLIENT,
          ad_account_id: ACCOUNT,
          shopify_connection_id: null,
          google_ads_connection_id: GOOGLE,
          shopify_anchor_binding_id: null,
          status: "active",
          bound_at: BOUND_AT,
        },
      ],
    });
    data.profiles.push({ id: ADMIN, role: "admin" });
    data.shopifyConnections[0].session_id = SESSION;
    data.sessions[0].requested_assets = ["shopify"];
    data.sessions[0].created_by = ADMIN;

    const queue = await projectClientReportingCutover(data);
    expect(queue.candidates.some((candidate) => candidate.kind === "provision")).toBe(true);

    const result = await provisionReviewedClientReportingSources(serviceFor(data) as never);
    expect(result).toEqual({ attempted: 0, provisioned: 0, failed: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps queue provisioning EUR-only but no longer currency-blocks an ECB-convertible source", async () => {
    // DKK converts with the day's ECB rate, so the client is not blocked —
    // the source is simply awaiting a binding (Rebind sources is the path;
    // queue candidates deliberately stay EUR-only because provisioning pins
    // the pair to the Google billing currency).
    const data = snapshot();
    data.googleConnections[0].currency = "DKK";

    const queue = await projectClientReportingCutover(data);

    expect(queue.candidates.some((candidate) => candidate.sourceLabel.includes("1234567890"))).toBe(
      false,
    );
    expect(queue.clients[0].status).toBe("bindings_required");
    expect(queue.clients[0].message).not.toContain("ECB publishes no rate");
  });

  it("still blocks a Google source billing in a currency the ECB cannot convert", async () => {
    const data = snapshot();
    data.googleConnections[0].currency = "TWD";

    const queue = await projectClientReportingCutover(data);

    expect(queue.candidates.some((candidate) => candidate.sourceLabel.includes("1234567890"))).toBe(
      false,
    );
    expect(queue.clients[0]).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("ECB publishes no rate"),
    });
  });

  it("warns that an unmapped Google source will report outside every store", async () => {
    const data = snapshot({ mappings: [] });

    const queue = await projectClientReportingCutover(data);
    const googleOnly = queue.candidates.find(
      (candidate) => candidate.sourceLabel === "1234567890",
    );

    expect(googleOnly?.message).toContain("report as unallocated");
    // The store's own candidate is allocated by definition and must stay clean.
    expect(
      queue.candidates.find((candidate) =>
        candidate.sourceLabel.includes("northwind.myshopify.com"),
      )?.message,
    ).not.toContain("unallocated");
  });

  it("does not warn about allocation when the client has no store to allocate to", async () => {
    const data = snapshot({ mappings: [], shopifyConnections: [], shopifyCredentials: [] });

    const queue = await projectClientReportingCutover(data);

    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0].message).not.toContain("unallocated");
  });

  it("names an account still waiting for its Windsor metadata instead of blaming its currency", async () => {
    const data = snapshot();
    data.googleConnections[0].currency = null;
    data.googleConnections[0].time_zone = null;
    data.googleConnections[0].account_name = "Yuna Kamakura";

    const queue = await projectClientReportingCutover(data);

    // Unusable is unusable: it must still never be offered as a source.
    expect(queue.candidates.some((candidate) => candidate.sourceLabel.includes("1234567890"))).toBe(
      false,
    );
    expect(queue.clients[0].message).toContain("Yuna Kamakura");
    expect(queue.clients[0].message).toContain("once an account has spend");
    expect(queue.clients[0].message).not.toContain("EUR-only");
  });

  it("does not offer restage for an abandoned identity with terminal billing history", async () => {
    const data = snapshot({
      adAccounts: [
        account({
          status: "suspended",
          reporting_role: "shopify_anchor",
          google_ads_customer_id: "1234567890",
          shopify_url: "northwind.myshopify.com",
        }),
      ],
      bindings: [
        {
          id: BINDING,
          client_id: CLIENT,
          ad_account_id: ACCOUNT,
          shopify_connection_id: SHOPIFY,
          google_ads_connection_id: GOOGLE,
          shopify_anchor_binding_id: null,
          status: "revoked",
          bound_at: BOUND_AT,
        },
      ],
      anchorEvents: [
        {
          binding_id: BINDING,
          prior_binding_id: null,
          ad_account_id: ACCOUNT,
          event_type: "source_abandoned",
          idempotency_key: "abandon:terminal",
          actor_id: ADMIN,
          reason: "Terminal billing identity",
          details: {},
          created_at: "2026-08-14T00:00:00.000Z",
        },
      ],
      billingStarts: [
        {
          ad_account_id: ACCOUNT,
          google_ads_customer_id: "1234567890",
          currency: "EUR",
        },
      ],
      billingEnds: [
        {
          ad_account_id: ACCOUNT,
          google_ads_customer_id: "1234567890",
          currency: "EUR",
        },
      ],
    });
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T00:00:00.000Z",
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Initial reporting cutover",
    };

    expect((await projectClientReportingCutover(data)).candidates).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "restage" })]),
    );
  });

  it("uses only server-recomputed source ids for provisioning", async () => {
    const data = snapshot();
    const action = (await projectClientReportingCutover(data)).candidates.find(
      (candidate) => candidate.kind === "provision",
    );
    expect(action).toBeDefined();
    mocks.createServiceClient.mockReturnValue(serviceFor(data));
    mocks.rpc.mockResolvedValue({ data: NEW_BINDING, error: null });

    await expect(executeClientReportingCutoverRequest(request(action!.id))).resolves.toEqual({
      action: "provision",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("provision_client_reporting_anchor", {
      p_shopify_connection_id: SHOPIFY,
      p_google_ads_connection_id: GOOGLE,
      p_shopify_anchor_binding_id: null,
      p_existing_ad_account_id: null,
      p_idempotency_key: expect.stringMatching(/^anchor:[0-9a-f]{64}$/),
      p_admin_id: ADMIN,
      p_reason: "Admin-reviewed reporting anchor provisioning",
    });
  });

  it("commits explicit adoption only when that opaque alternative is selected", async () => {
    const data = snapshot({ adAccounts: [account()] });
    const action = (await projectClientReportingCutover(data)).candidates.find(
      (candidate) => candidate.kind === "adopt",
    );
    expect(action).toMatchObject({ requiresExplicitReview: true });
    mocks.createServiceClient.mockReturnValue(serviceFor(data));
    mocks.rpc.mockResolvedValue({ data: NEW_BINDING, error: null });

    await executeClientReportingCutoverRequest(request(action!.id));

    expect(mocks.rpc).toHaveBeenCalledWith("provision_client_reporting_anchor", {
      p_shopify_connection_id: SHOPIFY,
      p_google_ads_connection_id: GOOGLE,
      p_shopify_anchor_binding_id: null,
      p_existing_ad_account_id: ACCOUNT,
      p_idempotency_key: expect.stringMatching(/^anchor:[0-9a-f]{64}$/),
      p_admin_id: ADMIN,
      p_reason: "Admin-reviewed explicit reporting anchor adoption",
    });
  });

  it("offers an exact reconnect upgrade and passes its locked evidence to the upgrade RPC", async () => {
    const data = snapshot({
      adAccounts: [
        account({
          status: "active",
          google_ads_customer_id: "1234567890",
          shopify_url: "northwind.myshopify.com",
        }),
      ],
      bindings: [
        {
          id: BINDING,
          client_id: CLIENT,
          ad_account_id: ACCOUNT,
          shopify_connection_id: null,
          google_ads_connection_id: GOOGLE,
          shopify_anchor_binding_id: null,
          status: "active",
          bound_at: BOUND_AT,
        },
      ],
      mappings: [],
      sessions: [
        {
          id: SESSION,
          mode: "reconnect",
          requested_assets: ["shopify"],
          status: "reviewed",
          target_client_id: CLIENT,
          claimed_user_id: CLIENT,
          reconnect_legacy_ad_account_id: ACCOUNT,
          reconnect_shopify_connection_id: null,
          reconnect_completed_at: "2026-08-14T00:00:00.000Z",
        },
      ],
      onboardingEvents: [
        {
          session_id: SESSION,
          event_type: "shopify_connected",
          actor_type: "invite",
          actor_id: CLIENT,
          details: {
            connection_id: SHOPIFY,
            shopify_domain: "northwind.myshopify.com",
            reused: false,
            target_source: "legacy",
          },
          created_at: "2026-08-14T00:00:00.000Z",
        },
      ],
    });
    data.shopifyConnections[0].shopify_currency = "JPY";
    const action = (await projectClientReportingCutover(data)).candidates.find(
      (candidate) => candidate.kind === "upgrade",
    );
    expect(action).toBeDefined();
    mocks.createServiceClient.mockReturnValue(serviceFor(data));
    mocks.rpc.mockResolvedValue({ data: NEW_BINDING, error: null });

    await executeClientReportingCutoverRequest(request(action!.id));

    expect(mocks.rpc).toHaveBeenCalledWith(
      "upgrade_client_reporting_google_binding_to_pair",
      {
        p_binding_id: BINDING,
        p_shopify_connection_id: SHOPIFY,
        p_reconnect_session_id: SESSION,
        p_idempotency_key: expect.stringMatching(/^anchor:[0-9a-f]{64}$/),
        p_admin_id: ADMIN,
        p_reason: "Admin-reviewed exact reconnect reporting upgrade",
      },
    );
  });

  it("classifies an exact post-cutover reconnect as replacement_required without an action", async () => {
    const data = snapshot({
      adAccounts: [
        account({
          status: "active",
          google_ads_customer_id: "1234567890",
          shopify_url: "northwind.myshopify.com",
        }),
      ],
      bindings: [
        {
          id: BINDING,
          client_id: CLIENT,
          ad_account_id: ACCOUNT,
          shopify_connection_id: null,
          google_ads_connection_id: GOOGLE,
          shopify_anchor_binding_id: null,
          status: "active",
          bound_at: BOUND_AT,
        },
      ],
      mappings: [],
      sessions: [
        {
          id: SESSION,
          mode: "reconnect",
          requested_assets: ["shopify"],
          status: "reviewed",
          target_client_id: CLIENT,
          claimed_user_id: CLIENT,
          reconnect_legacy_ad_account_id: ACCOUNT,
          reconnect_shopify_connection_id: null,
          reconnect_completed_at: "2026-08-14T00:00:00.000Z",
        },
      ],
      onboardingEvents: [
        {
          session_id: SESSION,
          event_type: "shopify_connected",
          actor_type: "invite",
          actor_id: CLIENT,
          details: {
            connection_id: SHOPIFY,
            shopify_domain: "northwind.myshopify.com",
            target_source: "legacy",
          },
          created_at: "2026-08-14T00:00:00.000Z",
        },
      ],
    });
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T02:00:00.000Z",
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Initial reporting cutover",
    };

    const queue = await projectClientReportingCutover(data);

    expect(queue.candidates).toEqual([]);
    expect(queue.clients[0]).toMatchObject({
      status: "replacement_required",
      syncActionId: null,
      activateActionId: null,
      message: expect.stringContaining("separate staged replacement lifecycle (0057)"),
    });
  });

  it.each([
    {
      label: "the impossible onboarding-target field is populated",
      mutate(data: ClientReportingCutoverSnapshot) {
        data.sessions[0].reconnect_shopify_connection_id = SHOPIFY;
      },
    },
    {
      label: "the purpose-bound event is malformed",
      mutate(data: ClientReportingCutoverSnapshot) {
        data.onboardingEvents[0].details = { connection_id: SHOPIFY };
      },
    },
    {
      label: "more than one connection event exists",
      mutate(data: ClientReportingCutoverSnapshot) {
        data.onboardingEvents.push({
          ...data.onboardingEvents[0],
          created_at: "2026-08-14T00:01:00.000Z",
        });
      },
    },
  ])("fails closed when $label", async ({ mutate }) => {
    const data = snapshot({
      adAccounts: [
        account({
          status: "active",
          google_ads_customer_id: "1234567890",
          shopify_url: "northwind.myshopify.com",
        }),
      ],
      bindings: [
        {
          id: BINDING,
          client_id: CLIENT,
          ad_account_id: ACCOUNT,
          shopify_connection_id: null,
          google_ads_connection_id: GOOGLE,
          shopify_anchor_binding_id: null,
          status: "active",
          bound_at: BOUND_AT,
        },
      ],
      mappings: [],
      sessions: [
        {
          id: SESSION,
          mode: "reconnect",
          requested_assets: ["shopify"],
          status: "reviewed",
          target_client_id: CLIENT,
          claimed_user_id: CLIENT,
          reconnect_legacy_ad_account_id: ACCOUNT,
          reconnect_shopify_connection_id: null,
          reconnect_completed_at: "2026-08-14T00:00:00.000Z",
        },
      ],
      onboardingEvents: [
        {
          session_id: SESSION,
          event_type: "shopify_connected",
          actor_type: "invite",
          actor_id: CLIENT,
          details: {
            connection_id: SHOPIFY,
            shopify_domain: "northwind.myshopify.com",
            target_source: "legacy",
          },
          created_at: "2026-08-14T00:00:00.000Z",
        },
      ],
    });
    mutate(data);

    expect((await projectClientReportingCutover(data)).candidates).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "upgrade" })]),
    );
  });

  it("authenticates before reading the body or constructing service_role", async () => {
    mocks.requireAdmin.mockRejectedValue(
      new ClientOnboardingError("forbidden", "Forbidden.", 403),
    );
    const bodyRead = vi.fn(async () => ({ done: true as const, value: undefined }));
    const unauthorisedRequest = {
      headers: new Headers(),
      body: { getReader: () => ({ read: bodyRead }) },
    } as unknown as Request;

    await expect(executeClientReportingCutoverRequest(unauthorisedRequest)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(bodyRead).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.refreshReportingSourcesNow).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects source-id injection before constructing service_role", async () => {
    await expect(
      executeClientReportingCutoverRequest(request(`rw_${"1".repeat(64)}`, { clientId: CLIENT })),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("recomputes the workflow and rejects a stale opaque action", async () => {
    mocks.createServiceClient.mockReturnValue(serviceFor(snapshot()));

    await expect(
      executeClientReportingCutoverRequest(request(`rw_${"1".repeat(64)}`)),
    ).rejects.toMatchObject({ code: "invalid_state", status: 409 });
    expect(mocks.refreshReportingSourcesNow).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("exposes sync first, runs the exact 90-day range, and withholds activation", async () => {
    const data = boundSnapshot(false);
    const queue = await projectClientReportingCutover(data);
    const client = queue.clients[0];
    expect(client).toMatchObject({
      status: "ready_to_sync",
      syncActionId: expect.stringMatching(/^rw_/),
      activateActionId: null,
    });
    mocks.createServiceClient.mockReturnValue(serviceFor(data));

    await executeClientReportingCutoverRequest(request(client.syncActionId!));

    expect(mocks.refreshReportingSourcesNow).toHaveBeenCalledWith([ACCOUNT], {
      client: expect.any(Object),
      from: day(-90),
      to: day(-1),
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "activate_client_reporting_cutover",
      expect.anything(),
    );
  });

  it("offers activation only after complete receipts and calls the marker RPC exactly", async () => {
    const data = boundSnapshot(true);
    const queue = await projectClientReportingCutover(data);
    const client = queue.clients[0];
    expect(client).toMatchObject({
      status: "ready_to_activate",
      syncedSourceCount: 2,
      activateActionId: expect.stringMatching(/^rw_/),
    });
    mocks.createServiceClient.mockReturnValue(serviceFor(data));
    mocks.rpc.mockResolvedValue({ data: CLIENT, error: null });

    await executeClientReportingCutoverRequest(request(client.activateActionId!));

    expect(mocks.rpc).toHaveBeenCalledWith("activate_client_reporting_cutover", {
      p_client_id: CLIENT,
      p_admin_id: ADMIN,
      p_reason: "Admin-reviewed reporting cutover after 90-day source sync",
    });
  });

  it("advances an eligible client end to end with the session's admin as reviewer", async () => {
    const data = boundSnapshot(true);
    data.profiles.push({ id: ADMIN, role: "admin" });
    data.sessions[0].created_by = ADMIN;
    mocks.rpc.mockResolvedValue({ data: CLIENT, error: null });

    const result = await advanceEligibleClientReportingCutovers(
      serviceFor(data) as never,
    );

    // One pass runs the offered 90-day sync AND the activation; the recompute
    // does not re-execute the same content-addressed action ids.
    expect(result).toEqual({
      syncsAttempted: 1,
      syncsCompleted: 1,
      activationsAttempted: 1,
      activated: 1,
      failed: 0,
    });
    expect(mocks.refreshReportingSourcesNow).toHaveBeenCalledWith([ACCOUNT], {
      client: expect.any(Object),
      from: day(-90),
      to: day(-1),
    });
    expect(mocks.rpc).toHaveBeenCalledWith("activate_client_reporting_cutover", {
      p_client_id: CLIENT,
      p_admin_id: ADMIN,
      p_reason: "Admin-reviewed reporting cutover after 90-day source sync",
    });
    expect(
      mocks.rpc.mock.calls.filter(
        ([name]) => name === "activate_client_reporting_cutover",
      ),
    ).toHaveLength(1);
  });

  it("does not advance without an admin-created onboarding session", async () => {
    const data = boundSnapshot(true);

    const result = await advanceEligibleClientReportingCutovers(
      serviceFor(data) as never,
    );

    expect(result).toEqual({
      syncsAttempted: 0,
      syncsCompleted: 0,
      activationsAttempted: 0,
      activated: 0,
      failed: 0,
    });
    expect(mocks.refreshReportingSourcesNow).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "activate_client_reporting_cutover",
      expect.anything(),
    );
  });

  it("does not treat a preexisting v2_active surface without the marker as cut over", async () => {
    const data = boundSnapshot(true);
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: null,
    };

    expect((await projectClientReportingCutover(data)).clients[0]).toMatchObject({
      status: "ready_to_activate",
      reportingCutoverAt: null,
      activateActionId: expect.stringMatching(/^rw_/),
    });
  });

  it("fails closed when a reporting marker has no authoritative binding", async () => {
    const data = snapshot();
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T02:00:00.000Z",
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Corrupt marker fixture",
    };

    const queue = await projectClientReportingCutover(data);

    expect(queue.candidates).toEqual([]);
    expect(queue.clients[0]).toMatchObject({
      status: "blocked",
      boundSourceCount: 0,
      syncActionId: null,
      activateActionId: null,
      stagedSources: [],
      message:
        "An authoritative reporting binding no longer has its exact healthy connected source. Reporting remains blocked until that authority is repaired.",
    });
  });

  it.each([
    {
      label: "the rollout has no onboarding session",
      mutate(data: ClientReportingCutoverSnapshot) {
        data.rolloutStates[0].onboarding_session_id = null;
      },
    },
    {
      label: "the onboarding session requests no assets",
      mutate(data: ClientReportingCutoverSnapshot) {
        data.sessions[0].requested_assets = [];
      },
    },
    {
      label: "the onboarding session has not been submitted",
      mutate(data: ClientReportingCutoverSnapshot) {
        data.sessions[0].status = "collecting";
      },
    },
  ])("withholds activation when $label", async ({ mutate }) => {
    const data = boundSnapshot(true);
    mutate(data);

    expect((await projectClientReportingCutover(data)).clients[0]).toMatchObject({
      status: "blocked",
      activateActionId: null,
      message:
        "The rollout has no reviewed asset onboarding session. Reporting activation is withheld until that evidence is repaired.",
    });
  });

  it("offers a purpose-bound staged action for a fresh post-cutover source", async () => {
    const data = boundSnapshot(true);
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T02:00:00.000Z",
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Initial reporting cutover",
    };
    data.googleConnections.push({
      ...data.googleConnections[0],
      id: GOOGLE_2,
      windsor_account_id: "987-654-3210",
      account_name: "Northwind Ads 2",
    });

    const queue = await projectClientReportingCutover(data);
    const candidate = queue.candidates.find(
      (item) => item.kind === "provision" && item.sourceLabel === "9876543210",
    );
    expect(candidate).toMatchObject({
      message: expect.stringContaining("staged and non-operational"),
    });
    expect(queue.clients[0]).toMatchObject({
      status: "blocked",
      sourceCount: 3,
      boundSourceCount: 2,
      syncedSourceCount: 2,
      syncActionId: null,
      activateActionId: null,
      message:
        "The existing V2 reporting authority remains active. A connected source is outside authority and must be staged explicitly.",
    });
    mocks.createServiceClient.mockReturnValue(serviceFor(data));
    mocks.rpc.mockResolvedValue({ data: NEW_BINDING, error: null });

    await executeClientReportingCutoverRequest(request(candidate!.id));

    expect(mocks.rpc).toHaveBeenCalledWith("stage_client_reporting_source", {
      p_client_id: CLIENT,
      p_shopify_connection_id: null,
      p_google_ads_connection_id: GOOGLE_2,
      p_shopify_anchor_binding_id: null,
      p_existing_ad_account_id: null,
      p_idempotency_key: expect.stringMatching(/^anchor:[0-9a-f]{64}$/),
      p_admin_id: ADMIN,
      p_reason: "Admin-reviewed post-cutover reporting source staging",
    });
  });

  it("blocks a new unverified post-cutover source until it can be staged safely", async () => {
    const data = boundSnapshot(true);
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T02:00:00.000Z",
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Initial reporting cutover",
    };
    data.googleConnections.push({
      ...data.googleConnections[0],
      id: GOOGLE_2,
      windsor_account_id: "987-654-3210",
      last_verified_at: null,
    });

    const queue = await projectClientReportingCutover(data);

    expect(queue.candidates).toEqual([]);
    expect(queue.clients[0]).toMatchObject({
      status: "blocked",
      sourceCount: 3,
      boundSourceCount: 2,
      syncActionId: null,
      activateActionId: null,
      message:
        "The existing reporting authority remains active, but a new connected source is blocked until it is verified and healthy; then it can be staged explicitly.",
    });
  });

  it("syncs and promotes only an exact server-recomputed staged source", async () => {
    const marker = "2026-08-14T02:00:00.000Z";
    const stagedAt = "2026-08-14T03:00:00.000Z";
    const data = boundSnapshot(true);
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: marker,
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Initial reporting cutover",
    };
    data.googleConnections.push({
      ...data.googleConnections[0],
      id: GOOGLE_2,
      windsor_account_id: "987-654-3210",
      account_name: "Northwind Ads 2",
    });
    data.mappings.push({
      shopify_connection_id: SHOPIFY,
      google_ads_connection_id: GOOGLE_2,
    });
    data.adAccounts.push(
      account({
        id: ACCOUNT_2,
        store_name: "Northwind Ads 2",
        status: "active",
        reporting_role: "google_spend",
        google_ads_customer_id: "9876543210",
      }),
    );
    data.bindings.push({
      id: BINDING_2,
      client_id: CLIENT,
      ad_account_id: ACCOUNT_2,
      shopify_connection_id: null,
      google_ads_connection_id: GOOGLE_2,
      shopify_anchor_binding_id: BINDING,
      status: "staged",
      bound_at: stagedAt,
    });
    data.syncStates.push({
      binding_id: BINDING_2,
      source_type: "google_ads",
      last_success_at: "2026-08-14T04:00:00.000Z",
      last_success_from: day(-90),
      last_success_to: day(-1),
      source_currency: "EUR",
      row_count: 90,
    });
    data.billingStarts.push({
      ad_account_id: ACCOUNT_2,
      google_ads_customer_id: "9876543210",
      currency: "EUR",
    });

    const staged = (await projectClientReportingCutover(data)).clients[0].stagedSources[0];
    expect(staged).toMatchObject({
      sourceLabel: "9876543210",
      syncedSourceCount: 1,
      sourceCount: 1,
      billingReady: true,
      syncActionId: expect.stringMatching(/^rw_/),
      promoteActionId: expect.stringMatching(/^rw_/),
      abandonActionId: null,
      message: expect.stringContaining("still non-operational"),
    });
    mocks.createServiceClient.mockReturnValue(serviceFor(data));
    mocks.rpc.mockResolvedValue({ data: BINDING_2, error: null });

    await executeClientReportingCutoverRequest(request(staged.syncActionId!));
    expect(mocks.refreshStagedReportingSourceNow).toHaveBeenCalledWith(BINDING_2, {
      client: expect.any(Object),
      from: day(-90),
      to: day(-1),
    });
    await executeClientReportingCutoverRequest(request(staged.promoteActionId!));
    expect(mocks.rpc).toHaveBeenCalledWith("promote_client_reporting_source", {
      p_binding_id: BINDING_2,
      p_admin_id: ADMIN,
      p_idempotency_key: expect.stringMatching(/^anchor:[0-9a-f]{64}$/),
      p_reason: "Admin-reviewed post-stage reporting source promotion",
    });
  });

  it("offers exact abandonment only before billing starts", async () => {
    const data = boundSnapshot(true);
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T02:00:00.000Z",
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Initial reporting cutover",
    };
    data.bindings.push({
      id: BINDING_2,
      client_id: CLIENT,
      ad_account_id: ACCOUNT_2,
      shopify_connection_id: null,
      google_ads_connection_id: GOOGLE_2,
      shopify_anchor_binding_id: BINDING,
      status: "staged",
      bound_at: "2026-08-14T03:00:00.000Z",
    });
    data.adAccounts.push(
      account({
        id: ACCOUNT_2,
        reporting_role: "google_spend",
        google_ads_customer_id: "9876543210",
      }),
    );
    data.googleConnections.push({
      ...data.googleConnections[0],
      id: GOOGLE_2,
      windsor_account_id: "987-654-3210",
    });
    data.mappings.push({
      shopify_connection_id: SHOPIFY,
      google_ads_connection_id: GOOGLE_2,
    });
    const staged = (await projectClientReportingCutover(data)).clients[0].stagedSources[0];
    expect(staged.abandonActionId).toMatch(/^rw_/);
    mocks.createServiceClient.mockReturnValue(serviceFor(data));
    mocks.rpc.mockResolvedValue({ data: BINDING_2, error: null });

    await executeClientReportingCutoverRequest(request(staged.abandonActionId!));

    expect(mocks.rpc).toHaveBeenCalledWith("abandon_client_reporting_source", {
      p_binding_id: BINDING_2,
      p_admin_id: ADMIN,
      p_idempotency_key: expect.stringMatching(/^anchor:[0-9a-f]{64}$/),
      p_reason: "Admin-reviewed staged reporting source abandonment",
    });
  });

  it.each([
    { label: "unbilled", terminalBilling: false },
    { label: "billing-ended", terminalBilling: true },
  ])("keeps only abandonment available for an unhealthy $label staged source", async ({
    terminalBilling,
  }) => {
    const data = boundSnapshot(true);
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T02:00:00.000Z",
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Initial reporting cutover",
    };
    data.googleConnections.push({
      ...data.googleConnections[0],
      id: GOOGLE_2,
      status: "revoked",
      windsor_account_id: "987-654-3210",
    });
    data.adAccounts.push(
      account({
        id: ACCOUNT_2,
        status: terminalBilling ? "suspended" : "pending",
        reporting_role: "google_spend",
        google_ads_customer_id: "9876543210",
      }),
    );
    data.bindings.push({
      id: BINDING_2,
      client_id: CLIENT,
      ad_account_id: ACCOUNT_2,
      shopify_connection_id: null,
      google_ads_connection_id: GOOGLE_2,
      shopify_anchor_binding_id: BINDING,
      status: "staged",
      bound_at: "2026-08-14T03:00:00.000Z",
    });
    if (terminalBilling) {
      const boundary = {
        ad_account_id: ACCOUNT_2,
        google_ads_customer_id: "9876543210",
        currency: "EUR",
      };
      data.billingStarts.push(boundary);
      data.billingEnds.push(boundary);
    }

    expect((await projectClientReportingCutover(data)).clients[0].stagedSources[0]).toMatchObject({
      sourceLabel: "9876543210",
      syncActionId: null,
      promoteActionId: null,
      abandonActionId: expect.stringMatching(/^rw_/),
      message: expect.stringContaining("staged but non-operational"),
    });
  });

  it("fails closed on a post-cutover active binding without source_added evidence", async () => {
    const data = boundSnapshot(true);
    const marker = "2026-08-14T02:00:00.000Z";
    const postBoundAt = "2026-08-14T03:00:00.000Z";
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "v2_active",
      reporting_cutover_at: marker,
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Initial reporting cutover",
    };
    data.googleConnections.push({
      ...data.googleConnections[0],
      id: GOOGLE_2,
      windsor_account_id: "987-654-3210",
      account_name: "Northwind Ads 2",
    });
    data.adAccounts.push(
      account({
        id: ACCOUNT_2,
        store_name: "Northwind Ads 2",
        reporting_role: "google_spend",
        google_ads_customer_id: "9876543210",
      }),
    );
    data.bindings.push({
      id: BINDING_2,
      client_id: CLIENT,
      ad_account_id: ACCOUNT_2,
      shopify_connection_id: null,
      google_ads_connection_id: GOOGLE_2,
      shopify_anchor_binding_id: null,
      status: "active",
      bound_at: postBoundAt,
    });

    expect((await projectClientReportingCutover(data)).clients[0]).toMatchObject({
      status: "blocked",
      syncedSourceCount: 2,
      syncActionId: null,
      activateActionId: null,
      message:
        "A post-cutover active binding has no immutable source_added promotion event. Existing authority stays fail-closed until it is repaired.",
    });

    data.syncStates.push({
      binding_id: BINDING_2,
      source_type: "google_ads",
      last_success_at: "2026-08-14T04:00:00.000Z",
      last_success_from: day(-90),
      last_success_to: day(-1),
      source_currency: "EUR",
      row_count: 90,
    });
    expect((await projectClientReportingCutover(data)).clients[0]).toMatchObject({
      status: "blocked",
      syncedSourceCount: 2,
      syncActionId: null,
      activateActionId: null,
      message:
        "A post-cutover active binding has no immutable source_added promotion event. Existing authority stays fail-closed until it is repaired.",
    });
  });

  it("blocks a fully covered Google-only client with an explicit Shopify requirement", async () => {
    const data = boundSnapshot(true);
    data.shopifyConnections = [];
    data.shopifyCredentials = [];
    data.mappings = [];
    data.adAccounts[0] = account({
      status: "pending",
      reporting_role: "google_spend",
      google_ads_customer_id: "1234567890",
    });
    data.bindings[0] = {
      ...data.bindings[0],
      shopify_connection_id: null,
    };
    data.syncStates = data.syncStates.filter((receipt) => receipt.source_type === "google_ads");

    expect((await projectClientReportingCutover(data)).clients[0]).toMatchObject({
      status: "blocked",
      sourceCount: 1,
      boundSourceCount: 1,
      syncActionId: null,
      activateActionId: null,
      message: "Reporting activation requires at least one connected Shopify store anchor.",
    });
  });

  it("lets rollback_legacy override an existing reporting marker", async () => {
    const data = boundSnapshot(true);
    data.rolloutStates[0] = {
      ...data.rolloutStates[0],
      operational_surface: "rollback_legacy",
      reporting_cutover_at: "2026-08-14T02:00:00.000Z",
      reporting_cutover_by: ADMIN,
      reporting_cutover_reason: "Emergency rollback",
    };

    expect((await projectClientReportingCutover(data)).clients[0]).toMatchObject({
      status: "blocked",
      reportingCutoverAt: null,
      syncActionId: null,
      activateActionId: null,
      message: "Legacy rollback overrides the reporting marker.",
    });
  });

  it("fails closed when the marker migration is absent", async () => {
    const service = serviceFor(snapshot(), "client_rollout_states");
    mocks.createServiceClient.mockReturnValue(service);

    await expect(listClientReportingCutoverQueue()).resolves.toEqual({
      available: false,
      candidates: [],
      clients: [],
    });
    await expect(
      executeClientReportingCutoverRequest(request(`rw_${"1".repeat(64)}`)),
    ).rejects.toMatchObject({ code: "database_error", status: 503 });
    expect(mocks.refreshReportingSourcesNow).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
