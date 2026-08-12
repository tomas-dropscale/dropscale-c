import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  getWorkspaceContext: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/portal/workspace", () => ({
  getWorkspaceContext: mocks.getWorkspaceContext,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { legacyAssetActionsBlocked } from "./client-rollout";

function serviceResult(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.maybeSingle,
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  mocks.maybeSingle.mockResolvedValue({ data, error });

  const from = vi.fn().mockReturnValue(query);
  mocks.createServiceClient.mockReturnValue({ from });
  return { from, query };
}

describe("portal client rollout guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceContext.mockResolvedValue({ active: { id: "client-1" } });
  });

  it("blocks legacy asset actions after the client is V2 active", async () => {
    const { from, query } = serviceResult({ operational_surface: "v2_active" });

    await expect(legacyAssetActionsBlocked()).resolves.toBe(true);
    expect(from).toHaveBeenCalledWith("client_rollout_states");
    expect(query.eq).toHaveBeenCalledWith("client_id", "client-1");
  });

  it.each(["legacy_only", "v2_onboarding", "v2_ready_for_cutover", "rollback_legacy"])(
    "keeps legacy actions for the %s transition state",
    async (operationalSurface) => {
      serviceResult({ operational_surface: operationalSurface });
      await expect(legacyAssetActionsBlocked()).resolves.toBe(false);
    },
  );

  it("keeps legacy behaviour when the workspace has no rollout row", async () => {
    serviceResult(null);
    await expect(legacyAssetActionsBlocked()).resolves.toBe(false);
  });

  it("fails closed when rollout state cannot be established", async () => {
    mocks.createServiceClient.mockReturnValue(null);
    await expect(legacyAssetActionsBlocked()).resolves.toBe(true);
  });

  it("fails closed when the rollout query errors", async () => {
    serviceResult(null, { code: "temporary_failure" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(legacyAssetActionsBlocked()).resolves.toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      "client rollout lookup failed:",
      "temporary_failure",
    );
    consoleError.mockRestore();
  });
});
