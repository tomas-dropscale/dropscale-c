import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  LARA_PRICING_BLAST_RADIUS,
  LARA_PRICING_CATALOG_BULK_QUERY,
  LARA_PRICING_CLEAR_COMPARE_AT_MUTATION,
  LARA_PRICING_REFERENCE_COUNTS,
  LaraPricingSalePlanError,
  loadLaraPricingPersistedRoot,
  loadLaraPricingProductArtifact,
  parseLaraPricingCatalogueBulkResult,
  persistLaraPricingSalePlan,
  prepareLaraPricingSalePlan,
  type LaraPricingBulkOperationEvidence,
  type LaraPricingImmutableArtifactStore,
} from "./lara-pricing-sale-plan";
import {
  canonicalRemediationJson,
  remediationSha256,
} from "./shopify-remediation-plan";

const CAPTURED_AT = "2026-08-12T19:00:00.000Z";
const PLAN_AT = "2026-08-12T19:05:00.000Z";
const RUN_ID = "70000000-0000-4000-8000-000000000007";

type ProductFixture = {
  id: string;
  handle: string;
  title: string;
  vendor: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
  publishedAt: string | null;
  updatedAt: string;
  variants: Array<{
    id: string;
    title: string;
    price: string;
    compareAtPrice: string | null;
    updatedAt: string;
  }>;
};

function productFixture(
  productId: number,
  variantPrices: Array<{ price: string; compareAtPrice: string | null }>,
  status: ProductFixture["status"] = "ACTIVE",
): ProductFixture {
  return {
    id: `gid://shopify/Product/${productId}`,
    handle: `product-${productId}`,
    title: `Product ${productId}`,
    vendor: "Lara Rovinj",
    status,
    publishedAt: status === "ACTIVE" ? "2026-08-10T10:00:00.000Z" : null,
    updatedAt: "2026-08-11T10:00:00.000Z",
    variants: variantPrices.map((prices, index) => ({
      id: `gid://shopify/ProductVariant/${productId * 1_000 + index + 1}`,
      title: `Variant ${index + 1}`,
      ...prices,
      updatedAt: "2026-08-11T10:00:00.000Z",
    })),
  };
}

function jsonlFor(products: ProductFixture[]) {
  const lines: string[] = [];
  for (const product of products) {
    const { variants, ...productRow } = product;
    lines.push(JSON.stringify(productRow));
    for (const variant of variants) {
      lines.push(JSON.stringify({ ...variant, __parentId: product.id }));
    }
  }
  return `${lines.join("\n")}\n`;
}

function evidence(
  jsonl: string,
  products: ProductFixture[],
  operationId = "gid://shopify/BulkOperation/1001",
): LaraPricingBulkOperationEvidence {
  return {
    operationId,
    status: "COMPLETED",
    completedAt: "2026-08-12T18:59:00.000Z",
    rootObjectCount: products.length,
    objectCount:
      products.length +
      products.reduce((count, product) => count + product.variants.length, 0),
    fileSize: new TextEncoder().encode(jsonl).byteLength,
  };
}

async function catalogueFor(products: ProductFixture[]) {
  const jsonl = jsonlFor(products);
  return parseLaraPricingCatalogueBulkResult({
    chunks: [jsonl.slice(0, 17), jsonl.slice(17, 61), jsonl.slice(61)],
    operation: evidence(jsonl, products),
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
      if (values.has(key) && JSON.stringify(values.get(key)) !== JSON.stringify(value)) {
        throw new Error("immutable collision");
      }
      values.set(key, structuredClone(value));
    }),
    getImmutableJson: vi.fn(async (key) => structuredClone(values.get(key))),
  };
}

describe("Lara unsupported sale-price plan", () => {
  it("builds exact all-status evidence from an ungrouped Admin Bulk Query", async () => {
    const products = [
      productFixture(1, [
        { price: "49.95", compareAtPrice: "99.90" },
        { price: "39.95", compareAtPrice: null },
      ]),
      productFixture(2, [{ price: "20.00", compareAtPrice: "40.00" }], "DRAFT"),
      productFixture(3, [{ price: "30.00", compareAtPrice: null }], "ARCHIVED"),
      productFixture(4, [{ price: "40.00", compareAtPrice: "80.00" }], "UNLISTED"),
    ];
    const catalogue = await catalogueFor(products);

    expect(catalogue.counts).toEqual({
      products: 4,
      variants: 5,
      productsWithCompareAt: 3,
      variantsWithCompareAt: 3,
    });
    expect(catalogue.bulk.rootObjectCount).toBe(4);
    expect(catalogue.bulk.objectCount).toBe(9);
    expect(catalogue.bulk.observedFileBytes).toBe(catalogue.bulk.fileSize);
    expect(catalogue.products.map((product) => product.status)).toEqual([
      "ACTIVE",
      "DRAFT",
      "ARCHIVED",
      "UNLISTED",
    ]);
    expect(catalogue.bulk.querySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(catalogue.products)).toBe(true);
    expect(LARA_PRICING_REFERENCE_COUNTS.variants).toBe(38_069);
    expect(LARA_PRICING_REFERENCE_COUNTS.qualification).toMatch(/Reference only/);
    expect(LARA_PRICING_CATALOG_BULK_QUERY).toContain("products");
    expect(LARA_PRICING_CATALOG_BULK_QUERY).toContain("variants");
  });

  it("plans only compare-at nulling and preserves every selling price", async () => {
    const catalogue = await catalogueFor([
      productFixture(1, [
        { price: "49.95", compareAtPrice: "99.90" },
        { price: "39.95", compareAtPrice: null },
      ]),
    ]);
    const plan = await prepareLaraPricingSalePlan({ catalogue, createdAt: PLAN_AT });

    expect(plan.executionMode).toBe("dry-run");
    expect(plan.counts.mutationVariants).toBe(1);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].change).toEqual({
      allowPartialUpdates: false,
      variants: [
        expect.objectContaining({
          id: "gid://shopify/ProductVariant/1001",
          expectedPrice: "49.95",
          expectedCompareAtPrice: "99.90",
          compareAtPrice: null,
        }),
      ],
    });
    expect(plan.operations[0].sourceProduct.variants[1].price).toBe("39.95");
    expect(plan.operations[0].inverse).toEqual({
      purpose: "recovery_only_do_not_automatically_restore_unsupported_sale_claims",
      variants: [
        { id: "gid://shopify/ProductVariant/1001", compareAtPrice: "99.90" },
      ],
    });
    expect(plan.vendorPolicy.mutationsAllowed).toBe(false);
    expect(LARA_PRICING_CLEAR_COMPARE_AT_MUTATION).toContain(
      "allowPartialUpdates: false",
    );
    expect(LARA_PRICING_CLEAR_COMPARE_AT_MUTATION).not.toMatch(/\$price|vendor/iu);
  });

  it("fails closed above the per-product atomic mutation boundary", async () => {
    const variants = Array.from({ length: 251 }, (_, index) => ({
      price: `${index + 1}.00`,
      compareAtPrice: `${index + 2}.00`,
    }));
    await expect(catalogueFor([productFixture(1, variants)])).rejects.toMatchObject({
      code: "BLAST_RADIUS_EXCEEDED",
    });
    expect(LARA_PRICING_BLAST_RADIUS.maxAffectedVariantsPerProduct).toBe(250);
  });

  it("rejects incomplete files and completed-operation count mismatches", async () => {
    const products = [productFixture(1, [{ price: "10.00", compareAtPrice: null }])];
    const jsonl = jsonlFor(products);
    await expect(
      parseLaraPricingCatalogueBulkResult({
        chunks: [jsonl],
        operation: { ...evidence(jsonl, products), objectCount: 999 },
        capturedAt: CAPTURED_AT,
      }),
    ).rejects.toBeInstanceOf(LaraPricingSalePlanError);
    await expect(
      parseLaraPricingCatalogueBulkResult({
        chunks: [jsonl],
        operation: { ...evidence(jsonl, products), status: "RUNNING" },
        capturedAt: CAPTURED_AT,
      }),
    ).rejects.toMatchObject({ code: "BULK_NOT_COMPLETED" });
  });

  it("bounds a single unterminated JSONL line while chunks are still arriving", async () => {
    const oversizedChunks = (async function* () {
      for (let index = 0; index < 9; index += 1) {
        yield "x".repeat(64 * 1024);
      }
    })();
    await expect(
      parseLaraPricingCatalogueBulkResult({
        chunks: oversizedChunks,
        operation: {
          operationId: "gid://shopify/BulkOperation/1002",
          status: "COMPLETED",
          completedAt: "2026-08-12T18:59:00.000Z",
          rootObjectCount: 1,
          objectCount: 1,
          fileSize: 9 * 64 * 1024,
        },
        capturedAt: CAPTURED_AT,
      }),
    ).rejects.toMatchObject({ code: "BULK_RESULT_TOO_LARGE" });
  });

  it("partitions the full before/inverse material into immutable service artifacts", async () => {
    const catalogue = await catalogueFor([
      productFixture(1, [{ price: "49.95", compareAtPrice: "99.90" }]),
      productFixture(2, [{ price: "20.00", compareAtPrice: null }], "ARCHIVED"),
    ]);
    const plan = await prepareLaraPricingSalePlan({ catalogue, createdAt: PLAN_AT });
    const store = memoryStore();
    const persisted = await persistLaraPricingSalePlan({ plan, store, runId: RUN_ID });

    expect(persisted.root.productPartitions).toHaveLength(2);
    expect(persisted.root.operations).toHaveLength(1);
    expect(persisted.root.operations[0].affectedVariants).toBe(1);
    expect(persisted.rootRef.byteLength).toBeLessThan(
      LARA_PRICING_BLAST_RADIUS.maxRootArtifactBytes,
    );
    expect(store.values.size).toBe(3);
    await expect(
      loadLaraPricingPersistedRoot({ store, ref: persisted.rootRef }),
    ).resolves.toEqual(persisted.root);

    const tampered = structuredClone(store.values.get(persisted.rootRef.key)) as {
      counts: { mutationVariants: number };
    };
    tampered.counts.mutationVariants = 999;
    store.values.set(persisted.rootRef.key, tampered);
    await expect(
      loadLaraPricingPersistedRoot({ store, ref: persisted.rootRef }),
    ).rejects.toMatchObject({ code: "ARTIFACT_MISMATCH" });
  });

  it("rejects self-consistent forged roots and mutation partitions, not only broken hashes", async () => {
    const catalogue = await catalogueFor([
      productFixture(1, [{ price: "49.95", compareAtPrice: "99.90" }]),
    ]);
    const plan = await prepareLaraPricingSalePlan({ catalogue, createdAt: PLAN_AT });
    const store = memoryStore();
    const persisted = await persistLaraPricingSalePlan({ plan, store, runId: RUN_ID });

    const forgedRoot = structuredClone(persisted.root) as unknown as Record<
      string,
      unknown
    >;
    forgedRoot.unreviewed = true;
    const rootPayload = Object.fromEntries(
      Object.entries(forgedRoot).filter(([key]) => key !== "digestSha256"),
    );
    forgedRoot.digestSha256 = await remediationSha256(rootPayload);
    const forgedRootRef = {
      key: persisted.rootRef.key,
      digestSha256: await remediationSha256(forgedRoot),
      byteLength: new TextEncoder().encode(canonicalRemediationJson(forgedRoot))
        .byteLength,
    };
    store.values.set(persisted.rootRef.key, forgedRoot);
    await expect(
      loadLaraPricingPersistedRoot({ store, ref: forgedRootRef }),
    ).rejects.toMatchObject({ code: "INVALID_PLAN" });

    const partitionRef = persisted.root.productPartitions[0].ref;
    const forgedPartition = structuredClone(
      store.values.get(partitionRef.key),
    ) as unknown as {
      operation: {
        change: { variants: Array<Record<string, unknown>> };
        digestSha256: string;
        [key: string]: unknown;
      };
    };
    forgedPartition.operation.change.variants[0].price = "0.01";
    const operationPayload = Object.fromEntries(
      Object.entries(forgedPartition.operation).filter(
        ([key]) => key !== "digestSha256",
      ),
    );
    forgedPartition.operation.digestSha256 = await remediationSha256(
      operationPayload,
    );
    const forgedPartitionRef = {
      key: partitionRef.key,
      digestSha256: await remediationSha256(forgedPartition),
      byteLength: new TextEncoder().encode(
        canonicalRemediationJson(forgedPartition),
      ).byteLength,
    };
    store.values.set(partitionRef.key, forgedPartition);
    await expect(
      loadLaraPricingProductArtifact({
        store,
        ref: forgedPartitionRef,
        expectedCatalogueDigest: persisted.root.sourceCatalogueDigestSha256,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PLAN" });
  });
});
