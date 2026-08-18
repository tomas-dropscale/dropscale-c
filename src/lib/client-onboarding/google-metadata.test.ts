import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkGoogleAdsAccountHealth: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/windsor/client", () => ({
  checkGoogleAdsAccountHealth: mocks.checkGoogleAdsAccountHealth,
}));

import { ensureGoogleConnectionMetadata } from "./google-metadata";

const ADMIN = "65000000-0000-4000-8000-000000000001";
const CLIENT = "65000000-0000-4000-8000-000000000002";
const CONNECTION = "65000000-0000-4000-8000-000000000030";
const SESSION = "65000000-0000-4000-8000-000000000050";

function fakeService(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const method of ["select", "eq"]) chain[method] = self;
      chain.then = (resolve: (value: unknown) => unknown) =>
        resolve({ data: tables[table] ?? [], error: null });
      return chain;
    },
    rpc: mocks.rpc,
  };
}

function tables(connection: Record<string, unknown> = {}) {
  return {
    client_google_ads_connections: [{
      id: CONNECTION,
      session_id: SESSION,
      windsor_account_id: "470-106-4403",
      currency: null,
      time_zone: null,
      ...connection,
    }],
    client_onboarding_sessions: [{ id: SESSION, created_by: ADMIN }],
    // The fake ignores .eq filters, so this table stands for the admin-only
    // result the real role filter would return.
    profiles: [{ id: ADMIN }],
  };
}

describe("automatic Google reporting metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkGoogleAdsAccountHealth.mockResolvedValue({
      ok: true,
      checkedAt: "2026-08-18T00:00:00.000Z",
      account: { currency: "EUR", timeZone: "Europe/Paris" },
    });
    mocks.rpc.mockResolvedValue({ data: CONNECTION, error: null });
  });

  it("enriches a connected source that never got its metadata", async () => {
    const result = await ensureGoogleConnectionMetadata(
      fakeService(tables()) as never,
    );

    expect(result).toEqual({ attempted: 1, enriched: 1, failed: 0 });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "enrich_client_google_ads_reporting_metadata",
      expect.objectContaining({
        p_connection_id: CONNECTION,
        p_currency: "EUR",
        p_time_zone: "Europe/Paris",
        p_admin_id: ADMIN,
      }),
    );
  });

  it("leaves already-enriched and non-admin-created sources alone", async () => {
    const enriched = await ensureGoogleConnectionMetadata(
      fakeService(tables({ currency: "EUR", time_zone: "Europe/Paris" })) as never,
    );
    expect(enriched).toEqual({ attempted: 0, enriched: 0, failed: 0 });

    const noAdmin = tables();
    noAdmin.client_onboarding_sessions = [{ id: SESSION, created_by: CLIENT }];
    const skipped = await ensureGoogleConnectionMetadata(
      fakeService(noAdmin) as never,
    );
    expect(skipped).toEqual({ attempted: 0, enriched: 0, failed: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("never overwrites a conflicting verified identity", async () => {
    mocks.checkGoogleAdsAccountHealth.mockResolvedValue({
      ok: true,
      checkedAt: "2026-08-18T00:00:00.000Z",
      account: { currency: "USD", timeZone: "Europe/Paris" },
    });

    const result = await ensureGoogleConnectionMetadata(
      fakeService(tables({ currency: "EUR" })) as never,
    );

    expect(result).toEqual({ attempted: 1, enriched: 0, failed: 1 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
