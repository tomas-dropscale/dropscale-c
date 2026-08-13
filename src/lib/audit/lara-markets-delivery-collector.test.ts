import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  manifestHash: vi.fn(),
  schemaHash: vi.fn(),
  summary: vi.fn(),
  createRuntime: vi.fn(),
  enqueue: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  get: vi.fn(),
  renew: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./lara-markets-delivery-map", () => {
  class LaraMarketsDeliveryMapError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    collectLaraMarketsDeliveryMap: mocks.collect,
    LARA_MARKETS_DELIVERY_QUERY_MANIFEST: {
      fixed: "query LaraFixedMarketsDeliveryRead { shop { id } }",
    },
    laraMarketsDeliveryManifestSha256: mocks.manifestHash,
    laraMarketsDeliverySchemaSha256: mocks.schemaHash,
    LaraMarketsDeliveryMapError,
    summariseLaraMarketsDeliveryArtifact: mocks.summary,
  };
});
vi.mock("./shopify-runtime", () => {
  class AuditShopifyRuntimeError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly retryable = false,
    ) {
      super(message);
    }
  }
  return {
    AuditShopifyRuntimeError,
    createAuditShopifyRuntime: mocks.createRuntime,
  };
});
vi.mock("./shopify-runs", () => {
  class AuditShopifyRunError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    AuditShopifyRunError,
    enqueueAuditShopifyRun: mocks.enqueue,
    claimAuditShopifyRun: mocks.claim,
    completeAuditShopifyRun: mocks.complete,
    failAuditShopifyRun: mocks.fail,
    getAuditShopifyRun: mocks.get,
    renewAuditShopifyRun: mocks.renew,
  };
});

import { AuditShopifyRuntimeError } from "./shopify-runtime";
import { AuditShopifyRunError } from "./shopify-runs";
import {
  LARA_MARKETS_DELIVERY_RUN_ID,
  runLaraMarketsDeliveryCollector,
} from "./lara-markets-delivery-collector";

const SPONSOR = "10000000-0000-4000-8000-000000000001";
const LEASE = "10000000-0000-4000-8000-000000000002";
const MANIFEST_HASH = "a".repeat(64);
const SCHEMA_HASH = "b".repeat(64);
const SUMMARY = {
  auditStatus: "complete" as const,
  completionIssues: [],
  sourceOfTruth: "legacy_delivery_profiles" as const,
  sourceOfTruthScope: "merchant_owned_shipping_configuration" as const,
  sourceOfTruthComplete: true,
  assessmentBoundary: "admin_configuration_not_checkout_quote" as const,
  inheritedMarketShippingPresent: true,
  marketDrivenShipping: false,
  moduleStatuses: {
    shopCurrencies: "complete" as const,
    markets: "complete" as const,
    webPresences: "complete" as const,
    locales: "complete" as const,
    marketShipping: "complete" as const,
    legacyDelivery: "complete" as const,
  },
  shopCurrencyCode: "EUR",
  enabledPresentmentCurrencies: ["EUR"],
  marketCount: 2,
  activeMarketCount: 2,
  webPresenceCount: 1,
  publishedLocales: ["hr", "pt-PT"],
  marketShippingOptionCount: 0,
  legacyProfileCount: 1,
  legacyZoneCount: 1,
  legacyMethodCount: 1,
  portugal: { countryCode: "PT" },
  croatia: { countryCode: "HR" },
  croatianPostReferences: [],
  dpdReferences: [],
  brandVendorPolicy: "accepted_non_issue_out_of_scope" as const,
};
const ARTIFACT = {
  schemaVersion: "lara-markets-delivery-map.v2",
  queryManifestSha256: MANIFEST_HASH,
};

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LARA_MARKETS_DELIVERY_RUN_ID,
    connection_id: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    requested_by: SPONSOR,
    requested_actor_type: "system",
    shopify_domain: "jwmtjg-fm.myshopify.com",
    state: "running",
    requested_source: "system.lara_markets_delivery_map",
    requested_note:
      "Lara Rovinj fixed read-only Markets, web presence, locale, currency and delivery map",
    schema_hash: SCHEMA_HASH,
    manifest_hash: MANIFEST_HASH,
    checkpoint: {},
    artifact: null,
    attempt_count: 1,
    retry_count: 0,
    max_retries: 2,
    next_attempt_at: null,
    lease_token: LEASE,
    lease_generation: 1,
    lease_acquired_at: "2026-08-12T21:00:00Z",
    lease_renewed_at: "2026-08-12T21:00:00Z",
    lease_expires_at: "2026-08-12T21:05:00Z",
    error_code: null,
    created_at: "2026-08-12T21:00:00Z",
    updated_at: "2026-08-12T21:00:00Z",
    started_at: "2026-08-12T21:00:00Z",
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.manifestHash.mockResolvedValue(MANIFEST_HASH);
  mocks.schemaHash.mockResolvedValue(SCHEMA_HASH);
  mocks.enqueue.mockResolvedValue(LARA_MARKETS_DELIVERY_RUN_ID);
  mocks.claim.mockResolvedValue(runRow());
  mocks.renew.mockResolvedValue(runRow());
  mocks.createRuntime.mockResolvedValue({
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: "jwmtjg-fm.myshopify.com",
    shopId: "gid://shopify/Shop/95462097276",
    grantedScopes: ["read_markets", "read_locales", "read_shipping"],
    query: vi.fn().mockResolvedValue({ shop: { id: "fixed" } }),
  });
  mocks.collect.mockImplementation(async ({ runtime }) => {
    await runtime.query("query LaraFixedMarketsDeliveryRead { shop { id } }");
    return ARTIFACT;
  });
  mocks.complete.mockResolvedValue(
    runRow({
      state: "completed",
      artifact: ARTIFACT,
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
      completed_at: "2026-08-12T21:01:00Z",
    }),
  );
  mocks.summary.mockReturnValue(SUMMARY);
  mocks.fail.mockResolvedValue(
    runRow({
      state: "failed",
      error_code: "markets_delivery_map_failed",
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
      failed_at: "2026-08-12T21:01:00Z",
    }),
  );
  mocks.get.mockResolvedValue(runRow());
});

describe("the durable Lara Markets and delivery collector", () => {
  it("pins the fixed system run and executes only the approved read manifest", async () => {
    await expect(
      runLaraMarketsDeliveryCollector({ requestedBy: SPONSOR, leaseToken: LEASE }),
    ).resolves.toEqual({
      runId: LARA_MARKETS_DELIVERY_RUN_ID,
      state: "completed",
      summary: SUMMARY,
    });

    expect(mocks.enqueue).toHaveBeenCalledWith({
      runId: LARA_MARKETS_DELIVERY_RUN_ID,
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      requestedBy: SPONSOR,
      shopDomain: "jwmtjg-fm.myshopify.com",
      source: "system.lara_markets_delivery_map",
      note:
        "Lara Rovinj fixed read-only Markets, web presence, locale, currency and delivery map",
      schemaHash: SCHEMA_HASH,
      manifestHash: MANIFEST_HASH,
      maxRetries: 2,
      actorType: "system",
    });
    expect(mocks.createRuntime).toHaveBeenCalledWith({
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      expectedShopDomain: "jwmtjg-fm.myshopify.com",
      expectedShopId: "gid://shopify/Shop/95462097276",
      allowedQueryDocuments: [
        "query LaraFixedMarketsDeliveryRead { shop { id } }",
      ],
    });
    expect(mocks.renew).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: LARA_MARKETS_DELIVERY_RUN_ID }),
      leaseToken: LEASE,
      checkpoint: { requestCount: 0 },
      leaseSeconds: 300,
    });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ artifact: ARTIFACT }),
    );
  });

  it("replays only a completed row with matching immutable evidence", async () => {
    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "already completed"),
    );
    mocks.get.mockResolvedValueOnce(
      runRow({
        state: "completed",
        artifact: ARTIFACT,
        completed_at: "2026-08-12T21:01:00Z",
      }),
    );

    await expect(
      runLaraMarketsDeliveryCollector({ requestedBy: SPONSOR, leaseToken: LEASE }),
    ).resolves.toMatchObject({ state: "completed", summary: SUMMARY });
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("rejects a stale terminal row whose requester evidence differs", async () => {
    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "already completed"),
    );
    mocks.get.mockResolvedValueOnce(
      runRow({
        requested_by: "20000000-0000-4000-8000-000000000001",
        state: "completed",
        artifact: ARTIFACT,
      }),
    );

    await expect(
      runLaraMarketsDeliveryCollector({ requestedBy: SPONSOR, leaseToken: LEASE }),
    ).resolves.toEqual({
      runId: LARA_MARKETS_DELIVERY_RUN_ID,
      state: "failed",
      errorCode: "run_evidence_mismatch",
    });
  });

  it("returns in-progress when a retryable Shopify failure is durably queued", async () => {
    mocks.createRuntime.mockRejectedValueOnce(
      new AuditShopifyRuntimeError("query_rate_limited", "must-not-leak", true),
    );
    mocks.fail.mockResolvedValueOnce(runRow({ state: "queued" }));

    const result = await runLaraMarketsDeliveryCollector({
      requestedBy: SPONSOR,
      leaseToken: LEASE,
    });
    expect(result).toEqual({
      runId: LARA_MARKETS_DELIVERY_RUN_ID,
      state: "in_progress",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "query_rate_limited", retryable: true }),
    );
  });
});
