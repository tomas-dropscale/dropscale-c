import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditBaselineManifestSha256: vi.fn(),
  auditBaselineSchemaSha256: vi.fn(),
  collectShopifyAuditBaseline: vi.fn(),
  createAuditShopifyRuntime: vi.fn(),
  enqueueAuditShopifyRun: vi.fn(),
  claimAuditShopifyRun: vi.fn(),
  completeAuditShopifyRun: vi.fn(),
  failAuditShopifyRun: vi.fn(),
  getAuditShopifyRun: vi.fn(),
  renewAuditShopifyRun: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit/shopify-baseline", () => ({
  AUDIT_BASELINE_QUERY_MANIFEST: { shopIdentity: "query AuditShopIdentity { shop { id } }" },
  auditBaselineManifestSha256: mocks.auditBaselineManifestSha256,
  auditBaselineSchemaSha256: mocks.auditBaselineSchemaSha256,
  collectShopifyAuditBaseline: mocks.collectShopifyAuditBaseline,
}));
vi.mock("@/lib/audit/shopify-runtime", async () => {
  class AuditShopifyRuntimeError extends Error {
    constructor(
      public code: string,
      message: string,
      public retryable = false,
    ) {
      super(message);
    }
  }
  return {
    AuditShopifyRuntimeError,
    createAuditShopifyRuntime: mocks.createAuditShopifyRuntime,
  };
});
vi.mock("@/lib/audit/shopify-runs", () => {
  class AuditShopifyRunError extends Error {
    constructor(public code: string) {
      super("Audit run error");
    }
  }
  return {
    AuditShopifyRunError,
    enqueueAuditShopifyRun: mocks.enqueueAuditShopifyRun,
    claimAuditShopifyRun: mocks.claimAuditShopifyRun,
    completeAuditShopifyRun: mocks.completeAuditShopifyRun,
    failAuditShopifyRun: mocks.failAuditShopifyRun,
    getAuditShopifyRun: mocks.getAuditShopifyRun,
    renewAuditShopifyRun: mocks.renewAuditShopifyRun,
  };
});

import { AuditShopifyRuntimeError } from "@/lib/audit/shopify-runtime";
import { AuditShopifyRunError } from "@/lib/audit/shopify-runs";
import {
  LARA_AUDIT_CONNECTION,
  runLaraAuditBaseline,
} from "./shopify-collector";

const RUN_ID = "40000000-0000-4000-8000-000000000010";
const LEASE = "40000000-0000-4000-8000-000000000011";
const ADMIN_ID = "40000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const CLAIMED = {
  id: RUN_ID,
  shopify_domain: LARA_AUDIT_CONNECTION.shopDomain,
  lease_generation: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditBaselineManifestSha256.mockResolvedValue(HASH);
  mocks.auditBaselineSchemaSha256.mockResolvedValue(HASH);
  mocks.enqueueAuditShopifyRun.mockResolvedValue(RUN_ID);
  mocks.claimAuditShopifyRun.mockResolvedValue(CLAIMED);
  mocks.createAuditShopifyRuntime.mockResolvedValue({
    query: vi.fn(),
    grantedScopes: ["read_products"],
  });
  mocks.collectShopifyAuditBaseline.mockResolvedValue({
    schemaVersion: "shopify-audit-baseline-v2",
    auditStatus: "complete",
    modules: {},
  });
  mocks.completeAuditShopifyRun.mockResolvedValue({ state: "completed" });
  mocks.failAuditShopifyRun.mockResolvedValue({ state: "failed" });
  mocks.getAuditShopifyRun.mockResolvedValue({ state: "running" });
  mocks.renewAuditShopifyRun.mockResolvedValue(CLAIMED);
});

describe("exact Lara Shopify collector orchestration", () => {
  it("pins connection/domain/shop before collecting and completes the durable run", async () => {
    await expect(
      runLaraAuditBaseline({ requestedBy: ADMIN_ID, runId: RUN_ID, leaseToken: LEASE }),
    ).resolves.toMatchObject({ runId: RUN_ID, state: "completed" });

    expect(mocks.enqueueAuditShopifyRun).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
        requestedBy: ADMIN_ID,
        shopDomain: "jwmtjg-fm.myshopify.com",
        source: "admin.baseline",
        schemaHash: HASH,
        manifestHash: HASH,
        maxRetries: 0,
        actorType: "admin",
      }),
    );
    expect(mocks.createAuditShopifyRuntime).toHaveBeenCalledWith({
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      expectedShopDomain: "jwmtjg-fm.myshopify.com",
      expectedShopId: "gid://shopify/Shop/95462097276",
      allowedQueryDocuments: ["query AuditShopIdentity { shop { id } }"],
    });
    expect(mocks.collectShopifyAuditBaseline).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: ["read_products"] }),
    );
    expect(mocks.renewAuditShopifyRun).toHaveBeenCalledWith({
      run: CLAIMED,
      leaseToken: LEASE,
      checkpoint: { requestCount: 0, collectionPrepared: true },
      leaseSeconds: 300,
    });
    const execute = mocks.collectShopifyAuditBaseline.mock.calls[0][0].execute;
    await execute("query AuditShopIdentity { shop { id } }");
    expect(mocks.renewAuditShopifyRun).toHaveBeenCalledWith({
      run: CLAIMED,
      leaseToken: LEASE,
      checkpoint: { requestCount: 0 },
      leaseSeconds: 300,
    });
    expect(mocks.completeAuditShopifyRun).toHaveBeenCalledWith(
      expect.objectContaining({ run: CLAIMED, leaseToken: LEASE }),
    );
  });

  it("binds a machine bootstrap to system evidence without changing the sponsor", async () => {
    await expect(
      runLaraAuditBaseline({
        requestedBy: ADMIN_ID,
        runId: RUN_ID,
        leaseToken: LEASE,
        trigger: "system",
      }),
    ).resolves.toMatchObject({ runId: RUN_ID, state: "completed" });

    expect(mocks.enqueueAuditShopifyRun).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: ADMIN_ID,
        source: "system.initial_baseline",
        note: expect.stringContaining("machine bootstrap"),
        actorType: "system",
      }),
    );
  });

  it("returns partial when collection modules are incomplete", async () => {
    mocks.collectShopifyAuditBaseline.mockResolvedValue({
      schemaVersion: "shopify-audit-baseline-v2",
      auditStatus: "partial",
      completionIssues: ["module:theme:failed"],
      modules: { theme: { status: "failed" } },
    });

    await expect(
      runLaraAuditBaseline({ requestedBy: ADMIN_ID, runId: RUN_ID, leaseToken: LEASE }),
    ).resolves.toMatchObject({ runId: RUN_ID, state: "partial" });
  });

  it("does not start a duplicate when the same manifest is already running", async () => {
    const existingRunId = "40000000-0000-4000-8000-000000000099";
    mocks.enqueueAuditShopifyRun.mockResolvedValue(existingRunId);
    mocks.claimAuditShopifyRun.mockRejectedValue(
      new AuditShopifyRunError("run_not_found", "Already running"),
    );

    await expect(
      runLaraAuditBaseline({
        requestedBy: ADMIN_ID,
        runId: RUN_ID,
        leaseToken: LEASE,
      }),
    ).resolves.toEqual({ runId: existingRunId, state: "in_progress" });
    expect(mocks.createAuditShopifyRuntime).not.toHaveBeenCalled();
  });

  it("reports an expired terminal run instead of calling it in progress", async () => {
    mocks.claimAuditShopifyRun.mockRejectedValue(
      new AuditShopifyRunError("run_not_found", "Lease expired"),
    );
    mocks.getAuditShopifyRun.mockResolvedValue({
      state: "failed",
      error_code: "lease_expired",
    });

    await expect(
      runLaraAuditBaseline({
        requestedBy: ADMIN_ID,
        runId: RUN_ID,
        leaseToken: LEASE,
      }),
    ).resolves.toEqual({
      runId: RUN_ID,
      state: "failed",
      errorCode: "lease_expired",
    });
  });

  it("records a typed, sanitized, retryable failure without returning its message", async () => {
    mocks.createAuditShopifyRuntime.mockRejectedValue(
      new AuditShopifyRuntimeError(
        "query_rate_limited",
        "must-not-be-returned client-secret-value",
        true,
      ),
    );
    mocks.failAuditShopifyRun.mockResolvedValue({ state: "failed" });

    const result = await runLaraAuditBaseline({
      requestedBy: ADMIN_ID,
      runId: RUN_ID,
      leaseToken: LEASE,
    });
    expect(result).toEqual({
      runId: RUN_ID,
      state: "failed",
      errorCode: "query_rate_limited",
    });
    expect(JSON.stringify(result)).not.toContain("client-secret-value");
    expect(mocks.failAuditShopifyRun).toHaveBeenCalledWith({
      run: CLAIMED,
      leaseToken: LEASE,
      errorCode: "query_rate_limited",
      retryable: true,
    });
  });

  it("does not mask the original failure when its lease was superseded", async () => {
    mocks.createAuditShopifyRuntime.mockRejectedValue(
      new AuditShopifyRuntimeError("query_unavailable", "Shopify unavailable", true),
    );
    mocks.failAuditShopifyRun.mockRejectedValue(
      new AuditShopifyRunError("fail_failed", "Lease superseded"),
    );
    mocks.getAuditShopifyRun.mockResolvedValue({ state: "running" });

    await expect(
      runLaraAuditBaseline({
        requestedBy: ADMIN_ID,
        runId: RUN_ID,
        leaseToken: LEASE,
      }),
    ).resolves.toEqual({ runId: RUN_ID, state: "in_progress" });
  });
});
