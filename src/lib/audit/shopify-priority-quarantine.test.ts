import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  claim: vi.fn(),
  renew: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  get: vi.fn(),
}));

vi.mock("./shopify-runs", () => {
  class AuditShopifyRunError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    AuditShopifyRunError,
    enqueueAuditShopifyRun: runMocks.enqueue,
    claimAuditShopifyRun: runMocks.claim,
    renewAuditShopifyRun: runMocks.renew,
    completeAuditShopifyRun: runMocks.complete,
    failAuditShopifyRun: runMocks.fail,
    getAuditShopifyRun: runMocks.get,
  };
});

vi.mock("./shopify-priority-quarantine-runtime", () => {
  class LaraPriorityQuarantineRuntimeError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly retryable = false,
    ) {
      super(message);
    }
  }
  return {
    LaraPriorityQuarantineRuntimeError,
    createLaraPriorityQuarantineRuntime: vi.fn(),
    LARA_PRIORITY_QUARANTINE_GRAPHQL_MANIFEST: {
      product: "fixed-query",
      quarantineToDraft: "fixed-mutation",
    },
  };
});

import { LARA_PRIORITY_PRODUCT_HANDLES } from "./shopify-baseline";
import type {
  LaraPriorityProductSnapshot,
  LaraPriorityQuarantineRuntime,
} from "./shopify-priority-quarantine-runtime";
import { LaraPriorityQuarantineRuntimeError } from "./shopify-priority-quarantine-runtime";
import { AuditShopifyRunError } from "./shopify-runs";
import {
  buildLaraPriorityQuarantinePlan,
  executeLaraPriorityQuarantine,
  LARA_PRIORITY_QUARANTINE_RUN_ID,
  LARA_PRIORITY_QUARANTINE_VENDOR,
  resolveLaraPriorityQuarantinePlan,
  verifyLaraPriorityQuarantinePlan,
} from "./shopify-priority-quarantine";

const AT = "2026-08-12T18:00:00.000Z";
const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const LEASE_TOKEN = "20000000-0000-4000-8000-000000000002";

function snapshots() {
  return new Map<string, LaraPriorityProductSnapshot>(
    LARA_PRIORITY_PRODUCT_HANDLES.map((handle, index) => [
      handle,
      {
        id: `gid://shopify/Product/${1000 + index}`,
        handle,
        title: `Protected product ${index + 1}`,
        status: "ACTIVE" as const,
        updatedAt: `2026-08-12T17:${String(index).padStart(2, "0")}:00.000Z`,
        vendor: LARA_PRIORITY_QUARANTINE_VENDOR,
      },
    ]),
  );
}

function fakeRuntime(store = snapshots()) {
  const mutationInputs: Array<{ id: string; status: "DRAFT" }> = [];
  const runtime: LaraPriorityQuarantineRuntime = {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopId: "gid://shopify/Shop/95462097276",
    shopDomain: "jwmtjg-fm.myshopify.com",
    async readPriorityProduct(handle) {
      const product = store.get(handle);
      if (!product) throw new Error("missing fixture");
      return { ...product };
    },
    async quarantineProductToDraft(productId) {
      const entry = [...store.entries()].find(([, product]) => product.id === productId);
      if (!entry) throw new Error("missing fixture");
      const [handle, before] = entry;
      mutationInputs.push({ id: productId, status: "DRAFT" });
      const after: LaraPriorityProductSnapshot = {
        ...before,
        status: "DRAFT",
        updatedAt: "2026-08-12T18:01:00.000Z",
      };
      store.set(handle, after);
      return { ...after };
    },
  };
  return { runtime, store, mutationInputs };
}

function claimedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: LARA_PRIORITY_QUARANTINE_RUN_ID,
    connection_id: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    requested_by: ADMIN_ID,
    requested_actor_type: "system" as const,
    shopify_domain: "jwmtjg-fm.myshopify.com",
    state: "running" as const,
    requested_source: "system.priority_quarantine",
    requested_note:
      "Authorised Lara priority quarantine: ten fixed ACTIVE products to DRAFT",
    schema_hash: "a".repeat(64),
    manifest_hash: "b".repeat(64),
    checkpoint: {},
    artifact: null,
    attempt_count: 1,
    retry_count: 0,
    max_retries: 3,
    next_attempt_at: null,
    lease_token: LEASE_TOKEN,
    lease_generation: 1,
    lease_acquired_at: AT,
    lease_renewed_at: AT,
    lease_expires_at: "2026-08-12T18:05:00.000Z",
    error_code: null,
    created_at: AT,
    updated_at: AT,
    started_at: AT,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

let enqueuedEvidence: {
  schemaHash: string;
  manifestHash: string;
  requestedBy: string;
  leaseToken: string;
};

function currentClaim(
  leaseToken: string,
  overrides: Record<string, unknown> = {},
) {
  return claimedRun({
    requested_by: enqueuedEvidence.requestedBy,
    schema_hash: enqueuedEvidence.schemaHash,
    manifest_hash: enqueuedEvidence.manifestHash,
    lease_token: leaseToken,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueuedEvidence = {
    schemaHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    requestedBy: ADMIN_ID,
    leaseToken: LEASE_TOKEN,
  };
  runMocks.enqueue.mockImplementation(async (input) => {
    enqueuedEvidence = {
      schemaHash: input.schemaHash,
      manifestHash: input.manifestHash,
      requestedBy: input.requestedBy,
      leaseToken: LEASE_TOKEN,
    };
    return input.runId;
  });
  runMocks.claim.mockImplementation(async (input) => {
    enqueuedEvidence.leaseToken = input.leaseToken;
    return currentClaim(input.leaseToken);
  });
  runMocks.renew.mockImplementation(async ({ run, checkpoint }) => ({
    ...run,
    checkpoint,
  }));
  runMocks.complete.mockImplementation(async ({ run, checkpoint, artifact }) => ({
    ...run,
    state: "completed",
    checkpoint,
    artifact,
  }));
  runMocks.fail.mockImplementation(
    async ({ run, checkpoint, errorCode, retryable }) => {
      const willRetry = retryable && run.retry_count < run.max_retries;
      return {
        ...run,
        state: willRetry ? "queued" : "failed",
        checkpoint,
        error_code: errorCode,
      };
    },
  );
});

describe("the sealed Lara priority quarantine plan", () => {
  it("contains exactly ten fixed ACTIVE-to-DRAFT operations and ACTIVE inverses", async () => {
    const { runtime } = fakeRuntime();
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime,
      now: () => new Date(AT),
    });

    expect(plan.payload.operations.map((operation) => operation.target.handle)).toEqual(
      LARA_PRIORITY_PRODUCT_HANDLES,
    );
    expect(plan.payload.operations).toHaveLength(10);
    expect(
      plan.payload.operations.every(
        (operation) =>
          operation.cas.expectedVendor === "Lara Rovinj" &&
          operation.cas.expectedStatus === "ACTIVE" &&
          operation.change.status === "DRAFT" &&
          operation.inverse.status === "ACTIVE",
      ),
    ).toBe(true);
    expect(plan.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan.payload.operations)).toBe(true);
  });

  it("rejects vendor drift and post-seal plan tampering", async () => {
    const vendorDrift = snapshots();
    const firstHandle = LARA_PRIORITY_PRODUCT_HANDLES[0];
    vendorDrift.set(firstHandle, { ...vendorDrift.get(firstHandle)!, vendor: "Other" });
    await expect(
      buildLaraPriorityQuarantinePlan({ runtime: fakeRuntime(vendorDrift).runtime }),
    ).rejects.toMatchObject({ code: "product_drift" });

    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const tampered = structuredClone(plan) as unknown as {
      payload: { operations: Array<{ cas: { expectedTitle: string } }> };
      digestSha256: string;
    };
    tampered.payload.operations[0]!.cas.expectedTitle = "Tampered";
    await expect(verifyLaraPriorityQuarantinePlan(tampered)).rejects.toMatchObject({
      code: "plan_digest_mismatch",
    });
  });
});

describe("the fenced Lara priority quarantine executor", () => {
  it("writes one product at a time, checkpoints before/after, and verifies all ten", async () => {
    const initial = fakeRuntime();
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: initial.runtime,
      now: () => new Date(AT),
    });
    const live = fakeRuntime(snapshots());

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: live.runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({ state: "completed", verifiedCount: 10 });
    expect(live.mutationInputs).toEqual(
      plan.payload.operations.map((operation) => ({
        id: operation.target.productId,
        status: "DRAFT",
      })),
    );
    expect(JSON.stringify(live.mutationInputs)).not.toContain("vendor");
    expect(runMocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
        actorType: "system",
        maxRetries: 3,
        manifestHash: plan.digestSha256,
      }),
    );
    expect(runMocks.renew.mock.calls.length).toBeGreaterThanOrEqual(21);
    const checkpoints = runMocks.renew.mock.calls.map(
      ([input]) => input.checkpoint as { journal: Array<{ event: string }> },
    );
    for (const operation of plan.payload.operations) {
      expect(
        checkpoints.some((item) =>
          item.journal.some(
            (entry: { event: string; operationId?: string }) =>
              entry.event === "operation.prepared" &&
              entry.operationId === operation.operationId,
          ),
        ),
      ).toBe(true);
      expect(
        checkpoints.some((item) =>
          item.journal.some(
            (entry: { event: string; operationId?: string }) =>
              entry.event === "operation.applied" &&
              entry.operationId === operation.operationId,
          ),
        ),
      ).toBe(true);
    }
    const completion = runMocks.complete.mock.calls[0]![0];
    expect(completion.artifact).toMatchObject({
      status: "verified",
      verifiedCount: 10,
      protectedVendor: "Lara Rovinj",
      mutationFields: ["id", "status"],
    });
    expect(
      completion.artifact.recordedRestoreEvidence.every(
        (operation: { restoreStatus: string }) => operation.restoreStatus === "ACTIVE",
      ),
    ).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(completion.checkpoint)).byteLength,
    ).toBeLessThan(65_536);
  });

  it("reconciles DRAFT only after this run checkpointed and attempted an ambiguous mutation", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const live = fakeRuntime(snapshots());
    const normalMutation = live.runtime.quarantineProductToDraft;
    let first = true;
    const runtime: LaraPriorityQuarantineRuntime = {
      ...live.runtime,
      async quarantineProductToDraft(productId) {
        const result = await normalMutation(productId);
        if (first) {
          first = false;
          throw new LaraPriorityQuarantineRuntimeError(
            "mutation_ambiguous",
            "response lost after Shopify committed",
            true,
          );
        }
        return result;
      },
    };

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime,
      now: () => new Date(AT),
    });

    expect(result.state).toBe("completed");
    expect(live.mutationInputs).toHaveLength(10);
    expect(JSON.stringify(runMocks.complete.mock.calls[0]![0].artifact.journal)).toContain(
      "operation.reconciled",
    );
  });

  it("rejects a pre-existing protected DRAFT before every mutation", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const liveStore = snapshots();
    const firstHandle = LARA_PRIORITY_PRODUCT_HANDLES[0];
    liveStore.set(firstHandle, {
      ...liveStore.get(firstHandle)!,
      status: "DRAFT",
      updatedAt: "2026-08-12T18:01:00.000Z",
    });
    const live = fakeRuntime(liveStore);

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: live.runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({ state: "failed", errorCode: "product_drift" });
    expect(live.mutationInputs).toEqual([]);
  });

  it("fails during whole-plan preflight before any mutation when a title drifts", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const drifted = snapshots();
    const lastHandle = LARA_PRIORITY_PRODUCT_HANDLES.at(-1)!;
    drifted.set(lastHandle, { ...drifted.get(lastHandle)!, title: "Concurrent edit" });
    const live = fakeRuntime(drifted);

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: live.runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({ state: "failed", errorCode: "product_drift" });
    expect(live.mutationInputs).toEqual([]);
    expect(runMocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "product_drift",
        checkpoint: expect.objectContaining({
          phase: "failed",
          approvedRepairPlan: expect.objectContaining({
            planId: "lara-priority-quarantine-active-to-draft-v1",
            digestSha256: plan.digestSha256,
            operations: expect.arrayContaining([
              expect.objectContaining({
                fromStatus: "ACTIVE",
                toStatus: "DRAFT",
                restoreStatus: "ACTIVE",
                protectedVendor: "Lara Rovinj",
              }),
            ]),
          }),
        }),
      }),
    );
    const failureCheckpoint = runMocks.fail.mock.calls[0]![0].checkpoint;
    expect(failureCheckpoint.approvedRepairPlan.operations).toHaveLength(10);
    expect(
      new TextEncoder().encode(JSON.stringify(failureCheckpoint)).byteLength,
    ).toBeLessThan(65_536);
  });

  it("resumes a durably prepared operation that is still exact ACTIVE", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const preparedCheckpoint = runMocks.renew.mock.calls
      .map(([input]) => input.checkpoint)
      .find(
        (checkpoint) =>
          checkpoint.nextOperationIndex === 0 &&
          checkpoint.journal.at(-1)?.event === "operation.prepared",
      );
    expect(preparedCheckpoint).toBeDefined();

    const resumed = fakeRuntime(snapshots());
    const resumedLease = "20000000-0000-4000-8000-000000000003";
    runMocks.claim.mockImplementationOnce(async () =>
      currentClaim(resumedLease, {
        checkpoint: preparedCheckpoint,
        attempt_count: 2,
        retry_count: 1,
        lease_generation: 2,
      }),
    );
    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: resumedLease,
      runtime: resumed.runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({ state: "completed", verifiedCount: 10 });
    expect(resumed.mutationInputs).toHaveLength(10);
  });

  it("reclaims after Shopify committed but the after-checkpoint was not written", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const live = fakeRuntime(snapshots());
    const normalRead = live.runtime.readPriorityProduct;
    const normalMutation = live.runtime.quarantineProductToDraft;
    let committed = false;
    let lostRead = false;
    const interruptedRuntime: LaraPriorityQuarantineRuntime = {
      ...live.runtime,
      async readPriorityProduct(handle) {
        if (committed && !lostRead) {
          lostRead = true;
          throw new LaraPriorityQuarantineRuntimeError(
            "shopify_unavailable",
            "readback response lost",
            true,
          );
        }
        return normalRead(handle);
      },
      async quarantineProductToDraft(productId) {
        const result = await normalMutation(productId);
        committed = true;
        return result;
      },
    };

    const firstResult = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: interruptedRuntime,
      now: () => new Date(AT),
    });
    expect(firstResult.state).toBe("in_progress");
    const queuedCheckpoint = runMocks.fail.mock.calls[0]![0].checkpoint;
    expect(queuedCheckpoint.journal.some(
      (entry: { event: string }) => entry.event === "operation.prepared",
    )).toBe(true);
    expect(queuedCheckpoint.journal.some(
      (entry: { event: string }) => entry.event === "operation.applied",
    )).toBe(false);

    const resumedLease = "20000000-0000-4000-8000-000000000004";
    const resolverRuntime = fakeRuntime(live.store).runtime;
    const resolverRead = vi.spyOn(resolverRuntime, "readPriorityProduct");
    runMocks.get.mockImplementationOnce(async () =>
      currentClaim(LEASE_TOKEN, {
        state: "queued",
        checkpoint: queuedCheckpoint,
      }),
    );
    const recoveredPlan = await resolveLaraPriorityQuarantinePlan({
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      runtime: resolverRuntime,
      now: () => new Date(AT),
    });
    expect(recoveredPlan.digestSha256).toBe(plan.digestSha256);
    expect(resolverRead).not.toHaveBeenCalled();

    runMocks.claim.mockImplementationOnce(async () =>
      currentClaim(resumedLease, {
        checkpoint: queuedCheckpoint,
        attempt_count: 2,
        retry_count: 1,
        lease_generation: 2,
      }),
    );
    const secondResult = await executeLaraPriorityQuarantine({
      sealedPlan: recoveredPlan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: resumedLease,
      runtime: live.runtime,
      now: () => new Date(AT),
    });

    expect(secondResult).toMatchObject({ state: "completed", verifiedCount: 10 });
    expect(live.mutationInputs).toHaveLength(10);
    expect(
      runMocks.complete.mock.calls.at(-1)![0].artifact.journal.some(
        (entry: { event: string; operationId: string | null }) =>
          entry.event === "operation.reconciled" &&
          entry.operationId === "quarantine-01",
      ),
    ).toBe(true);
  });

  it("rejects a tampered persisted checkpoint before reading or mutating Shopify", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const transient: LaraPriorityQuarantineRuntime = {
      ...fakeRuntime().runtime,
      async readPriorityProduct() {
        throw new LaraPriorityQuarantineRuntimeError(
          "shopify_unavailable",
          "temporary read outage",
          true,
        );
      },
    };
    await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: transient,
      now: () => new Date(AT),
    });
    const tampered = structuredClone(runMocks.fail.mock.calls[0]![0].checkpoint);
    tampered.planDigestSha256 = "f".repeat(64);

    const untouched = fakeRuntime(snapshots());
    const readSpy = vi.spyOn(untouched.runtime, "readPriorityProduct");
    const resumedLease = "20000000-0000-4000-8000-000000000005";
    runMocks.claim.mockImplementationOnce(async () =>
      currentClaim(resumedLease, {
        checkpoint: tampered,
        attempt_count: 2,
        retry_count: 1,
        lease_generation: 2,
      }),
    );
    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: resumedLease,
      runtime: untouched.runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({ state: "failed", errorCode: "invalid_checkpoint" });
    expect(readSpy).not.toHaveBeenCalled();
    expect(untouched.mutationInputs).toEqual([]);
  });

  it("treats mutation_rejected as terminal even if an unrelated DRAFT appears", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const store = snapshots();
    const base = fakeRuntime(store);
    const normalRead = base.runtime.readPriorityProduct;
    let rejected = false;
    let readsAfterRejection = 0;
    const runtime: LaraPriorityQuarantineRuntime = {
      ...base.runtime,
      async readPriorityProduct(handle) {
        if (rejected) readsAfterRejection += 1;
        return normalRead(handle);
      },
      async quarantineProductToDraft() {
        const handle = LARA_PRIORITY_PRODUCT_HANDLES[0];
        store.set(handle, {
          ...store.get(handle)!,
          status: "DRAFT",
          updatedAt: "2026-08-12T18:01:00.000Z",
        });
        rejected = true;
        throw new LaraPriorityQuarantineRuntimeError(
          "mutation_rejected",
          "definitive user error",
          false,
        );
      },
    };

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({ state: "failed", errorCode: "mutation_rejected" });
    expect(readsAfterRejection).toBe(0);
    const failure = runMocks.fail.mock.calls[0]![0];
    expect(failure.retryable).toBe(false);
    expect(JSON.stringify(failure.checkpoint.journal)).not.toContain(
      "operation.reconciled",
    );
    expect(
      failure.checkpoint.approvedRepairPlan.operations.every(
        (operation: { restoreStatus: string }) => operation.restoreStatus === "ACTIVE",
      ),
    ).toBe(true);
  });

  it("queues a transient read failure while retaining the sealed restore evidence", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const runtime: LaraPriorityQuarantineRuntime = {
      ...fakeRuntime().runtime,
      async readPriorityProduct() {
        throw new LaraPriorityQuarantineRuntimeError(
          "shopify_unavailable",
          "temporary read outage",
          true,
        );
      },
    };

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime,
      now: () => new Date(AT),
    });

    expect(result.state).toBe("in_progress");
    expect(runMocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true, errorCode: "shopify_unavailable" }),
    );
    const failureCheckpoint = runMocks.fail.mock.calls[0]![0].checkpoint;
    expect(failureCheckpoint.phase).toBe("applying");
    expect(failureCheckpoint.approvedRepairPlan.operations).toHaveLength(10);
    expect(
      new TextEncoder().encode(JSON.stringify(failureCheckpoint)).byteLength,
    ).toBeLessThan(65_536);
  });

  it("queues a transient checkpoint database failure before any mutation", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const live = fakeRuntime(snapshots());
    runMocks.renew.mockRejectedValueOnce(
      new AuditShopifyRunError("claim_failed", "temporary checkpoint outage"),
    );

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: live.runtime,
      now: () => new Date(AT),
    });

    expect(result.state).toBe("in_progress");
    expect(live.mutationInputs).toEqual([]);
    expect(runMocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true, errorCode: "claim_failed" }),
    );
  });

  it("becomes terminal when a transient failure exhausts the bounded retry budget", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    runMocks.claim.mockImplementationOnce(async () =>
      currentClaim(LEASE_TOKEN, {
        attempt_count: 4,
        retry_count: 3,
        lease_generation: 4,
      }),
    );
    const runtime: LaraPriorityQuarantineRuntime = {
      ...fakeRuntime().runtime,
      async readPriorityProduct() {
        throw new LaraPriorityQuarantineRuntimeError(
          "shopify_unavailable",
          "persistent outage",
          true,
        );
      },
    };

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "shopify_unavailable",
    });
    expect(runMocks.fail.mock.calls[0]![0].checkpoint.phase).toBe("failed");
  });

  it("rejects an unverified mutation response before its readback can be attributed", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const base = fakeRuntime(snapshots());
    const normalRead = base.runtime.readPriorityProduct;
    let mutationReturned = false;
    let readsAfterMutation = 0;
    const runtime: LaraPriorityQuarantineRuntime = {
      ...base.runtime,
      async readPriorityProduct(handle) {
        if (mutationReturned) readsAfterMutation += 1;
        return normalRead(handle);
      },
      async quarantineProductToDraft(productId) {
        mutationReturned = true;
        const current = await normalRead(LARA_PRIORITY_PRODUCT_HANDLES[0]);
        return { ...current, id: productId, status: "ACTIVE" };
      },
    };

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "product_not_verified",
    });
    expect(readsAfterMutation).toBe(0);
  });

  it("returns completed and in-progress durable replays without a Shopify mutation", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    const noClaim = new AuditShopifyRunError("run_not_found", "already owned");
    runMocks.claim.mockRejectedValue(noClaim);
    runMocks.get.mockImplementationOnce(async () =>
      currentClaim(LEASE_TOKEN, {
        state: "completed",
        artifact: {
          schemaVersion: "lara-priority-quarantine.v1",
          status: "verified",
          runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
          planId: "lara-priority-quarantine-active-to-draft-v1",
          planDigestSha256: plan.digestSha256,
          verifiedCount: 10,
          protectedVendor: "Lara Rovinj",
        },
      }),
    );
    const runtime = fakeRuntime();
    const completed = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: runtime.runtime,
      now: () => new Date(AT),
    });
    expect(completed).toMatchObject({ state: "completed", verifiedCount: 10 });

    runMocks.get.mockImplementationOnce(async () =>
      currentClaim(LEASE_TOKEN, { state: "queued" }),
    );
    const inProgress = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: runtime.runtime,
      now: () => new Date(AT),
    });
    expect(inProgress.state).toBe("in_progress");
    expect(runtime.mutationInputs).toEqual([]);
  });

  it("reconciles a lost completion response from the durable completed row", async () => {
    const plan = await buildLaraPriorityQuarantinePlan({
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });
    let durableCompleted: ReturnType<typeof claimedRun> | null = null;
    runMocks.complete.mockImplementationOnce(async ({ run, checkpoint, artifact }) => {
      durableCompleted = claimedRun({
        ...run,
        state: "completed",
        checkpoint,
        artifact,
      });
      throw new AuditShopifyRunError("complete_failed", "response lost");
    });
    runMocks.fail.mockRejectedValueOnce(
      new AuditShopifyRunError("fail_failed", "row already completed"),
    );
    runMocks.get.mockImplementationOnce(async () => durableCompleted);

    const result = await executeLaraPriorityQuarantine({
      sealedPlan: plan,
      requestedBy: ADMIN_ID,
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      leaseToken: LEASE_TOKEN,
      runtime: fakeRuntime().runtime,
      now: () => new Date(AT),
    });

    expect(result).toMatchObject({ state: "completed", verifiedCount: 10 });
  });
});
