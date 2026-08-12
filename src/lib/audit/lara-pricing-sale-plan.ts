import "server-only";

import { z } from "zod";

import {
  LARA_ROVINJ_REMEDIATION_SHOP,
  canonicalRemediationJson,
  freezeRemediationValue,
  remediationSha256,
  type DeepReadonly,
} from "./shopify-remediation-plan";

/**
 * Immutable catalogue evidence and repair plan for unsupported sale pricing.
 *
 * The catalogue read is intentionally a Shopify Bulk Query. Lara has more
 * than 25,000 variants, which is beyond Shopify's ordinary connection
 * pagination ceiling. The write side is deliberately different: one direct,
 * atomic `productVariantsBulkUpdate` per product gives us a useful CAS and a
 * deterministic reconciliation boundary that a fire-and-forget bulk mutation
 * would not provide.
 */

export const LARA_PRICING_SALE_SCHEMA_VERSION =
  "lara-pricing-sale-repair.v1" as const;
export const LARA_PRICING_SALE_PLAN_ID =
  "lara-remove-unsupported-compare-at-v1" as const;
export const LARA_PRICING_API_VERSION = "2026-07" as const;

export const LARA_PRICING_REFERENCE_COUNTS = Object.freeze({
  observedAt: "2026-08-12",
  products: 1_449,
  variants: 38_069,
  qualification:
    "Reference only. Every repair plan must be rebuilt from a fresh completed Shopify Admin Bulk Query.",
} as const);

export const LARA_PRICING_BLAST_RADIUS = Object.freeze({
  maxProducts: 2_000,
  maxVariants: 50_000,
  maxAffectedVariants: 50_000,
  maxAffectedVariantsPerProduct: 250,
  // Cloudflare Workers have a 128 MB isolate ceiling. Retaining the parsed
  // catalogue plus the bounded plan needs substantial headroom beyond the raw
  // UTF-8 stream, so fail closed before a source result reaches 16 MiB.
  maxJsonlBytes: 16 * 1024 * 1024,
  maxJsonlLineBytes: 512 * 1024,
  maxProductArtifactBytes: 2 * 1024 * 1024,
  maxRootArtifactBytes: 4 * 1024 * 1024,
} as const);

export const LARA_PRICING_VENDOR_POLICY = Object.freeze({
  decision: "merchant_accepted_non_issue",
  mutationsAllowed: false,
  note: "Vendor/brand is outside this repair and is absent from every mutation input.",
} as const);

export const LARA_PRICING_LEGAL_BASIS = Object.freeze({
  disposition: "remove_compare_at_until_prior_price_is_proven",
  sellingPricePolicy: "preserve_exactly",
  scope: "all_product_statuses_including_draft_archived_and_unlisted",
  evidence: [
    "Directive 98/6/EC Article 6a: a reduction announcement uses the lowest prior price in at least the preceding 30 days.",
    "Croatia NN 59/2026 amended consumer-price rules for special forms of sale and the prior 30-day price.",
    "No product-level lowest-prior-price evidence was supplied for Lara's catalogue-wide sale presentation.",
  ],
} as const);

/** Query submitted inside `bulkOperationRunQuery`, not a normal paginated query. */
export const LARA_PRICING_CATALOG_BULK_QUERY = `#graphql
  {
    products {
      edges {
        node {
          id
          handle
          title
          vendor
          status
          publishedAt
          updatedAt
          variants {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                updatedAt
              }
            }
          }
        }
      }
    }
  }
`;

/** Fixed launch document; the bulk query is server-owned and has no query variable. */
export const LARA_PRICING_START_BULK_QUERY_MUTATION = `#graphql
  mutation LaraStartPricingCatalogueBulkQuery {
    bulkOperationRunQuery(
      groupObjects: false
      query: """
${LARA_PRICING_CATALOG_BULK_QUERY.replace(/^#graphql\s*/u, "")}
      """
    ) {
      bulkOperation {
        id type status errorCode createdAt completedAt
        rootObjectCount objectCount fileSize query url partialDataUrl
      }
      userErrors { code field message }
    }
  }
`;

/** Poll only the operation id returned by the fixed launch document. */
export const LARA_PRICING_BULK_OPERATION_QUERY = `#graphql
  query LaraPricingCatalogueBulkStatus($id: ID!) {
    bulkOperation(id: $id) {
      id
      type
      status
      errorCode
      createdAt
      completedAt
      rootObjectCount
      objectCount
      fileSize
      query
      url
      partialDataUrl
    }
  }
`;

/** Fixed direct read used for a per-product CAS immediately before a write. */
export const LARA_PRICING_PRODUCT_READ_QUERY = `#graphql
  query LaraPricingProduct($id: ID!, $after: String) {
    product(id: $id) {
      id
      handle
      title
      vendor
      status
      publishedAt
      updatedAt
      variants(first: 250, after: $after) {
        nodes { id title price compareAtPrice updatedAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/**
 * Fixed writer document. `allowPartialUpdates: false` makes each product the
 * atomic boundary. A connected adapter must construct each variant input as
 * exactly `{ id, compareAtPrice: null }`; price and vendor are not variables.
 */
export const LARA_PRICING_CLEAR_COMPARE_AT_MUTATION = `#graphql
  mutation LaraClearUnsupportedCompareAt(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(
      productId: $productId
      variants: $variants
      allowPartialUpdates: false
    ) {
      product { id updatedAt }
      productVariants { id price compareAtPrice updatedAt }
      userErrors { code field message }
    }
  }
`;

export const LARA_PRICING_GRAPHQL_MANIFEST = Object.freeze({
  bulkCatalogue: LARA_PRICING_CATALOG_BULK_QUERY,
  startBulkCatalogue: LARA_PRICING_START_BULK_QUERY_MUTATION,
  pollBulkCatalogue: LARA_PRICING_BULK_OPERATION_QUERY,
  productCas: LARA_PRICING_PRODUCT_READ_QUERY,
  clearCompareAt: LARA_PRICING_CLEAR_COMPARE_AT_MUTATION,
});

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
const BULK_OPERATION_GID = /^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/;
// Shopify documents product handles as lowercase letters, numbers and
// hyphens. `\p{L}`/`\p{N}` is intentional: valid Admin handles are not
// restricted to ASCII, and the fixed reader must preserve them as evidence.
const HANDLE = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_KEY = /^[a-z0-9][a-z0-9/_.-]{2,499}$/;
const ROOT_ARTIFACT_KEY =
  /^lara-pricing\/lara-pricing-sale-repair\.v1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/root\.json$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MONEY = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

const timestampSchema = z.string().datetime({ offset: true });
const moneySchema = z.string().regex(MONEY).max(100);
const handleSchema = z
  .string()
  .max(255)
  .regex(HANDLE)
  .refine((value) => value === value.toLowerCase());

const variantSnapshotSchema = z
  .object({
    id: z.string().regex(VARIANT_GID),
    title: z.string().max(500),
    price: moneySchema,
    compareAtPrice: moneySchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict();

const productSnapshotSchema = z
  .object({
    id: z.string().regex(PRODUCT_GID),
    handle: handleSchema,
    title: z.string().max(500),
    vendor: z.string().max(255),
    status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"]),
    publishedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema,
    variants: z.array(variantSnapshotSchema).min(1).max(2_048),
  })
  .strict();

const bulkEvidenceSchema = z
  .object({
    operationId: z.string().regex(BULK_OPERATION_GID),
    status: z.literal("COMPLETED"),
    completedAt: timestampSchema,
    rootObjectCount: z.number().int().nonnegative(),
    objectCount: z.number().int().nonnegative(),
    fileSize: z.number().int().nonnegative(),
    observedFileBytes: z.number().int().nonnegative(),
    querySha256: z.string().regex(SHA256),
  })
  .strict();

const catalogueSnapshotSchema = z
  .object({
    schemaVersion: z.literal(LARA_PRICING_SALE_SCHEMA_VERSION),
    shop: z
      .object({
        domain: z.literal(LARA_ROVINJ_REMEDIATION_SHOP.domain),
        shopId: z.literal(LARA_ROVINJ_REMEDIATION_SHOP.shopId),
      })
      .strict(),
    capturedAt: timestampSchema,
    bulk: bulkEvidenceSchema,
    counts: z
      .object({
        products: z.number().int().positive(),
        variants: z.number().int().positive(),
        productsWithCompareAt: z.number().int().nonnegative(),
        variantsWithCompareAt: z.number().int().nonnegative(),
      })
      .strict(),
    productDigestsSha256: z.array(z.string().regex(SHA256)).min(1),
    products: z.array(productSnapshotSchema).min(1),
    digestSha256: z.string().regex(SHA256),
  })
  .strict();

// Module-private provenance for snapshots that were fully parsed, counted,
// hashed and deep-frozen here. Re-validating those exact identities with Zod
// would clone the entire 38k-variant catalogue again inside a Worker isolate.
const trustedCatalogueSnapshots = new WeakSet<object>();

export type LaraPricingVariantSnapshot = z.output<typeof variantSnapshotSchema>;
export type LaraPricingProductSnapshot = z.output<typeof productSnapshotSchema>;
export type LaraPricingCatalogueSnapshot = DeepReadonly<
  z.output<typeof catalogueSnapshotSchema>
>;

export type LaraPricingBulkOperationEvidence = Readonly<{
  operationId: string;
  status: string;
  completedAt: string | null;
  rootObjectCount: string | number;
  objectCount: string | number;
  fileSize: string | number;
}>;

type MutableProduct = Omit<LaraPricingProductSnapshot, "variants"> & {
  variants: LaraPricingVariantSnapshot[];
};

const bulkProductLineSchema = z
  .object({
    id: z.string().regex(PRODUCT_GID),
    handle: handleSchema,
    title: z.string().max(500),
    vendor: z.string().max(255),
    status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"]),
    publishedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict();

const bulkVariantLineSchema = variantSnapshotSchema
  .extend({ __parentId: z.string().regex(PRODUCT_GID) })
  .strict();

export class LaraPricingSalePlanError extends Error {
  constructor(
    public readonly code:
      | "BULK_NOT_COMPLETED"
      | "BULK_METADATA_INVALID"
      | "BULK_STREAM_INVALID"
      | "BULK_JSONL_INVALID"
      | "BULK_PRODUCT_ROW_INVALID"
      | "BULK_VARIANT_ROW_INVALID"
      | "BULK_ROW_SHAPE_INVALID"
      | "BULK_CATALOGUE_INCOMPLETE"
      | "BULK_RESULT_TOO_LARGE"
      | "COUNT_MISMATCH"
      | "DUPLICATE_RESOURCE"
      | "ORPHAN_VARIANT"
      | "BLAST_RADIUS_EXCEEDED"
      | "INVALID_CATALOGUE"
      | "INVALID_PLAN"
      | "PLAN_DIGEST_MISMATCH"
      | "ARTIFACT_TOO_LARGE"
      | "ARTIFACT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "LaraPricingSalePlanError";
  }
}

function parseUnsignedInteger(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBulkEvidence(
  input: LaraPricingBulkOperationEvidence,
  observedFileBytes: number,
  querySha256: string,
) {
  const rootObjectCount = parseUnsignedInteger(input.rootObjectCount);
  const objectCount = parseUnsignedInteger(input.objectCount);
  const fileSize = parseUnsignedInteger(input.fileSize);
  if (input.status !== "COMPLETED") {
    throw new LaraPricingSalePlanError(
      "BULK_NOT_COMPLETED",
      "The pricing catalogue can only be built from a completed Admin Bulk Query.",
    );
  }
  if (
    !BULK_OPERATION_GID.test(input.operationId) ||
    typeof input.completedAt !== "string" ||
    !timestampSchema.safeParse(input.completedAt).success ||
    rootObjectCount === null ||
    objectCount === null ||
    fileSize === null
  ) {
    throw new LaraPricingSalePlanError(
      "BULK_METADATA_INVALID",
      "Shopify returned invalid pricing Bulk Query metadata.",
    );
  }
  if (fileSize !== observedFileBytes) {
    throw new LaraPricingSalePlanError(
      "COUNT_MISMATCH",
      "The downloaded JSONL byte count does not match the completed Bulk Query.",
    );
  }
  return {
    operationId: input.operationId,
    status: "COMPLETED" as const,
    completedAt: input.completedAt,
    rootObjectCount,
    objectCount,
    fileSize,
    observedFileBytes,
    querySha256,
  };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function omitCanonicalKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key)),
  );
}

async function* jsonlLines(
  chunks: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<{ line: string; bytes: number }, void, void> {
  let buffer = "";
  let totalBytes = 0;
  for await (const chunk of chunks) {
    if (typeof chunk !== "string") {
      throw new LaraPricingSalePlanError(
        "BULK_STREAM_INVALID",
        "The pricing Bulk Query stream did not contain text chunks.",
      );
    }
    totalBytes += utf8Length(chunk);
    if (totalBytes > LARA_PRICING_BLAST_RADIUS.maxJsonlBytes) {
      throw new LaraPricingSalePlanError(
        "BULK_RESULT_TOO_LARGE",
        "The pricing Bulk Query result exceeded the fixed byte limit.",
      );
    }
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const rawLine = buffer.slice(0, newline);
      let line = rawLine;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const bytes = utf8Length(rawLine) + 1;
      if (bytes > LARA_PRICING_BLAST_RADIUS.maxJsonlLineBytes) {
        throw new LaraPricingSalePlanError(
          "BULK_RESULT_TOO_LARGE",
          "A pricing Bulk Query JSONL line exceeded the fixed byte limit.",
        );
      }
      yield { line, bytes };
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (utf8Length(buffer) > LARA_PRICING_BLAST_RADIUS.maxJsonlLineBytes) {
      throw new LaraPricingSalePlanError(
        "BULK_RESULT_TOO_LARGE",
        "A pricing Bulk Query JSONL line exceeded the fixed byte limit.",
      );
    }
  }
  if (buffer.length > 0) {
    const bytes = utf8Length(buffer);
    if (bytes > LARA_PRICING_BLAST_RADIUS.maxJsonlLineBytes) {
      throw new LaraPricingSalePlanError(
        "BULK_RESULT_TOO_LARGE",
        "A pricing Bulk Query JSONL line exceeded the fixed byte limit.",
      );
    }
    if (buffer.trim()) yield { line: buffer, bytes };
  }
}

function sortGids(left: string, right: string): number {
  const leftId = BigInt(left.slice(left.lastIndexOf("/") + 1));
  const rightId = BigInt(right.slice(right.lastIndexOf("/") + 1));
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function stableProductState(product: DeepReadonly<LaraPricingProductSnapshot>) {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    vendor: product.vendor,
    status: product.status,
    publishedAt: product.publishedAt,
    updatedAt: product.updatedAt,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      title: variant.title,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      updatedAt: variant.updatedAt,
    })),
  };
}

export async function laraPricingProductStateSha256(
  product: DeepReadonly<LaraPricingProductSnapshot>,
): Promise<string> {
  return remediationSha256(stableProductState(product));
}

/**
 * Parse the ungrouped JSONL result of the fixed Bulk Query and prove that the
 * file, Shopify object counts and locally parsed counts all agree.
 */
export async function parseLaraPricingCatalogueBulkResult({
  chunks,
  operation,
  capturedAt,
}: {
  chunks: AsyncIterable<string> | Iterable<string>;
  operation: LaraPricingBulkOperationEvidence;
  capturedAt: string;
}): Promise<LaraPricingCatalogueSnapshot> {
  if (!timestampSchema.safeParse(capturedAt).success) {
    throw new LaraPricingSalePlanError(
      "BULK_METADATA_INVALID",
      "The pricing catalogue capture timestamp is invalid.",
    );
  }

  const byId = new Map<string, MutableProduct>();
  // `groupObjects: false` deliberately removes Shopify's parent/child
  // grouping guarantee. Keep children keyed by their explicit `__parentId`
  // and reconcile them only after the whole bounded result has been parsed.
  const variantsByParentId = new Map<string, LaraPricingVariantSnapshot[]>();
  const variantIds = new Set<string>();
  let observedFileBytes = 0;
  let parsedObjectCount = 0;

  for await (const item of jsonlLines(chunks)) {
    observedFileBytes += item.bytes;
    if (!item.line.trim()) continue;
    parsedObjectCount += 1;
    let value: unknown;
    try {
      value = JSON.parse(item.line);
    } catch {
      throw new LaraPricingSalePlanError(
        "BULK_JSONL_INVALID",
        "The pricing Bulk Query returned invalid JSONL.",
      );
    }

    const record = value as Record<string, unknown> | null;
    if (record && typeof record.id === "string" && PRODUCT_GID.test(record.id)) {
      const parsed = bulkProductLineSchema.safeParse(value);
      if (!parsed.success) {
        throw new LaraPricingSalePlanError(
          "BULK_PRODUCT_ROW_INVALID",
          "The pricing Bulk Query returned an invalid product row.",
        );
      }
      if (byId.has(parsed.data.id)) {
        throw new LaraPricingSalePlanError(
          "DUPLICATE_RESOURCE",
          "The pricing Bulk Query returned a duplicate product.",
        );
      }
      byId.set(parsed.data.id, { ...parsed.data, variants: [] });
      continue;
    }

    if (record && typeof record.id === "string" && VARIANT_GID.test(record.id)) {
      const parsed = bulkVariantLineSchema.safeParse(value);
      if (!parsed.success) {
        throw new LaraPricingSalePlanError(
          "BULK_VARIANT_ROW_INVALID",
          "The pricing Bulk Query returned an invalid variant row.",
        );
      }
      if (variantIds.has(parsed.data.id)) {
        throw new LaraPricingSalePlanError(
          "DUPLICATE_RESOURCE",
          "The pricing Bulk Query returned a duplicate variant.",
        );
      }
      variantIds.add(parsed.data.id);
      const variant: LaraPricingVariantSnapshot = {
        id: parsed.data.id,
        title: parsed.data.title,
        price: parsed.data.price,
        compareAtPrice: parsed.data.compareAtPrice,
        updatedAt: parsed.data.updatedAt,
      };
      const siblings = variantsByParentId.get(parsed.data.__parentId);
      if (siblings) siblings.push(variant);
      else variantsByParentId.set(parsed.data.__parentId, [variant]);
      continue;
    }

    throw new LaraPricingSalePlanError(
      "BULK_ROW_SHAPE_INVALID",
      "The pricing Bulk Query returned a row outside the fixed product/variant shape.",
    );
  }

  const querySha256 = await remediationSha256(LARA_PRICING_CATALOG_BULK_QUERY);
  const bulk = parseBulkEvidence(operation, observedFileBytes, querySha256);
  for (const [parentId, variants] of variantsByParentId) {
    const parent = byId.get(parentId);
    if (!parent) {
      throw new LaraPricingSalePlanError(
        "ORPHAN_VARIANT",
        "The pricing Bulk Query returned a variant without its product parent.",
      );
    }
    parent.variants.push(...variants);
  }
  const products = [...byId.values()]
    .map((product) => ({
      ...product,
      variants: [...product.variants].sort((left, right) => sortGids(left.id, right.id)),
    }))
    .sort((left, right) => sortGids(left.id, right.id));

  if (
    products.length === 0 ||
    products.some(
      (product) =>
        product.variants.length === 0 || product.variants.length > 2_048,
    )
  ) {
    throw new LaraPricingSalePlanError(
      "BULK_CATALOGUE_INCOMPLETE",
      "The pricing Bulk Query did not contain a complete product catalogue.",
    );
  }
  if (
    products.length !== bulk.rootObjectCount ||
    products.length + variantIds.size !== bulk.objectCount ||
    parsedObjectCount !== bulk.objectCount
  ) {
    throw new LaraPricingSalePlanError(
      "COUNT_MISMATCH",
      "The parsed catalogue does not match Shopify's completed Bulk Query counts.",
    );
  }
  if (
    products.length > LARA_PRICING_BLAST_RADIUS.maxProducts ||
    variantIds.size > LARA_PRICING_BLAST_RADIUS.maxVariants
  ) {
    throw new LaraPricingSalePlanError(
      "BLAST_RADIUS_EXCEEDED",
      "The fresh Lara catalogue exceeded the fixed repair blast radius.",
    );
  }

  const productsWithCompareAt = products.filter((product) =>
    product.variants.some((variant) => variant.compareAtPrice !== null),
  ).length;
  const variantsWithCompareAt = products.reduce(
    (count, product) =>
      count + product.variants.filter((variant) => variant.compareAtPrice !== null).length,
    0,
  );
  if (variantsWithCompareAt > LARA_PRICING_BLAST_RADIUS.maxAffectedVariants) {
    throw new LaraPricingSalePlanError(
      "BLAST_RADIUS_EXCEEDED",
      "The compare-at target count exceeded the fixed repair blast radius.",
    );
  }
  for (const product of products) {
    const affected = product.variants.filter(
      (variant) => variant.compareAtPrice !== null,
    ).length;
    if (affected > LARA_PRICING_BLAST_RADIUS.maxAffectedVariantsPerProduct) {
      throw new LaraPricingSalePlanError(
        "BLAST_RADIUS_EXCEEDED",
        `Product ${product.id} has more than 250 compare-at variants; it cannot be changed atomically by this plan.`,
      );
    }
  }

  // Keep peak isolate pressure bounded. Lara's catalogue has thousands of
  // products; launching one WebCrypto job per product at once needlessly
  // retains every canonical byte buffer until the whole Promise fan-out
  // settles.
  const productDigestsSha256: string[] = [];
  for (const product of products) {
    productDigestsSha256.push(await laraPricingProductStateSha256(product));
  }
  const payload = {
    schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    capturedAt,
    bulk,
    counts: {
      products: products.length,
      variants: variantIds.size,
      productsWithCompareAt,
      variantsWithCompareAt,
    },
    productDigestsSha256,
    products,
  };
  const catalogueMetadata = omitCanonicalKeys(payload, ["products"]);
  const digestSha256 = await remediationSha256({
    ...catalogueMetadata,
    catalogueOrder: products.map((product, index) => ({
      productId: product.id,
      digestSha256: productDigestsSha256[index],
    })),
  });
  // Every JSONL row was already strict-parsed, all cross-row counts/digests
  // were reconciled above and each scalar produced here is fixed or validated.
  // Avoid a second full-catalogue Zod clone at the Worker memory boundary.
  const catalogue = freezeRemediationValue({
    ...payload,
    digestSha256,
  }) as LaraPricingCatalogueSnapshot;
  trustedCatalogueSnapshots.add(catalogue as object);
  return catalogue;
}

/** Re-validate every partition digest and count before a snapshot is trusted. */
export async function verifyLaraPricingCatalogueSnapshot(
  input: unknown,
): Promise<LaraPricingCatalogueSnapshot> {
  if (
    input !== null &&
    typeof input === "object" &&
    trustedCatalogueSnapshots.has(input)
  ) {
    return input as LaraPricingCatalogueSnapshot;
  }
  const parsed = catalogueSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new LaraPricingSalePlanError(
      "INVALID_CATALOGUE",
      "The pricing catalogue snapshot is invalid.",
    );
  }
  const catalogue = parsed.data;
  const productIds = new Set<string>();
  const variantIds = new Set<string>();
  let productsWithCompareAt = 0;
  let variantsWithCompareAt = 0;
  const actualProductDigests: string[] = [];
  for (const product of catalogue.products) {
    if (productIds.has(product.id)) {
      throw new LaraPricingSalePlanError(
        "DUPLICATE_RESOURCE",
        "The pricing catalogue snapshot contains a duplicate product.",
      );
    }
    productIds.add(product.id);
    let productHasCompareAt = false;
    for (const variant of product.variants) {
      if (variantIds.has(variant.id)) {
        throw new LaraPricingSalePlanError(
          "DUPLICATE_RESOURCE",
          "The pricing catalogue snapshot contains a duplicate variant.",
        );
      }
      variantIds.add(variant.id);
      if (variant.compareAtPrice !== null) {
        productHasCompareAt = true;
        variantsWithCompareAt += 1;
      }
    }
    if (productHasCompareAt) productsWithCompareAt += 1;
    actualProductDigests.push(await laraPricingProductStateSha256(product));
  }
  if (
    actualProductDigests.length !== catalogue.productDigestsSha256.length ||
    actualProductDigests.some(
      (digest, index) => digest !== catalogue.productDigestsSha256[index],
    ) ||
    catalogue.counts.products !== productIds.size ||
    catalogue.counts.variants !== variantIds.size ||
    catalogue.counts.productsWithCompareAt !== productsWithCompareAt ||
    catalogue.counts.variantsWithCompareAt !== variantsWithCompareAt ||
    catalogue.bulk.rootObjectCount !== productIds.size ||
    catalogue.bulk.objectCount !== productIds.size + variantIds.size
  ) {
    throw new LaraPricingSalePlanError(
      "COUNT_MISMATCH",
      "The pricing catalogue counts or product digests no longer match.",
    );
  }
  const catalogueMetadata = omitCanonicalKeys(catalogue, [
    "products",
    "digestSha256",
  ]);
  const expectedDigest = await remediationSha256({
    ...catalogueMetadata,
    catalogueOrder: catalogue.products.map((product, index) => ({
      productId: product.id,
      digestSha256: catalogue.productDigestsSha256[index],
    })),
  });
  if (expectedDigest !== catalogue.digestSha256) {
    throw new LaraPricingSalePlanError(
      "PLAN_DIGEST_MISMATCH",
      "The immutable pricing catalogue digest does not match its contents.",
    );
  }
  const trusted = freezeRemediationValue(catalogue);
  trustedCatalogueSnapshots.add(trusted as object);
  return trusted;
}

export type LaraPricingVariantChange = DeepReadonly<{
  id: string;
  expectedTitle: string;
  expectedUpdatedAt: string;
  expectedPrice: string;
  expectedCompareAtPrice: string;
  compareAtPrice: null;
}>;

export type LaraPricingProductOperation = DeepReadonly<{
  schemaVersion: typeof LARA_PRICING_SALE_SCHEMA_VERSION;
  operationId: string;
  kind: "product_variants.clear_compare_at";
  target: {
    productId: string;
    handle: string;
  };
  sourceProduct: LaraPricingProductSnapshot;
  cas: {
    beforeStateSha256: string;
    expectedProductUpdatedAt: string;
  };
  change: {
    allowPartialUpdates: false;
    variants: LaraPricingVariantChange[];
  };
  inverse: {
    purpose: "recovery_only_do_not_automatically_restore_unsupported_sale_claims";
    variants: Array<{ id: string; compareAtPrice: string }>;
  };
  protectedPolicy: {
    sellingPrice: "must_remain_exact";
    productStatus: "must_remain_exact";
    publication: "must_remain_exact";
    vendorMutationAllowed: false;
  };
  digestSha256: string;
}>;

export type LaraPricingPreparedPlan = DeepReadonly<{
  schemaVersion: typeof LARA_PRICING_SALE_SCHEMA_VERSION;
  planId: typeof LARA_PRICING_SALE_PLAN_ID;
  createdAt: string;
  executionMode: "dry-run";
  shop: typeof LARA_ROVINJ_REMEDIATION_SHOP;
  sourceCatalogueDigestSha256: string;
  sourceBulkOperationId: string;
  legalBasis: typeof LARA_PRICING_LEGAL_BASIS;
  vendorPolicy: typeof LARA_PRICING_VENDOR_POLICY;
  counts: LaraPricingCatalogueSnapshot["counts"] & {
    operationProducts: number;
    mutationVariants: number;
  };
  catalogue: LaraPricingCatalogueSnapshot;
  operations: LaraPricingProductOperation[];
  digestSha256: string;
}>;

async function buildProductOperation(
  product: DeepReadonly<LaraPricingProductSnapshot>,
  ordinal: number,
): Promise<LaraPricingProductOperation | null> {
  const affected = product.variants.filter(
    (variant) => variant.compareAtPrice !== null,
  );
  if (affected.length === 0) return null;
  if (affected.length > LARA_PRICING_BLAST_RADIUS.maxAffectedVariantsPerProduct) {
    throw new LaraPricingSalePlanError(
      "BLAST_RADIUS_EXCEEDED",
      "A product repair would exceed Shopify's fixed 250-item input limit.",
    );
  }
  const operationId = `pricing-${String(ordinal + 1).padStart(4, "0")}`;
  const payload = {
    schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    operationId,
    kind: "product_variants.clear_compare_at" as const,
    target: { productId: product.id, handle: product.handle },
    sourceProduct: product,
    cas: {
      beforeStateSha256: await laraPricingProductStateSha256(product),
      expectedProductUpdatedAt: product.updatedAt,
    },
    change: {
      allowPartialUpdates: false as const,
      variants: affected.map((variant) => ({
        id: variant.id,
        expectedTitle: variant.title,
        expectedUpdatedAt: variant.updatedAt,
        expectedPrice: variant.price,
        expectedCompareAtPrice: variant.compareAtPrice as string,
        compareAtPrice: null,
      })),
    },
    inverse: {
      purpose:
        "recovery_only_do_not_automatically_restore_unsupported_sale_claims" as const,
      variants: affected.map((variant) => ({
        id: variant.id,
        compareAtPrice: variant.compareAtPrice as string,
      })),
    },
    protectedPolicy: {
      sellingPrice: "must_remain_exact" as const,
      productStatus: "must_remain_exact" as const,
      publication: "must_remain_exact" as const,
      vendorMutationAllowed: false as const,
    },
  };
  return freezeRemediationValue({
    ...payload,
    digestSha256: await remediationSha256(payload),
  });
}

export async function prepareLaraPricingSalePlan({
  catalogue,
  createdAt,
}: {
  catalogue: LaraPricingCatalogueSnapshot;
  createdAt: string;
}): Promise<LaraPricingPreparedPlan> {
  if (!timestampSchema.safeParse(createdAt).success) {
    throw new LaraPricingSalePlanError("INVALID_PLAN", "The plan timestamp is invalid.");
  }
  const verifiedCatalogue = await verifyLaraPricingCatalogueSnapshot(catalogue);

  const operations: LaraPricingProductOperation[] = [];
  for (const [ordinal, product] of verifiedCatalogue.products.entries()) {
    const operation = await buildProductOperation(product, ordinal);
    if (operation) operations.push(operation);
  }
  const mutationVariants = operations.reduce(
    (count, operation) => count + operation.change.variants.length,
    0,
  );
  if (mutationVariants !== verifiedCatalogue.counts.variantsWithCompareAt) {
    throw new LaraPricingSalePlanError(
      "COUNT_MISMATCH",
      "The pricing plan did not account for every non-null compare-at price.",
    );
  }

  const payload = {
    schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    planId: LARA_PRICING_SALE_PLAN_ID,
    createdAt,
    executionMode: "dry-run" as const,
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    sourceCatalogueDigestSha256: verifiedCatalogue.digestSha256,
    sourceBulkOperationId: verifiedCatalogue.bulk.operationId,
    legalBasis: LARA_PRICING_LEGAL_BASIS,
    vendorPolicy: LARA_PRICING_VENDOR_POLICY,
    counts: {
      ...verifiedCatalogue.counts,
      operationProducts: operations.length,
      mutationVariants,
    },
    catalogue: verifiedCatalogue,
    operations,
  };
  const digestSha256 = await remediationSha256({
    ...payload,
    catalogue: {
      digestSha256: verifiedCatalogue.digestSha256,
      counts: verifiedCatalogue.counts,
      bulkOperationId: verifiedCatalogue.bulk.operationId,
    },
    operations: operations.map((operation) => ({
      operationId: operation.operationId,
      productId: operation.target.productId,
      digestSha256: operation.digestSha256,
    })),
  });
  return freezeRemediationValue({ ...payload, digestSha256 });
}

export type LaraPricingImmutableArtifactRef = DeepReadonly<{
  key: string;
  digestSha256: string;
  byteLength: number;
}>;

export type LaraPricingProductArtifact = DeepReadonly<{
  schemaVersion: typeof LARA_PRICING_SALE_SCHEMA_VERSION;
  kind: "catalogue_product_partition";
  ordinal: number;
  sourceCatalogueDigestSha256: string;
  productDigestSha256: string;
  product: LaraPricingProductSnapshot;
  operation: LaraPricingProductOperation | null;
}>;

export type LaraPricingPersistedPlanRoot = DeepReadonly<{
  schemaVersion: typeof LARA_PRICING_SALE_SCHEMA_VERSION;
  kind: "persisted_plan_root";
  planId: typeof LARA_PRICING_SALE_PLAN_ID;
  createdAt: string;
  executionMode: "dry-run";
  shop: typeof LARA_ROVINJ_REMEDIATION_SHOP;
  sourceCatalogueDigestSha256: string;
  sourceBulkOperationId: string;
  legalBasis: typeof LARA_PRICING_LEGAL_BASIS;
  vendorPolicy: typeof LARA_PRICING_VENDOR_POLICY;
  counts: LaraPricingPreparedPlan["counts"];
  productPartitions: Array<{
    ordinal: number;
    productId: string;
    productDigestSha256: string;
    affectedVariants: number;
    ref: LaraPricingImmutableArtifactRef;
  }>;
  operations: Array<{
    operationIndex: number;
    operationId: string;
    productOrdinal: number;
    productId: string;
    operationDigestSha256: string;
    affectedVariants: number;
    partitionRef: LaraPricingImmutableArtifactRef;
  }>;
  preparedPlanDigestSha256: string;
  digestSha256: string;
}>;

export type LaraPricingImmutableArtifactStore = Readonly<{
  /** Service-only, create-if-absent. Reusing a key is allowed only for identical bytes. */
  putImmutableJson(input: {
    key: string;
    value: unknown;
    digestSha256: string;
    byteLength: number;
  }): Promise<void>;
  /** Service-only read; no public or signed browser URL may be returned. */
  getImmutableJson(key: string): Promise<unknown>;
}>;

function safeArtifactKey(value: string): string {
  const normalized = value.toLowerCase();
  if (!ARTIFACT_KEY.test(normalized) || normalized.includes("..")) {
    throw new LaraPricingSalePlanError(
      "INVALID_PLAN",
      "The immutable pricing artifact key is invalid.",
    );
  }
  return normalized;
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function validArtifactRef(
  value: unknown,
  expectedKey: string,
  maxBytes: number,
): value is LaraPricingImmutableArtifactRef {
  const item = value as LaraPricingImmutableArtifactRef | null;
  return Boolean(
    hasExactKeys(item, ["key", "digestSha256", "byteLength"]) &&
      item?.key === expectedKey &&
      SHA256.test(item.digestSha256) &&
      Number.isSafeInteger(item.byteLength) &&
      item.byteLength > 0 &&
      item.byteLength <= maxBytes,
  );
}

function safeCount(value: unknown, maximum: number, positive = false): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) >= (positive ? 1 : 0) &&
    Number(value) <= maximum;
}

function assertPersistedRootStructure(
  root: LaraPricingPersistedPlanRoot,
  ref: LaraPricingImmutableArtifactRef,
): void {
  const counts = root?.counts;
  const rootPrefix = ROOT_ARTIFACT_KEY.test(ref.key)
    ? ref.key.slice(0, -"root.json".length)
    : "";
  if (
    !hasExactKeys(root, [
      "schemaVersion",
      "kind",
      "planId",
      "createdAt",
      "executionMode",
      "shop",
      "sourceCatalogueDigestSha256",
      "sourceBulkOperationId",
      "legalBasis",
      "vendorPolicy",
      "counts",
      "productPartitions",
      "operations",
      "preparedPlanDigestSha256",
      "digestSha256",
    ]) ||
    !hasExactKeys(root.shop, ["domain", "shopId"]) ||
    !hasExactKeys(counts, [
      "products",
      "variants",
      "productsWithCompareAt",
      "variantsWithCompareAt",
      "operationProducts",
      "mutationVariants",
    ]) ||
    root.schemaVersion !== LARA_PRICING_SALE_SCHEMA_VERSION ||
    root.kind !== "persisted_plan_root" ||
    root.planId !== LARA_PRICING_SALE_PLAN_ID ||
    root.executionMode !== "dry-run" ||
    root.shop?.domain !== LARA_ROVINJ_REMEDIATION_SHOP.domain ||
    root.shop?.shopId !== LARA_ROVINJ_REMEDIATION_SHOP.shopId ||
    !timestampSchema.safeParse(root.createdAt).success ||
    !SHA256.test(root.sourceCatalogueDigestSha256) ||
    !BULK_OPERATION_GID.test(root.sourceBulkOperationId) ||
    canonicalRemediationJson(root.legalBasis) !==
      canonicalRemediationJson(LARA_PRICING_LEGAL_BASIS) ||
    canonicalRemediationJson(root.vendorPolicy) !==
      canonicalRemediationJson(LARA_PRICING_VENDOR_POLICY) ||
    !safeCount(counts?.products, LARA_PRICING_BLAST_RADIUS.maxProducts, true) ||
    !safeCount(counts?.variants, LARA_PRICING_BLAST_RADIUS.maxVariants, true) ||
    !safeCount(counts?.productsWithCompareAt, counts.products) ||
    !safeCount(counts?.variantsWithCompareAt, counts.variants) ||
    !safeCount(counts?.operationProducts, counts.products) ||
    !safeCount(counts?.mutationVariants, counts.variants) ||
    counts.operationProducts !== counts.productsWithCompareAt ||
    counts.mutationVariants !== counts.variantsWithCompareAt ||
    !Array.isArray(root.productPartitions) ||
    root.productPartitions.length !== counts.products ||
    !Array.isArray(root.operations) ||
    root.operations.length !== counts.operationProducts ||
    !SHA256.test(root.preparedPlanDigestSha256) ||
    !SHA256.test(root.digestSha256) ||
    !rootPrefix
  ) {
    throw new LaraPricingSalePlanError(
      "INVALID_PLAN",
      "The immutable pricing root structure is invalid.",
    );
  }

  const productIds = new Set<string>();
  let affectedVariants = 0;
  for (const [ordinal, partition] of root.productPartitions.entries()) {
    const key = `${rootPrefix}products/${String(ordinal).padStart(4, "0")}.json`;
    if (
      !hasExactKeys(partition, [
        "ordinal",
        "productId",
        "productDigestSha256",
        "affectedVariants",
        "ref",
      ]) ||
      partition.ordinal !== ordinal ||
      !PRODUCT_GID.test(partition.productId) ||
      productIds.has(partition.productId) ||
      !SHA256.test(partition.productDigestSha256) ||
      !safeCount(
        partition.affectedVariants,
        LARA_PRICING_BLAST_RADIUS.maxAffectedVariantsPerProduct,
      ) ||
      !validArtifactRef(
        partition.ref,
        key,
        LARA_PRICING_BLAST_RADIUS.maxProductArtifactBytes,
      )
    ) {
      throw new LaraPricingSalePlanError(
        "INVALID_PLAN",
        "An immutable pricing root partition is invalid.",
      );
    }
    productIds.add(partition.productId);
    affectedVariants += partition.affectedVariants;
  }

  const operatedOrdinals = new Set<number>();
  for (const [operationIndex, operation] of root.operations.entries()) {
    const partition = root.productPartitions[operation.productOrdinal];
    if (
      !hasExactKeys(operation, [
        "operationIndex",
        "operationId",
        "productOrdinal",
        "productId",
        "operationDigestSha256",
        "affectedVariants",
        "partitionRef",
      ]) ||
      operation.operationIndex !== operationIndex ||
      operation.operationId !==
        `pricing-${String(operation.productOrdinal + 1).padStart(4, "0")}` ||
      !safeCount(operation.productOrdinal, counts.products - 1) ||
      operatedOrdinals.has(operation.productOrdinal) ||
      !partition ||
      partition.productId !== operation.productId ||
      partition.affectedVariants !== operation.affectedVariants ||
      operation.affectedVariants < 1 ||
      !SHA256.test(operation.operationDigestSha256) ||
      canonicalRemediationJson(operation.partitionRef) !==
        canonicalRemediationJson(partition.ref)
    ) {
      throw new LaraPricingSalePlanError(
        "INVALID_PLAN",
        "An immutable pricing root operation is invalid.",
      );
    }
    operatedOrdinals.add(operation.productOrdinal);
  }
  if (
    affectedVariants !== counts.mutationVariants ||
    root.productPartitions.some(
      (partition) =>
        (partition.affectedVariants > 0) !== operatedOrdinals.has(partition.ordinal),
    )
  ) {
    throw new LaraPricingSalePlanError(
      "COUNT_MISMATCH",
      "The immutable pricing root operation counts do not reconcile.",
    );
  }
}

async function assertProductArtifactStructure(
  artifact: LaraPricingProductArtifact,
  ref: LaraPricingImmutableArtifactRef,
  expectedCatalogueDigest: string,
): Promise<void> {
  const parsedProduct = productSnapshotSchema.safeParse(artifact?.product);
  const ordinalMatch = /\/products\/([0-9]{4})\.json$/.exec(ref.key);
  const expectedOrdinal = ordinalMatch ? Number(ordinalMatch[1]) : -1;
  if (
    !hasExactKeys(artifact, [
      "schemaVersion",
      "kind",
      "ordinal",
      "sourceCatalogueDigestSha256",
      "productDigestSha256",
      "product",
      "operation",
    ]) ||
    artifact.schemaVersion !== LARA_PRICING_SALE_SCHEMA_VERSION ||
    artifact.kind !== "catalogue_product_partition" ||
    artifact.ordinal !== expectedOrdinal ||
    !safeCount(artifact.ordinal, LARA_PRICING_BLAST_RADIUS.maxProducts - 1) ||
    artifact.sourceCatalogueDigestSha256 !== expectedCatalogueDigest ||
    !SHA256.test(artifact.productDigestSha256) ||
    !parsedProduct.success ||
    (await laraPricingProductStateSha256(parsedProduct.data)) !==
      artifact.productDigestSha256
  ) {
    throw new LaraPricingSalePlanError(
      "INVALID_PLAN",
      "An immutable pricing product partition is invalid.",
    );
  }

  const affected = parsedProduct.data.variants.filter(
    (variant) => variant.compareAtPrice !== null,
  );
  const operation = artifact.operation;
  if (affected.length === 0) {
    if (operation !== null) {
      throw new LaraPricingSalePlanError(
        "INVALID_PLAN",
        "A compliant product partition unexpectedly contains a mutation.",
      );
    }
    return;
  }
  if (!operation || !hasExactKeys(operation, [
    "schemaVersion",
    "operationId",
    "kind",
    "target",
    "sourceProduct",
    "cas",
    "change",
    "inverse",
    "protectedPolicy",
    "digestSha256",
  ])) {
    throw new LaraPricingSalePlanError(
      "INVALID_PLAN",
      "An affected product partition is missing its fixed mutation.",
    );
  }
  const operationPayload = omitCanonicalKeys(operation, ["digestSha256"]);
  if (
    operation.schemaVersion !== LARA_PRICING_SALE_SCHEMA_VERSION ||
    operation.operationId !==
      `pricing-${String(artifact.ordinal + 1).padStart(4, "0")}` ||
    operation.kind !== "product_variants.clear_compare_at" ||
    !hasExactKeys(operation.target, ["productId", "handle"]) ||
    operation.target.productId !== parsedProduct.data.id ||
    operation.target.handle !== parsedProduct.data.handle ||
    canonicalRemediationJson(operation.sourceProduct) !==
      canonicalRemediationJson(parsedProduct.data) ||
    !hasExactKeys(operation.cas, [
      "beforeStateSha256",
      "expectedProductUpdatedAt",
    ]) ||
    operation.cas.beforeStateSha256 !== artifact.productDigestSha256 ||
    operation.cas.expectedProductUpdatedAt !== parsedProduct.data.updatedAt ||
    !hasExactKeys(operation.change, ["allowPartialUpdates", "variants"]) ||
    operation.change.allowPartialUpdates !== false ||
    !Array.isArray(operation.change.variants) ||
    operation.change.variants.length !== affected.length ||
    !hasExactKeys(operation.inverse, ["purpose", "variants"]) ||
    operation.inverse.purpose !==
      "recovery_only_do_not_automatically_restore_unsupported_sale_claims" ||
    !Array.isArray(operation.inverse.variants) ||
    operation.inverse.variants.length !== affected.length ||
    !hasExactKeys(operation.protectedPolicy, [
      "sellingPrice",
      "productStatus",
      "publication",
      "vendorMutationAllowed",
    ]) ||
    operation.protectedPolicy.sellingPrice !== "must_remain_exact" ||
    operation.protectedPolicy.productStatus !== "must_remain_exact" ||
    operation.protectedPolicy.publication !== "must_remain_exact" ||
    operation.protectedPolicy.vendorMutationAllowed !== false ||
    !SHA256.test(operation.digestSha256) ||
    (await remediationSha256(operationPayload)) !== operation.digestSha256
  ) {
    throw new LaraPricingSalePlanError(
      "INVALID_PLAN",
      "An immutable pricing product mutation is invalid.",
    );
  }

  for (const [index, before] of affected.entries()) {
    const change = operation.change.variants[index];
    const inverse = operation.inverse.variants[index];
    if (
      !change ||
      !inverse ||
      !hasExactKeys(change, [
        "id",
        "expectedTitle",
        "expectedUpdatedAt",
        "expectedPrice",
        "expectedCompareAtPrice",
        "compareAtPrice",
      ]) ||
      !hasExactKeys(inverse, ["id", "compareAtPrice"]) ||
      change.id !== before.id ||
      change.expectedTitle !== before.title ||
      change.expectedUpdatedAt !== before.updatedAt ||
      change.expectedPrice !== before.price ||
      change.expectedCompareAtPrice !== before.compareAtPrice ||
      change.compareAtPrice !== null ||
      inverse.id !== before.id ||
      inverse.compareAtPrice !== before.compareAtPrice
    ) {
      throw new LaraPricingSalePlanError(
        "INVALID_PLAN",
        "A pricing mutation contains a field outside the exact compare-at repair.",
      );
    }
  }
}

async function artifactRef(
  key: string,
  value: unknown,
  maxBytes: number,
): Promise<LaraPricingImmutableArtifactRef> {
  const json = canonicalRemediationJson(value);
  const byteLength = utf8Length(json);
  if (byteLength > maxBytes) {
    throw new LaraPricingSalePlanError(
      "ARTIFACT_TOO_LARGE",
      "An immutable pricing artifact exceeded its fixed size limit.",
    );
  }
  return freezeRemediationValue({
    key: safeArtifactKey(key),
    digestSha256: await remediationSha256(value),
    byteLength,
  });
}

/**
 * Persist every full before state and inverse outside the 64 KiB run
 * checkpoint. The returned root reference is the only plan material a run
 * checkpoint needs to carry.
 */
export async function persistLaraPricingSalePlan({
  plan,
  store,
  runId,
}: {
  plan: LaraPricingPreparedPlan;
  store: LaraPricingImmutableArtifactStore;
  runId: string;
}): Promise<{
  root: LaraPricingPersistedPlanRoot;
  rootRef: LaraPricingImmutableArtifactRef;
}> {
  if (!UUID.test(runId)) {
    throw new LaraPricingSalePlanError("INVALID_PLAN", "The pricing run id is invalid.");
  }
  const operationByProduct = new Map(
    plan.operations.map((operation) => [operation.target.productId, operation]),
  );
  const productPartitions: Array<
    LaraPricingPersistedPlanRoot["productPartitions"][number]
  > = [];

  for (const [ordinal, product] of plan.catalogue.products.entries()) {
    const partition: LaraPricingProductArtifact = {
      schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
      kind: "catalogue_product_partition",
      ordinal,
      sourceCatalogueDigestSha256: plan.sourceCatalogueDigestSha256,
      productDigestSha256: plan.catalogue.productDigestsSha256[ordinal],
      product,
      operation: operationByProduct.get(product.id) ?? null,
    };
    const key = `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${runId}/products/${String(ordinal).padStart(4, "0")}.json`;
    const ref = await artifactRef(
      key,
      partition,
      LARA_PRICING_BLAST_RADIUS.maxProductArtifactBytes,
    );
    await store.putImmutableJson({ ...ref, value: partition });
    productPartitions.push({
      ordinal,
      productId: product.id,
      productDigestSha256: partition.productDigestSha256,
      affectedVariants: partition.operation?.change.variants.length ?? 0,
      ref,
    });
  }

  const operations = productPartitions
    .filter((partition) => partition.affectedVariants > 0)
    .map((partition, operationIndex) => {
      const operation = operationByProduct.get(partition.productId);
      if (!operation) {
        throw new LaraPricingSalePlanError(
          "INVALID_PLAN",
          "A persisted product target is missing its immutable operation.",
        );
      }
      return {
        operationIndex,
        operationId: operation.operationId,
        productOrdinal: partition.ordinal,
        productId: partition.productId,
        operationDigestSha256: operation.digestSha256,
        affectedVariants: partition.affectedVariants,
        partitionRef: partition.ref,
      };
    });
  const rootPayload = {
    schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    kind: "persisted_plan_root" as const,
    planId: LARA_PRICING_SALE_PLAN_ID,
    createdAt: plan.createdAt,
    executionMode: "dry-run" as const,
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    sourceCatalogueDigestSha256: plan.sourceCatalogueDigestSha256,
    sourceBulkOperationId: plan.sourceBulkOperationId,
    legalBasis: LARA_PRICING_LEGAL_BASIS,
    vendorPolicy: LARA_PRICING_VENDOR_POLICY,
    counts: plan.counts,
    productPartitions,
    operations,
    preparedPlanDigestSha256: plan.digestSha256,
  };
  const root: LaraPricingPersistedPlanRoot = freezeRemediationValue({
    ...rootPayload,
    digestSha256: await remediationSha256(rootPayload),
  });
  const rootRef = await artifactRef(
    `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${runId}/root.json`,
    root,
    LARA_PRICING_BLAST_RADIUS.maxRootArtifactBytes,
  );
  await store.putImmutableJson({ ...rootRef, value: root });
  return freezeRemediationValue({ root, rootRef });
}

export async function loadLaraPricingPersistedRoot({
  store,
  ref,
}: {
  store: LaraPricingImmutableArtifactStore;
  ref: LaraPricingImmutableArtifactRef;
}): Promise<LaraPricingPersistedPlanRoot> {
  const value = await store.getImmutableJson(ref.key);
  if (
    (await remediationSha256(value)) !== ref.digestSha256 ||
    utf8Length(canonicalRemediationJson(value)) !== ref.byteLength
  ) {
    throw new LaraPricingSalePlanError(
      "ARTIFACT_MISMATCH",
      "The immutable pricing root artifact no longer matches its reference.",
    );
  }
  const root = value as LaraPricingPersistedPlanRoot;
  assertPersistedRootStructure(root, ref);
  const rootPayload = omitCanonicalKeys(root ?? {}, ["digestSha256"]);
  if (
    !root ||
    root.schemaVersion !== LARA_PRICING_SALE_SCHEMA_VERSION ||
    root.kind !== "persisted_plan_root" ||
    root.shop?.domain !== LARA_ROVINJ_REMEDIATION_SHOP.domain ||
    root.shop?.shopId !== LARA_ROVINJ_REMEDIATION_SHOP.shopId ||
    (await remediationSha256(rootPayload)) !== root.digestSha256 ||
    root.operations.length !== root.counts.operationProducts ||
    root.productPartitions.length !== root.counts.products
  ) {
    throw new LaraPricingSalePlanError(
      "INVALID_PLAN",
      "The immutable pricing root artifact is invalid.",
    );
  }
  return freezeRemediationValue(root);
}

export async function loadLaraPricingProductArtifact({
  store,
  ref,
  expectedCatalogueDigest,
}: {
  store: LaraPricingImmutableArtifactStore;
  ref: LaraPricingImmutableArtifactRef;
  expectedCatalogueDigest: string;
}): Promise<LaraPricingProductArtifact> {
  const value = await store.getImmutableJson(ref.key);
  if (
    (await remediationSha256(value)) !== ref.digestSha256 ||
    utf8Length(canonicalRemediationJson(value)) !== ref.byteLength
  ) {
    throw new LaraPricingSalePlanError(
      "ARTIFACT_MISMATCH",
      "An immutable pricing product artifact no longer matches its reference.",
    );
  }
  const artifact = value as LaraPricingProductArtifact;
  await assertProductArtifactStructure(
    artifact,
    ref,
    expectedCatalogueDigest,
  );
  const operation = artifact?.operation;
  const operationPayload = operation
    ? omitCanonicalKeys(operation, ["digestSha256"])
    : null;
  if (
    !artifact ||
    artifact.schemaVersion !== LARA_PRICING_SALE_SCHEMA_VERSION ||
    artifact.kind !== "catalogue_product_partition" ||
    artifact.sourceCatalogueDigestSha256 !== expectedCatalogueDigest ||
    (await laraPricingProductStateSha256(artifact.product)) !==
      artifact.productDigestSha256 ||
    (operation !== null &&
      (operation.target.productId !== artifact.product.id ||
        (await remediationSha256(operationPayload)) !== operation.digestSha256))
  ) {
    throw new LaraPricingSalePlanError(
      "INVALID_PLAN",
      "An immutable pricing product partition is invalid.",
    );
  }
  return freezeRemediationValue(artifact);
}
