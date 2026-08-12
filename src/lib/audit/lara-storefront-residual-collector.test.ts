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
vi.mock("./lara-storefront-residual-map", () => {
  class LaraStorefrontResidualMapError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    collectLaraStorefrontResidualMap: mocks.collect,
    LARA_STOREFRONT_RESIDUAL_QUERY_MANIFEST: {
      fixed: "query LaraFixedRead { shop { id } }",
    },
    LARA_STOREFRONT_RESIDUAL_SCHEMA_VERSION: "lara-storefront-residual-map.v3",
    laraStorefrontResidualManifestSha256: mocks.manifestHash,
    laraStorefrontResidualSchemaSha256: mocks.schemaHash,
    LaraStorefrontResidualMapError,
    summariseLaraStorefrontResidualArtifact: mocks.summary,
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
  LARA_STOREFRONT_RESIDUAL_RUN_ID,
  readLaraShortLivedThemeBody,
  runLaraStorefrontResidualCollector,
} from "./lara-storefront-residual-collector";

const SPONSOR = "10000000-0000-4000-8000-000000000001";
const LEASE = "10000000-0000-4000-8000-000000000002";
const MANIFEST_HASH = "a".repeat(64);
const SCHEMA_HASH = "b".repeat(64);
const SUMMARY = {
  auditStatus: "complete" as const,
  completionIssues: [],
  themeFileCount: 274,
  scannedSourceCount: 240,
  matchedSourceCount: 4,
  textSizeReconciliationCount: 3,
  integrityDiagnosticCount: 0,
  kachingEmbedCount: 1,
  activeKachingEmbedCount: 1,
  croatianPostMatchedFileCount: 2,
  saleNarrativeMatchedFileCount: 1,
  summerSaleMenuItemCount: 1,
  contactLinks: { main: 1, footer: 0 },
  aboutLinks: { main: 0, footer: 0 },
  appInstallations: {
    status: "complete" as const,
    scannedCount: 12,
    pagesRead: 1,
    matches: [
      {
        product: "shopify_flow" as const,
        title: "Shopify Flow",
        handle: "shopify-flow",
        shopifyDeveloped: true as const,
      },
    ],
  },
};
const ARTIFACT = {
  schemaVersion: "lara-storefront-residual-map.v3",
  queryManifestSha256: MANIFEST_HASH,
};

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LARA_STOREFRONT_RESIDUAL_RUN_ID,
    connection_id: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    requested_by: SPONSOR,
    requested_actor_type: "system",
    shopify_domain: "jwmtjg-fm.myshopify.com",
    state: "running",
    requested_source: "system.storefront_residual_map",
    requested_note:
      "Lara Rovinj fixed read-only storefront residual source and menu map",
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
  vi.unstubAllGlobals();
  mocks.manifestHash.mockResolvedValue(MANIFEST_HASH);
  mocks.schemaHash.mockResolvedValue(SCHEMA_HASH);
  mocks.enqueue.mockResolvedValue(LARA_STOREFRONT_RESIDUAL_RUN_ID);
  mocks.claim.mockResolvedValue(runRow());
  mocks.renew.mockResolvedValue(runRow());
  mocks.createRuntime.mockResolvedValue({
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: "jwmtjg-fm.myshopify.com",
    shopId: "gid://shopify/Shop/95462097276",
    grantedScopes: ["read_themes", "read_online_store_navigation"],
    query: vi.fn().mockResolvedValue({ shop: { id: "fixed" } }),
  });
  mocks.collect.mockImplementation(async ({ runtime }) => {
    await runtime.query("query LaraFixedRead { shop { id } }");
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
      error_code: "residual_map_failed",
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
      failed_at: "2026-08-12T21:01:00Z",
    }),
  );
  mocks.get.mockResolvedValue(runRow());
});

describe("the durable Lara storefront residual collector", () => {
  it("pins the fixed system run and executes only the approved read manifest", async () => {
    await expect(
      runLaraStorefrontResidualCollector({ requestedBy: SPONSOR, leaseToken: LEASE }),
    ).resolves.toEqual({
      runId: LARA_STOREFRONT_RESIDUAL_RUN_ID,
      state: "completed",
      summary: SUMMARY,
    });

    expect(mocks.enqueue).toHaveBeenCalledWith({
      runId: LARA_STOREFRONT_RESIDUAL_RUN_ID,
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      requestedBy: SPONSOR,
      shopDomain: "jwmtjg-fm.myshopify.com",
      source: "system.storefront_residual_map",
      note: "Lara Rovinj fixed read-only storefront residual source and menu map",
      schemaHash: SCHEMA_HASH,
      manifestHash: MANIFEST_HASH,
      maxRetries: 2,
      actorType: "system",
    });
    expect(mocks.createRuntime).toHaveBeenCalledWith({
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      expectedShopDomain: "jwmtjg-fm.myshopify.com",
      expectedShopId: "gid://shopify/Shop/95462097276",
      allowedQueryDocuments: ["query LaraFixedRead { shop { id } }"],
    });
    expect(mocks.renew).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: LARA_STOREFRONT_RESIDUAL_RUN_ID }),
      leaseToken: LEASE,
      checkpoint: { requestCount: 0, shortBodyReadCount: 0 },
      leaseSeconds: 300,
    });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ artifact: ARTIFACT }),
    );
  });

  it("replays a completed row only when all immutable run evidence still matches", async () => {
    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "already completed"),
    );
    mocks.get.mockResolvedValueOnce(
      runRow({ state: "completed", artifact: ARTIFACT, completed_at: "2026-08-12T21:01:00Z" }),
    );

    await expect(
      runLaraStorefrontResidualCollector({ requestedBy: SPONSOR, leaseToken: LEASE }),
    ).resolves.toMatchObject({ state: "completed", summary: SUMMARY });
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("rejects a stale terminal row whose requester or manifest evidence differs", async () => {
    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "already completed"),
    );
    mocks.get.mockResolvedValueOnce(
      runRow({
        requested_by: "20000000-0000-4000-8000-000000000001",
        state: "completed",
        artifact: ARTIFACT,
        completed_at: "2026-08-12T21:01:00Z",
      }),
    );

    await expect(
      runLaraStorefrontResidualCollector({ requestedBy: SPONSOR, leaseToken: LEASE }),
    ).resolves.toEqual({
      runId: LARA_STOREFRONT_RESIDUAL_RUN_ID,
      state: "failed",
      errorCode: "run_evidence_mismatch",
    });
  });

  it("returns in-progress when a typed Shopify failure is durably queued for retry", async () => {
    mocks.createRuntime.mockRejectedValueOnce(
      new AuditShopifyRuntimeError(
        "query_rate_limited",
        "must-not-leak",
        true,
      ),
    );
    mocks.fail.mockResolvedValueOnce(runRow({ state: "queued" }));

    const result = await runLaraStorefrontResidualCollector({
      requestedBy: SPONSOR,
      leaseToken: LEASE,
    });
    expect(result).toEqual({
      runId: LARA_STOREFRONT_RESIDUAL_RUN_ID,
      state: "in_progress",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "query_rate_limited", retryable: true }),
    );
  });
});

describe("the Shopify short-lived theme body boundary", () => {
  it("reads an exact UTF-8 body from an allowlisted Shopify CDN without redirects", async () => {
    const source = "Sniženja — Do 50% popusta";
    const sourceBytes = new TextEncoder().encode(source);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sourceBytes, {
        status: 200,
        headers: { "content-length": String(sourceBytes.byteLength) },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readLaraShortLivedThemeBody({
        url: "https://cdn.shopify.com/s/files/source?signature=not-persisted",
        expectedBytes: sourceBytes.byteLength,
        filename: "sections/header-group.json",
      }),
    ).resolves.toBe(source);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: "GET", redirect: "manual", cache: "no-store" }),
    );
  });

  it("accepts only Shopify-prefixed short-lived bodies on Google storage", async () => {
    const source = "body";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(source, {
        status: 200,
        headers: { "content-length": String(source.length) },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readLaraShortLivedThemeBody({
        url: "https://storage.googleapis.com/shopify-theme-assets/body?X-Goog-Signature=private",
        expectedBytes: source.length,
        filename: "assets/main.css",
      }),
    ).resolves.toBe(source);
    await expect(
      readLaraShortLivedThemeBody({
        url: "https://storage.googleapis.com/unrelated/body?X-Goog-Signature=private",
        expectedBytes: source.length,
        filename: "assets/main.css",
      }),
    ).rejects.toThrow("disallowed");
  });

  it("rejects non-Shopify, credentialed, oversized or byte-drift URLs before persistence", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readLaraShortLivedThemeBody({
        url: "https://169.254.169.254/internal",
        expectedBytes: 10,
        filename: "config/settings_data.json",
      }),
    ).rejects.toThrow("disallowed");
    await expect(
      readLaraShortLivedThemeBody({
        url: "https://user:password@cdn.shopify.com/source",
        expectedBytes: 10,
        filename: "config/settings_data.json",
      }),
    ).rejects.toThrow("disallowed");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response("short", { status: 200 }));
    await expect(
      readLaraShortLivedThemeBody({
        url: "https://assets.shopifycdn.com/source",
        expectedBytes: 10,
        filename: "config/settings_data.json",
      }),
    ).rejects.toThrow("exact size");
  });
});
