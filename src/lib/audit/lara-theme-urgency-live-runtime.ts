import "server-only";

import { createHash } from "node:crypto";

import { decryptToken } from "@/lib/google-ads/crypto";
import { createServiceClient } from "@/lib/supabase/service";
import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_REST_THEME_ID,
  LARA_THEME_URGENCY_SOURCE_QUERY,
  LARA_THEME_URGENCY_THEME,
  readLaraThemeUrgencySnapshot,
  type LaraThemeUrgencyFilename,
  type LaraThemeUrgencyReadRuntime,
  type LaraThemeUrgencyRestAsset,
} from "./lara-theme-urgency-plan";
import {
  LARA_THEME_FILES_UPSERT_MUTATION,
  LARA_THEME_JOB_QUERY,
} from "./lara-theme-urgency-executor";
import {
  classifyLaraThemeUrgencyLiveState,
  laraThemeUrgencyOperationFilenames,
  verifyLaraThemeUrgencyLiveMaterial,
  type LaraThemeUrgencyLiveMaterial,
} from "./lara-theme-urgency-live-contract";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  AUDIT_SHOPIFY_API_VERSION,
  exchangeAuditClientCredentials,
  normalizeAuditShopDomain,
  verifyAuditShop,
} from "./shopify";

const CONNECTION_COLUMNS =
  "id, status, shopify_shop_id, shopify_domain, shopify_client_id, granted_scopes, audit_shopify_credentials(client_secret_ciphertext)" as const;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REST_ASSET_ENVELOPE_BYTES = 12_500_000;
const MAX_REST_ASSET_FILE_BYTES = 2_000_000;
const MD5 = /^[a-f0-9]{32}$/;
const JOB_GID = /^gid:\/\/shopify\/Job\/[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const REST_ASSET_FIELDS = Object.freeze([
  "key",
  "value",
  "updated_at",
  "content_type",
  "size",
  "checksum",
  "theme_id",
] as const);

export const LARA_THEME_URGENCY_GRAPHQL_MANIFEST = Object.freeze({
  source: LARA_THEME_URGENCY_SOURCE_QUERY,
  upsert: LARA_THEME_FILES_UPSERT_MUTATION,
  job: LARA_THEME_JOB_QUERY,
});

export const LARA_THEME_URGENCY_REST_ASSET_MANIFEST = Object.freeze({
  method: "GET",
  apiVersion: AUDIT_SHOPIFY_API_VERSION,
  themeId: LARA_THEME_URGENCY_REST_THEME_ID,
  path: `/admin/api/${AUDIT_SHOPIFY_API_VERSION}/themes/${LARA_THEME_URGENCY_REST_THEME_ID}/assets.json`,
  fields: REST_ASSET_FIELDS,
  filenames: LARA_THEME_URGENCY_FILES,
  // Cloudflare must observe redirects without following them. `manual` keeps
  // the Shopify token on the original host and lets the response validator
  // reject every 3xx explicitly; `error` collapses a redirect into the same
  // fetch exception as a network failure and removes useful safe evidence.
  redirects: "manual",
  writesAllowed: false,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  response: Object.freeze({
    status: 200,
    mediaType: "application/json; optional charset=utf-8",
    jsonAssetContentType: "application/json",
    liquidAssetContentType: "application/x-liquid",
    maxEnvelopeBytes: MAX_REST_ASSET_ENVELOPE_BYTES,
    maxFileBytes: MAX_REST_ASSET_FILE_BYTES,
    exactFields: true,
    exactSizeAndMd5: true,
    mustMatchPrecedingGraphqlMetadata: true,
  }),
} as const);

export type LaraThemeUrgencySubmitResult =
  | Readonly<{
      status: "completed";
      filenames: readonly LaraThemeUrgencyFilename[];
      jobId: null;
      exemptionConfirmedByShopify: true;
    }>
  | Readonly<{
      status: "pending";
      filenames: readonly LaraThemeUrgencyFilename[];
      jobId: string;
      exemptionConfirmedByShopify: true;
    }>;

export type LaraThemeUrgencyLiveRuntime = LaraThemeUrgencyReadRuntime &
  Readonly<{
    connectionId: typeof LARA_AUDIT_CONNECTION.connectionId;
    shopId: typeof LARA_AUDIT_CONNECTION.shopId;
    shopDomain: typeof LARA_AUDIT_CONNECTION.shopDomain;
    apiVersion: typeof AUDIT_SHOPIFY_API_VERSION;
    themeId: typeof LARA_THEME_URGENCY_THEME.id;
    themeFileWriteRequirement: "write_themes_and_shopify_exemption";
    readExactThemeAsset(
      filename: LaraThemeUrgencyFilename,
    ): Promise<LaraThemeUrgencyRestAsset>;
    submitApprovedPlan(
      material: LaraThemeUrgencyLiveMaterial,
    ): Promise<LaraThemeUrgencySubmitResult>;
    readAsyncJob(jobId: string): Promise<Readonly<{ id: string; done: boolean }>>;
  }>;

export type LaraThemeUrgencyLiveRuntimeErrorCode =
  | "connection_invalid"
  | "connection_unavailable"
  | "credential_unavailable"
  | "graphql_error"
  | "invalid_job"
  | "invalid_plan"
  | "invalid_source_query"
  | "invalid_rest_asset"
  | "invalid_rest_asset_envelope"
  | "invalid_rest_asset_fields"
  | "invalid_rest_asset_integrity"
  | "invalid_rest_asset_json"
  | "invalid_rest_asset_redirect"
  | "invalid_rest_asset_response"
  | "missing_read_themes"
  | "missing_write_themes"
  | "mutation_ambiguous"
  | "mutation_rejected"
  | "rest_asset_body_unavailable"
  | "rest_asset_fetch_unavailable"
  | "rest_asset_upstream_unavailable"
  | "rest_asset_unavailable"
  | "shop_mismatch"
  | "shop_verification_unavailable"
  | "shopify_unavailable"
  | "source_query_unavailable"
  | "source_drift"
  | "theme_write_exemption_unavailable"
  | "unsupported_api_version";

export class LaraThemeUrgencyLiveRuntimeError extends Error {
  constructor(
    public readonly code: LaraThemeUrgencyLiveRuntimeErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "LaraThemeUrgencyLiveRuntimeError";
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

type GraphqlEnvelope<TData> = {
  data?: TData;
  errors?: unknown;
};

type ThemeUpsertData = {
  themeFilesUpsert?: {
    upsertedThemeFiles?: unknown;
    job?: unknown;
    userErrors?: unknown;
  } | null;
};

type JobData = { job?: unknown };

function runtimeError(
  code: LaraThemeUrgencyLiveRuntimeErrorCode,
  message: string,
  retryable = false,
) {
  return new LaraThemeUrgencyLiveRuntimeError(code, message, retryable);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function credentialCiphertext(value: unknown): string | null {
  const entry = Array.isArray(value)
    ? value.length === 1
      ? value[0]
      : null
    : value;
  const record = objectRecord(entry);
  return typeof record?.client_secret_ciphertext === "string" &&
    record.client_secret_ciphertext.length > 0
    ? record.client_secret_ciphertext
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validateSourceVariables(variables: Record<string, unknown>) {
  if (
    !exactKeys(variables, ["themeId", "filenames"]) ||
    variables.themeId !== LARA_THEME_URGENCY_THEME.id ||
    !Array.isArray(variables.filenames) ||
    variables.filenames.length !== 1 ||
    typeof variables.filenames[0] !== "string" ||
    !LARA_THEME_URGENCY_FILES.includes(
      variables.filenames[0] as LaraThemeUrgencyFilename,
    )
  ) {
    throw runtimeError(
      "invalid_source_query",
      "The theme runtime only accepts one fixed Lara source filename.",
    );
  }
}

function graphqlErrorCodes(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((value) => {
    const error = objectRecord(value);
    const extensions = objectRecord(error?.extensions);
    return typeof extensions?.code === "string"
      ? [extensions.code.toUpperCase()]
      : [];
  });
}

function allAccessDenied(errors: unknown): boolean {
  const codes = graphqlErrorCodes(errors);
  return codes.length > 0 && codes.every((code) => code === "ACCESS_DENIED");
}

function graphqlErrorsRetryable(errors: unknown): boolean {
  const codes = graphqlErrorCodes(errors);
  return (
    codes.length > 0 &&
    codes.every((code) => code === "THROTTLED" || code === "INTERNAL_SERVER_ERROR")
  );
}

function parseThemeUserErrors(errors: unknown): Array<{ code: string | null }> {
  if (!Array.isArray(errors)) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify omitted the exact theme mutation user errors.",
    );
  }
  return errors.map((value) => {
    const error = objectRecord(value);
    if (
      !error ||
      !exactKeys(error, ["code", "field", "filename", "message"]) ||
      (error.code !== null && typeof error.code !== "string") ||
      (error.field !== null &&
        (!Array.isArray(error.field) ||
          error.field.some((part) => typeof part !== "string"))) ||
      (error.filename !== null && typeof error.filename !== "string") ||
      typeof error.message !== "string" ||
      error.message.length === 0
    ) {
      throw runtimeError(
        "mutation_ambiguous",
        "Shopify returned malformed exact theme mutation user errors.",
      );
    }
    return {
      code: typeof error.code === "string" ? error.code.toUpperCase() : null,
    };
  });
}

async function postGraphql(
  accessToken: string,
  document: string,
  variables: Record<string, unknown>,
  mutation: boolean,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(
      `https://${LARA_AUDIT_CONNECTION.shopDomain}/admin/api/${AUDIT_SHOPIFY_API_VERSION}/graphql.json`,
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
    throw runtimeError(
      mutation ? "mutation_ambiguous" : "source_query_unavailable",
      mutation
        ? "The exact theme mutation outcome is ambiguous and must be reconciled."
        : "Shopify could not be reached for the exact theme read.",
      !mutation,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function requireUsableResponse(response: Response, mutation: boolean): void {
  if (response.headers.get("x-shopify-api-version") !== AUDIT_SHOPIFY_API_VERSION) {
    throw runtimeError(
      mutation ? "mutation_ambiguous" : "unsupported_api_version",
      mutation
        ? "Shopify served an unexpected version after the exact theme mutation."
        : "Shopify served an unexpected API version for the theme read.",
      !mutation,
    );
  }
  if (response.status >= 300 || !response.ok) {
    throw runtimeError(
      mutation ? "mutation_ambiguous" : "source_query_unavailable",
      mutation
        ? "Shopify did not confirm the exact theme mutation."
        : "Shopify rejected the exact theme read.",
      !mutation && (response.status === 429 || response.status >= 500),
    );
  }
}

async function parseEnvelope<TData>(
  response: Response,
  mutation: boolean,
): Promise<GraphqlEnvelope<TData>> {
  requireUsableResponse(response, mutation);
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw runtimeError(
      mutation ? "mutation_ambiguous" : "graphql_error",
      mutation
        ? "Shopify returned invalid mutation JSON; reconcile the exact theme state."
        : "Shopify returned invalid theme query JSON.",
      !mutation,
    );
  }
  if (!objectRecord(envelope)) {
    throw runtimeError(
      mutation ? "mutation_ambiguous" : "graphql_error",
      "Shopify returned an invalid exact theme GraphQL envelope.",
      !mutation,
    );
  }
  return envelope as GraphqlEnvelope<TData>;
}

async function queryExactSource<TData>(
  accessToken: string,
  document: string,
  variables: Record<string, unknown> = {},
): Promise<TData> {
  if (document !== LARA_THEME_URGENCY_SOURCE_QUERY) {
    throw runtimeError(
      "invalid_source_query",
      "Only the fixed Lara theme source query is available.",
    );
  }
  validateSourceVariables(variables);
  const response = await postGraphql(accessToken, document, variables, false);
  const envelope = await parseEnvelope<TData>(response, false);
  if (Object.hasOwn(envelope, "errors")) {
    if (!Array.isArray(envelope.errors)) {
      throw runtimeError("graphql_error", "Shopify returned malformed theme query errors.");
    }
    if (envelope.errors.length > 0) {
      throw runtimeError(
        "graphql_error",
        "Shopify reported an exact theme source query error.",
        graphqlErrorsRetryable(envelope.errors),
      );
    }
  }
  if (!Object.hasOwn(envelope, "data")) {
    throw runtimeError("graphql_error", "Shopify omitted exact theme source data.");
  }
  return envelope.data as TData;
}

function expectedRestContentType(filename: LaraThemeUrgencyFilename): string {
  return filename.endsWith(".json") ? "application/json" : "application/x-liquid";
}

function responseIsJson(response: Response): boolean {
  const value = response.headers.get("content-type");
  return (
    typeof value === "string" &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim())
  );
}

function validContentLength(response: Response): boolean {
  const value = response.headers.get("content-length");
  if (value === null) return true;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  const size = Number(value);
  return Number.isSafeInteger(size) && size <= MAX_REST_ASSET_ENVELOPE_BYTES;
}

async function getExactRestAsset(
  accessToken: string,
  filename: LaraThemeUrgencyFilename,
): Promise<LaraThemeUrgencyRestAsset> {
  if (!LARA_THEME_URGENCY_FILES.includes(filename)) {
    throw runtimeError(
      "invalid_source_query",
      "The REST theme reader only accepts one fixed Lara source filename.",
    );
  }
  const url = new URL(
    LARA_THEME_URGENCY_REST_ASSET_MANIFEST.path,
    `https://${LARA_AUDIT_CONNECTION.shopDomain}`,
  );
  url.searchParams.set("asset[key]", filename);
  url.searchParams.set("fields", REST_ASSET_FIELDS.join(","));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "x-shopify-access-token": accessToken,
      },
    });
  } catch {
    throw runtimeError(
      "rest_asset_fetch_unavailable",
      "Shopify could not return the fixed REST theme asset.",
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (
    response.url &&
    response.url !== url.href
  ) {
    throw runtimeError(
      "invalid_rest_asset_redirect",
      "Shopify redirected the fixed REST theme asset request.",
    );
  }
  if (
    response.status !== 200 ||
    !response.ok ||
    response.headers.get("x-shopify-api-version") !==
      AUDIT_SHOPIFY_API_VERSION ||
    !responseIsJson(response) ||
    !validContentLength(response)
  ) {
    throw runtimeError(
      response.status === 429 || response.status >= 500
        ? "rest_asset_upstream_unavailable"
        : "invalid_rest_asset_response",
      "Shopify returned an invalid fixed REST theme asset response.",
      response.status === 429 || response.status >= 500,
    );
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw runtimeError(
      "rest_asset_body_unavailable",
      "Shopify interrupted the fixed REST theme asset response.",
      true,
    );
  }
  if (
    new TextEncoder().encode(raw).byteLength > MAX_REST_ASSET_ENVELOPE_BYTES
  ) {
    throw runtimeError(
      "invalid_rest_asset_envelope",
      "The fixed REST theme asset envelope exceeded its bounded size.",
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw runtimeError(
      "invalid_rest_asset_json",
      "Shopify returned malformed fixed REST theme asset JSON.",
    );
  }
  const root = objectRecord(envelope);
  const asset = objectRecord(root?.asset);
  if (
    !root ||
    !exactKeys(root, ["asset"]) ||
    !asset ||
    !exactKeys(asset, REST_ASSET_FIELDS) ||
    asset.key !== filename ||
    asset.theme_id !== LARA_THEME_URGENCY_REST_THEME_ID ||
    asset.content_type !== expectedRestContentType(filename) ||
    typeof asset.value !== "string" ||
    typeof asset.updated_at !== "string" ||
    !Number.isFinite(Date.parse(asset.updated_at)) ||
    typeof asset.size !== "number" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0 ||
    asset.size > MAX_REST_ASSET_FILE_BYTES ||
    typeof asset.checksum !== "string" ||
    !MD5.test(asset.checksum)
  ) {
    throw runtimeError(
      "invalid_rest_asset_fields",
      "Shopify returned malformed fixed REST theme asset fields.",
    );
  }
  const content = asset.value;
  const size = Number(asset.size);
  const checksumMd5 = asset.checksum;
  if (
    new TextEncoder().encode(content).byteLength !== size ||
    createHash("md5").update(content, "utf8").digest("hex") !== checksumMd5
  ) {
    throw runtimeError(
      "invalid_rest_asset_integrity",
      "The fixed REST theme asset failed its exact byte-size and MD5 proof.",
    );
  }
  return Object.freeze({
    filename,
    themeId: LARA_THEME_URGENCY_REST_THEME_ID,
    checksumMd5,
    contentType: asset.content_type,
    size,
    updatedAt: asset.updated_at,
    content,
  });
}

function parseFilenames(
  value: unknown,
  options: { allowMissing?: boolean } = {},
): LaraThemeUrgencyFilename[] {
  if (value === null || value === undefined) {
    if (options.allowMissing) return [];
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify omitted the exact theme mutation file results.",
    );
  }
  if (!Array.isArray(value)) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned malformed exact theme mutation file results.",
    );
  }
  const filenames = value.map((entry) => {
    const result = objectRecord(entry);
    if (
      typeof result?.filename !== "string" ||
      !LARA_THEME_URGENCY_FILES.includes(
        result.filename as LaraThemeUrgencyFilename,
      )
    ) {
      throw runtimeError(
        "mutation_ambiguous",
        "Shopify returned an unexpected exact theme filename.",
      );
    }
    return result.filename as LaraThemeUrgencyFilename;
  });
  if (new Set(filenames).size !== filenames.length) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned a duplicate exact theme mutation filename.",
    );
  }
  return filenames;
}

function parseJobId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const job = objectRecord(value);
  if (typeof job?.id !== "string" || !JOB_GID.test(job.id)) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned an invalid asynchronous theme job.",
    );
  }
  return job.id;
}

async function submitApprovedPlan(
  accessToken: string,
  readRuntime: LaraThemeUrgencyReadRuntime,
  input: LaraThemeUrgencyLiveMaterial,
): Promise<LaraThemeUrgencySubmitResult> {
  let material: LaraThemeUrgencyLiveMaterial;
  try {
    material = await verifyLaraThemeUrgencyLiveMaterial(input);
  } catch {
    throw runtimeError("invalid_plan", "The exact Lara live theme material is invalid.");
  }

  // Narrow the unavoidable Shopify read/write window immediately before the
  // fixed mutation. No caller can supply a theme id, filename or body.
  const current = await readLaraThemeUrgencySnapshot({
    runtime: readRuntime,
    capturedAt: material.payload.capturedAt,
  });
  if (
    (await classifyLaraThemeUrgencyLiveState({ material, current })) !==
    "before_exact"
  ) {
    throw runtimeError(
      "source_drift",
      "The exact Lara theme source changed before the write boundary.",
    );
  }

  const expectedFilenames = laraThemeUrgencyOperationFilenames(material);
  const files = material.payload.plan.payload.operations.map((operation) => ({
    filename: operation.target.filename,
    body: { type: "TEXT" as const, value: operation.after.content },
  }));
  const response = await postGraphql(
    accessToken,
    LARA_THEME_FILES_UPSERT_MUTATION,
    { themeId: LARA_THEME_URGENCY_THEME.id, files },
    true,
  );
  const envelope = await parseEnvelope<ThemeUpsertData>(response, true);
  if (Object.hasOwn(envelope, "errors")) {
    if (!Array.isArray(envelope.errors)) {
      throw runtimeError(
        "mutation_ambiguous",
        "Shopify returned malformed exact theme mutation errors.",
      );
    }
    if (envelope.errors.length > 0) {
      if (allAccessDenied(envelope.errors)) {
        throw runtimeError(
          "theme_write_exemption_unavailable",
          "Shopify has not made the required theme-file write exemption available.",
        );
      }
      throw runtimeError(
        "mutation_ambiguous",
        "Shopify returned a mutation-level error; reconcile the exact theme state.",
      );
    }
  }
  const payload = envelope.data?.themeFilesUpsert;
  if (!payload) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify omitted the exact theme mutation result.",
    );
  }
  const userErrors = parseThemeUserErrors(payload.userErrors);
  const jobId = parseJobId(payload.job);
  const filenames = parseFilenames(payload.upsertedThemeFiles, {
    allowMissing: jobId !== null || userErrors.length > 0,
  });
  if (userErrors.length > 0) {
    const userErrorCodes = userErrors.flatMap((error) =>
      error.code === null ? [] : [error.code],
    );
    if (
      filenames.length === 0 &&
      jobId === null &&
      userErrorCodes.length === userErrors.length &&
      userErrorCodes.every((code) => code === "ACCESS_DENIED")
    ) {
      throw runtimeError(
        "theme_write_exemption_unavailable",
        "Shopify has not made the required theme-file write exemption available.",
      );
    }
    if (filenames.length === 0 && jobId === null) {
      throw runtimeError(
        "mutation_rejected",
        "Shopify rejected the exact theme mutation before acknowledging a file.",
      );
    }
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify reported a possibly partial exact theme mutation.",
    );
  }
  if (filenames.some((filename) => !expectedFilenames.includes(filename))) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify acknowledged an unexpected theme filename.",
    );
  }
  if (jobId !== null) {
    return Object.freeze({
      status: "pending" as const,
      filenames: Object.freeze(filenames),
      jobId,
      exemptionConfirmedByShopify: true as const,
    });
  }
  if (
    filenames.length !== expectedFilenames.length ||
    expectedFilenames.some((filename) => !filenames.includes(filename))
  ) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify did not acknowledge the complete synchronous theme write set.",
    );
  }
  return Object.freeze({
    status: "completed" as const,
    filenames: Object.freeze(filenames),
    jobId: null,
    exemptionConfirmedByShopify: true as const,
  });
}

async function readAsyncJob(accessToken: string, jobId: string) {
  if (!JOB_GID.test(jobId)) {
    throw runtimeError("invalid_job", "The exact theme job ID is invalid.");
  }
  const response = await postGraphql(
    accessToken,
    LARA_THEME_JOB_QUERY,
    { jobId },
    false,
  );
  const envelope = await parseEnvelope<JobData>(response, false);
  if (Object.hasOwn(envelope, "errors")) {
    if (!Array.isArray(envelope.errors)) {
      throw runtimeError(
        "graphql_error",
        "Shopify returned malformed exact asynchronous job errors.",
        true,
      );
    }
    if (envelope.errors.length > 0) {
      throw runtimeError(
        "graphql_error",
        "Shopify could not read the exact asynchronous theme job.",
        graphqlErrorsRetryable(envelope.errors),
      );
    }
  }
  const job = objectRecord(envelope.data?.job);
  if (job?.id !== jobId || typeof job.done !== "boolean") {
    throw runtimeError(
      "invalid_job",
      "Shopify returned an invalid exact asynchronous theme job.",
      true,
    );
  }
  return Object.freeze({ id: jobId, done: job.done });
}

/** Create a fresh-token runtime exposing only the fixed source, mutation and job documents. */
export async function createLaraThemeUrgencyLiveRuntime(): Promise<LaraThemeUrgencyLiveRuntime> {
  const service = createServiceClient();
  if (!service) {
    throw runtimeError(
      "connection_unavailable",
      "Server-side Shopify access is unavailable.",
    );
  }
  const { data, error } = await service
    .from("audit_shopify_connections")
    .select(CONNECTION_COLUMNS)
    .eq("id", LARA_AUDIT_CONNECTION.connectionId)
    .maybeSingle();
  if (error || !data) {
    throw runtimeError(
      "connection_unavailable",
      "The Lara audit connection is unavailable.",
    );
  }

  const row = data as unknown as ConnectionRow;
  let storedDomain: string;
  try {
    storedDomain = normalizeAuditShopDomain(String(row.shopify_domain ?? ""));
  } catch {
    throw runtimeError("connection_invalid", "The Lara audit connection is invalid.");
  }
  if (
    row.id !== LARA_AUDIT_CONNECTION.connectionId ||
    row.status !== "connected" ||
    row.shopify_shop_id !== LARA_AUDIT_CONNECTION.shopId ||
    storedDomain !== LARA_AUDIT_CONNECTION.shopDomain ||
    typeof row.shopify_client_id !== "string" ||
    !Array.isArray(row.granted_scopes) ||
    row.granted_scopes.some((scope) => typeof scope !== "string")
  ) {
    throw runtimeError("shop_mismatch", "The theme runtime targets another shop.");
  }
  const storedScopes = [...new Set(row.granted_scopes as string[])].sort();
  if (!storedScopes.includes("read_themes")) {
    throw runtimeError("missing_read_themes", "The Lara app cannot read themes.");
  }
  if (!storedScopes.includes("write_themes")) {
    throw runtimeError("missing_write_themes", "The Lara app cannot update themes.");
  }
  const ciphertext = credentialCiphertext(row.audit_shopify_credentials);
  if (!ciphertext) {
    throw runtimeError(
      "credential_unavailable",
      "The Lara audit credential is unavailable.",
    );
  }

  let secret = "";
  let accessToken = "";
  try {
    secret = await decryptToken(ciphertext);
    accessToken = await exchangeAuditClientCredentials({
      shopDomain: storedDomain,
      clientId: row.shopify_client_id,
      clientSecret: secret,
    });
  } catch {
    throw runtimeError(
      "credential_unavailable",
      "The Lara audit credential could not be used.",
    );
  } finally {
    secret = "";
  }

  let verified;
  try {
    verified = await verifyAuditShop({ shopDomain: storedDomain, accessToken });
  } catch {
    throw runtimeError(
      "shop_verification_unavailable",
      "Shopify could not verify Lara.",
      true,
    );
  }
  if (
    verified.shopId !== LARA_AUDIT_CONNECTION.shopId ||
    verified.myshopifyDomain !== LARA_AUDIT_CONNECTION.shopDomain
  ) {
    throw runtimeError("shop_mismatch", "Shopify verified a different shop.");
  }
  if (
    verified.scopes.granted.length !== storedScopes.length ||
    verified.scopes.granted.some((scope, index) => scope !== storedScopes[index])
  ) {
    throw runtimeError(
      "connection_invalid",
      "The Shopify grant changed after the Lara connection.",
    );
  }
  if (!verified.scopes.granted.includes("read_themes")) {
    throw runtimeError("missing_read_themes", "The verified app cannot read themes.");
  }
  if (!verified.scopes.granted.includes("write_themes")) {
    throw runtimeError(
      "missing_write_themes",
      "The verified app cannot update themes.",
    );
  }

  const query = <TData>(
    document: string,
    variables: Record<string, unknown> = {},
  ) => queryExactSource<TData>(accessToken, document, variables);
  const readRuntime: LaraThemeUrgencyReadRuntime = {
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    shopId: LARA_AUDIT_CONNECTION.shopId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    grantedScopes: Object.freeze([...verified.scopes.granted]),
    query,
    readExactThemeAsset: (filename: LaraThemeUrgencyFilename) =>
      getExactRestAsset(accessToken, filename),
  };

  return Object.freeze({
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    shopId: LARA_AUDIT_CONNECTION.shopId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    grantedScopes: readRuntime.grantedScopes,
    query,
    readExactThemeAsset: readRuntime.readExactThemeAsset!,
    apiVersion: AUDIT_SHOPIFY_API_VERSION,
    themeId: LARA_THEME_URGENCY_THEME.id,
    themeFileWriteRequirement: "write_themes_and_shopify_exemption" as const,
    submitApprovedPlan: (material: LaraThemeUrgencyLiveMaterial) =>
      submitApprovedPlan(accessToken, readRuntime, material),
    readAsyncJob: (jobId: string) => readAsyncJob(accessToken, jobId),
  });
}
