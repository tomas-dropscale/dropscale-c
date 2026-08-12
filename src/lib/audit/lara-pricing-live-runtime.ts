import "server-only";

import { decryptToken } from "@/lib/google-ads/crypto";
import { createServiceClient } from "@/lib/supabase/service";
import {
  LARA_PRICING_API_VERSION,
  LARA_PRICING_BLAST_RADIUS,
  LARA_PRICING_BULK_OPERATION_QUERY,
  LARA_PRICING_CATALOG_BULK_QUERY,
  LARA_PRICING_CLEAR_COMPARE_AT_MUTATION,
  LARA_PRICING_PRODUCT_READ_QUERY,
  LARA_PRICING_START_BULK_QUERY_MUTATION,
  parseLaraPricingCatalogueBulkResult,
  type LaraPricingBulkOperationEvidence,
  type LaraPricingCatalogueSnapshot,
  type LaraPricingProductSnapshot,
} from "./lara-pricing-sale-plan";
import {
  LaraPricingMutationDefinitiveError,
  LaraPricingMutationAmbiguousError,
  type LaraPricingRepairRuntime,
} from "./lara-pricing-sale-executor";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  exchangeAuditClientCredentials,
  normalizeAuditShopDomain,
  verifyAuditShop,
} from "./shopify";

const CONNECTION_COLUMNS =
  "id, status, shopify_shop_id, shopify_domain, shopify_client_id, granted_scopes, audit_shopify_credentials(client_secret_ciphertext)" as const;
const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const BULK_OPERATION_GID = /^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
const HANDLE = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
const MONEY = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const RESULT_HOST = "storage.googleapis.com";
const RESULT_PATH =
  /^\/(?:shopify|shopify-tiers-assets-prod-us-east1)\/[A-Za-z0-9_./=+~-]{8,1024}$/;
const BULK_RECOVERY_LOOKBACK_MS = 5 * 60 * 1_000;

export const LARA_PRICING_RECENT_BULK_QUERIES = `#graphql
  query LaraPricingRecentBulkQueries($query: String!) {
    bulkOperations(
      first: 50
      reverse: true
      sortKey: CREATED_AT
      query: $query
    ) {
      nodes {
        id type status errorCode createdAt completedAt
        rootObjectCount objectCount fileSize query
      }
      pageInfo { hasNextPage }
    }
  }
`;

export const LARA_PRICING_LIVE_GRAPHQL_MANIFEST = Object.freeze({
  catalogue: LARA_PRICING_CATALOG_BULK_QUERY,
  startCatalogue: LARA_PRICING_START_BULK_QUERY_MUTATION,
  pollCatalogue: LARA_PRICING_BULK_OPERATION_QUERY,
  recoverCatalogueStart: LARA_PRICING_RECENT_BULK_QUERIES,
  recoveryLookbackMs: BULK_RECOVERY_LOOKBACK_MS,
  product: LARA_PRICING_PRODUCT_READ_QUERY,
  clearCompareAt: LARA_PRICING_CLEAR_COMPARE_AT_MUTATION,
});

export type LaraPricingBulkStatus = Readonly<{
  id: string;
  type: "QUERY";
  status:
    | "CREATED"
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELED"
    | "CANCELING"
    | "EXPIRED";
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  rootObjectCount: string;
  objectCount: string;
  fileSize: string | null;
  hasResult: boolean;
  hasPartialResult: boolean;
}>;

export type LaraPricingDownloadedCatalogue = Readonly<{
  catalogue: LaraPricingCatalogueSnapshot;
  jsonlSha256: string;
  byteLength: number;
}>;

export type LaraPricingLiveRuntime = LaraPricingRepairRuntime &
  Readonly<{
    connectionId: typeof LARA_AUDIT_CONNECTION.connectionId;
    shopId: typeof LARA_AUDIT_CONNECTION.shopId;
    shopDomain: typeof LARA_AUDIT_CONNECTION.shopDomain;
    apiVersion: typeof LARA_PRICING_API_VERSION;
    grantedScopes: readonly string[];
    startCatalogueBulk(): Promise<LaraPricingBulkStatus>;
    pollCatalogueBulk(operationId: string): Promise<LaraPricingBulkStatus>;
    recoverExactCatalogueStarts(
      requestedAfter: string,
    ): Promise<readonly LaraPricingBulkStatus[]>;
    downloadCompletedCatalogue(input: {
      operationId: string;
      capturedAt: string;
    }): Promise<LaraPricingDownloadedCatalogue>;
  }>;

export type LaraPricingLiveRuntimeErrorCode =
  | "bulk_download_invalid"
  | "bulk_download_too_large"
  | "bulk_failed"
  | "bulk_not_completed"
  | "bulk_start_ambiguous"
  | "bulk_start_rejected"
  | "connection_invalid"
  | "connection_unavailable"
  | "credential_unavailable"
  | "graphql_error"
  | "invalid_bulk_operation"
  | "invalid_product"
  | "missing_read_products"
  | "missing_write_products"
  | "mutation_rejected"
  | "shop_mismatch"
  | "shopify_unavailable"
  | "unsupported_api_version";

export class LaraPricingLiveRuntimeError extends Error {
  constructor(
    public readonly code: LaraPricingLiveRuntimeErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "LaraPricingLiveRuntimeError";
  }
}

type ConnectionRow = {
  id?: unknown;
  status?: unknown;
  shopify_shop_id?: unknown;
  shopify_domain?: unknown;
  shopify_client_id?: unknown;
  granted_scopes?: unknown;
  audit_shopify_credentials?: unknown;
};

type GraphqlEnvelope = { data?: unknown; errors?: unknown };

type InternalBulkStatus = LaraPricingBulkStatus &
  Readonly<{ query: string; resultUrl: string | null; partialResultUrl: string | null }>;

function runtimeError(
  code: LaraPricingLiveRuntimeErrorCode,
  message: string,
  retryable = false,
) {
  return new LaraPricingLiveRuntimeError(code, message, retryable);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shopifyProductHandle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    HANDLE.test(value) &&
    value === value.toLowerCase()
  );
}

function credentialCiphertext(value: unknown): string | null {
  const item = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  const row = record(item);
  return typeof row?.client_secret_ciphertext === "string" &&
    row.client_secret_ciphertext.length > 0
    ? row.client_secret_ciphertext
    : null;
}

function graphqlCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const extensions = record(record(item)?.extensions);
    return typeof extensions?.code === "string"
      ? [extensions.code.toUpperCase()]
      : [];
  });
}

function onlyCodes(value: unknown, allowed: readonly string[]): boolean {
  const codes = graphqlCodes(value);
  return codes.length > 0 && codes.every((code) => allowed.includes(code));
}

function normalizedGraphql(value: string): string {
  return value.replace(/^\s*#graphql\s*/u, "").replace(/\s+/gu, " ").trim();
}

function exactCatalogueQuery(value: unknown): value is string {
  return (
    typeof value === "string" &&
    normalizedGraphql(value) === normalizedGraphql(LARA_PRICING_CATALOG_BULK_QUERY)
  );
}

function unsigned(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? value
    : null;
}

function timestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function parseBulk(value: unknown, requireQuery = true): InternalBulkStatus {
  const item = record(value);
  const id = item?.id;
  const type = item?.type;
  const status = item?.status;
  const createdAt = timestamp(item?.createdAt);
  const completedAt = timestamp(item?.completedAt, true);
  const rootObjectCount = unsigned(item?.rootObjectCount);
  const objectCount = unsigned(item?.objectCount);
  const fileSize = unsigned(item?.fileSize, true);
  const resultUrl = item?.url === null ? null : item?.url;
  const partialResultUrl = item?.partialDataUrl === null ? null : item?.partialDataUrl;
  const query = requireQuery ? item?.query : LARA_PRICING_CATALOG_BULK_QUERY;
  if (
    typeof id !== "string" ||
    !BULK_OPERATION_GID.test(id) ||
    type !== "QUERY" ||
    ![
      "CREATED",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELED",
      "CANCELING",
      "EXPIRED",
    ].includes(String(status)) ||
    createdAt === null ||
    (item?.completedAt !== null && completedAt === null) ||
    rootObjectCount === null ||
    objectCount === null ||
    (item?.fileSize !== null && fileSize === null) ||
    (resultUrl !== null && typeof resultUrl !== "string") ||
    (partialResultUrl !== null && typeof partialResultUrl !== "string") ||
    !exactCatalogueQuery(query)
  ) {
    throw runtimeError(
      "invalid_bulk_operation",
      "Shopify returned a bulk operation outside the fixed Lara catalogue query.",
    );
  }
  const errorCode = item?.errorCode;
  if (errorCode !== null && typeof errorCode !== "string") {
    throw runtimeError("invalid_bulk_operation", "Shopify returned an invalid bulk error.");
  }
  return Object.freeze({
    id,
    type: "QUERY" as const,
    status: status as InternalBulkStatus["status"],
    errorCode,
    createdAt,
    completedAt,
    rootObjectCount,
    objectCount,
    fileSize,
    hasResult: resultUrl !== null,
    hasPartialResult: partialResultUrl !== null,
    query,
    resultUrl,
    partialResultUrl,
  });
}

function publicBulk(status: InternalBulkStatus): LaraPricingBulkStatus {
  return Object.freeze({
    id: status.id,
    type: status.type,
    status: status.status,
    errorCode: status.errorCode,
    createdAt: status.createdAt,
    completedAt: status.completedAt,
    rootObjectCount: status.rootObjectCount,
    objectCount: status.objectCount,
    fileSize: status.fileSize,
    hasResult: status.hasResult,
    hasPartialResult: status.hasPartialResult,
  });
}

type RequestKind = "read" | "start" | "mutation";

async function postGraphql(
  accessToken: string,
  document: string,
  variables: Readonly<Record<string, unknown>>,
  kind: RequestKind,
): Promise<GraphqlEnvelope> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `https://${LARA_AUDIT_CONNECTION.shopDomain}/admin/api/${LARA_PRICING_API_VERSION}/graphql.json`,
      {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-shopify-access-token": accessToken,
        },
        body: JSON.stringify({ query: document, variables }),
      },
    );
  } catch {
    if (kind === "mutation") {
      throw new LaraPricingMutationAmbiguousError();
    }
    if (kind === "start") {
      throw runtimeError(
        "bulk_start_ambiguous",
        "The fixed catalogue query might have started but its acknowledgement was lost.",
        true,
      );
    }
    throw runtimeError("shopify_unavailable", "Shopify could not be reached.", true);
  } finally {
    clearTimeout(timer);
  }

  if (response.headers.get("x-shopify-api-version") !== LARA_PRICING_API_VERSION) {
    if (kind === "mutation") throw new LaraPricingMutationAmbiguousError();
    if (kind === "start") {
      throw runtimeError("bulk_start_ambiguous", "The bulk start was not acknowledged.", true);
    }
    throw runtimeError(
      "unsupported_api_version",
      "Shopify served an unexpected API version.",
    );
  }
  if (!response.ok || response.status >= 300) {
    if (kind === "mutation" && response.status >= 500) {
      throw new LaraPricingMutationAmbiguousError();
    }
    if (kind === "mutation") {
      throw new LaraPricingMutationDefinitiveError(
        "Shopify definitively rejected the fixed pricing mutation.",
        response.status === 429,
      );
    }
    if (kind === "start" && response.status >= 500) {
      throw runtimeError("bulk_start_ambiguous", "The bulk start was not acknowledged.", true);
    }
    const retryable = response.status === 429 || response.status >= 500;
    throw runtimeError(
      kind === "start" ? "bulk_start_rejected" : "shopify_unavailable",
      "Shopify rejected the fixed pricing operation.",
      retryable,
    );
  }

  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    if (kind === "mutation") throw new LaraPricingMutationAmbiguousError();
    if (kind === "start") {
      throw runtimeError("bulk_start_ambiguous", "The bulk start response was unusable.", true);
    }
    throw runtimeError("graphql_error", "Shopify returned invalid GraphQL JSON.", true);
  }
  if (!record(envelope)) {
    if (kind === "mutation") throw new LaraPricingMutationAmbiguousError();
    if (kind === "start") {
      throw runtimeError("bulk_start_ambiguous", "The bulk start response was unusable.", true);
    }
    throw runtimeError("graphql_error", "Shopify returned an invalid GraphQL envelope.");
  }
  return envelope as GraphqlEnvelope;
}

function requireQueryData(envelope: GraphqlEnvelope): Record<string, unknown> {
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    throw runtimeError(
      "graphql_error",
      "Shopify rejected the fixed pricing query.",
      onlyCodes(envelope.errors, ["THROTTLED", "INTERNAL_SERVER_ERROR"]),
    );
  }
  const data = record(envelope.data);
  if (!data) throw runtimeError("graphql_error", "Shopify omitted pricing query data.");
  return data;
}

async function startCatalogueBulk(accessToken: string): Promise<LaraPricingBulkStatus> {
  const envelope = await postGraphql(
    accessToken,
    LARA_PRICING_START_BULK_QUERY_MUTATION,
    {},
    "start",
  );
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    if (!onlyCodes(envelope.errors, ["THROTTLED", "ACCESS_DENIED"])) {
      throw runtimeError(
        "bulk_start_ambiguous",
        "The fixed catalogue query may have started despite a GraphQL error.",
        true,
      );
    }
    throw runtimeError(
      "bulk_start_rejected",
      "Shopify rejected the fixed catalogue bulk query.",
      onlyCodes(envelope.errors, ["THROTTLED"]),
    );
  }
  const payload = record(record(envelope.data)?.bulkOperationRunQuery);
  if (!payload || !Array.isArray(payload.userErrors)) {
    throw runtimeError("bulk_start_ambiguous", "The bulk start acknowledgement was incomplete.", true);
  }
  if (payload.userErrors.length > 0) {
    const codes = payload.userErrors.map((value) => record(value)?.code);
    const retryable =
      codes.length > 0 &&
      codes.every(
        (code) =>
          code === "LIMIT_REACHED" || code === "OPERATION_IN_PROGRESS",
      );
    throw runtimeError(
      "bulk_start_rejected",
      "Shopify rejected the catalogue bulk query.",
      retryable,
    );
  }
  try {
    return publicBulk(parseBulk(payload.bulkOperation));
  } catch {
    // No user error means Shopify might have created the operation even when
    // the returned object was truncated or otherwise unusable.
    throw runtimeError(
      "bulk_start_ambiguous",
      "The bulk start acknowledgement was incomplete.",
      true,
    );
  }
}

async function pollCatalogueBulkInternal(
  accessToken: string,
  operationId: string,
): Promise<InternalBulkStatus> {
  if (!BULK_OPERATION_GID.test(operationId)) {
    throw runtimeError("invalid_bulk_operation", "The catalogue bulk operation ID is invalid.");
  }
  const envelope = await postGraphql(
    accessToken,
    LARA_PRICING_BULK_OPERATION_QUERY,
    { id: operationId },
    "read",
  );
  const data = requireQueryData(envelope);
  const status = parseBulk(data.bulkOperation);
  if (status.id !== operationId) {
    throw runtimeError("invalid_bulk_operation", "Shopify returned another bulk operation.");
  }
  return status;
}

async function recoverExactCatalogueStarts(
  accessToken: string,
  requestedAfter: string,
): Promise<readonly LaraPricingBulkStatus[]> {
  if (!timestamp(requestedAfter)) {
    throw runtimeError("invalid_bulk_operation", "The bulk recovery timestamp is invalid.");
  }
  // Shopify owns `createdAt`; include a bounded clock-skew window so an
  // ambiguous start cannot disappear just because the two clocks differ. The
  // coordinator treats any pre-boundary candidate as a collision rather than
  // assuming that it belongs to this run.
  const recoveryFloor = new Date(
    Date.parse(requestedAfter) - BULK_RECOVERY_LOOKBACK_MS,
  ).toISOString();
  const filter = `operation_type:query created_at:>=${recoveryFloor}`;
  const envelope = await postGraphql(
    accessToken,
    LARA_PRICING_RECENT_BULK_QUERIES,
    { query: filter },
    "read",
  );
  const connection = record(requireQueryData(envelope).bulkOperations);
  const pageInfo = record(connection?.pageInfo);
  if (
    !Array.isArray(connection?.nodes) ||
    typeof pageInfo?.hasNextPage !== "boolean" ||
    pageInfo.hasNextPage
  ) {
    throw runtimeError("graphql_error", "Shopify omitted recent bulk operations.");
  }
  const statuses = connection.nodes
    .map((item) => parseBulk({ ...record(item), url: null, partialDataUrl: null }))
    .filter((item) => Date.parse(item.createdAt) >= Date.parse(recoveryFloor))
    .map(publicBulk);
  const ids = new Set(statuses.map((item) => item.id));
  if (ids.size !== statuses.length) {
    throw runtimeError("invalid_bulk_operation", "Shopify duplicated a bulk operation.");
  }
  return Object.freeze(statuses);
}

function safeResultUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw runtimeError("bulk_download_invalid", "Shopify returned an invalid result URL.");
  }
  const pathStart = value.indexOf("/", value.indexOf("://") + 3);
  const queryStart = value.indexOf("?", pathStart);
  const fragmentStart = value.indexOf("#", pathStart);
  const pathEnd = Math.min(
    ...[queryStart, fragmentStart, value.length].filter((index) => index >= 0),
  );
  const rawPathname = pathStart >= 0 ? value.slice(pathStart, pathEnd) : "";
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== RESULT_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    rawPathname !== parsed.pathname ||
    !RESULT_PATH.test(parsed.pathname)
  ) {
    throw runtimeError(
      "bulk_download_invalid",
      "The Shopify result URL is outside the fixed private download allowlist.",
    );
  }
  return parsed;
}

/* Incremental SHA-256 keeps the bounded JSONL stream from requiring a second full copy. */
class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private buffered = 0;
  private total = 0;

  update(bytes: Uint8Array): void {
    this.total += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(64 - this.buffered, bytes.byteLength - offset);
      this.block.set(bytes.subarray(offset, offset + take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === 64) {
        this.compress(this.block);
        this.buffered = 0;
      }
    }
  }

  private compress(block: Uint8Array): void {
    const k = SHA256_K;
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      const j = i * 4;
      w[i] =
        ((block[j] ?? 0) << 24) |
        ((block[j + 1] ?? 0) << 16) |
        ((block[j + 2] ?? 0) << 8) |
        (block[j + 3] ?? 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + s1 + ch + (k[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.state[0] = ((this.state[0] ?? 0) + a) >>> 0;
    this.state[1] = ((this.state[1] ?? 0) + b) >>> 0;
    this.state[2] = ((this.state[2] ?? 0) + c) >>> 0;
    this.state[3] = ((this.state[3] ?? 0) + d) >>> 0;
    this.state[4] = ((this.state[4] ?? 0) + e) >>> 0;
    this.state[5] = ((this.state[5] ?? 0) + f) >>> 0;
    this.state[6] = ((this.state[6] ?? 0) + g) >>> 0;
    this.state[7] = ((this.state[7] ?? 0) + h) >>> 0;
  }

  digestHex(): string {
    const tail = new Uint8Array(128);
    tail.set(this.block.subarray(0, this.buffered));
    tail[this.buffered] = 0x80;
    const finalBytes = this.buffered < 56 ? 64 : 128;
    const bitLength = BigInt(this.total) * BigInt(8);
    for (let i = 0; i < 8; i += 1) {
      tail[finalBytes - 1 - i] = Number(
        (bitLength >> BigInt(i * 8)) & BigInt(0xff),
      );
    }
    this.compress(tail.subarray(0, 64));
    if (finalBytes === 128) this.compress(tail.subarray(64, 128));
    return [...this.state]
      .map((word) => word.toString(16).padStart(8, "0"))
      .join("");
  }
}

function rotr(value: number, count: number): number {
  return ((value >>> count) | (value << (32 - count))) >>> 0;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

async function downloadCompletedCatalogue(
  accessToken: string,
  input: { operationId: string; capturedAt: string },
): Promise<LaraPricingDownloadedCatalogue> {
  if (!timestamp(input.capturedAt)) {
    throw runtimeError("invalid_bulk_operation", "The catalogue capture timestamp is invalid.");
  }
  const operation = await pollCatalogueBulkInternal(accessToken, input.operationId);
  if (
    operation.status !== "COMPLETED" ||
    !operation.completedAt ||
    !operation.fileSize ||
    !operation.resultUrl ||
    operation.partialResultUrl !== null
  ) {
    throw runtimeError("bulk_not_completed", "The full catalogue bulk query is not complete.", true);
  }
  const expectedBytes = Number(operation.fileSize);
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > LARA_PRICING_BLAST_RADIUS.maxJsonlBytes
  ) {
    throw runtimeError("bulk_download_too_large", "The catalogue result exceeds the byte ceiling.");
  }
  const resultUrl = safeResultUrl(operation.resultUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(resultUrl, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { accept: "application/jsonl, application/octet-stream, text/plain" },
    });
  } catch {
    clearTimeout(timer);
    throw runtimeError("shopify_unavailable", "The catalogue result could not be downloaded.", true);
  }
  if (!response.ok || response.status !== 200 || response.type === "opaqueredirect") {
    clearTimeout(timer);
    throw runtimeError("bulk_download_invalid", "The catalogue download was not a direct success.", response.status >= 500);
  }
  if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") {
    clearTimeout(timer);
    throw runtimeError("bulk_download_invalid", "Compressed catalogue results are not accepted.");
  }
  const mediaType = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    ![
      "application/jsonl",
      "application/jsonlines",
      "application/octet-stream",
      "text/plain",
    ].includes(mediaType ?? "")
  ) {
    clearTimeout(timer);
    throw runtimeError(
      "bulk_download_invalid",
      "The catalogue result has an unexpected media type.",
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && unsigned(contentLength) !== operation.fileSize) {
    clearTimeout(timer);
    throw runtimeError("bulk_download_invalid", "The catalogue Content-Length does not match Shopify.");
  }
  if (!response.body) {
    clearTimeout(timer);
    throw runtimeError("bulk_download_invalid", "The catalogue result body is missing.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hasher = new IncrementalSha256();
  let observedBytes = 0;
  let digest = "";
  let streamComplete = false;
  async function* chunks(): AsyncGenerator<string> {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) {
          throw runtimeError("bulk_download_invalid", "The catalogue response stream is invalid.");
        }
        observedBytes += part.value.byteLength;
        if (observedBytes > expectedBytes || observedBytes > LARA_PRICING_BLAST_RADIUS.maxJsonlBytes) {
          throw runtimeError("bulk_download_too_large", "The catalogue result exceeded its declared size.");
        }
        hasher.update(part.value);
        const text = decoder.decode(part.value, { stream: true });
        if (text) yield text;
      }
      const finalText = decoder.decode();
      if (finalText) yield finalText;
      if (observedBytes !== expectedBytes) {
        throw runtimeError("bulk_download_invalid", "The catalogue byte count does not match Shopify.");
      }
      digest = hasher.digestHex();
      streamComplete = true;
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // Best effort only; the sanitized runtime error below remains authoritative.
      }
      if (error instanceof LaraPricingLiveRuntimeError) throw error;
      throw runtimeError("bulk_download_invalid", "The catalogue stream is not valid UTF-8 JSONL.");
    } finally {
      if (!streamComplete) {
        try {
          await reader.cancel();
        } catch {
          // Best effort when parsing rejects a yielded JSONL line.
        }
      }
      clearTimeout(timer);
    }
  }

  const evidence: LaraPricingBulkOperationEvidence = {
    operationId: operation.id,
    status: operation.status,
    completedAt: operation.completedAt,
    rootObjectCount: operation.rootObjectCount,
    objectCount: operation.objectCount,
    fileSize: operation.fileSize,
  };
  const catalogue = await parseLaraPricingCatalogueBulkResult({
    chunks: chunks(),
    operation: evidence,
    capturedAt: input.capturedAt,
  });
  if (!/^[a-f0-9]{64}$/.test(digest) || observedBytes !== expectedBytes) {
    throw runtimeError("bulk_download_invalid", "The catalogue integrity proof is incomplete.");
  }
  return Object.freeze({ catalogue, jsonlSha256: digest, byteLength: observedBytes });
}

function parseProduct(value: unknown): {
  product: Omit<LaraPricingProductSnapshot, "variants">;
  variants: LaraPricingProductSnapshot["variants"];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const product = record(value);
  const connection = record(product?.variants);
  const pageInfo = record(connection?.pageInfo);
  if (
    typeof product?.id !== "string" || !PRODUCT_GID.test(product.id) ||
    !shopifyProductHandle(product.handle) ||
    typeof product.title !== "string" || product.title.length > 500 ||
    typeof product.vendor !== "string" || product.vendor.length > 255 ||
    !["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"].includes(
      String(product.status),
    ) ||
    (product.publishedAt !== null && !timestamp(product.publishedAt)) ||
    !timestamp(product.updatedAt) || !Array.isArray(connection?.nodes) ||
    typeof pageInfo?.hasNextPage !== "boolean" ||
    (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
  ) {
    throw runtimeError("invalid_product", "Shopify returned an invalid pricing product.");
  }
  const variants = connection.nodes.map((item) => {
    const variant = record(item);
    if (
      typeof variant?.id !== "string" || !VARIANT_GID.test(variant.id) ||
      typeof variant.title !== "string" || variant.title.length > 500 ||
      typeof variant.price !== "string" || !MONEY.test(variant.price) ||
      (variant.compareAtPrice !== null &&
        (typeof variant.compareAtPrice !== "string" || !MONEY.test(variant.compareAtPrice))) ||
      !timestamp(variant.updatedAt)
    ) {
      throw runtimeError("invalid_product", "Shopify returned an invalid pricing variant.");
    }
    return {
      id: variant.id,
      title: variant.title,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice as string | null,
      updatedAt: variant.updatedAt as string,
    };
  });
  return {
    product: {
      id: product.id,
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      status: product.status as LaraPricingProductSnapshot["status"],
      publishedAt: product.publishedAt as string | null,
      updatedAt: product.updatedAt as string,
    },
    variants,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor as string | null,
  };
}

function gidOrder(left: string, right: string): number {
  const a = BigInt(left.slice(left.lastIndexOf("/") + 1));
  const b = BigInt(right.slice(right.lastIndexOf("/") + 1));
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readFullProduct(
  accessToken: string,
  productId: string,
): Promise<LaraPricingProductSnapshot> {
  if (!PRODUCT_GID.test(productId)) {
    throw runtimeError("invalid_product", "The fixed pricing product ID is invalid.");
  }
  let after: string | null = null;
  let base: Omit<LaraPricingProductSnapshot, "variants"> | null = null;
  const variants: LaraPricingProductSnapshot["variants"][number][] = [];
  for (let page = 0; page < 9; page += 1) {
    const envelope = await postGraphql(
      accessToken,
      LARA_PRICING_PRODUCT_READ_QUERY,
      { id: productId, after },
      "read",
    );
    const parsed = parseProduct(requireQueryData(envelope).product);
    if (parsed.product.id !== productId || (base && JSON.stringify(base) !== JSON.stringify(parsed.product))) {
      throw runtimeError("invalid_product", "The pricing product changed during pagination.");
    }
    base = parsed.product;
    variants.push(...parsed.variants);
    if (!parsed.hasNextPage) {
      if (!base || variants.length < 1 || new Set(variants.map((v) => v.id)).size !== variants.length) {
        throw runtimeError("invalid_product", "The pricing product variants are incomplete.");
      }
      return Object.freeze({
        ...base,
        variants: Object.freeze([...variants].sort((a, b) => gidOrder(a.id, b.id))),
      }) as LaraPricingProductSnapshot;
    }
    if (!parsed.endCursor || parsed.endCursor === after) {
      throw runtimeError("invalid_product", "The pricing variant cursor did not advance.");
    }
    after = parsed.endCursor;
  }
  throw runtimeError("invalid_product", "The pricing product exceeded the pagination ceiling.");
}

async function clearCompareAtPricesAtomic(
  accessToken: string,
  input: { productId: string; variantIds: readonly string[]; allowPartialUpdates: false },
): Promise<void> {
  if (
    !PRODUCT_GID.test(input.productId) || input.allowPartialUpdates !== false ||
    input.variantIds.length < 1 || input.variantIds.length > 250 ||
    new Set(input.variantIds).size !== input.variantIds.length ||
    input.variantIds.some((id) => !VARIANT_GID.test(id))
  ) {
    throw new LaraPricingMutationDefinitiveError(
      "The fixed pricing mutation input is invalid.",
    );
  }
  const variants = input.variantIds.map((id) => ({ id, compareAtPrice: null }));
  const envelope = await postGraphql(
    accessToken,
    LARA_PRICING_CLEAR_COMPARE_AT_MUTATION,
    { productId: input.productId, variants },
    "mutation",
  );
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    if (onlyCodes(envelope.errors, ["THROTTLED"])) {
      throw new LaraPricingMutationDefinitiveError(
        "Shopify throttled the fixed pricing mutation.",
        true,
      );
    }
    if (onlyCodes(envelope.errors, ["ACCESS_DENIED"])) {
      throw new LaraPricingMutationDefinitiveError(
        "Shopify denied the fixed pricing mutation.",
      );
    }
    throw new LaraPricingMutationAmbiguousError();
  }
  const payload = record(record(envelope.data)?.productVariantsBulkUpdate);
  if (!payload || !Array.isArray(payload.userErrors)) {
    throw new LaraPricingMutationAmbiguousError();
  }
  if (payload.userErrors.length > 0) {
    throw new LaraPricingMutationDefinitiveError();
  }
  if (!Array.isArray(payload.productVariants)) {
    throw new LaraPricingMutationAmbiguousError();
  }
  const returnedIds = payload.productVariants.map((item) => {
    const variant = record(item);
    if (
      typeof variant?.id !== "string" || !VARIANT_GID.test(variant.id) ||
      variant.compareAtPrice !== null || typeof variant.price !== "string" ||
      !MONEY.test(variant.price) || !timestamp(variant.updatedAt)
    ) {
      throw new LaraPricingMutationAmbiguousError();
    }
    return variant.id;
  });
  if (
    returnedIds.length !== input.variantIds.length ||
    new Set(returnedIds).size !== returnedIds.length ||
    input.variantIds.some((id) => !returnedIds.includes(id))
  ) {
    throw new LaraPricingMutationAmbiguousError();
  }
}

/** Fresh-token runtime with no arbitrary GraphQL, URL or mutation-value entrypoint. */
export async function createLaraPricingLiveRuntime(): Promise<LaraPricingLiveRuntime> {
  const service = createServiceClient();
  if (!service) throw runtimeError("connection_unavailable", "Server-side Shopify access is unavailable.");
  const { data, error } = await service
    .from("audit_shopify_connections")
    .select(CONNECTION_COLUMNS)
    .eq("id", LARA_AUDIT_CONNECTION.connectionId)
    .maybeSingle();
  if (error || !data) throw runtimeError("connection_unavailable", "The Lara connection is unavailable.");
  const row = data as unknown as ConnectionRow;
  let domain: string;
  try {
    domain = normalizeAuditShopDomain(String(row.shopify_domain ?? ""));
  } catch {
    throw runtimeError("connection_invalid", "The Lara connection is invalid.");
  }
  if (
    row.id !== LARA_AUDIT_CONNECTION.connectionId || row.status !== "connected" ||
    row.shopify_shop_id !== LARA_AUDIT_CONNECTION.shopId ||
    domain !== LARA_AUDIT_CONNECTION.shopDomain ||
    typeof row.shopify_client_id !== "string" || !Array.isArray(row.granted_scopes) ||
    row.granted_scopes.some((scope) => typeof scope !== "string")
  ) {
    throw runtimeError("shop_mismatch", "The pricing runtime targets another shop.");
  }
  const storedScopes = [...new Set(row.granted_scopes as string[])].sort();
  if (!storedScopes.includes("read_products")) throw runtimeError("missing_read_products", "The Lara app cannot read products.");
  if (!storedScopes.includes("write_products")) throw runtimeError("missing_write_products", "The Lara app cannot update products.");
  const ciphertext = credentialCiphertext(row.audit_shopify_credentials);
  if (!ciphertext) throw runtimeError("credential_unavailable", "The Lara credential is unavailable.");

  let secret = "";
  let accessToken = "";
  try {
    secret = await decryptToken(ciphertext);
    accessToken = await exchangeAuditClientCredentials({
      shopDomain: domain,
      clientId: row.shopify_client_id,
      clientSecret: secret,
    });
  } catch {
    throw runtimeError("credential_unavailable", "The Lara credential could not be used.");
  } finally {
    secret = "";
  }
  let verified;
  try {
    verified = await verifyAuditShop({ shopDomain: domain, accessToken });
  } catch {
    throw runtimeError("shopify_unavailable", "Shopify could not verify Lara.", true);
  }
  if (verified.shopId !== LARA_AUDIT_CONNECTION.shopId || verified.myshopifyDomain !== domain) {
    throw runtimeError("shop_mismatch", "Shopify verified another shop.");
  }
  if (
    verified.scopes.granted.length !== storedScopes.length ||
    verified.scopes.granted.some((scope, index) => scope !== storedScopes[index])
  ) {
    throw runtimeError("connection_invalid", "The Shopify grant changed after connection.");
  }
  if (!verified.scopes.granted.includes("read_products")) throw runtimeError("missing_read_products", "The verified app cannot read products.");
  if (!verified.scopes.granted.includes("write_products")) throw runtimeError("missing_write_products", "The verified app cannot update products.");

  return Object.freeze({
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    shopId: LARA_AUDIT_CONNECTION.shopId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    apiVersion: LARA_PRICING_API_VERSION,
    grantedScopes: Object.freeze([...verified.scopes.granted]),
    startCatalogueBulk: () => startCatalogueBulk(accessToken),
    pollCatalogueBulk: async (id: string) => publicBulk(await pollCatalogueBulkInternal(accessToken, id)),
    recoverExactCatalogueStarts: (after: string) => recoverExactCatalogueStarts(accessToken, after),
    downloadCompletedCatalogue: (input: {
      operationId: string;
      capturedAt: string;
    }) => downloadCompletedCatalogue(accessToken, input),
    readFullProduct: (id: string) => readFullProduct(accessToken, id),
    clearCompareAtPricesAtomic: (input: {
      productId: string;
      variantIds: readonly string[];
      allowPartialUpdates: false;
    }) => clearCompareAtPricesAtomic(accessToken, input),
  });
}
