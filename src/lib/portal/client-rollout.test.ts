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
  portalStoreSurface,
} from "./client-rollout";

/** A rollout read plus the two narrow list reads the store surface makes. */
function surfaceService(options: {
  rollout: unknown;
  legacyAccounts?: unknown[];
  boundStores?: unknown[];
}) {
  const rollout = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  rollout.select.mockReturnValue(rollout);
  rollout.eq.mockReturnValue(rollout);
  rollout.maybeSingle.mockResolvedValue({ data: options.rollout, error: null });

  const list = (data: unknown[]) => {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.not = vi.fn(() => query);
    query.limit = vi.fn(async () => ({ data, error: null }));
    return query;
  };

  const from = vi.fn((table: string) =>
    table === "client_rollout_states"
      ? rollout
      : table === "ad_accounts"
        ? list(options.legacyAccounts ?? [])
        : list(options.boundStores ?? []),
  );
  mocks.createServiceClient.mockReturnValue({ from });
  return from;
}

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

describe("portal store surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceContext.mockResolvedValue({ active: { id: "client-1" } });
  });

  it("serves the projection to a V2-only client whose store is already audited", async () => {
    // The cutover boundary protects a legacy surface. This client has none, and
    // waiting for cutover left the store bound, syncing and invisible.
    surfaceService({
      rollout: { operational_surface: "v2_ready_for_cutover", reporting_cutover_at: null },
      legacyAccounts: [],
      boundStores: [{ id: "binding-1" }],
    });

    await expect(portalStoreSurface("surface-v2-only")).resolves.toBe("v2");
  });

  it("keeps the legacy surface while the client still owns a legacy account", async () => {
    surfaceService({
      rollout: { operational_surface: "v2_ready_for_cutover", reporting_cutover_at: null },
      legacyAccounts: [{ id: "account-1" }],
      boundStores: [{ id: "binding-1" }],
    });

    await expect(portalStoreSurface("surface-mixed")).resolves.toBe("legacy");
  });

  it("keeps the legacy surface when there is no audited store to project yet", async () => {
    surfaceService({
      rollout: { operational_surface: "v2_onboarding", reporting_cutover_at: null },
      legacyAccounts: [],
      boundStores: [],
    });

    await expect(portalStoreSurface("surface-empty")).resolves.toBe("legacy");
  });

  it("leaves a client past cutover on the authority it already had", async () => {
    const from = surfaceService({
      rollout: {
        operational_surface: "v2_active",
        reporting_cutover_at: "2026-08-14T00:00:00.000Z",
      },
    });

    await expect(portalStoreSurface("surface-live")).resolves.toBe("v2");
    // Already v2: the extra reads must not happen at all.
    expect(from).not.toHaveBeenCalledWith("ad_accounts");
    expect(from).not.toHaveBeenCalledWith("client_reporting_bindings");
  });

  it("falls back to the legacy surface when the extra reads fail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const rollout = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    rollout.select.mockReturnValue(rollout);
    rollout.eq.mockReturnValue(rollout);
    rollout.maybeSingle.mockResolvedValue({
      data: { operational_surface: "v2_ready_for_cutover", reporting_cutover_at: null },
      error: null,
    });
    const broken: Record<string, ReturnType<typeof vi.fn>> = {};
    broken.select = vi.fn(() => broken);
    broken.eq = vi.fn(() => broken);
    broken.not = vi.fn(() => broken);
    broken.limit = vi.fn(async () => ({ data: null, error: { code: "42501" } }));
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn((table: string) => (table === "client_rollout_states" ? rollout : broken)),
    });

    await expect(portalStoreSurface("surface-broken")).resolves.toBe("legacy");
    consoleError.mockRestore();
  });
});
