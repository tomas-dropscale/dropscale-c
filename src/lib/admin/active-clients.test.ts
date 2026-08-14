import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { countActiveClients } from "./active-clients";

function query(data: unknown, error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>["then"];
  } = {
    select: vi.fn(),
    eq: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.then = (resolve, reject) => Promise.resolve({ data, error }).then(resolve, reject);
  return chain;
}

function session(accounts: string[], admins: string[] = []) {
  return {
    from: vi.fn((table: string) => {
      if (table === "ad_accounts") {
        return query(accounts.map((client_id) => ({ client_id })));
      }
      if (table === "profiles") return query(admins.map((id) => ({ id })));
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

describe("active client reporting projection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unions legacy active clients with marked cutovers and excludes admins", async () => {
    const rollouts = [
      {
        client_id: "cutover-pending",
        operational_surface: "v2_active",
        reporting_cutover_at: "2026-08-14T00:00:00Z",
        reporting_cutover_by: "admin",
        reporting_cutover_reason: "Reporting cutover",
      },
      {
        client_id: "historical-v2-active",
        operational_surface: "v2_active",
        reporting_cutover_at: null,
        reporting_cutover_by: null,
        reporting_cutover_reason: null,
      },
      {
        client_id: "admin",
        operational_surface: "v2_active",
        reporting_cutover_at: "2026-08-14T00:00:00Z",
        reporting_cutover_by: "admin",
        reporting_cutover_reason: "Reporting cutover",
      },
      {
        client_id: "rolled-back",
        operational_surface: "rollback_legacy",
        reporting_cutover_at: "2026-08-13T00:00:00Z",
        reporting_cutover_by: "admin",
        reporting_cutover_reason: "Reporting cutover",
      },
    ];
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn(() => query(rollouts)),
    });

    await expect(
      countActiveClients(
        session(["legacy", "legacy", "historical-v2-active", "admin"], [
          "admin",
        ]) as never,
      ),
    ).resolves.toBe(3);
  });

  it("fails closed when a durable marker is only partially readable", async () => {
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn(() =>
        query([
          {
            client_id: "client-1",
            operational_surface: "v2_active",
            reporting_cutover_at: "2026-08-14T00:00:00Z",
            reporting_cutover_by: null,
            reporting_cutover_reason: null,
          },
        ]),
      ),
    });

    await expect(countActiveClients(session(["legacy"]) as never)).rejects.toThrow(
      "inconsistent",
    );
  });

  it("fails closed when rollout authority cannot be read", async () => {
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn(() => query(null, { code: "42501" })),
    });

    await expect(countActiveClients(session(["legacy"]) as never)).rejects.toThrow(
      "unavailable",
    );
  });
});
