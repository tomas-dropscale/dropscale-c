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

import {
  clientReportingAuthority,
  legacyAssetActionsBlocked,
} from "./client-rollout";

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

  it("keeps legacy asset actions until reporting has a durable cutover marker", async () => {
    const { from, query } = serviceResult({
      operational_surface: "v2_active",
      reporting_cutover_at: null,
    });

    await expect(legacyAssetActionsBlocked()).resolves.toBe(false);
    expect(from).toHaveBeenCalledWith("client_rollout_states");
    expect(query.eq).toHaveBeenCalledWith("client_id", "client-1");
  });

  it.each(["legacy_only", "v2_onboarding", "v2_ready_for_cutover", "rollback_legacy"])(
    "keeps legacy actions for the %s transition state",
    async (operationalSurface) => {
      serviceResult({
        operational_surface: operationalSurface,
        reporting_cutover_at: null,
      });
      await expect(legacyAssetActionsBlocked()).resolves.toBe(false);
    },
  );

  it("keeps a historical V2-active client on legacy reporting without the cutover marker", async () => {
    serviceResult({
      operational_surface: "v2_active",
      reporting_cutover_at: null,
    });

    await expect(clientReportingAuthority("client-1")).resolves.toBe("legacy");
  });

  it("uses V2 reporting only after the purpose-bound cutover marker exists", async () => {
    serviceResult({
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T01:00:00.000Z",
    });

    await expect(clientReportingAuthority("client-1")).resolves.toBe("v2");
  });

  it("blocks legacy asset actions after the purpose-bound reporting cutover", async () => {
    serviceResult({
      operational_surface: "v2_active",
      reporting_cutover_at: "2026-08-14T01:00:00.000Z",
    });

    await expect(legacyAssetActionsBlocked()).resolves.toBe(true);
  });

  it("lets rollback_legacy override the historical cutover marker", async () => {
    serviceResult({
      operational_surface: "rollback_legacy",
      reporting_cutover_at: "2026-08-14T01:00:00.000Z",
    });

    await expect(clientReportingAuthority("client-1")).resolves.toBe("legacy");
  });

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
