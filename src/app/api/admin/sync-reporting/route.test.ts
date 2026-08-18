import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { RangeSelection } from "@/lib/portal/range";

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
    callOrder: [] as string[],
    getSessionProfile: vi.fn(),
    createServiceClient: vi.fn(),
    readSmallJson: vi.fn(),
    refreshAdminCampaignSnapshots: vi.fn(),
    listAdminReportingStoreScopes: vi.fn(),
    ensureAdminAnalyticsRollupCoverage: vi.fn(),
    refreshAdminStoreAnalyticsSnapshots: vi.fn(),
    provisionReviewedClientReportingSources: vi.fn(),
    ensureGoogleConnectionMetadata: vi.fn(),
    advanceEligibleClientReportingCutovers: vi.fn(),
    ensureAutomaticBillingStarts: vi.fn(),
    refreshReportingSourcesNow: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/http", () => ({
  isExactRecord: (value: unknown, required: readonly string[]) =>
    Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === required.length &&
        required.every((key) => key in (value as Record<string, unknown>)),
    ),
  readSmallJson: mocks.readSmallJson,
}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/admin/campaigns", () => ({
  listAdminReportingStoreScopes: mocks.listAdminReportingStoreScopes,
  refreshAdminCampaignSnapshots: mocks.refreshAdminCampaignSnapshots,
}));
vi.mock("@/lib/admin/store-analytics", () => ({
  ensureAdminAnalyticsRollupCoverage: mocks.ensureAdminAnalyticsRollupCoverage,
  refreshAdminStoreAnalyticsSnapshots: mocks.refreshAdminStoreAnalyticsSnapshots,
}));
vi.mock("@/lib/client-onboarding/reporting-cutover", () => ({
  provisionReviewedClientReportingSources:
    mocks.provisionReviewedClientReportingSources,
  advanceEligibleClientReportingCutovers:
    mocks.advanceEligibleClientReportingCutovers,
}));
vi.mock("@/lib/metrics/recompute", () => ({
  refreshReportingSourcesNow: mocks.refreshReportingSourcesNow,
}));
vi.mock("@/lib/billing/auto-start", () => ({
  ensureAutomaticBillingStarts: mocks.ensureAutomaticBillingStarts,
}));
vi.mock("@/lib/client-onboarding/google-metadata", () => ({
  ensureGoogleConnectionMetadata: mocks.ensureGoogleConnectionMetadata,
}));
vi.mock("@/lib/portal/range", async () =>
  import("../../../../lib/portal/range"),
);

import { POST } from "./route";

const URL = "http://localhost/api/admin/sync-reporting";
const CRON_SECRET = "test-cron-secret";
const REPORTING_SYNC_SECRET = "test-reporting-sync-secret";
const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const STORE_ID = "20000000-0000-4000-8000-000000000001";
const RANGE = {
  key: "custom" as const,
  from: "2026-08-03",
  to: "2026-08-12",
};
const serviceClient = { service: true };

function adminRequest(body: unknown, origin = "http://localhost") {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

function cronRequest(range: string, secret = CRON_SECRET, origin?: string) {
  return new NextRequest(`${URL}?range=${range}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      ...(origin ? { origin } : {}),
    },
  });
}

function campaignRequest(range: RangeSelection = RANGE) {
  return { scope: "campaigns", range };
}

function allRequest(range = RANGE) {
  return { scope: "all", range };
}

function storeRequest(overrides: Record<string, unknown> = {}) {
  return {
    scope: "store",
    clientId: CLIENT_ID,
    store: {
      accountId: STORE_ID,
      activityAccountIds: [STORE_ID],
      currency: "EUR",
    },
    range: RANGE,
    ...overrides,
  };
}

function reportingScope(index: number) {
  const accountId = `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  return {
    clientId: CLIENT_ID,
    store: {
      accountId,
      activityAccountIds: [accountId],
      currency: "EUR",
    },
  };
}

async function flushMicrotasks() {
  // Generous: the store path now awaits the automatic chain (provisioning,
  // billing starts, cutover advance) before its parallel refresh begins.
  for (let step = 0; step < 40; step += 1) await Promise.resolve();
}

const metricReady = {
  state: "ready",
  data: { storeCount: 1, dayCount: 10, refreshed: true },
};
const snapshotReady = { attempted: 3, refreshed: 3, partial: 0, busy: 0, failed: 0 };
const campaignReady = {
  attempted: 1,
  refreshed: 1,
  partial: 0,
  busy: 0,
  failed: 0,
  metricCoverage: { state: "ready", materializedAccountDays: 10, expectedAccountDays: 10 },
};

describe("admin exact-range reporting sync route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callOrder.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    vi.stubEnv("REPORTING_SYNC_SECRET", REPORTING_SYNC_SECRET);
    mocks.getSessionProfile.mockImplementation(async () => {
      mocks.callOrder.push("auth");
      return { profile: { id: "admin-1", role: "admin" } };
    });
    mocks.readSmallJson.mockImplementation(async (request: Request) => {
      mocks.callOrder.push("body");
      return request.json();
    });
    mocks.createServiceClient.mockImplementation(() => {
      mocks.callOrder.push("service");
      return serviceClient;
    });
    mocks.refreshAdminCampaignSnapshots.mockResolvedValue(campaignReady);
    mocks.listAdminReportingStoreScopes.mockResolvedValue([
      {
        clientId: CLIENT_ID,
        store: {
          accountId: STORE_ID,
          activityAccountIds: [STORE_ID],
          currency: "EUR",
        },
      },
    ]);
    mocks.ensureAdminAnalyticsRollupCoverage.mockResolvedValue(metricReady);
    mocks.refreshAdminStoreAnalyticsSnapshots.mockResolvedValue(snapshotReady);
    mocks.provisionReviewedClientReportingSources.mockResolvedValue({
      attempted: 0,
      provisioned: 0,
      failed: 0,
    });
    mocks.ensureGoogleConnectionMetadata.mockResolvedValue({
      attempted: 0,
      enriched: 0,
      failed: 0,
    });
    mocks.ensureAutomaticBillingStarts.mockResolvedValue({
      attempted: 0,
      started: 0,
      activated: 0,
      failed: 0,
    });
    mocks.advanceEligibleClientReportingCutovers.mockResolvedValue({
      syncsAttempted: 0,
      syncsCompleted: 0,
      activationsAttempted: 0,
      activated: 0,
      failed: 0,
    });
    mocks.refreshReportingSourcesNow.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("authenticates an admin before reading the body or creating a service client", async () => {
    mocks.getSessionProfile.mockImplementationOnce(async () => {
      mocks.callOrder.push("auth");
      return { profile: null };
    });

    const response = await POST(adminRequest(campaignRequest()));

    expect(response.status).toBe(403);
    expect(mocks.callOrder).toEqual(["auth"]);
    expect(mocks.readSmallJson).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.refreshAdminCampaignSnapshots).not.toHaveBeenCalled();
    expect(mocks.provisionReviewedClientReportingSources).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin admin after auth and before body or service access", async () => {
    const response = await POST(
      adminRequest(campaignRequest(), "https://attacker.invalid"),
    );

    expect(response.status).toBe(403);
    expect(mocks.callOrder).toEqual(["auth"]);
    expect(mocks.readSmallJson).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("syncs the exact manual campaign range and materialises metrics first", async () => {
    const response = await POST(adminRequest(campaignRequest()));

    expect(response.status).toBe(200);
    expect(mocks.callOrder).toEqual(["auth", "body", "service"]);
    // Reviewed clients are provisioned into reporting sources before the
    // campaign refresh so a fresh cutover is included in the same sync.
    expect(mocks.provisionReviewedClientReportingSources).toHaveBeenCalledWith(
      serviceClient,
    );
    expect(
      mocks.provisionReviewedClientReportingSources.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.refreshAdminCampaignSnapshots.mock.invocationCallOrder[0],
    );
    expect(mocks.refreshAdminCampaignSnapshots).toHaveBeenCalledWith(RANGE, {
      authenticate: false,
      client: serviceClient,
      refreshMetrics: true,
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      scope: "campaigns",
      result: campaignReady,
    });
  });

  it("accepts the exact d3 and d14 manual and machine presets", async () => {
    for (const range of [
      { key: "d3" as const, from: "2026-08-13", to: "2026-08-15" },
      { key: "d14" as const, from: "2026-08-02", to: "2026-08-15" },
    ]) {
      const response = await POST(adminRequest(campaignRequest(range)));

      expect(response.status).toBe(200);
      expect(mocks.refreshAdminCampaignSnapshots).toHaveBeenLastCalledWith(range, {
        authenticate: false,
        client: serviceClient,
        refreshMetrics: true,
      });

      const machineResponse = await POST(cronRequest(range.key));
      expect(machineResponse.status).toBe(200);
      expect(mocks.refreshAdminCampaignSnapshots).toHaveBeenLastCalledWith(range, {
        authenticate: false,
        client: serviceClient,
      });
    }
  });

  it("syncs every store and the portfolio together for the manual all request", async () => {
    const response = await POST(adminRequest(allRequest()));

    expect(response.status).toBe(200);
    expect(mocks.refreshAdminCampaignSnapshots).toHaveBeenCalledWith(RANGE, {
      authenticate: false,
      client: serviceClient,
      refreshMetrics: true,
    });
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      scope: "all",
    });
  });

  it("materialises the store grid and provider snapshots in parallel", async () => {
    let releaseMetrics!: (value: typeof metricReady) => void;
    mocks.ensureAdminAnalyticsRollupCoverage.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseMetrics = resolve;
      }),
    );
    const responsePromise = POST(adminRequest(storeRequest()));
    await flushMicrotasks();

    expect(mocks.ensureAdminAnalyticsRollupCoverage).toHaveBeenCalledWith(
      {
        clientId: CLIENT_ID,
        stores: [{
          accountId: STORE_ID,
          activityAccountIds: [STORE_ID],
          currency: "EUR",
        }],
        range: RANGE,
      },
      { authenticate: false },
    );
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledWith(
      {
        clientId: CLIENT_ID,
        store: {
          accountId: STORE_ID,
          activityAccountIds: [STORE_ID],
          currency: "EUR",
          days: [],
        },
        range: RANGE,
      },
      { authenticate: false },
    );
    // Provider snapshots started while metric coverage was deliberately still
    // pending; a sequential implementation would not have called it yet. The
    // second call settles the 30-day ROAS tracking range in the same sync.
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledTimes(2);
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        range: { key: "custom", from: "2026-07-14", to: "2026-08-12" },
      }),
      { authenticate: false },
    );
    releaseMetrics(metricReady);
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });

  it("rejects invalid store ids without creating a service client or running sync", async () => {
    const response = await POST(adminRequest(storeRequest({
      clientId: "not-a-client-id",
    })));

    expect(response.status).toBe(422);
    expect(mocks.callOrder).toEqual(["auth", "body"]);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.ensureAdminAnalyticsRollupCoverage).not.toHaveBeenCalled();
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).not.toHaveBeenCalled();
  });

  it("returns an honest partial 502 after successful store families were persisted", async () => {
    mocks.ensureAdminAnalyticsRollupCoverage.mockResolvedValueOnce({
      state: "partial",
      data: {
        storeCount: 1,
        dayCount: 5,
        refreshed: true,
        materializedAccountDays: 5,
        expectedAccountDays: 7,
      },
      message: "5 of 7 account-days are materialised.",
    });
    mocks.refreshAdminStoreAnalyticsSnapshots.mockResolvedValueOnce({
      attempted: 3,
      refreshed: 2,
      partial: 0,
      busy: 0,
      failed: 1,
    });

    const response = await POST(adminRequest(storeRequest()));

    expect(response.status).toBe(502);
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Store reporting could not be fully refreshed.",
      result: { refreshed: 2, failed: 1 },
      metricCoverage: { state: "partial" },
    });
  });

  it("returns 502 after a partial campaign refresh without hiding its successful count", async () => {
    mocks.refreshAdminCampaignSnapshots.mockResolvedValueOnce({
      ...campaignReady,
      attempted: 3,
      refreshed: 3,
      partial: 1,
      failed: 0,
    });

    const response = await POST(adminRequest(campaignRequest()));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Campaign reporting could not be fully refreshed.",
      result: { refreshed: 3, partial: 1, failed: 0 },
    });
  });

  it.each([
    ["today", { key: "today", from: "2026-08-15", to: "2026-08-15" }],
    ["d7", { key: "d7", from: "2026-08-09", to: "2026-08-15" }],
  ] as const)("allows CRON_SECRET to refresh only the %s preset", async (key, range) => {
    const response = await POST(cronRequest(key));

    expect(response.status).toBe(200);
    expect(mocks.getSessionProfile).not.toHaveBeenCalled();
    expect(mocks.readSmallJson).not.toHaveBeenCalled();
    // f5da538: today refreshes metrics too — its campaign-hour feed is
    // fresher than Windsor's current-day aggregate. d7 stays the rolling
    // history refresh.
    expect(key === "today" || key === "d7").toBe(true);
    expect(mocks.refreshAdminCampaignSnapshots).toHaveBeenCalledWith(range, {
      authenticate: false,
      client: serviceClient,
      refreshMetrics: true,
    });
    expect(mocks.listAdminReportingStoreScopes).toHaveBeenCalledWith(serviceClient);
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledWith(
      {
        clientId: CLIENT_ID,
        store: {
          accountId: STORE_ID,
          activityAccountIds: [STORE_ID],
          currency: "EUR",
          days: [],
        },
        range,
      },
      { authenticate: false },
    );
  });

  it("refreshes exact 30-day metrics and provider snapshots for the bootstrap secret", async () => {
    const range = { key: "d30", from: "2026-07-17", to: "2026-08-15" };
    const response = await POST(cronRequest("d30", REPORTING_SYNC_SECRET));

    expect(response.status).toBe(200);
    expect(mocks.getSessionProfile).not.toHaveBeenCalled();
    expect(mocks.refreshAdminCampaignSnapshots).toHaveBeenCalledWith(range, {
      authenticate: false,
      client: serviceClient,
      refreshMetrics: true,
    });
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalled();
  });

  it("backfills 60 daily metric days without duplicating store detail snapshots", async () => {
    const range = { key: "custom", from: "2026-06-17", to: "2026-08-15" };
    const response = await POST(cronRequest("d60", REPORTING_SYNC_SECRET));

    expect(response.status).toBe(200);
    expect(mocks.refreshAdminCampaignSnapshots).toHaveBeenCalledWith(range, {
      authenticate: false,
      client: serviceClient,
      refreshMetrics: true,
    });
    expect(mocks.listAdminReportingStoreScopes).not.toHaveBeenCalled();
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).not.toHaveBeenCalled();
  });

  it("refreshes independent stores concurrently", async () => {
    const scopes = Array.from({ length: 17 }, (_, index) => reportingScope(index));
    mocks.listAdminReportingStoreScopes.mockResolvedValueOnce(scopes);
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    mocks.refreshAdminStoreAnalyticsSnapshots.mockImplementation(
      (input: { store: { accountId: string } }) =>
        new Promise((resolve) => {
          active += 1;
          maximum = Math.max(maximum, active);
          releases.push(() => {
            active -= 1;
            resolve({
              ...snapshotReady,
              accountId: input.store.accountId,
              from: "2026-08-15",
              to: "2026-08-15",
            });
          });
        }),
    );

    const responsePromise = POST(cronRequest("today"));
    await flushMicrotasks();
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledTimes(15);
    expect(maximum).toBe(15);

    for (let completed = 0; completed < 15; completed += 1) {
      releases[completed]();
      await flushMicrotasks();
      expect(maximum).toBeLessThanOrEqual(15);
    }
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledTimes(17);
    releases[15]();
    releases[16]();
    await flushMicrotasks();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      budget: {
        exhausted: false,
        launchedStores: 17,
        skippedStores: 0,
      },
    });
  });

  it("stops launching hourly store batches at the 120-second route budget", async () => {
    const scopes = Array.from({ length: 17 }, (_, index) => reportingScope(index));
    mocks.listAdminReportingStoreScopes.mockResolvedValueOnce(scopes);
    const releases: Array<() => void> = [];
    mocks.refreshAdminStoreAnalyticsSnapshots.mockImplementation(
      (input: { store: { accountId: string } }) =>
        new Promise((resolve) => {
          releases.push(() => resolve({
            ...snapshotReady,
            accountId: input.store.accountId,
            from: "2026-08-15",
            to: "2026-08-15",
          }));
        }),
    );

    const responsePromise = POST(cronRequest("today"));
    await flushMicrotasks();
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledTimes(15);

    vi.setSystemTime(new Date(Date.now() + 120_001));
    releases.forEach((release) => release());
    await flushMicrotasks();

    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(mocks.refreshAdminStoreAnalyticsSnapshots).toHaveBeenCalledTimes(15);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("route budget"),
      stores: expect.arrayContaining([
        expect.objectContaining({ refreshed: 3, failed: 0 }),
      ]),
      budget: {
        limitMs: 120_000,
        exhausted: true,
        launchedStores: 15,
        skippedStores: 2,
      },
    });
  });

  it("rejects unsupported machine ranges before creating a service client", async () => {
    const response = await POST(cronRequest("d90"));

    expect(response.status).toBe(422);
    expect(mocks.getSessionProfile).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("does not grant machine authority to a wrong CRON_SECRET", async () => {
    mocks.getSessionProfile.mockResolvedValueOnce({ profile: null });

    const response = await POST(cronRequest("today", "wrong-secret"));

    expect(response.status).toBe(403);
    expect(mocks.getSessionProfile).toHaveBeenCalledOnce();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });
});
