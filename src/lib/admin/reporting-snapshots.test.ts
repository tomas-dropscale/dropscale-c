import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { presetSelection } from "../portal/range";
import {
  ADMIN_REPORTING_CURRENT_RANGE_TTL_MS,
  ADMIN_REPORTING_KEEP_LAST_GOOD_MS,
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

/**
 * A refresh client: the claim and completion RPCs succeed, and the one row
 * read behind the keep-last-good rule and the today guard answers with `row`
 * (null: never synced).
 */
function refreshClient(
  row: {
    state: string;
    last_success_at: string | null;
    payload?: unknown;
    message?: string | null;
    last_error_code?: string | null;
  } | null,
) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_admin_reporting_snapshot_refresh") {
      return { data: "62000000-0000-4000-8000-000000000010", error: null };
    }
    return { data: true, error: null };
  });
  const query: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: row, error: null });
  return { rpc, from: vi.fn(() => query), query };
}

const DEGRADED_PARTIAL = {
  state: "partial" as const,
  rows: [{ campaignId: "123" }],
  message: "Google metrics are ready; Shopify attribution is unavailable.",
  degraded: { code: "provider_partial" },
};

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

  it("persists a degraded partial family when no prior success exists", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const client = refreshClient(null);

    const result = await refreshAdminReportingSnapshot({
      client: client as never,
      family: "google_campaigns",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: async () => DEGRADED_PARTIAL,
    });

    // Google-only data beats nothing: the dashed sheet is still persisted.
    expect(result).toMatchObject({ state: "refreshed", snapshotState: "partial" });
    expect(client.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({
        p_state: "partial",
        p_payload: [{ campaignId: "123" }],
        p_message: DEGRADED_PARTIAL.message,
      }),
    );
    expect(client.from).toHaveBeenCalledWith("admin_reporting_range_snapshots");
    expect(client.query.eq).toHaveBeenCalledWith("authority_key", authority.key);
  });

  it("keeps a ready snapshot from the last day and records the degraded reload as a failure", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const client = refreshClient({
      state: "ready",
      last_success_at: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await refreshAdminReportingSnapshot({
      client: client as never,
      family: "store_campaign_performance",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: async () => DEGRADED_PARTIAL,
    });

    expect(result).toEqual({ state: "failed", errorCode: "provider_partial" });
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_admin_reporting_snapshot_refresh",
      "fail_admin_reporting_snapshot_refresh",
    ]);
    expect(client.rpc).toHaveBeenLastCalledWith(
      "fail_admin_reporting_snapshot_refresh",
      expect.objectContaining({
        p_error_code: "provider_partial",
        p_error_message: DEGRADED_PARTIAL.message,
        p_lease_token: "62000000-0000-4000-8000-000000000010",
      }),
    );
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("replaces a ready snapshot older than a day with the degraded partial", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const client = refreshClient({
      state: "ready",
      last_success_at: new Date(
        Date.now() - ADMIN_REPORTING_KEEP_LAST_GOOD_MS - 60_000,
      ).toISOString(),
    });

    const result = await refreshAdminReportingSnapshot({
      client: client as never,
      family: "store_campaign_performance",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: async () => DEGRADED_PARTIAL,
    });

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "partial" });
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_admin_reporting_snapshot_refresh",
      "complete_admin_reporting_snapshot_refresh",
    ]);
  });

  it("replaces a prior partial snapshot with the degraded partial", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const client = refreshClient({
      state: "partial",
      last_success_at: new Date().toISOString(),
    });

    const result = await refreshAdminReportingSnapshot({
      client: client as never,
      family: "store_campaign_performance",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: async () => DEGRADED_PARTIAL,
    });

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "partial" });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({ p_state: "partial" }),
    );
  });

  it("never reads the row for a partial that is not degraded, and caps the stored message", async () => {
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
        message: "x".repeat(1_200),
      }),
    });

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "partial" });
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({
        p_state: "partial",
        p_message: "x".repeat(1_000),
      }),
    );
  });

  it("rejects a degraded code the row cannot store", async () => {
    const authority = await adminReportingAuthority({ surface: "legacy" });
    const client = refreshClient(null);

    const result = await refreshAdminReportingSnapshot({
      client: client as never,
      family: "google_campaigns",
      accountId: ACCOUNT,
      ...RANGE,
      authority,
      verifyAuthority: async () => authority,
      load: async () => ({ ...DEGRADED_PARTIAL, degraded: { code: "Not-Valid" } }),
    });

    expect(result).toEqual({ state: "failed", errorCode: "provider_failed" });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "fail_admin_reporting_snapshot_refresh",
      expect.objectContaining({ p_error_code: "provider_failed" }),
    );
  });
});

describe("the today snapshot guard", () => {
  // The guard keys on the current Lisbon day, the same day the sync legs use.
  const today = presetSelection("today").to;
  const TODAY = { from: today, to: today };
  const yesterday = new Date(`${today}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const YESTERDAY = {
    from: yesterday.toISOString().slice(0, 10),
    to: yesterday.toISOString().slice(0, 10),
  };
  // Account 385-546-6298 on 2026-09-15: the 10:04:30 read totalled 118.99.
  const storedGoogle = [
    { campaignId: "1", spend: 100 },
    { campaignId: "2", spend: 18.99 },
  ];
  const storedStore = [{ granularity: "day", rows: [{ campaignId: "1", spend: 100 }, { campaignId: "2", spend: 18.99 }] }];
  const readyRow = (payload: unknown) => ({
    state: "ready",
    last_success_at: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
    payload,
  });

  async function refresh(
    client: ReturnType<typeof refreshClient>,
    family: "google_campaigns" | "store_campaign_performance" | "shopify_funnel",
    range: { from: string; to: string },
    load: () => Promise<{ state: "ready" | "partial" | "empty" | "unavailable"; rows: unknown[]; message?: string | null }>,
  ) {
    const authority = await adminReportingAuthority({ surface: "v2_active" });
    return refreshAdminReportingSnapshot({
      client: client as never,
      family,
      accountId: ACCOUNT,
      ...range,
      authority,
      verifyAuthority: async () => authority,
      load,
    });
  }

  it("keeps today's ready sheet when the reload totals zero, completing it again with no failure", async () => {
    // The 10:05:30 replica: no campaigns for today at all. The sheet used to
    // be rewritten with a total of 0.00 over 118.99. Nothing failed, so the
    // row records no failure: a recorded one marked a healthy account partial
    // on the campaigns page, dropped it from the analytics running set and
    // answered the hourly leg with 502 until a fresher replica turned up.
    const client = refreshClient(readyRow(storedGoogle));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await refresh(client, "google_campaigns", TODAY, async () => ({
      state: "empty",
      rows: [],
      message: null,
    }));

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "ready", kept: true });
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_admin_reporting_snapshot_refresh",
      "complete_admin_reporting_snapshot_refresh",
    ]);
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({
        p_state: "ready",
        p_payload: storedGoogle,
        p_message: null,
        p_lease_token: "62000000-0000-4000-8000-000000000010",
      }),
    );
    // The sheet is read for this case only.
    expect(client.query.select).toHaveBeenCalledWith(
      "state, last_success_at, payload, message, last_error_code",
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/118\.99 spend and the reload 0\.00/));
    warn.mockRestore();
  });

  it("keeps today's ready sheet when the reload totals less", async () => {
    const client = refreshClient(readyRow(storedGoogle));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await refresh(client, "google_campaigns", TODAY, async () => ({
      state: "ready",
      rows: [{ campaignId: "1", spend: 51.9 }],
    }));

    expect(result).toMatchObject({ state: "refreshed", kept: true });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({ p_payload: storedGoogle }),
    );
    expect(client.rpc).not.toHaveBeenCalledWith(
      "fail_admin_reporting_snapshot_refresh",
      expect.anything(),
    );
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("carries the sheet's own message, and drops a recorded failure's text, when it keeps the sheet", async () => {
    // A ready sheet can carry a note of its own, and that note belongs to
    // the sheet. A failure's text (0073) belongs to the failure this
    // completion supersedes: the row must not go on reading it with no
    // failure code behind it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noted = refreshClient({
      ...readyRow(storedGoogle),
      message: "The exact spend window was materialised on demand.",
      last_error_code: null,
    });
    await refresh(noted, "google_campaigns", TODAY, async () => ({
      state: "empty",
      rows: [],
      message: null,
    }));
    expect(noted.rpc).toHaveBeenLastCalledWith(
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({
        p_message: "The exact spend window was materialised on demand.",
      }),
    );

    const failed = refreshClient({
      ...readyRow(storedGoogle),
      message: "Last failure: Shopify attribution timed out.",
      last_error_code: "provider_partial",
    });
    await refresh(failed, "google_campaigns", TODAY, async () => ({
      state: "empty",
      rows: [],
      message: null,
    }));
    expect(failed.rpc).toHaveBeenLastCalledWith(
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({ p_message: null }),
    );
    warn.mockRestore();
  });

  it("records snapshot_failed when the kept sheet's completion is fenced", async () => {
    // The lease expired or the row moved under this refresh: the kept sheet
    // could not be stamped, and that is a failure, recorded as any fenced
    // completion is.
    const client = refreshClient(readyRow(storedGoogle));
    client.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_admin_reporting_snapshot_refresh") {
        return { data: "62000000-0000-4000-8000-000000000010", error: null };
      }
      return { data: name !== "complete_admin_reporting_snapshot_refresh", error: null };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await refresh(client, "google_campaigns", TODAY, async () => ({
      state: "empty",
      rows: [],
      message: null,
    }));

    expect(result).toEqual({ state: "failed", errorCode: "snapshot_failed" });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "fail_admin_reporting_snapshot_refresh",
      expect.objectContaining({ p_error_code: "snapshot_failed" }),
    );
    warn.mockRestore();
    error.mockRestore();
  });

  it("completes today's sheet when the reload totals more", async () => {
    const client = refreshClient(readyRow(storedGoogle));

    const result = await refresh(client, "google_campaigns", TODAY, async () => ({
      state: "ready",
      rows: [{ campaignId: "1", spend: 130 }],
    }));

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "ready" });
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_admin_reporting_snapshot_refresh",
      "complete_admin_reporting_snapshot_refresh",
    ]);
  });

  it("completes today's sheet when the reload totals the same, in another order", async () => {
    // 18.99 + 100 and 100 + 18.99 differ in the last bit; that is not a
    // regression, and the fresher read carries the later clicks.
    const client = refreshClient(readyRow(storedGoogle));

    const result = await refresh(client, "google_campaigns", TODAY, async () => ({
      state: "ready",
      rows: [{ campaignId: "2", spend: 18.99 }, { campaignId: "1", spend: 100 }],
    }));

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "ready" });
    expect(result).not.toHaveProperty("kept");
  });

  it("keeps today's sheet when the reload totals the same spend with a count behind", async () => {
    // The daily budget is spent, so the total no longer moves, while Google
    // keeps attributing conversions hours after their clicks: a replica
    // behind the one that wrote 5 conversions answers the same 118.99 with 3.
    const counted = [
      { campaignId: "1", spend: 100, clicks: 50, conversions: 5 },
      { campaignId: "2", spend: 18.99, clicks: 10, conversions: 0 },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const behind = refreshClient(readyRow(counted));
    const kept = await refresh(behind, "google_campaigns", TODAY, async () => ({
      state: "ready",
      rows: [
        { campaignId: "1", spend: 100, clicks: 50, conversions: 3 },
        { campaignId: "2", spend: 18.99, clicks: 10, conversions: 0 },
      ],
    }));
    expect(kept).toMatchObject({ state: "refreshed", kept: true });
    expect(behind.rpc).toHaveBeenLastCalledWith(
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({ p_payload: counted }),
    );

    const fewerClicks = refreshClient(readyRow(counted));
    expect(
      await refresh(fewerClicks, "google_campaigns", TODAY, async () => ({
        state: "ready",
        rows: [
          { campaignId: "1", spend: 100, clicks: 49, conversions: 5 },
          { campaignId: "2", spend: 18.99, clicks: 10, conversions: 0 },
        ],
      })),
    ).toMatchObject({ state: "refreshed", kept: true });

    const ahead = refreshClient(readyRow(counted));
    const grown = [
      { campaignId: "1", spend: 100, clicks: 50, conversions: 6 },
      { campaignId: "2", spend: 18.99, clicks: 10, conversions: 0 },
    ];
    const completed = await refresh(ahead, "google_campaigns", TODAY, async () => ({
      state: "ready",
      rows: grown,
    }));
    expect(completed).toEqual({
      state: "refreshed",
      snapshotState: "ready",
      refreshedAt: expect.any(String),
    });
    expect(ahead.rpc).toHaveBeenLastCalledWith(
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({ p_payload: grown }),
    );
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("reads the store sheet's rows for store_campaign_performance", async () => {
    const client = refreshClient(readyRow(storedStore));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const kept = await refresh(client, "store_campaign_performance", TODAY, async () => ({
      state: "ready",
      rows: [{ granularity: "day", rows: [{ campaignId: "1", spend: 51.9 }] }],
    }));
    expect(kept).toMatchObject({ state: "refreshed", kept: true });
    expect(client.rpc).toHaveBeenLastCalledWith(
      "complete_admin_reporting_snapshot_refresh",
      expect.objectContaining({ p_payload: storedStore }),
    );

    const grown = refreshClient(readyRow(storedStore));
    const completed = await refresh(grown, "store_campaign_performance", TODAY, async () => ({
      state: "ready",
      rows: [{ granularity: "day", rows: [{ campaignId: "1", spend: 206.25 }] }],
    }));
    expect(completed).toMatchObject({ state: "refreshed", snapshotState: "ready" });
    expect(completed).not.toHaveProperty("kept");

    // A store sheet reports counts it does not have as null; null counts as
    // zero on both sides, so an equal-spend reload without them still lands.
    const uncounted = refreshClient(
      readyRow([{ granularity: "day", rows: [{ campaignId: "1", spend: 100, clicks: null, conversions: null }] }]),
    );
    expect(
      await refresh(uncounted, "store_campaign_performance", TODAY, async () => ({
        state: "ready",
        rows: [{ granularity: "day", rows: [{ campaignId: "1", spend: 100, clicks: null, conversions: null }] }],
      })),
    ).not.toHaveProperty("kept");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("never enters the guard for a closed-day range", async () => {
    // A closed day is Windsor final: a smaller total is the corrected figure,
    // and the row is not even read.
    const client = refreshClient(readyRow(storedGoogle));

    const result = await refresh(client, "google_campaigns", YESTERDAY, async () => ({
      state: "ready",
      rows: [{ campaignId: "1", spend: 0.5 }],
    }));

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "ready" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("never enters the guard for a multi-day range ending today", async () => {
    const client = refreshClient(readyRow(storedGoogle));

    const result = await refresh(
      client,
      "google_campaigns",
      { from: YESTERDAY.from, to: today },
      async () => ({ state: "ready", rows: [{ campaignId: "1", spend: 0.5 }] }),
    );

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "ready" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("never enters the guard for a family without a spend total", async () => {
    const client = refreshClient(readyRow([{ day: today, sessions: 500 }]));

    const result = await refresh(client, "shopify_funnel", TODAY, async () => ({
      state: "empty",
      rows: [],
      message: null,
    }));

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "empty" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("lets an unavailable reload through: a lost connection is not a smaller day", async () => {
    const client = refreshClient(readyRow(storedGoogle));

    const result = await refresh(client, "google_campaigns", TODAY, async () => ({
      state: "unavailable",
      rows: [],
      message: "Campaign reporting is unavailable until this Google Ads connection is restored.",
    }));

    expect(result).toMatchObject({ state: "refreshed", snapshotState: "unavailable" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("completes over a stored sheet that is not ready, or not readable", async () => {
    const partial = refreshClient({ ...readyRow(storedGoogle), state: "partial" });
    expect(
      await refresh(partial, "google_campaigns", TODAY, async () => ({
        state: "ready",
        rows: [{ campaignId: "1", spend: 1 }],
      })),
    ).toMatchObject({ state: "refreshed", snapshotState: "ready" });

    const malformed = refreshClient(readyRow([{ campaignId: "1", spend: "118.99" }]));
    expect(
      await refresh(malformed, "google_campaigns", TODAY, async () => ({
        state: "ready",
        rows: [{ campaignId: "1", spend: 1 }],
      })),
    ).toMatchObject({ state: "refreshed", snapshotState: "ready" });

    const unsynced = refreshClient(null);
    expect(
      await refresh(unsynced, "google_campaigns", TODAY, async () => ({
        state: "empty",
        rows: [],
        message: null,
      })),
    ).toMatchObject({ state: "refreshed", snapshotState: "empty" });
  });

  it("still prefers the keep-last-good rule for a degraded partial reload of today", async () => {
    const client = refreshClient(readyRow(storedGoogle));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await refresh(client, "google_campaigns", TODAY, async () => DEGRADED_PARTIAL);

    expect(result).toEqual({ state: "failed", errorCode: "provider_partial" });
    expect(client.from).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
