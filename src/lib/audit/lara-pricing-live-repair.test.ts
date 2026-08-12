import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  enqueue: vi.fn(),
  claim: vi.fn(),
  renew: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  rpc: vi.fn(),
  createStore: vi.fn(),
  preflightStore: vi.fn(),
}));

vi.mock("./shopify-runs", () => ({
  getAuditShopifyRun: mocks.get,
  enqueueAuditShopifyRun: mocks.enqueue,
  claimAuditShopifyRun: mocks.claim,
  renewAuditShopifyRun: mocks.renew,
  completeAuditShopifyRun: mocks.complete,
  failAuditShopifyRun: mocks.fail,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("./lara-pricing-artifact-store", () => {
  class LaraPricingArtifactStoreError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    createLaraPricingArtifactStore: mocks.createStore,
    preflightLaraPricingArtifactStore: mocks.preflightStore,
    LaraPricingArtifactStoreError,
  };
});
vi.mock("./lara-pricing-live-runtime", () => {
  class LaraPricingLiveRuntimeError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly retryable = false,
    ) {
      super(message);
    }
  }
  return {
    LARA_PRICING_LIVE_GRAPHQL_MANIFEST: {
      catalogue: "fixed-catalogue",
      startCatalogue: "fixed-start",
      pollCatalogue: "fixed-poll",
      recoverCatalogueStart: "fixed-recovery",
      product: "fixed-product",
      clearCompareAt: "fixed-mutation",
      recoveryLookbackMs: 300_000,
    },
    LaraPricingLiveRuntimeError,
    createLaraPricingLiveRuntime: vi.fn(),
  };
});

import {
  LARA_PRICING_LIVE_REPAIR_RUN_ID,
  LaraPricingLiveRepairError,
  laraPricingLiveRepairRequestEvidence,
  runLaraPricingLiveRepairOneShot,
  type LaraPricingLiveCheckpoint,
} from "./lara-pricing-live-repair";
import { LaraPricingArtifactStoreError } from "./lara-pricing-artifact-store";
import {
  LaraPricingLiveRuntimeError,
  type LaraPricingLiveRuntime,
} from "./lara-pricing-live-runtime";
import type { AuditShopifyRun } from "@/lib/supabase/types";
import {
  parseLaraPricingCatalogueBulkResult,
  persistLaraPricingSalePlan,
  prepareLaraPricingSalePlan,
  type LaraPricingImmutableArtifactStore,
  type LaraPricingProductSnapshot,
} from "./lara-pricing-sale-plan";
import { initialLaraPricingExecutionCheckpoint } from "./lara-pricing-sale-executor";

const REQUESTED_BY = "71000000-0000-4000-8000-000000000001";

async function runRow(
  overrides: Partial<AuditShopifyRun> = {},
): Promise<AuditShopifyRun> {
  const evidence = await laraPricingLiveRepairRequestEvidence();
  return {
    id: evidence.runId,
    connection_id: evidence.connectionId,
    requested_by: REQUESTED_BY,
    requested_actor_type: "system",
    shopify_domain: evidence.shopDomain,
    state: "queued",
    requested_source: evidence.source,
    requested_note: evidence.note,
    schema_hash: evidence.schemaHash,
    manifest_hash: evidence.manifestHash,
    checkpoint: {},
    artifact: null,
    attempt_count: 0,
    retry_count: 0,
    max_retries: evidence.maxRetries,
    next_attempt_at: "2026-08-12T20:00:00.000Z",
    lease_token: null,
    lease_generation: 0,
    lease_acquired_at: null,
    lease_renewed_at: null,
    lease_expires_at: null,
    error_code: null,
    created_at: "2026-08-12T20:00:00.000Z",
    updated_at: "2026-08-12T20:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

function inertRuntime(): LaraPricingLiveRuntime {
  return {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopId: "gid://shopify/Shop/95462097276",
    shopDomain: "jwmtjg-fm.myshopify.com",
    apiVersion: "2026-07",
    grantedScopes: ["read_products", "write_products"],
    startCatalogueBulk: vi.fn(),
    pollCatalogueBulk: vi.fn(),
    recoverExactCatalogueStarts: vi.fn(async () => []),
    downloadCompletedCatalogue: vi.fn(),
    readFullProduct: vi.fn(),
    clearCompareAtPricesAtomic: vi.fn(),
  };
}

function memoryArtifactStore(): LaraPricingImmutableArtifactStore & {
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  return {
    values,
    putImmutableJson: vi.fn(async ({ key, value }) => {
      values.set(key, structuredClone(value));
    }),
    getImmutableJson: vi.fn(async (key) => structuredClone(values.get(key))),
  };
}

async function terminalCrashFixture(phase: "verifying" | "verified") {
  const evidence = await laraPricingLiveRepairRequestEvidence();
  const sourceProduct: LaraPricingProductSnapshot = {
    id: "gid://shopify/Product/1",
    handle: "product-1",
    title: "Product 1",
    vendor: "Lara Rovinj",
    status: "ACTIVE",
    publishedAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    variants: [
      {
        id: "gid://shopify/ProductVariant/1001",
        title: "Default Title",
        price: "49.95",
        compareAtPrice: "99.90",
        updatedAt: "2026-08-11T10:00:00.000Z",
      },
    ],
  };
  const catalogue = async (
    product: LaraPricingProductSnapshot,
    operationId: string,
    capturedAt: string,
  ) => {
    const { variants, ...productRow } = product;
    const jsonl = `${JSON.stringify(productRow)}\n${JSON.stringify({
      ...variants[0],
      __parentId: product.id,
    })}\n`;
    return parseLaraPricingCatalogueBulkResult({
      chunks: [jsonl],
      operation: {
        operationId,
        status: "COMPLETED",
        completedAt: capturedAt,
        rootObjectCount: 1,
        objectCount: 2,
        fileSize: new TextEncoder().encode(jsonl).byteLength,
      },
      capturedAt,
    });
  };
  const source = await catalogue(
    sourceProduct,
    "gid://shopify/BulkOperation/3001",
    "2026-08-12T20:01:00.000Z",
  );
  const plan = await prepareLaraPricingSalePlan({
    catalogue: source,
    createdAt: "2026-08-12T20:02:00.000Z",
  });
  const store = memoryArtifactStore();
  const persisted = await persistLaraPricingSalePlan({
    plan,
    store,
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
  });
  const repairedProduct: LaraPricingProductSnapshot = {
    ...structuredClone(sourceProduct),
    updatedAt: "2026-08-12T20:03:00.000Z",
    variants: sourceProduct.variants.map((variant) => ({
      ...structuredClone(variant),
      compareAtPrice: null,
      updatedAt: "2026-08-12T20:03:00.000Z",
    })),
  };
  const fresh = await catalogue(
    repairedProduct,
    "gid://shopify/BulkOperation/3002",
    "2026-08-12T20:04:00.000Z",
  );
  const initialExecution = initialLaraPricingExecutionCheckpoint({
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    rootRef: persisted.rootRef,
    root: persisted.root,
    approvedPlanDigestSha256: persisted.root.digestSha256,
  });
  const execution = {
    ...initialExecution,
    phase: "verified" as const,
    nextOperationIndex: persisted.root.operations.length,
    appliedProducts: 1,
    appliedVariants: 1,
    freshVerificationDigestSha256: fresh.digestSha256,
    freshVerificationProducts: fresh.counts.products,
    freshVerificationVariants: fresh.counts.variants,
  };
  const checkpoint: LaraPricingLiveCheckpoint = {
    schemaVersion: "lara-pricing-sale-live-repair.v1",
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    revision: 20,
    sliceCount: 10,
    phase,
    schemaHash: evidence.schemaHash,
    manifestHash: evidence.manifestHash,
    source: {
      requestedAt: "2026-08-12T20:00:00.000Z",
      operationId: source.bulk.operationId,
      completedAt: source.bulk.completedAt,
      capturedAt: source.capturedAt,
      jsonlSha256: "a".repeat(64),
      byteLength: source.bulk.fileSize,
      catalogueDigestSha256: source.digestSha256,
      products: source.counts.products,
      variants: source.counts.variants,
      variantsWithCompareAt: source.counts.variantsWithCompareAt,
      pollCount: 2,
    },
    planCreatedAt: plan.createdAt,
    preparedPlanDigestSha256: plan.digestSha256,
    nextPreparationOrdinal: source.counts.products,
    rootRef: persisted.rootRef,
    rootDigestSha256: persisted.root.digestSha256,
    execution,
    verification: {
      requestedAt: "2026-08-12T20:03:30.000Z",
      operationId: fresh.bulk.operationId,
      completedAt: fresh.bulk.completedAt,
      capturedAt: fresh.capturedAt,
      jsonlSha256: "b".repeat(64),
      byteLength: fresh.bulk.fileSize,
      catalogueDigestSha256: fresh.digestSha256,
      products: fresh.counts.products,
      variants: fresh.counts.variants,
      variantsWithCompareAt: 0,
      pollCount: 2,
      nextSourceOrdinal: source.counts.products,
      missingSourceProducts: 0,
      missingSourceVariants: 0,
      sellingPriceDriftVariants: 0,
      vendorDriftProducts: 0,
      statusDriftProducts: 0,
      publicationDriftProducts: 0,
    },
    journalSequence: 5,
    journalDigestSha256: "c".repeat(64),
    lastEvent: {
      sequence: 5,
      occurredAt: "2026-08-12T20:05:00.000Z",
      event: "verification.run.verified",
      detailCode: null,
    },
    blockedCode: null,
  };
  return { checkpoint, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createStore.mockReturnValue({
    putImmutableJson: vi.fn(),
    getImmutableJson: vi.fn(),
  });
  mocks.preflightStore.mockResolvedValue(undefined);
});

describe("fenced Lara pricing one-shot", () => {
  it("enqueues exact system evidence, claims first, and persists only a bounded secret-free checkpoint", async () => {
    const queued = await runRow();
    let durable = queued;
    mocks.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(queued);
    mocks.enqueue.mockResolvedValue(LARA_PRICING_LIVE_REPAIR_RUN_ID);
    mocks.claim.mockImplementation(async (input: { leaseToken: string }) => {
      durable = {
        ...queued,
        state: "running",
        attempt_count: 1,
        next_attempt_at: null,
        lease_token: input.leaseToken,
        lease_generation: 1,
        lease_acquired_at: "2026-08-12T20:00:01.000Z",
        lease_renewed_at: "2026-08-12T20:00:01.000Z",
        lease_expires_at: "2026-08-12T20:05:01.000Z",
        started_at: "2026-08-12T20:00:01.000Z",
      };
      return durable;
    });
    mocks.renew.mockImplementation(async (input: { checkpoint: Record<string, unknown> }) => {
      durable = { ...durable, checkpoint: structuredClone(input.checkpoint) };
      return durable;
    });
    mocks.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      durable = {
        ...durable,
        state: "queued",
        checkpoint: structuredClone(args.p_checkpoint as Record<string, unknown>),
        next_attempt_at: "2026-08-12T20:00:31.000Z",
        lease_token: null,
        lease_acquired_at: null,
        lease_renewed_at: null,
        lease_expires_at: null,
      };
      return { data: [durable], error: null };
    });
    const runtime = inertRuntime();
    const outcome = await runLaraPricingLiveRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtimeFactory: async () => runtime,
    });

    expect(outcome).toEqual(
      expect.objectContaining({ state: "in_progress", phase: "source_starting" }),
    );
    const evidence = await laraPricingLiveRepairRequestEvidence();
    expect(mocks.enqueue).toHaveBeenCalledWith({
      runId: evidence.runId,
      connectionId: evidence.connectionId,
      requestedBy: REQUESTED_BY,
      shopDomain: evidence.shopDomain,
      source: evidence.source,
      note: evidence.note,
      schemaHash: evidence.schemaHash,
      manifestHash: evidence.manifestHash,
      maxRetries: evidence.maxRetries,
      actorType: "system",
    });
    expect(mocks.claim).toHaveBeenCalledBefore(mocks.renew);
    expect(mocks.preflightStore).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
        leaseGeneration: 1,
      }),
    );
    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(runtime.startCatalogueBulk).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "yield_audit_shopify_run",
      expect.objectContaining({
        p_run_id: LARA_PRICING_LIVE_REPAIR_RUN_ID,
        p_lease_generation: 1,
      }),
    );
    const checkpoint = durable.checkpoint;
    const serialized = JSON.stringify(checkpoint);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(64 * 1024);
    expect(serialized).not.toMatch(
      /access.?token|client.?secret|authorization|signed.?url|credential/i,
    );
    expect(checkpoint).toEqual(
      expect.objectContaining({
        runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
        phase: "source_starting",
        revision: 3,
        sliceCount: 1,
      }),
    );
  });

  it("does not create a runtime or private store when another lease owns the run", async () => {
    const queued = await runRow();
    mocks.get.mockResolvedValueOnce(queued).mockResolvedValueOnce(queued);
    mocks.claim.mockRejectedValue(new Error("not ready"));
    const runtimeFactory = vi.fn(async () => inertRuntime());

    const outcome = await runLaraPricingLiveRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtimeFactory,
    });

    expect(outcome.state).toBe("in_progress");
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.renew).not.toHaveBeenCalled();
  });

  it("fails before creating a Shopify runtime when migration 0045 preflight is unavailable", async () => {
    const queued = await runRow();
    let running = await runRow({
      state: "running",
      attempt_count: 1,
      next_attempt_at: null,
      lease_token: "72000000-0000-4000-8000-000000000001",
      lease_generation: 1,
      lease_acquired_at: "2026-08-12T20:00:01.000Z",
      lease_renewed_at: "2026-08-12T20:00:01.000Z",
      lease_expires_at: "2026-08-12T20:05:01.000Z",
      started_at: "2026-08-12T20:00:01.000Z",
    });
    mocks.get.mockResolvedValue(queued);
    mocks.claim.mockImplementation(async (input: { leaseToken: string }) => {
      running = { ...running, lease_token: input.leaseToken };
      return running;
    });
    mocks.renew.mockImplementation(async (input: { checkpoint: Record<string, unknown> }) => {
      running = { ...running, checkpoint: input.checkpoint };
      return running;
    });
    mocks.preflightStore.mockRejectedValueOnce(
      new LaraPricingArtifactStoreError(
        "server_not_configured",
        "migration unavailable",
      ),
    );
    mocks.fail.mockImplementation(async (input: { errorCode: string }) => ({
      ...running,
      state: "failed",
      artifact: null,
      error_code: input.errorCode,
      next_attempt_at: null,
      failed_at: "2026-08-12T20:00:02.000Z",
      completed_at: null,
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    }));
    const runtimeFactory = vi.fn(async () => inertRuntime());

    const outcome = await runLaraPricingLiveRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtimeFactory,
    });

    expect(outcome).toEqual(
      expect.objectContaining({
        state: "failed",
        errorCode: "pricing_server_not_configured",
      }),
    );
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "pricing_server_not_configured",
        retryable: false,
      }),
    );
  });

  it("rejects any reused run whose fixed source, actor or hashes differ", async () => {
    const tampered = await runRow({ requested_source: "system.other" });
    mocks.get.mockResolvedValue(tampered);
    await expect(
      runLaraPricingLiveRepairOneShot({ requestedBy: REQUESTED_BY }),
    ).rejects.toBeInstanceOf(LaraPricingLiveRepairError);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.createStore).not.toHaveBeenCalled();
  });

  it("rejects a terminal replay that still carries a lease before trusting its checkpoint", async () => {
    const malformed = await runRow({
      state: "failed",
      next_attempt_at: null,
      lease_token: "72000000-0000-4000-8000-000000000001",
      lease_generation: 1,
      lease_acquired_at: "2026-08-12T20:00:01.000Z",
      lease_renewed_at: "2026-08-12T20:00:01.000Z",
      lease_expires_at: "2026-08-12T20:05:01.000Z",
      error_code: "pricing_failure",
      failed_at: "2026-08-12T20:00:02.000Z",
    });
    mocks.get.mockResolvedValue(malformed);

    await expect(
      runLaraPricingLiveRepairOneShot({ requestedBy: REQUESTED_BY }),
    ).rejects.toMatchObject({ code: "run_metadata_mismatch" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.preflightStore).not.toHaveBeenCalled();
  });

  it("reconciles both terminal crash windows and completes without re-running Shopify", async () => {
    for (const phase of ["verifying", "verified"] as const) {
      vi.clearAllMocks();
      mocks.preflightStore.mockResolvedValue(undefined);
      const fixture = await terminalCrashFixture(phase);
      const checkpointAtSliceCeiling = {
        ...structuredClone(fixture.checkpoint),
        sliceCount: 3_500,
      };
      mocks.createStore.mockReturnValue(fixture.store);
      let running = await runRow({
        state: "running",
        checkpoint: checkpointAtSliceCeiling as unknown as Record<
          string,
          unknown
        >,
        attempt_count: 11,
        next_attempt_at: null,
        lease_token: "72000000-0000-4000-8000-000000000001",
        lease_generation: 7,
        lease_acquired_at: "2026-08-12T20:06:00.000Z",
        lease_renewed_at: "2026-08-12T20:06:00.000Z",
        lease_expires_at: "2026-08-12T20:11:00.000Z",
        started_at: "2026-08-12T20:00:01.000Z",
      });
      mocks.get.mockResolvedValue(
        await runRow({
          checkpoint: structuredClone(checkpointAtSliceCeiling) as unknown as Record<
            string,
            unknown
          >,
        }),
      );
      mocks.claim.mockImplementation(async (input: { leaseToken: string }) => {
        running = { ...running, lease_token: input.leaseToken };
        return running;
      });
      mocks.renew.mockImplementation(
        async (input: { checkpoint: Record<string, unknown> }) => {
          running = { ...running, checkpoint: structuredClone(input.checkpoint) };
          return running;
        },
      );
      mocks.complete.mockImplementation(
        async (input: {
          checkpoint: Record<string, unknown>;
          artifact: Record<string, unknown>;
        }) => ({
          ...running,
          state: "completed",
          checkpoint: structuredClone(input.checkpoint),
          artifact: structuredClone(input.artifact),
          completed_at: "2026-08-12T20:07:00.000Z",
          failed_at: null,
          next_attempt_at: null,
          error_code: null,
          lease_token: null,
          lease_acquired_at: null,
          lease_renewed_at: null,
          lease_expires_at: null,
        }),
      );
      const runtimeFactory = vi.fn(async () => inertRuntime());

      await expect(
        runLaraPricingLiveRepairOneShot({
          requestedBy: REQUESTED_BY,
          runtimeFactory,
        }),
      ).resolves.toEqual(
        expect.objectContaining({ state: "completed", phase: "verified" }),
      );
      expect(runtimeFactory).not.toHaveBeenCalled();
      expect(mocks.complete).toHaveBeenCalledTimes(1);
      expect(mocks.fail).not.toHaveBeenCalled();
    }
  });

  it("keeps a sealed terminal checkpoint retryable when completion acknowledgement is ambiguous", async () => {
    const fixture = await terminalCrashFixture("verified");
    mocks.createStore.mockReturnValue(fixture.store);
    const queued = await runRow({
      checkpoint: structuredClone(fixture.checkpoint) as unknown as Record<
        string,
        unknown
      >,
    });
    let running = await runRow({
      state: "running",
      checkpoint: structuredClone(fixture.checkpoint) as unknown as Record<
        string,
        unknown
      >,
      attempt_count: 4,
      lease_generation: 7,
      lease_token: "72000000-0000-4000-8000-000000000001",
      lease_acquired_at: "2026-08-12T20:06:00.000Z",
      lease_renewed_at: "2026-08-12T20:06:00.000Z",
      lease_expires_at: "2026-08-12T20:11:00.000Z",
      next_attempt_at: null,
    });
    mocks.get
      .mockResolvedValueOnce(queued)
      .mockImplementation(async () => running);
    mocks.claim.mockImplementation(async (input: { leaseToken: string }) => {
      running = { ...running, lease_token: input.leaseToken };
      return running;
    });
    mocks.renew.mockImplementation(
      async (input: { checkpoint: Record<string, unknown>; leaseToken: string }) => {
        running = {
          ...running,
          checkpoint: structuredClone(input.checkpoint),
          lease_token: input.leaseToken,
        };
        return running;
      },
    );
    mocks.complete.mockRejectedValueOnce(new Error("lost terminal acknowledgement"));
    mocks.fail.mockImplementation(
      async (input: {
        checkpoint: Record<string, unknown>;
        errorCode: string;
      }) => ({
        ...running,
        state: "queued",
        checkpoint: structuredClone(input.checkpoint),
        artifact: null,
        error_code: input.errorCode,
        failed_at: null,
        completed_at: null,
        next_attempt_at: "2026-08-12T20:07:30.000Z",
        lease_token: null,
        lease_acquired_at: null,
        lease_renewed_at: null,
        lease_expires_at: null,
      }),
    );
    const runtimeFactory = vi.fn(async () => inertRuntime());

    await expect(
      runLaraPricingLiveRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtimeFactory,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        state: "in_progress",
        phase: "verified",
        errorCode: "pricing_terminal_commit_ambiguous",
      }),
    );
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: true,
        errorCode: "pricing_terminal_commit_ambiguous",
      }),
    );
  });

  it("retries a transient immutable-root read before attempting terminal completion", async () => {
    const fixture = await terminalCrashFixture("verified");
    const unavailableStore = {
      putImmutableJson: vi.fn(),
      getImmutableJson: vi.fn(async () => {
        throw new LaraPricingArtifactStoreError(
          "artifact_read_failed",
          "temporary read failure",
        );
      }),
    };
    mocks.createStore.mockReturnValue(unavailableStore);
    const queued = await runRow({
      checkpoint: structuredClone(fixture.checkpoint) as unknown as Record<
        string,
        unknown
      >,
    });
    let running = await runRow({
      state: "running",
      checkpoint: structuredClone(fixture.checkpoint) as unknown as Record<
        string,
        unknown
      >,
      lease_generation: 7,
      lease_token: "72000000-0000-4000-8000-000000000001",
      lease_acquired_at: "2026-08-12T20:06:00.000Z",
      lease_renewed_at: "2026-08-12T20:06:00.000Z",
      lease_expires_at: "2026-08-12T20:11:00.000Z",
      next_attempt_at: null,
    });
    mocks.get.mockResolvedValue(queued);
    mocks.claim.mockImplementation(async (input: { leaseToken: string }) => {
      running = { ...running, lease_token: input.leaseToken };
      return running;
    });
    mocks.renew.mockImplementation(
      async (input: { checkpoint: Record<string, unknown>; leaseToken: string }) => {
        running = {
          ...running,
          checkpoint: structuredClone(input.checkpoint),
          lease_token: input.leaseToken,
        };
        return running;
      },
    );
    mocks.fail.mockImplementation(
      async (input: {
        checkpoint: Record<string, unknown>;
        errorCode: string;
      }) => ({
        ...running,
        state: "queued",
        checkpoint: structuredClone(input.checkpoint),
        artifact: null,
        error_code: input.errorCode,
        next_attempt_at: "2026-08-12T20:07:30.000Z",
        lease_token: null,
        lease_acquired_at: null,
        lease_renewed_at: null,
        lease_expires_at: null,
      }),
    );

    await expect(
      runLaraPricingLiveRepairOneShot({ requestedBy: REQUESTED_BY }),
    ).resolves.toEqual(
      expect.objectContaining({
        state: "in_progress",
        phase: "verified",
        errorCode: "pricing_artifact_read_failed",
      }),
    );
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: true,
        errorCode: "pricing_artifact_read_failed",
      }),
    );
  });

  it("reconciles a lost completion response that was already committed", async () => {
    const fixture = await terminalCrashFixture("verified");
    mocks.createStore.mockReturnValue(fixture.store);
    const queued = await runRow({
      checkpoint: structuredClone(fixture.checkpoint) as unknown as Record<
        string,
        unknown
      >,
    });
    let running = await runRow({
      state: "running",
      checkpoint: structuredClone(fixture.checkpoint) as unknown as Record<
        string,
        unknown
      >,
      lease_generation: 7,
      lease_token: "72000000-0000-4000-8000-000000000001",
      lease_acquired_at: "2026-08-12T20:06:00.000Z",
      lease_renewed_at: "2026-08-12T20:06:00.000Z",
      lease_expires_at: "2026-08-12T20:11:00.000Z",
      next_attempt_at: null,
    });
    let completed: AuditShopifyRun | null = null;
    mocks.get
      .mockResolvedValueOnce(queued)
      .mockImplementation(async () => completed ?? running);
    mocks.claim.mockImplementation(async (input: { leaseToken: string }) => {
      running = { ...running, lease_token: input.leaseToken };
      return running;
    });
    mocks.renew.mockImplementation(
      async (input: { checkpoint: Record<string, unknown>; leaseToken: string }) => {
        running = {
          ...running,
          checkpoint: structuredClone(input.checkpoint),
          lease_token: input.leaseToken,
        };
        return running;
      },
    );
    mocks.complete.mockImplementation(
      async (input: {
        checkpoint: Record<string, unknown>;
        artifact: Record<string, unknown>;
      }) => {
        completed = {
          ...running,
          state: "completed",
          checkpoint: structuredClone(input.checkpoint),
          artifact: structuredClone(input.artifact),
          completed_at: "2026-08-12T20:07:00.000Z",
          failed_at: null,
          error_code: null,
          next_attempt_at: null,
          lease_token: null,
          lease_acquired_at: null,
          lease_renewed_at: null,
          lease_expires_at: null,
        };
        throw new Error("response lost after commit");
      },
    );
    const runtimeFactory = vi.fn(async () => inertRuntime());

    await expect(
      runLaraPricingLiveRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtimeFactory,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ state: "completed", phase: "verified" }),
    );
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("replays a completed run against the immutable root and rejects missing evidence", async () => {
    const fixture = await terminalCrashFixture("verified");
    mocks.createStore.mockReturnValue(fixture.store);
    let running = await runRow({
      state: "running",
      checkpoint: structuredClone(fixture.checkpoint) as unknown as Record<
        string,
        unknown
      >,
      lease_generation: 7,
      lease_token: "72000000-0000-4000-8000-000000000001",
      lease_acquired_at: "2026-08-12T20:06:00.000Z",
      lease_renewed_at: "2026-08-12T20:06:00.000Z",
      lease_expires_at: "2026-08-12T20:11:00.000Z",
      next_attempt_at: null,
    });
    let completed: AuditShopifyRun | null = null;
    const queued = await runRow({
      state: "queued",
      checkpoint: structuredClone(fixture.checkpoint) as unknown as Record<
        string,
        unknown
      >,
    });
    mocks.get.mockResolvedValueOnce(queued).mockResolvedValueOnce(queued);
    mocks.claim.mockImplementation(async (input: { leaseToken: string }) => {
      running = { ...running, lease_token: input.leaseToken };
      return running;
    });
    mocks.renew.mockImplementation(
      async (input: {
        checkpoint: Record<string, unknown>;
        leaseToken: string;
      }) => {
        running = {
          ...running,
          checkpoint: structuredClone(input.checkpoint),
          lease_token: input.leaseToken,
        };
        return running;
      },
    );
    mocks.complete.mockImplementation(
      async (input: {
        checkpoint: Record<string, unknown>;
        artifact: Record<string, unknown>;
      }) => {
        completed = {
          ...running,
          state: "completed",
          checkpoint: structuredClone(input.checkpoint),
          artifact: structuredClone(input.artifact),
          completed_at: "2026-08-12T20:07:00.000Z",
          lease_token: null,
          lease_acquired_at: null,
          lease_renewed_at: null,
          lease_expires_at: null,
          next_attempt_at: null,
        };
        return completed;
      },
    );
    mocks.fail.mockImplementation(async (input: { errorCode: string }) => ({
      ...running,
      state: "failed",
      artifact: null,
      error_code: input.errorCode,
      failed_at: "2026-08-12T20:07:00.000Z",
      completed_at: null,
      next_attempt_at: null,
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    }));
    const firstOutcome = await runLaraPricingLiveRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtimeFactory: async () => inertRuntime(),
    });
    expect(firstOutcome).toEqual(
      expect.objectContaining({ state: "completed", phase: "verified" }),
    );
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    if (!completed) throw new TypeError("missing completed fixture");

    vi.clearAllMocks();
    mocks.claim.mockClear();
    mocks.get.mockReset();
    mocks.get.mockResolvedValue(completed);
    mocks.createStore.mockReturnValue(fixture.store);
    await expect(
      runLaraPricingLiveRepairOneShot({ requestedBy: REQUESTED_BY }),
    ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
    expect(fixture.store.getImmutableJson).toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();

    fixture.store.values.delete(fixture.checkpoint.rootRef?.key ?? "");
    await expect(
      runLaraPricingLiveRepairOneShot({ requestedBy: REQUESTED_BY }),
    ).rejects.toMatchObject({ code: "terminal_artifact_invalid" });
  });

  it("records retryability explicitly instead of treating a definite setup error as ambiguous", async () => {
    const queued = await runRow();
    let running = await runRow({
      state: "running",
      attempt_count: 1,
      next_attempt_at: null,
      lease_token: "72000000-0000-4000-8000-000000000001",
      lease_generation: 1,
      lease_acquired_at: "2026-08-12T20:00:01.000Z",
      lease_renewed_at: "2026-08-12T20:00:01.000Z",
      lease_expires_at: "2026-08-12T20:05:01.000Z",
      started_at: "2026-08-12T20:00:01.000Z",
    });
    mocks.get.mockResolvedValue(queued);
    mocks.claim.mockImplementation(async (input: { leaseToken: string }) => {
      running = { ...running, lease_token: input.leaseToken };
      return running;
    });
    mocks.renew.mockImplementation(async (input: { checkpoint: Record<string, unknown> }) => {
      running = { ...running, checkpoint: input.checkpoint };
      return running;
    });
    mocks.fail.mockImplementation(async (input: { retryable: boolean; errorCode: string }) => ({
      ...running,
      state: input.retryable ? "queued" : "failed",
      error_code: input.errorCode,
      next_attempt_at: input.retryable
        ? "2026-08-12T20:00:31.000Z"
        : null,
      failed_at: input.retryable ? null : "2026-08-12T20:00:02.000Z",
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    }));

    const retryable = await runLaraPricingLiveRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtimeFactory: async () => {
        throw new LaraPricingLiveRuntimeError(
          "shopify_unavailable",
          "temporary",
          true,
        );
      },
    });
    expect(retryable.state).toBe("in_progress");
    expect(mocks.fail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        retryable: true,
        errorCode: "pricing_shopify_unavailable",
      }),
    );
  });
});
