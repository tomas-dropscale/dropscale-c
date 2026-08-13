import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionProfile: vi.fn(),
  createServiceClient: vi.fn(),
  createClientOnboardingInvitationMaterial: vi.fn(),
  hashClientOnboardingToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/shopify/client", () => ({
  normalizeShopDomain: (value: string) =>
    value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0],
}));
vi.mock("@/lib/client-onboarding/invitations", () => ({
  clientOnboardingInvitationUrl: vi.fn(),
  createClientOnboardingInvitationMaterial: mocks.createClientOnboardingInvitationMaterial,
  hashClientOnboardingToken: mocks.hashClientOnboardingToken,
  isClientOnboardingId: (value: unknown) => typeof value === "string" && value.length === 36,
  isClientOnboardingToken: (value: unknown) => typeof value === "string" && value.length === 43,
}));

import {
  authorizeClientOnboardingRequest,
  createClientOnboardingSession,
  recoverClientOnboardingIdentity,
  revokeClientOnboardingSession,
} from "./sessions";

const SESSION = "40000000-0000-4000-8000-000000000001";
const OWNER = "40000000-0000-4000-8000-000000000002";
const OTHER_USER = "40000000-0000-4000-8000-000000000003";
const OTHER_SESSION = "40000000-0000-4000-8000-000000000004";
const TOKEN = "a".repeat(43);
const TOKEN_HASH = "stored-token-hash";

describe("client onboarding invitation asset rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClientOnboardingInvitationMaterial.mockResolvedValue({
      id: SESSION,
      token: TOKEN,
      tokenHash: TOKEN_HASH,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      url: `https://dropscale.app/onboarding/client/${SESSION}#${TOKEN}`,
    });
  });

  it.each(["shopify", "google_ads"])(
    "rejects a partial new-client setup requesting only %s",
    async (asset) => {
      const { rpc } = serviceFor(sessionRow());

      await expect(
        createClientOnboardingSession({
          mode: "new_client",
          requestedAssets: [asset],
          adminId: OTHER_USER,
        }),
      ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
      expect(mocks.createClientOnboardingInvitationMaterial).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("keeps a purpose-bound Add assets link valid", async () => {
    const { rpc } = serviceFor(sessionRow());

    await expect(
      createClientOnboardingSession({
        mode: "add_assets",
        requestedAssets: ["google_ads"],
        targetClientId: OWNER,
        adminId: OTHER_USER,
      }),
    ).resolves.toMatchObject({
      mode: "add_assets",
      requestedAssets: ["google_ads"],
    });
    expect(rpc).toHaveBeenCalledWith(
      "create_client_onboarding_invitation",
      expect.objectContaining({ p_target_client_id: OWNER }),
    );
  });

  it("creates reconnect through the exact Shopify-target RPC without a client id", async () => {
    const { rpc } = serviceFor(sessionRow());

    await expect(
      createClientOnboardingSession({
        mode: "reconnect",
        requestedAssets: ["shopify"],
        targetShopify: { source: "legacy", id: OTHER_SESSION },
        adminId: OTHER_USER,
      }),
    ).resolves.toMatchObject({
      mode: "reconnect",
      requestedAssets: ["shopify"],
      targetShopify: { source: "legacy", id: OTHER_SESSION },
    });
    expect(rpc).toHaveBeenCalledWith(
      "create_client_shopify_reconnect_invitation",
      {
        p_session_id: SESSION,
        p_target_source: "legacy",
        p_target_id: OTHER_SESSION,
        p_token_hash: TOKEN_HASH,
        p_expires_at: expect.any(String),
        p_created_by: OTHER_USER,
      },
    );
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("p_target_client_id");
  });

  it.each([
    ["a missing target", ["shopify"], undefined],
    ["Google Ads", ["google_ads"], { source: "legacy", id: OTHER_SESSION }],
    ["a general client id", ["shopify"], { source: "legacy", id: OTHER_SESSION }],
  ] as const)("rejects reconnect with %s", async (_label, requestedAssets, targetShopify) => {
    const { rpc } = serviceFor(sessionRow());

    await expect(
      createClientOnboardingSession({
        mode: "reconnect",
        requestedAssets,
        ...(targetShopify ? { targetShopify } : {}),
        ...(_label === "a general client id" ? { targetClientId: OWNER } : {}),
        adminId: OTHER_USER,
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });
});

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    mode: "new_client",
    requested_assets: [],
    status: "pending",
    invite_token_hash: TOKEN_HASH,
    invite_expires_at: new Date(Date.now() + 60_000).toISOString(),
    failed_attempts: 0,
    last_attempt_at: null,
    target_client_id: null,
    reconnect_legacy_ad_account_id: null,
    reconnect_shopify_connection_id: null,
    reconnect_completed_at: null,
    claimed_user_id: null,
    first_name: null,
    last_name: null,
    email: null,
    created_by: OTHER_USER,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    identity_created_at: null,
    submitted_at: null,
    reviewed_at: null,
    reviewed_by: null,
    activated_at: null,
    revoked_at: null,
    last_error_code: null,
    ...overrides,
  };
}

function serviceFor(row: ReturnType<typeof sessionRow>) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  const rpc = vi.fn(async () => ({ data: SESSION, error: null }));
  const getUserById = vi.fn(async () => ({
    data: {
      user: authUser({
        user_metadata: {
          client_onboarding_id: SESSION,
          display_name: "Casey Example",
          preferences: { locale: "en" },
        },
      }),
    },
    error: null,
  }));
  const updateUserById = vi.fn(async () => ({ data: { user: authUser() }, error: null }));
  const deleteUser = vi.fn();
  const service = {
    from: vi.fn(() => query),
    rpc,
    auth: {
      admin: { getUserById, updateUserById, deleteUser },
    },
  };
  mocks.createServiceClient.mockReturnValue(service);
  return { service, query, rpc, getUserById, updateUserById, deleteUser };
}

function authUser(overrides: Record<string, unknown> = {}) {
  return {
    id: OWNER,
    email: "casey@example.com",
    user_metadata: { client_onboarding_id: SESSION },
    ...overrides,
  };
}

describe("claimed existing-client onboarding authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hashClientOnboardingToken.mockResolvedValue(TOKEN_HASH);
  });

  it.each([
    ["no authenticated user", null],
    ["a different authenticated user", authUser({ id: OTHER_USER })],
  ])("rejects a valid bearer presented by %s", async (_label, user) => {
    serviceFor(
      sessionRow({
        mode: "add_assets",
        requested_assets: ["shopify"],
        target_client_id: OWNER,
        claimed_user_id: OWNER,
      }),
    );
    mocks.getSessionProfile.mockResolvedValue({ user, profile: null });

    await expect(authorizeClientOnboardingRequest(SESSION, TOKEN)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("allows the matching logged-in owner and retains the stored hash for open-session RPCs", async () => {
    serviceFor(
      sessionRow({
        mode: "add_assets",
        requested_assets: ["shopify"],
        target_client_id: OWNER,
        claimed_user_id: OWNER,
      }),
    );
    mocks.getSessionProfile.mockResolvedValue({ user: authUser(), profile: null });

    await expect(authorizeClientOnboardingRequest(SESSION, TOKEN)).resolves.toMatchObject({
      tokenHash: TOKEN_HASH,
      actorUserId: OWNER,
    });
  });

  it.each(["submitted", "reviewed", "active"])(
    "allows the matching owner to reload a %s session without reusing the bearer",
    async (status) => {
      serviceFor(
        sessionRow({
          mode: "add_assets",
          requested_assets: ["shopify"],
          status,
          invite_token_hash: null,
          invite_expires_at: null,
          target_client_id: OWNER,
          claimed_user_id: OWNER,
        }),
      );
      mocks.getSessionProfile.mockResolvedValue({ user: authUser(), profile: null });

      await expect(authorizeClientOnboardingRequest(SESSION)).resolves.toMatchObject({
        tokenHash: "",
        actorUserId: OWNER,
        usingInvitation: false,
      });
    },
  );
});

describe("new-client identity recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hashClientOnboardingToken.mockResolvedValue(TOKEN_HASH);
  });

  it("claims the invitation for the currently authenticated matching Auth user", async () => {
    const { rpc } = serviceFor(sessionRow());
    mocks.getSessionProfile.mockResolvedValue({ user: authUser(), profile: null });

    await expect(
      recoverClientOnboardingIdentity({
        sessionId: SESSION,
        invitationToken: TOKEN,
        firstName: " Casey ",
        lastName: " Example ",
        email: "CASEY@example.com",
      }),
    ).resolves.toMatchObject({ alreadyCreated: true });
    expect(rpc).toHaveBeenCalledWith("claim_client_onboarding_identity", {
      p_session_id: SESSION,
      p_token_hash: TOKEN_HASH,
      p_user_id: OWNER,
      p_first_name: "Casey",
      p_last_name: "Example",
      p_email: "casey@example.com",
    });
  });

  it("recovers a pre-existing Auth identity whose metadata was not updated by sign-up", async () => {
    const { rpc, updateUserById } = serviceFor(sessionRow());
    mocks.getSessionProfile.mockResolvedValue({
      user: authUser({ user_metadata: {} }),
      profile: null,
    });

    await expect(
      recoverClientOnboardingIdentity({
        sessionId: SESSION,
        invitationToken: TOKEN,
        firstName: "Casey",
        lastName: "Example",
        email: "casey@example.com",
      }),
    ).resolves.toMatchObject({ alreadyCreated: true });
    expect(rpc).toHaveBeenCalledWith(
      "claim_client_onboarding_identity",
      expect.objectContaining({ p_user_id: OWNER, p_email: "casey@example.com" }),
    );
    expect(updateUserById).toHaveBeenCalledWith(OWNER, {
      user_metadata: { client_onboarding_id: SESSION },
    });
  });

  it("recovers safely when metadata points to the same user's revoked prior invitation", async () => {
    const { query, rpc, updateUserById } = serviceFor(sessionRow());
    query.maybeSingle
      .mockResolvedValueOnce({ data: sessionRow(), error: null })
      .mockResolvedValueOnce({
        data: {
          mode: "new_client",
          status: "revoked",
          claimed_user_id: OWNER,
          email: "casey@example.com",
        },
        error: null,
      });
    mocks.getSessionProfile.mockResolvedValue({
      user: authUser({
        user_metadata: {
          client_onboarding_id: OTHER_SESSION,
          preferences: { locale: "en" },
        },
      }),
      profile: null,
    });

    await expect(
      recoverClientOnboardingIdentity({
        sessionId: SESSION,
        invitationToken: TOKEN,
        firstName: "Casey",
        lastName: "Example",
        email: "casey@example.com",
      }),
    ).resolves.toMatchObject({ alreadyCreated: true });
    expect(rpc).toHaveBeenCalledWith(
      "claim_client_onboarding_identity",
      expect.objectContaining({ p_user_id: OWNER }),
    );
    expect(updateUserById).toHaveBeenCalledWith(OWNER, {
      user_metadata: {
        client_onboarding_id: SESSION,
        preferences: { locale: "en" },
      },
    });
  });

  it.each([
    ["session metadata", authUser({ user_metadata: { client_onboarding_id: OTHER_SESSION } })],
    ["email", authUser({ email: "someone-else@example.com" })],
  ])("rejects a recovery with mismatched Auth %s", async (_label, user) => {
    const { rpc } = serviceFor(sessionRow());
    mocks.getSessionProfile.mockResolvedValue({ user, profile: null });

    await expect(
      recoverClientOnboardingIdentity({
        sessionId: SESSION,
        invitationToken: TOKEN,
        firstName: "Casey",
        lastName: "Example",
        email: "casey@example.com",
      }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("new-client cancellation identity continuity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retains the Auth user and removes only the cancelled invitation metadata", async () => {
    const { rpc, getUserById, updateUserById, deleteUser } = serviceFor(
      sessionRow({ status: "collecting", claimed_user_id: OWNER }),
    );

    await expect(revokeClientOnboardingSession(SESSION, OTHER_USER)).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledWith("revoke_client_onboarding_session", {
      p_session_id: SESSION,
      p_admin_id: OTHER_USER,
    });
    expect(getUserById).toHaveBeenCalledWith(OWNER);
    expect(updateUserById).toHaveBeenCalledWith(OWNER, {
      user_metadata: {
        display_name: "Casey Example",
        preferences: { locale: "en" },
      },
    });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("does not clear correlation metadata owned by another onboarding session", async () => {
    const { getUserById, updateUserById, deleteUser } = serviceFor(
      sessionRow({ status: "collecting", claimed_user_id: OWNER }),
    );
    getUserById.mockResolvedValueOnce({
      data: {
        user: authUser({
          user_metadata: {
            client_onboarding_id: OTHER_SESSION,
            display_name: "Casey Example",
          },
        }),
      },
      error: null,
    });

    await expect(revokeClientOnboardingSession(SESSION, OTHER_USER)).resolves.toBeUndefined();

    expect(updateUserById).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("can retry only the metadata finalization after the database cancellation committed", async () => {
    const { rpc, updateUserById } = serviceFor(
      sessionRow({ status: "revoked", claimed_user_id: OWNER }),
    );

    await expect(revokeClientOnboardingSession(SESSION, OTHER_USER)).resolves.toBeUndefined();

    expect(rpc).not.toHaveBeenCalled();
    expect(updateUserById).toHaveBeenCalledWith(OWNER, {
      user_metadata: {
        display_name: "Casey Example",
        preferences: { locale: "en" },
      },
    });
  });
});
