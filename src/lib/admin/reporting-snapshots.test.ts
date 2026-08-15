import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ADMIN_REPORTING_CURRENT_RANGE_TTL_MS,
  adminReportingSnapshotIsStale,
  adminReportingAuthority,
  readAdminReportingSnapshots,
  refreshAdminReportingSnapshot,
} from "./reporting-snapshots";

const ACCOUNT = "62000000-0000-4000-8000-000000000001";
const OTHER = "62000000-0000-4000-8000-000000000002";
const RANGE = { from: "2026-08-09", to: "2026-08-15" };

function readClient(rows: unknown[]) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>["then"];
  } = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.then = (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  return {
    from: vi.fn(() => query),
  };
}

describe("admin reporting snapshots", () => {
  it("ages only current-Lisbon-day snapshots after the conservative TTL", () => {
    const now = Date.parse("2026-08-15T12:00:00.000Z");
    expect(adminReportingSnapshotIsStale({
      to: "2026-08-15",
      refreshedAt: new Date(now - ADMIN_REPORTING_CURRENT_RANGE_TTL_MS - 1).toISOString(),
      now,
    })).toBe(true);
    expect(adminReportingSnapshotIsStale({
      to: "2026-08-15",
      refreshedAt: new Date(now - ADMIN_REPORTING_CURRENT_RANGE_TTL_MS).toISOString(),
      now,
    })).toBe(false);
    expect(adminReportingSnapshotIsStale({
      to: "2026-08-14",
      refreshedAt: "2025-01-01T00:00:00.000Z",
      now,
    })).toBe(false);
  });

  it("fingerprints a manifest independently of object key order", async () => {
    const left = await adminReportingAuthority({
      surface: "v2_active",
      source: { bindingId: "one", connectionId: "two" },
    });
    const right = await adminReportingAuthority({
      source: { connectionId: "two", bindingId: "one" },
      surface: "v2_active",
    });
    expect(left.key).toBe(right.key);
    expect(left.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads one exact range in one query and misses a stale authority", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const stale = await adminReportingAuthority({ surface: "v2_active" });
    const client = readClient([
      {
        family: "google_campaigns",
        scope_account_id: ACCOUNT,
        from_day: RANGE.from,
        to_day: RANGE.to,
        authority_key: authority.key,
        authority_manifest: authority.manifest,
        state: "ready",
        payload: [{ campaignId: "123" }],
        message: null,
        last_success_at: "2026-08-15T16:00:00.000Z",
        last_attempt_at: "2026-08-15T16:00:00.000Z",
        last_error_code: null,
        lease_token: null,
        lease_expires_at: null,
        revision: 2,
      },
    ]);

    const result = await readAdminReportingSnapshots<{ campaignId: string }>({
      client: client as never,
      family: "google_campaigns",
      scopes: [
        { accountId: ACCOUNT, authorityKey: authority.key },
        { accountId: OTHER, authorityKey: stale.key },
      ],
      ...RANGE,
    });
    expect(result.get(ACCOUNT)).toMatchObject({
      state: "ready",
      rows: [{ campaignId: "123" }],
      revision: 2,
    });
    expect(result.get(OTHER)).toMatchObject({ state: "not_synced", rows: [] });
    expect(client.from).toHaveBeenCalledOnce();
  });

  it("records a failed attempt without completing over the last success", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const rpc = vi.fn(async (name: string) => {
      if (name === "claim_admin_reporting_snapshot_refresh") {
        return { data: "62000000-0000-4000-8000-000000000010", error: null };
      }
      if (name === "fail_admin_reporting_snapshot_refresh") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const result = await refreshAdminReportingSnapshot({
      client: { rpc } as never,
      family: "google_campaigns",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: async () => {
        throw new Error("provider down");
      },
    });
    expect(result).toEqual({ state: "failed", errorCode: "provider_failed" });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_admin_reporting_snapshot_refresh",
      "fail_admin_reporting_snapshot_refresh",
    ]);
  });

  it("fences completion when authority changes during a provider request", async () => {
    const before = await adminReportingAuthority({ surface: "legacy" });
    const after = await adminReportingAuthority({ surface: "v2_active" });
    const rpc = vi.fn(async (name: string) => {
      if (name === "claim_admin_reporting_snapshot_refresh") {
        return { data: "62000000-0000-4000-8000-000000000010", error: null };
      }
      if (name === "fail_admin_reporting_snapshot_refresh") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const result = await refreshAdminReportingSnapshot({
      client: { rpc } as never,
      family: "google_campaigns",
      accountId: ACCOUNT,
      ...RANGE,
      authority: before,
      verifyAuthority: async () => after,
      load: async () => ({ state: "ready", rows: [{ campaignId: "123" }] }),
    });
    expect(result).toEqual({ state: "failed", errorCode: "topology_changed" });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_admin_reporting_snapshot_refresh",
      "fail_admin_reporting_snapshot_refresh",
    ]);
  });

  it("completes a valid family and treats an active lease as idempotent busy", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: "62000000-0000-4000-8000-000000000010",
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });
    const refreshed = await refreshAdminReportingSnapshot({
      client: { rpc } as never,
      family: "google_campaigns",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: async () => ({ state: "ready", rows: [{ campaignId: "123" }] }),
    });
    expect(refreshed).toMatchObject({ state: "refreshed", snapshotState: "ready" });

    const busyRpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const busy = await refreshAdminReportingSnapshot({
      client: { rpc: busyRpc } as never,
      family: "google_campaigns",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: vi.fn(),
    });
    expect(busy).toEqual({ state: "busy" });
  });

  it("persists a partial family while exposing that degraded state to the caller", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: "62000000-0000-4000-8000-000000000010",
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });

    const result = await refreshAdminReportingSnapshot({
      client: { rpc } as never,
      family: "google_campaigns",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: async () => ({
        state: "partial",
        rows: [{ campaignId: "123" }],
        message: "One provider child is still unavailable.",
      }),
    });

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "partial" });
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({
        p_state: "partial",
        p_payload: [{ campaignId: "123" }],
      }),
    );
  });
});
