import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  // Declared inside vi.hoisted: vi.mock factories are hoisted above every
  // top-level statement, so a class defined at module scope is not yet
  // initialised when the factory first runs.
  class FakeClientOnboardingError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    createServiceClient: vi.fn(),
    clientReportingAuthority: vi.fn(),
    rpc: vi.fn(),
    ClientOnboardingError: FakeClientOnboardingError,
  };
});

vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
}));
vi.mock("@/lib/portal/client-rollout", () => ({
  clientReportingAuthority: mocks.clientReportingAuthority,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { revokeReportingBindingForAsset } from "./reporting-binding-admin";

const ADMIN = "40000000-0000-4000-8000-000000000001";
const BINDING = "40000000-0000-4000-8000-000000000011";
const SHOPIFY = "40000000-0000-4000-8000-000000000021";
const CLIENT = "40000000-0000-4000-8000-000000000031";

function anchorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BINDING,
    client_id: CLIENT,
    ad_account_id: "40000000-0000-4000-8000-000000000041",
    shopify_connection_id: SHOPIFY,
    google_ads_connection_id: null,
    shopify_anchor_binding_id: null,
    status: "active",
    ...overrides,
  };
}

/** One chain per table: maybeSingle() answers point reads, await answers lists. */
function service(singles: Record<string, unknown>, lists: Record<string, unknown[]> = {}) {
  const from = vi.fn((table: string) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> & {
      then?: Promise<unknown>["then"];
    } = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue({ data: singles[table] ?? null, error: null });
    chain.then = (resolve, reject) =>
      Promise.resolve({ data: lists[table] ?? [], error: null }).then(resolve, reject);
    return chain;
  });
  return { from, rpc: mocks.rpc };
}

describe("unbinding a Shopify anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceClient.mockReturnValue(
      service({
        client_reporting_bindings: anchorRow(),
        client_shopify_connections: { shopify_name: "Lia Singapura", shopify_domain: "lia.myshopify.com" },
      }),
    );
  });

  it("retires a live client's store whole instead of a plain revoke", async () => {
    mocks.clientReportingAuthority.mockResolvedValue("v2");
    mocks.rpc.mockResolvedValue({ data: BINDING, error: null });

    const coverage = await revokeReportingBindingForAsset({
      kind: "shopify",
      connectionId: SHOPIFY,
      adminId: ADMIN,
    });

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("retire_client_reporting_store", {
      p_anchor_binding_id: BINDING,
      p_admin_id: ADMIN,
      p_idempotency_key: `store-retire:${BINDING}`,
      p_reason: "Admin retired this store from the client's reporting; its history is kept.",
    });
    expect(coverage).toMatchObject({
      bindingId: BINDING,
      retired: true,
      covers: [{ kind: "shopify", id: SHOPIFY, name: "Lia Singapura" }],
    });
  });

  it("keeps the plain revoke before the cutover", async () => {
    mocks.clientReportingAuthority.mockResolvedValue("legacy");
    mocks.rpc.mockResolvedValue({ data: BINDING, error: null });

    const coverage = await revokeReportingBindingForAsset({
      kind: "shopify",
      connectionId: SHOPIFY,
      adminId: ADMIN,
    });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "revoke_client_reporting_binding",
      expect.objectContaining({ p_binding_id: BINDING, p_admin_id: ADMIN }),
    );
    expect(coverage.retired).toBeUndefined();
  });

  it("passes the retirement RPC's own refusal through, in words", async () => {
    mocks.clientReportingAuthority.mockResolvedValue("v2");
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "23514",
        message: "Hand over or remove the Google sources still reporting to this store first.",
      },
    });

    await expect(
      revokeReportingBindingForAsset({ kind: "shopify", connectionId: SHOPIFY, adminId: ADMIN }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      status: 409,
      message: "Hand over or remove the Google sources still reporting to this store first.",
    });
  });

  it("sends a live client's pair to the retire RPC too, so its refusal explains the next step", async () => {
    // A pair (store + its own Google account) cannot be retired as-is, but the
    // retire RPC says exactly why and what to do - hand the account over or
    // stop counting and remove it - where the plain revoke's guard would only
    // say "demote the rollout". So the live path asks the RPC and relays it.
    mocks.clientReportingAuthority.mockResolvedValue("v2");
    mocks.createServiceClient.mockReturnValue(
      service({
        client_reporting_bindings: anchorRow({
          google_ads_connection_id: "40000000-0000-4000-8000-000000000051",
        }),
        client_shopify_connections: { shopify_name: "Pair store", shopify_domain: "pair.myshopify.com" },
        client_google_ads_connections: { account_name: "Pair ads", windsor_account_id: "111-111-1111" },
      }),
    );
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "23514",
        message:
          "Hand the store's Google account over to its next store, or stop counting and remove it, before retiring the store.",
      },
    });

    await expect(
      revokeReportingBindingForAsset({ kind: "shopify", connectionId: SHOPIFY, adminId: ADMIN }),
    ).rejects.toMatchObject({ code: "invalid_state", status: 409, message: expect.stringMatching(/Hand the store's Google account over/) });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "retire_client_reporting_store",
      expect.objectContaining({ p_anchor_binding_id: BINDING }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith("revoke_client_reporting_binding", expect.anything());
  });
});
