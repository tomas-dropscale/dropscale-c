import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  completeLaraPricingSaleVerification,
  executeLaraPricingSaleSlice,
  initialLaraPricingExecutionCheckpoint,
  LaraPricingMutationDefinitiveError,
  LaraPricingMutationAmbiguousError,
  verifyLaraPricingSaleRepair,
  type LaraPricingDurableCoordinator,
  type LaraPricingExecutionCheckpoint,
  type LaraPricingJournalEvent,
  type LaraPricingRepairRuntime,
} from "./lara-pricing-sale-executor";
import {
  parseLaraPricingCatalogueBulkResult,
  persistLaraPricingSalePlan,
  prepareLaraPricingSalePlan,
  type LaraPricingBulkOperationEvidence,
  type LaraPricingImmutableArtifactStore,
  type LaraPricingProductSnapshot,
} from "./lara-pricing-sale-plan";

const RUN_ID = "70000000-0000-4000-8000-000000000007";
const FENCE = "fence-1";
const CAPTURED_AT = "2026-08-12T19:00:00.000Z";
const PLAN_AT = "2026-08-12T19:05:00.000Z";

function product(
  productId: number,
  status: LaraPricingProductSnapshot["status"] = "ACTIVE",
): LaraPricingProductSnapshot {
  return {
    id: `gid://shopify/Product/${productId}`,
    handle: `product-${productId}`,
    title: `Product ${productId}`,
    vendor: "Lara Rovinj",
    status,
    publishedAt: status === "ACTIVE" ? "2026-08-10T10:00:00.000Z" : null,
    updatedAt: "2026-08-11T10:00:00.000Z",
    variants: [
      {
        id: `gid://shopify/ProductVariant/${productId * 1_000 + 1}`,
        title: "Default Title",
        price: productId === 1 ? "49.95" : "20.00",
        compareAtPrice: productId === 1 ? "99.90" : "40.00",
        updatedAt: "2026-08-11T10:00:00.000Z",
      },
    ],
  };
}

function jsonlFor(products: readonly LaraPricingProductSnapshot[]) {
  const lines: string[] = [];
  for (const item of products) {
    const { variants, ...productRow } = item;
    lines.push(JSON.stringify(productRow));
    for (const variant of variants) {
      lines.push(JSON.stringify({ ...variant, __parentId: item.id }));
    }
  }
  return `${lines.join("\n")}\n`;
}

function evidence(
  jsonl: string,
  products: readonly LaraPricingProductSnapshot[],
  operationId: string,
): LaraPricingBulkOperationEvidence {
  return {
    operationId,
    status: "COMPLETED",
    completedAt: "2026-08-12T18:59:00.000Z",
    rootObjectCount: products.length,
    objectCount:
      products.length +
      products.reduce((count, item) => count + item.variants.length, 0),
    fileSize: new TextEncoder().encode(jsonl).byteLength,
  };
}

async function catalogue(
  products: readonly LaraPricingProductSnapshot[],
  operationId = "gid://shopify/BulkOperation/2001",
) {
  const jsonl = jsonlFor(products);
  return parseLaraPricingCatalogueBulkResult({
    chunks: [jsonl],
    operation: evidence(jsonl, products, operationId),
    capturedAt: CAPTURED_AT,
  });
}

function memoryStore(): LaraPricingImmutableArtifactStore & {
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

function memoryCoordinator(initial: LaraPricingExecutionCheckpoint) {
  let revision = 1;
  let checkpoint = structuredClone(initial);
  const events: LaraPricingJournalEvent[] = [];
  const coordinator: LaraPricingDurableCoordinator = {
    load: vi.fn(async ({ runId, fence }) => {
      expect(runId).toBe(RUN_ID);
      expect(fence).toBe(FENCE);
      return { revision, checkpoint: structuredClone(checkpoint) };
    }),
    transition: vi.fn(async (input) => {
      expect(input.runId).toBe(RUN_ID);
      expect(input.fence).toBe(FENCE);
      if (input.expectedRevision !== revision) throw new Error("stale revision");
      revision += 1;
      checkpoint = structuredClone(input.checkpoint);
      events.push(structuredClone(input.event));
      return { revision };
    }),
  };
  return {
    coordinator,
    events,
    checkpoint: () => structuredClone(checkpoint),
  };
}

function memoryRuntime(
  source: readonly LaraPricingProductSnapshot[],
  options: { applyThenThrowOnce?: boolean } = {},
) {
  const states = new Map(
    source.map((item) => [item.id, structuredClone(item)]),
  );
  let didThrow = false;
  const clearCompareAtPricesAtomic = vi.fn(
    async ({
      productId,
      variantIds,
      allowPartialUpdates,
    }: Parameters<LaraPricingRepairRuntime["clearCompareAtPricesAtomic"]>[0]) => {
      expect(allowPartialUpdates).toBe(false);
      const current = states.get(productId);
      if (!current) throw new Error("missing product");
      const targetIds = new Set(variantIds);
      const after: LaraPricingProductSnapshot = {
        ...structuredClone(current),
        updatedAt: "2026-08-12T20:00:00.000Z",
        variants: current.variants.map((variant) =>
          targetIds.has(variant.id)
            ? {
                ...structuredClone(variant),
                compareAtPrice: null,
                updatedAt: "2026-08-12T20:00:00.000Z",
              }
            : structuredClone(variant),
        ),
      };
      states.set(productId, after);
      if (options.applyThenThrowOnce && !didThrow) {
        didThrow = true;
        throw new LaraPricingMutationAmbiguousError(
          "lost response after Shopify accepted the mutation",
        );
      }
    },
  );
  const runtime: LaraPricingRepairRuntime = {
    readFullProduct: vi.fn(async (productId) => {
      const current = states.get(productId);
      if (!current) throw new Error("missing product");
      return structuredClone(current);
    }),
    clearCompareAtPricesAtomic,
  };
  return { runtime, states, clearCompareAtPricesAtomic };
}

async function preparedFixture(
  products: readonly LaraPricingProductSnapshot[] = [product(1), product(2, "DRAFT")],
) {
  const sourceCatalogue = await catalogue(products);
  const plan = await prepareLaraPricingSalePlan({
    catalogue: sourceCatalogue,
    createdAt: PLAN_AT,
  });
  const store = memoryStore();
  const persisted = await persistLaraPricingSalePlan({ plan, store, runId: RUN_ID });
  const initial = initialLaraPricingExecutionCheckpoint({
    runId: RUN_ID,
    rootRef: persisted.rootRef,
    root: persisted.root,
    approvedPlanDigestSha256: persisted.root.digestSha256,
  });
  return { products, sourceCatalogue, plan, store, persisted, initial };
}

describe("bounded Lara sale-price execution", () => {
  it("writes one atomic product at a time, preserves selling prices and pauses for fresh proof", async () => {
    const fixture = await preparedFixture();
    const durable = memoryCoordinator(fixture.initial);
    const live = memoryRuntime(fixture.products);

    const result = await executeLaraPricingSaleSlice({
      runId: RUN_ID,
      fence: FENCE,
      approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
      store: fixture.store,
      coordinator: durable.coordinator,
      runtime: live.runtime,
    });

    expect(result.phase).toBe("verification_pending");
    expect(result.mutationsAttempted).toBe(2);
    expect(result.checkpoint.appliedProducts).toBe(2);
    expect(result.checkpoint.appliedVariants).toBe(2);
    expect(result.checkpoint.nextOperationIndex).toBe(2);
    expect(live.clearCompareAtPricesAtomic).toHaveBeenCalledTimes(2);
    expect(live.clearCompareAtPricesAtomic.mock.calls[0]?.[0]).toEqual({
      productId: "gid://shopify/Product/1",
      variantIds: ["gid://shopify/ProductVariant/1001"],
      allowPartialUpdates: false,
    });
    expect(live.states.get("gid://shopify/Product/1")?.variants[0]).toEqual(
      expect.objectContaining({ price: "49.95", compareAtPrice: null }),
    );
    expect(live.states.get("gid://shopify/Product/2")?.variants[0]).toEqual(
      expect.objectContaining({ price: "20.00", compareAtPrice: null }),
    );
    expect(durable.events.map((event) => event.event)).toEqual([
      "run.ready",
      "operation.prepared",
      "operation.applied",
      "operation.prepared",
      "operation.applied",
      "run.verification_pending",
    ]);
    expect(new TextEncoder().encode(JSON.stringify(result.checkpoint)).byteLength).toBeLessThan(
      8 * 1024,
    );
  });

  it("reconciles a lost response without issuing a duplicate mutation", async () => {
    const fixture = await preparedFixture([product(1)]);
    const durable = memoryCoordinator(fixture.initial);
    const live = memoryRuntime(fixture.products, { applyThenThrowOnce: true });

    const first = await executeLaraPricingSaleSlice({
      runId: RUN_ID,
      fence: FENCE,
      approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
      store: fixture.store,
      coordinator: durable.coordinator,
      runtime: live.runtime,
    });
    expect(first.phase).toBe("reconciling");
    expect(first.checkpoint.nextOperationIndex).toBe(0);

    const resumed = await executeLaraPricingSaleSlice({
      runId: RUN_ID,
      fence: FENCE,
      approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
      store: fixture.store,
      coordinator: durable.coordinator,
      runtime: live.runtime,
    });
    expect(resumed.phase).toBe("verification_pending");
    expect(resumed.checkpoint.appliedProducts).toBe(1);
    expect(live.clearCompareAtPricesAtomic).toHaveBeenCalledTimes(1);
    expect(durable.events.map((event) => event.event)).toContain(
      "operation.reconciled",
    );
  });

  it("reconciles consecutive externally compliant products with exact counters", async () => {
    const fixture = await preparedFixture();
    const durable = memoryCoordinator(fixture.initial);
    const live = memoryRuntime(fixture.products);
    for (const [productId, current] of live.states) {
      live.states.set(productId, {
        ...current,
        variants: current.variants.map((variant) => ({
          ...variant,
          compareAtPrice: null,
        })),
      });
    }

    const result = await executeLaraPricingSaleSlice({
      runId: RUN_ID,
      fence: FENCE,
      approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
      store: fixture.store,
      coordinator: durable.coordinator,
      runtime: live.runtime,
    });

    expect(result.phase).toBe("verification_pending");
    expect(result.checkpoint.appliedProducts).toBe(0);
    expect(result.checkpoint.appliedVariants).toBe(0);
    expect(result.checkpoint.externallyCompliantProducts).toBe(2);
    expect(result.checkpoint.externallyCompliantVariants).toBe(2);
    expect(live.clearCompareAtPricesAtomic).not.toHaveBeenCalled();
  });

  it("never converts a definite or arbitrary mutation failure into reconciliation", async () => {
    const fixture = await preparedFixture([product(1)]);
    const durable = memoryCoordinator(fixture.initial);
    const live = memoryRuntime(fixture.products);
    live.clearCompareAtPricesAtomic.mockRejectedValueOnce(
      new TypeError("definite adapter failure"),
    );

    await expect(
      executeLaraPricingSaleSlice({
        runId: RUN_ID,
        fence: FENCE,
        approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
        store: fixture.store,
        coordinator: durable.coordinator,
        runtime: live.runtime,
      }),
    ).rejects.toThrow("definite adapter failure");

    expect(durable.checkpoint()).toEqual(
      expect.objectContaining({
        phase: "reconciling",
        nextOperationIndex: 0,
        attemptsForCurrentOperation: 1,
      }),
    );
    expect(durable.events.map((event) => event.event)).toEqual([
      "run.ready",
      "operation.prepared",
    ]);
  });

  it("durably leaves reconciliation before surfacing a typed definitive rejection", async () => {
    const fixture = await preparedFixture([product(1)]);
    const durable = memoryCoordinator(fixture.initial);
    const live = memoryRuntime(fixture.products);
    live.clearCompareAtPricesAtomic.mockRejectedValueOnce(
      new LaraPricingMutationDefinitiveError("definite rejection", true),
    );

    await expect(
      executeLaraPricingSaleSlice({
        runId: RUN_ID,
        fence: FENCE,
        approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
        store: fixture.store,
        coordinator: durable.coordinator,
        runtime: live.runtime,
      }),
    ).rejects.toMatchObject({
      code: "mutation_rejected",
      retryable: true,
    });
    expect(durable.checkpoint()).toEqual(
      expect.objectContaining({
        phase: "applying",
        nextOperationIndex: 0,
        currentOperationIndex: null,
        attemptsForCurrentOperation: 0,
      }),
    );
    expect(durable.events.map((event) => event.event)).toEqual([
      "run.ready",
      "operation.prepared",
      "operation.rejected",
    ]);
  });

  it("blocks before writing when a protected selling price drifts", async () => {
    const fixture = await preparedFixture([product(1)]);
    const durable = memoryCoordinator(fixture.initial);
    const live = memoryRuntime(fixture.products);
    const changed = live.states.get("gid://shopify/Product/1");
    if (!changed) throw new TypeError("missing fixture");
    changed.variants[0].price = "59.95";

    const result = await executeLaraPricingSaleSlice({
      runId: RUN_ID,
      fence: FENCE,
      approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
      store: fixture.store,
      coordinator: durable.coordinator,
      runtime: live.runtime,
    });
    expect(result.phase).toBe("blocked");
    expect(result.checkpoint.blockedCode).toBe("PRODUCT_OR_PRICE_CAS_DRIFT");
    expect(live.clearCompareAtPricesAtomic).not.toHaveBeenCalled();
  });

  it("allows inventory-only timestamp drift while every protected value remains exact", async () => {
    const fixture = await preparedFixture([product(1)]);
    const durable = memoryCoordinator(fixture.initial);
    const live = memoryRuntime(fixture.products);
    const current = live.states.get("gid://shopify/Product/1");
    if (!current) throw new TypeError("missing fixture");
    current.updatedAt = "2026-08-12T19:59:00.000Z";
    current.variants[0].updatedAt = "2026-08-12T19:59:00.000Z";

    const result = await executeLaraPricingSaleSlice({
      runId: RUN_ID,
      fence: FENCE,
      approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
      store: fixture.store,
      coordinator: durable.coordinator,
      runtime: live.runtime,
    });
    expect(result.phase).toBe("verification_pending");
    expect(live.clearCompareAtPricesAtomic).toHaveBeenCalledTimes(1);
    expect(live.states.get("gid://shopify/Product/1")?.variants[0]).toEqual(
      expect.objectContaining({ price: "49.95", compareAtPrice: null }),
    );
  });

  it("rejects a structurally valid checkpoint that skips immutable root work", async () => {
    const fixture = await preparedFixture();
    const skipped: LaraPricingExecutionCheckpoint = {
      ...fixture.initial,
      phase: "applying",
      nextOperationIndex: 1,
      appliedProducts: 0,
      appliedVariants: 0,
    };
    const durable = memoryCoordinator(skipped);
    const live = memoryRuntime(fixture.products);

    await expect(
      executeLaraPricingSaleSlice({
        runId: RUN_ID,
        fence: FENCE,
        approvedPlanDigestSha256: fixture.persisted.root.digestSha256,
        store: fixture.store,
        coordinator: durable.coordinator,
        runtime: live.runtime,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CHECKPOINT" });
    expect(live.runtime.readFullProduct).not.toHaveBeenCalled();
    expect(live.clearCompareAtPricesAtomic).not.toHaveBeenCalled();
  });

  it("requires a fresh full-catalogue Bulk Query with zero compare-at values in every status", async () => {
    const fixture = await preparedFixture();
    const stillOnSale = await catalogue(
      fixture.products,
      "gid://shopify/BulkOperation/2002",
    );
    const blocked = await verifyLaraPricingSaleRepair({
      root: fixture.persisted.root,
      store: fixture.store,
      freshCatalogue: stillOnSale,
    });
    expect(blocked).toEqual(
      expect.objectContaining({
        status: "blocked",
        nonNullCompareAtVariants: 2,
        blockedCode: "COMPARE_AT_REMAINS",
      }),
    );

    const repairedProducts = fixture.products.map((item) => ({
      ...structuredClone(item),
      updatedAt: "2026-08-12T20:00:00.000Z",
      variants: item.variants.map((variant) => ({
        ...structuredClone(variant),
        compareAtPrice: null,
        updatedAt: "2026-08-12T20:00:00.000Z",
      })),
    }));
    const repairedCatalogue = await catalogue(
      repairedProducts,
      "gid://shopify/BulkOperation/2003",
    );
    const verified = await verifyLaraPricingSaleRepair({
      root: fixture.persisted.root,
      store: fixture.store,
      freshCatalogue: repairedCatalogue,
    });
    expect(verified).toEqual(
      expect.objectContaining({
        status: "verified",
        nonNullCompareAtVariants: 0,
        sellingPriceDriftVariants: 0,
        vendorDriftProducts: 0,
        statusDriftProducts: 0,
        publicationDriftProducts: 0,
        blockedCode: null,
      }),
    );

    const protectedFieldDrift = structuredClone(repairedProducts);
    protectedFieldDrift[0].vendor = "Unexpected vendor";
    protectedFieldDrift[1].status = "ARCHIVED";
    protectedFieldDrift[1].publishedAt = "2026-08-12T21:00:00.000Z";
    const driftCatalogue = await catalogue(
      protectedFieldDrift,
      "gid://shopify/BulkOperation/2004",
    );
    await expect(
      verifyLaraPricingSaleRepair({
        root: fixture.persisted.root,
        store: fixture.store,
        freshCatalogue: driftCatalogue,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "blocked",
        vendorDriftProducts: 1,
        statusDriftProducts: 1,
        publicationDriftProducts: 1,
        blockedCode: "VENDOR_DRIFT",
      }),
    );

    const durable = memoryCoordinator({
      ...fixture.initial,
      phase: "verification_pending",
      nextOperationIndex: fixture.persisted.root.operations.length,
    });
    const completed = await completeLaraPricingSaleVerification({
      runId: RUN_ID,
      fence: FENCE,
      coordinator: durable.coordinator,
      verification: verified,
    });
    expect(completed.phase).toBe("verified");
    expect(completed.freshVerificationDigestSha256).toBe(
      repairedCatalogue.digestSha256,
    );
  });
});
