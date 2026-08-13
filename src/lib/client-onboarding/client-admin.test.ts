import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ClientOnboardingError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return {
    ClientOnboardingError,
    createServiceClient: vi.fn(),
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
    profileSelect: vi.fn(),
    profileEq: vi.fn(),
    profileMaybeSingle: vi.fn(),
    getUserById: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUserById: vi.fn(),
    rpc: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import {
  archivePortalClient,
  sendPortalClientPasswordReset,
  updatePortalClientIdentity,
} from "./client-admin";

const CLIENT_ID = "40000000-0000-4000-8000-000000000001";
const ADMIN_ID = "40000000-0000-4000-8000-000000000002";
const OLD_EMAIL = "owner@northwind.example";
const NEW_EMAIL = "team@northwind.example";

function portal(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_ID,
    full_name: "Northwind Home",
    email: OLD_EMAIL,
    discord_handle: "northwind.home",
    approval_status: "approved",
    ...overrides,
  };
}

function authUser(email: string, confirmed = true) {
  return {
    data: {
      user: {
        id: CLIENT_ID,
        email,
        email_confirmed_at: confirmed ? "2026-08-01T10:00:00.000Z" : null,
      },
    },
    error: null,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    clientId: CLIENT_ID,
    fullName: "Northwind Commerce",
    email: NEW_EMAIL,
    discordHandle: "@northwind.team",
    adminId: ADMIN_ID,
    ...overrides,
  } as Parameters<typeof updatePortalClientIdentity>[0];
}

describe("admin portal client persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) =>
      table === "profiles"
        ? { select: mocks.profileSelect }
        : { select: mocks.select },
    );
    mocks.select.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.profileSelect.mockReturnValue({ eq: mocks.profileEq });
    mocks.profileEq.mockReturnValue({ maybeSingle: mocks.profileMaybeSingle });
    mocks.maybeSingle.mockResolvedValue({ data: portal(), error: null });
    mocks.profileMaybeSingle.mockResolvedValue({
      data: { role: "member" },
      error: null,
    });
    mocks.getUserById.mockResolvedValue(authUser(OLD_EMAIL));
    mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    mocks.updateUserById.mockResolvedValue(authUser(NEW_EMAIL));
    mocks.rpc.mockResolvedValue({ data: CLIENT_ID, error: null });
    mocks.createServiceClient.mockReturnValue({
      from: mocks.from,
      auth: {
        admin: {
          getUserById: mocks.getUserById,
          updateUserById: mocks.updateUserById,
        },
        resetPasswordForEmail: mocks.resetPasswordForEmail,
      },
      rpc: mocks.rpc,
    });
  });

  it("loads both identity authorities before changing Auth, then calls the exact RPC", async () => {
    await expect(
      updatePortalClientIdentity(
        input({
          fullName: "  Northwind   Commerce  ",
          email: " TEAM@NORTHWIND.EXAMPLE ",
          discordHandle: " @northwind.team ",
        }),
      ),
    ).resolves.toEqual({
      id: CLIENT_ID,
      fullName: "Northwind Commerce",
      email: NEW_EMAIL,
      discordHandle: "northwind.team",
    });

    expect(mocks.maybeSingle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUserById.mock.invocationCallOrder[0],
    );
    expect(mocks.getUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUserById.mock.invocationCallOrder[0],
    );
    expect(mocks.updateUserById).toHaveBeenCalledWith(CLIENT_ID, {
      email: NEW_EMAIL,
      email_confirm: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("update_portal_client_identity", {
      p_client_id: CLIENT_ID,
      p_full_name: "Northwind Commerce",
      p_email: NEW_EMAIL,
      p_discord_handle: "northwind.team",
      p_admin_id: ADMIN_ID,
    });
  });

  it("normalises an empty Discord handle to null without rewriting an unchanged Auth email", async () => {
    mocks.getUserById.mockResolvedValue(authUser(OLD_EMAIL));

    const result = await updatePortalClientIdentity(
      input({ email: OLD_EMAIL, discordHandle: "   " }),
    );

    expect(result.discordHandle).toBeNull();
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "update_portal_client_identity",
      expect.objectContaining({ p_email: OLD_EMAIL, p_discord_handle: null }),
    );
  });

  it.each([
    "x",
    "@@northwind",
    "two words",
    "https://discord.com/users/1",
    "discord.com/name",
    "discordapp.com/name",
    "www.name",
  ])(
    "rejects an invalid Discord value before constructing service persistence",
    async (discordHandle) => {
      await expect(
        updatePortalClientIdentity(input({ discordHandle })),
      ).rejects.toMatchObject({ code: "invalid_request", status: 400 });

      expect(mocks.createServiceClient).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("restores Auth only after proving a failed RPC left the portal row unchanged", async () => {
    mocks.maybeSingle
      .mockResolvedValueOnce({ data: portal(), error: null })
      .mockResolvedValueOnce({ data: portal(), error: null });
    mocks.getUserById
      .mockResolvedValueOnce(authUser(OLD_EMAIL))
      .mockResolvedValueOnce(authUser(NEW_EMAIL));
    mocks.updateUserById
      .mockResolvedValueOnce(authUser(NEW_EMAIL))
      .mockResolvedValueOnce(authUser(OLD_EMAIL));
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "Invalid identity." },
    });

    await expect(updatePortalClientIdentity(input())).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });

    expect(mocks.updateUserById).toHaveBeenNthCalledWith(2, CLIENT_ID, {
      email: OLD_EMAIL,
      email_confirm: true,
    });
  });

  it("maps a database email conflict and safely restores Auth", async () => {
    mocks.maybeSingle
      .mockResolvedValueOnce({ data: portal(), error: null })
      .mockResolvedValueOnce({ data: portal(), error: null });
    mocks.getUserById
      .mockResolvedValueOnce(authUser(OLD_EMAIL))
      .mockResolvedValueOnce(authUser(NEW_EMAIL));
    mocks.updateUserById
      .mockResolvedValueOnce(authUser(NEW_EMAIL))
      .mockResolvedValueOnce(authUser(OLD_EMAIL));
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate key value" },
    });

    await expect(updatePortalClientIdentity(input())).rejects.toMatchObject({
      code: "identity_exists",
      status: 409,
      message: "That email is already used by another account.",
    });
    expect(mocks.updateUserById).toHaveBeenNthCalledWith(2, CLIENT_ID, {
      email: OLD_EMAIL,
      email_confirm: true,
    });
  });

  it("accepts verified desired state after an ambiguous RPC failure without undoing Auth", async () => {
    mocks.maybeSingle
      .mockResolvedValueOnce({ data: portal(), error: null })
      .mockResolvedValueOnce({
        data: portal({
          full_name: "Northwind Commerce",
          email: NEW_EMAIL,
          discord_handle: "northwind.team",
        }),
        error: null,
      });
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "fetch_failed", message: "Connection closed." },
    });

    await expect(updatePortalClientIdentity(input())).resolves.toMatchObject({
      email: NEW_EMAIL,
      discordHandle: "northwind.team",
    });
    expect(mocks.updateUserById).toHaveBeenCalledTimes(1);
  });

  it("does not restore Auth when a failed RPC leaves a divergent database state", async () => {
    mocks.maybeSingle
      .mockResolvedValueOnce({ data: portal(), error: null })
      .mockResolvedValueOnce({
        data: portal({ full_name: "Changed concurrently" }),
        error: null,
      });
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "fetch_failed", message: "Connection closed." },
    });

    await expect(updatePortalClientIdentity(input())).rejects.toMatchObject({
      code: "database_error",
      status: 500,
      message:
        "The client identity update could not be verified. Refresh before retrying.",
    });
    expect(mocks.updateUserById).toHaveBeenCalledTimes(1);
    expect(mocks.updateUserById).toHaveBeenCalledWith(CLIENT_ID, {
      email: NEW_EMAIL,
      email_confirm: true,
    });
  });

  it("does not call the RPC when Auth definitively rejects a duplicate email", async () => {
    mocks.updateUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { code: "email_exists", status: 422, message: "Email already exists" },
    });
    mocks.getUserById
      .mockResolvedValueOnce(authUser(OLD_EMAIL))
      .mockResolvedValueOnce(authUser(OLD_EMAIL));

    await expect(updatePortalClientIdentity(input())).rejects.toMatchObject({
      code: "identity_exists",
      status: 409,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("sends recovery only to the matching Auth email with a token-hash callback redirect", async () => {
    await expect(sendPortalClientPasswordReset(CLIENT_ID)).resolves.toBe(
      OLD_EMAIL,
    );

    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(OLD_EMAIL, {
      redirectTo:
        "https://dropscale.app/auth/callback?next=%2Freset-password",
    });
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not send a recovery email when the portal client does not exist", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(sendPortalClientPasswordReset(CLIENT_ID)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("rejects a password reset while the portal and Auth emails disagree", async () => {
    mocks.getUserById.mockResolvedValue(authUser(NEW_EMAIL));

    await expect(sendPortalClientPasswordReset(CLIENT_ID)).rejects.toMatchObject({
      code: "invalid_state",
      status: 409,
    });
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("does not send password reset email for an archived client", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: portal({ approval_status: "rejected" }),
      error: null,
    });

    await expect(sendPortalClientPasswordReset(CLIENT_ID)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(mocks.getUserById).not.toHaveBeenCalled();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("does not send password reset email to an admin profile", async () => {
    mocks.profileMaybeSingle.mockResolvedValue({
      data: { role: "admin" },
      error: null,
    });

    await expect(sendPortalClientPasswordReset(CLIENT_ID)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("fails closed when the exact Auth account has no email", async () => {
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: CLIENT_ID, email: null } },
      error: null,
    });

    await expect(sendPortalClientPasswordReset(CLIENT_ID)).rejects.toMatchObject({
      code: "invalid_state",
      status: 409,
    });
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("classifies password-reset rate limits without leaking Auth details", async () => {
    mocks.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: {
        code: "over_email_send_rate_limit",
        status: 429,
        message: "Internal provider detail",
      },
    });

    await expect(sendPortalClientPasswordReset(CLIENT_ID)).rejects.toMatchObject({
      code: "too_many_attempts",
      status: 429,
      message: "Too many reset emails were requested. Wait a minute and try again.",
    });
  });

  it.each([
    { mode: "returned", detail: "SMTP password leaked" },
    { mode: "thrown", detail: "Network secret leaked" },
  ])(
    "redacts a $mode password-reset provider failure",
    async ({ mode, detail }) => {
      if (mode === "thrown") {
        mocks.resetPasswordForEmail.mockRejectedValue(new Error(detail));
      } else {
        mocks.resetPasswordForEmail.mockResolvedValue({
          data: null,
          error: { code: "smtp_failed", status: 500, message: detail },
        });
      }

      await expect(sendPortalClientPasswordReset(CLIENT_ID)).rejects.toMatchObject({
        code: "identity_failed",
        status: 502,
        message: "The password reset email could not be sent.",
      });
    },
  );

  it("archives through the service-only RPC without deleting any related row in TypeScript", async () => {
    await archivePortalClient(CLIENT_ID, ADMIN_ID);

    expect(mocks.rpc).toHaveBeenCalledWith("archive_portal_client", {
      p_client_id: CLIENT_ID,
      p_admin_id: ADMIN_ID,
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it.each([
    {
      databaseError: {
        code: "P0002",
        message: "Target portal client not found.",
      },
      expected: {
        code: "not_found",
        status: 404,
        message: "Client not found.",
      },
    },
    {
      databaseError: { code: "42501", message: "Target is an admin." },
      expected: { code: "forbidden", status: 403, message: "Forbidden." },
    },
    {
      databaseError: { code: "XX000", message: "Internal detail." },
      expected: {
        code: "database_error",
        status: 500,
        message: "The client identity could not be updated.",
      },
    },
  ])(
    "maps archive error $databaseError.code without leaking database details",
    async ({ databaseError, expected }) => {
      mocks.rpc.mockResolvedValue({ data: null, error: databaseError });

      await expect(
        archivePortalClient(CLIENT_ID, ADMIN_ID),
      ).rejects.toMatchObject(expected);
    },
  );
});
