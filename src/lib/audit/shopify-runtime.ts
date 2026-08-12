import "server-only";

import { decryptToken } from "@/lib/google-ads/crypto";
import { createServiceClient } from "@/lib/supabase/service";
import {
  AUDIT_SHOPIFY_API_VERSION,
  ShopifyAuditError,
  exchangeAuditClientCredentials,
  normalizeAuditShopDomain,
  verifyAuditShop,
} from "./shopify";

const CONNECTION_COLUMNS =
  "id, status, shopify_shop_id, shopify_domain, shopify_client_id, granted_scopes, audit_shopify_credentials(client_secret_ciphertext)" as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHOP_GID = /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_QUERY_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 5_000;

declare const auditShopifyQueryDocumentBrand: unique symbol;

/**
 * An opaque read-only document for server-owned query constants. The runtime
 * also validates plain strings so it can implement the baseline executor
 * signature; callers must never pass a document from a request body.
 */
export type AuditShopifyQueryDocument = string & {
  readonly [auditShopifyQueryDocumentBrand]: true;
};

export type AuditShopifyRuntimeErrorCode =
  | "invalid_input"
  | "server_not_configured"
  | "database_error"
  | "connection_not_found"
  | "connection_not_connected"
  | "connection_record_invalid"
  | "expected_domain_mismatch"
  | "expected_shop_id_mismatch"
  | "credential_decrypt_failed"
  | "token_exchange_failed"
  | "shop_verification_failed"
  | "verified_domain_mismatch"
  | "verified_shop_id_mismatch"
  | "invalid_query"
  | "query_timeout"
  | "query_redirect"
  | "query_rate_limited"
  | "query_unauthorised"
  | "query_unavailable"
  | "query_failed"
  | "unsupported_api_version"
  | "invalid_graphql_response"
  | "graphql_errors";

export class AuditShopifyRuntimeError extends Error {
  constructor(
    public readonly code: AuditShopifyRuntimeErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AuditShopifyRuntimeError";
  }
}

export type AuditShopifyRuntime = Readonly<{
  connectionId: string;
  shopId: string;
  shopDomain: string;
  grantedScopes: readonly string[];
  query<TData>(
    document: string,
    variables?: Record<string, unknown>,
  ): Promise<TData>;
}>;

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

function runtimeError(
  code: AuditShopifyRuntimeErrorCode,
  message: string,
  retryable = false,
): AuditShopifyRuntimeError {
  return new AuditShopifyRuntimeError(code, message, retryable);
}

/**
 * A small lexer is deliberately stricter than GraphQL itself. It skips
 * comments and string contents, requires the first token to be `query`, and
 * rejects mutation/subscription tokens anywhere in the document.
 */
function operationWords(document: string): string[] {
  const words: string[] = [];
  let index = document.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (index < document.length) {
    const char = document[index];

    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "#") {
      while (index < document.length && document[index] !== "\n") index += 1;
      continue;
    }
    if (document.startsWith('"""', index)) {
      index += 3;
      while (index < document.length && !document.startsWith('"""', index)) {
        if (document[index] === "\\") index += 1;
        index += 1;
      }
      index = Math.min(document.length, index + 3);
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < document.length) {
        if (document[index] === "\\") {
          index += 2;
          continue;
        }
        if (document[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < document.length && /[A-Za-z0-9_]/.test(document[index])) {
        index += 1;
      }
      words.push(document.slice(start, index));
      continue;
    }
    index += 1;
  }

  return words;
}

function assertReadOnlyQuery(document: string): void {
  if (typeof document !== "string" || !document || document.length > 100_000) {
    throw runtimeError("invalid_query", "The audit query document is invalid.");
  }

  const words = operationWords(document);
  if (
    words[0] !== "query" ||
    words.some((word) => word === "mutation" || word === "subscription")
  ) {
    throw runtimeError(
      "invalid_query",
      "Only an explicitly named read-only Shopify query is allowed.",
    );
  }
}

/** Define a fixed server-owned GraphQL query after validating its operation. */
export function defineAuditShopifyQuery(document: string): AuditShopifyQueryDocument {
  assertReadOnlyQuery(document);
  return document as AuditShopifyQueryDocument;
}

function credentialCiphertext(value: unknown): string | null {
  const credential = Array.isArray(value)
    ? value.length === 1
      ? value[0]
      : null
    : value;
  if (!credential || typeof credential !== "object") return null;
  const ciphertext = (credential as Record<string, unknown>).client_secret_ciphertext;
  return typeof ciphertext === "string" && ciphertext.length > 0 ? ciphertext : null;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())) {
    return Math.min(Number(retryAfter) * 1_000, MAX_RETRY_DELAY_MS);
  }
  return Math.min(DEFAULT_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function graphqlErrorsRetryable(errors: unknown): boolean {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((error) => {
    if (!error || typeof error !== "object") return false;
    const record = error as Record<string, unknown>;
    const extensions =
      record.extensions && typeof record.extensions === "object"
        ? (record.extensions as Record<string, unknown>)
        : null;
    const code = typeof extensions?.code === "string" ? extensions.code : "";
    return code === "THROTTLED" || code === "INTERNAL_SERVER_ERROR";
  });
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchQuery(
  shopDomain: string,
  accessToken: string,
  document: string,
  variables: Record<string, unknown>,
): Promise<Response> {
  let body: string;
  try {
    body = JSON.stringify({ query: document, variables });
    if (typeof body !== "string") {
      throw new TypeError("The query payload is not serialisable.");
    }
  } catch {
    throw runtimeError("invalid_query", "The audit query variables are invalid.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(
      `https://${shopDomain}/admin/api/${AUDIT_SHOPIFY_API_VERSION}/graphql.json`,
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
        body,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw runtimeError("query_timeout", "Shopify took too long to answer.", true);
    }
    throw runtimeError("query_unavailable", "Shopify could not be reached.", true);
  } finally {
    clearTimeout(timeout);
  }
}

async function executeQuery<TData>(
  shopDomain: string,
  accessToken: string,
  document: string,
  variables: Record<string, unknown> = {},
): Promise<TData> {
  // Re-check at execution time so a TypeScript cast cannot bypass the runtime
  // safety boundary.
  assertReadOnlyQuery(document);

  for (let attempt = 0; attempt <= MAX_QUERY_RETRIES; attempt += 1) {
    const response = await fetchQuery(
      shopDomain,
      accessToken,
      document,
      variables,
    );

    if (response.status >= 300 && response.status < 400) {
      throw runtimeError(
        "query_redirect",
        "Shopify returned an unexpected redirect for the audit query.",
      );
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_QUERY_RETRIES) {
        await wait(retryDelayMs(response, attempt));
        continue;
      }
      throw runtimeError(
        response.status === 429 ? "query_rate_limited" : "query_unavailable",
        response.status === 429
          ? "Shopify is rate limiting the audit query."
          : "Shopify could not answer the audit query.",
        true,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw runtimeError(
        "query_unauthorised",
        "The Shopify audit connection is no longer authorised.",
      );
    }
    if (!response.ok) {
      throw runtimeError("query_failed", "Shopify rejected the audit query.");
    }

    if (response.headers.get("x-shopify-api-version") !== AUDIT_SHOPIFY_API_VERSION) {
      throw runtimeError(
        "unsupported_api_version",
        "Shopify served an unexpected API version for the audit query.",
      );
    }

    let envelope: GraphqlEnvelope<TData>;
    try {
      envelope = (await response.json()) as GraphqlEnvelope<TData>;
    } catch {
      throw runtimeError(
        "invalid_graphql_response",
        "Shopify returned an invalid audit query response.",
        true,
      );
    }

    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw runtimeError(
        "invalid_graphql_response",
        "Shopify returned an invalid audit query response.",
        true,
      );
    }
    if (Object.hasOwn(envelope, "errors")) {
      if (!Array.isArray(envelope.errors) || envelope.errors.length > 0) {
        const retryable = graphqlErrorsRetryable(envelope.errors);
        if (retryable && attempt < MAX_QUERY_RETRIES) {
          await wait(Math.min(DEFAULT_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS));
          continue;
        }
        throw runtimeError(
          "graphql_errors",
          "Shopify reported an error while running the audit query.",
          retryable,
        );
      }
    }
    if (!Object.hasOwn(envelope, "data")) {
      throw runtimeError(
        "invalid_graphql_response",
        "Shopify returned an invalid audit query response.",
        true,
      );
    }

    return envelope.data as TData;
  }

  // The bounded loop either returns data or throws a typed error.
  throw runtimeError("query_unavailable", "Shopify could not answer the audit query.", true);
}

function wrapShopifyStageError(
  stage: "token" | "verify",
  error: unknown,
): AuditShopifyRuntimeError {
  const retryable = error instanceof ShopifyAuditError ? error.retryable : false;
  if (stage === "verify" && error instanceof ShopifyAuditError) {
    if (error.code === "domain_mismatch") {
      return runtimeError(
        "verified_domain_mismatch",
        "Shopify verified a different store domain.",
      );
    }
    if (error.code === "unsupported_api_version") {
      return runtimeError(
        "unsupported_api_version",
        "Shopify served an unexpected API version while verifying the store.",
      );
    }
  }
  return runtimeError(
    stage === "token" ? "token_exchange_failed" : "shop_verification_failed",
    stage === "token"
      ? "The Shopify audit token exchange failed."
      : "The Shopify audit store verification failed.",
    retryable,
  );
}

/**
 * Creates an ephemeral, read-only client for one already-authenticated admin
 * operation. The caller must complete its session/role check before invoking
 * this service-role DAL. A fresh Shopify token is exchanged every time.
 */
export async function createAuditShopifyRuntime({
  connectionId,
  expectedShopDomain,
  expectedShopId,
  allowedQueryDocuments,
}: {
  connectionId: string;
  expectedShopDomain: string;
  expectedShopId: string;
  allowedQueryDocuments: readonly string[];
}): Promise<AuditShopifyRuntime> {
  if (
    !UUID.test(connectionId) ||
    !SHOP_GID.test(expectedShopId) ||
    !Array.isArray(allowedQueryDocuments) ||
    allowedQueryDocuments.length === 0 ||
    allowedQueryDocuments.length > 100
  ) {
    throw runtimeError("invalid_input", "The expected audit connection identity is invalid.");
  }
  const allowedQueries = new Set<string>();
  try {
    for (const document of allowedQueryDocuments) {
      assertReadOnlyQuery(document);
      allowedQueries.add(document);
    }
  } catch {
    throw runtimeError("invalid_input", "The audit query manifest is invalid.");
  }

  let expectedDomain: string;
  try {
    expectedDomain = normalizeAuditShopDomain(expectedShopDomain);
  } catch {
    throw runtimeError("invalid_input", "The expected audit connection identity is invalid.");
  }

  let service: ReturnType<typeof createServiceClient>;
  try {
    service = createServiceClient();
  } catch {
    throw runtimeError(
      "server_not_configured",
      "Server-side audit access is not configured.",
    );
  }
  if (!service) {
    throw runtimeError(
      "server_not_configured",
      "Server-side audit access is not configured.",
    );
  }

  let data: unknown = null;
  let databaseError: unknown = null;
  try {
    const result = await service
      .from("audit_shopify_connections")
      .select(CONNECTION_COLUMNS)
      .eq("id", connectionId)
      .maybeSingle();
    data = result.data;
    databaseError = result.error;
  } catch {
    throw runtimeError(
      "database_error",
      "The audit connection could not be loaded.",
      true,
    );
  }
  if (databaseError) {
    throw runtimeError("database_error", "The audit connection could not be loaded.");
  }
  if (!data) {
    throw runtimeError("connection_not_found", "The audit connection was not found.");
  }

  const row = data as unknown as ConnectionRow;
  if (row.status !== "connected") {
    throw runtimeError(
      "connection_not_connected",
      "The audit connection is not in the connected state.",
    );
  }

  if (
    row.id !== connectionId ||
    typeof row.shopify_shop_id !== "string" ||
    typeof row.shopify_domain !== "string" ||
    typeof row.shopify_client_id !== "string" ||
    !Array.isArray(row.granted_scopes) ||
    row.granted_scopes.some((scope) => typeof scope !== "string")
  ) {
    throw runtimeError(
      "connection_record_invalid",
      "The stored audit connection identity is incomplete.",
    );
  }

  let storedDomain: string;
  try {
    storedDomain = normalizeAuditShopDomain(row.shopify_domain);
  } catch {
    throw runtimeError(
      "connection_record_invalid",
      "The stored audit connection identity is incomplete.",
    );
  }
  if (storedDomain !== expectedDomain) {
    throw runtimeError(
      "expected_domain_mismatch",
      "The requested domain does not match the stored audit connection.",
    );
  }
  if (row.shopify_shop_id !== expectedShopId) {
    throw runtimeError(
      "expected_shop_id_mismatch",
      "The requested shop does not match the stored audit connection.",
    );
  }

  const ciphertext = credentialCiphertext(row.audit_shopify_credentials);
  if (!ciphertext) {
    throw runtimeError(
      "connection_record_invalid",
      "The stored audit connection credential is unavailable.",
    );
  }

  let clientSecret: string;
  try {
    clientSecret = await decryptToken(ciphertext);
  } catch {
    throw runtimeError(
      "credential_decrypt_failed",
      "The stored audit credential could not be decrypted.",
    );
  }

  let accessToken: string;
  try {
    accessToken = await exchangeAuditClientCredentials({
      shopDomain: storedDomain,
      clientId: row.shopify_client_id,
      clientSecret,
    });
  } catch (error) {
    throw wrapShopifyStageError("token", error);
  } finally {
    // Best-effort release of the plaintext reference immediately after the
    // exchange. The secret is never captured by the returned runtime.
    clientSecret = "";
  }

  if (typeof accessToken !== "string" || accessToken.length < 16) {
    throw runtimeError("token_exchange_failed", "The Shopify audit token exchange failed.");
  }

  let verifiedShop: Awaited<ReturnType<typeof verifyAuditShop>>;
  try {
    verifiedShop = await verifyAuditShop({
      shopDomain: storedDomain,
      accessToken,
    });
  } catch (error) {
    throw wrapShopifyStageError("verify", error);
  }

  let verifiedDomain: string;
  try {
    verifiedDomain = normalizeAuditShopDomain(verifiedShop.myshopifyDomain);
  } catch {
    throw runtimeError(
      "verified_domain_mismatch",
      "Shopify verified a different store domain.",
    );
  }
  if (verifiedDomain !== storedDomain || verifiedDomain !== expectedDomain) {
    throw runtimeError(
      "verified_domain_mismatch",
      "Shopify verified a different store domain.",
    );
  }
  if (
    verifiedShop.shopId !== row.shopify_shop_id ||
    verifiedShop.shopId !== expectedShopId
  ) {
    throw runtimeError(
      "verified_shop_id_mismatch",
      "Shopify verified a different store identity.",
    );
  }

  const storedScopes = [...new Set(row.granted_scopes as string[])].sort();
  const verifiedScopes = verifiedShop.scopes.granted;
  if (
    storedScopes.length !== verifiedScopes.length ||
    storedScopes.some((scope, index) => scope !== verifiedScopes[index])
  ) {
    throw runtimeError(
      "connection_record_invalid",
      "The Shopify audit grant changed after the connection was stored.",
    );
  }

  return Object.freeze({
    connectionId,
    shopId: expectedShopId,
    shopDomain: expectedDomain,
    grantedScopes: Object.freeze([...verifiedScopes]),
    async query<TData>(
      document: string,
      variables: Record<string, unknown> = {},
    ) {
      if (!allowedQueries.has(document)) {
        throw runtimeError(
          "invalid_query",
          "The audit query is not present in the approved manifest.",
        );
      }
      return executeQuery<TData>(expectedDomain, accessToken, document, variables);
    },
  });
}
