import "server-only";

import { decryptToken } from "@/lib/google-ads/crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  AUDIT_SHOPIFY_API_VERSION,
  exchangeAuditClientCredentials,
  normalizeAuditShopDomain,
  verifyAuditShop,
} from "./shopify";

/**
 * Dedicated write boundary for the one-shot Lara priority quarantine.
 *
 * It deliberately does not reuse or extend the collector's query-only runtime:
 * callers receive two fixed-purpose methods, never a GraphQL executor or access
 * token. The only mutation document in this module can set Product.status to
 * DRAFT and its variables are constructed here from an exact product GID.
 */

const CONNECTION_COLUMNS =
  "id, status, shopify_shop_id, shopify_domain, shopify_client_id, granted_scopes, audit_shopify_credentials(client_secret_ciphertext)" as const;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUEST_TIMEOUT_MS = 15_000;

export const LARA_PRIORITY_PRODUCT_QUERY = `#graphql
  query LaraPriorityQuarantineProduct($handle: String!) {
    product: productByIdentifier(identifier: { handle: $handle }) {
      id
      handle
      title
      status
      updatedAt
      vendor
    }
  }
`;

export const LARA_PRIORITY_PRODUCT_DRAFT_MUTATION = `#graphql
  mutation LaraPriorityQuarantineToDraft($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        handle
        title
        status
        updatedAt
        vendor
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const LARA_PRIORITY_QUARANTINE_GRAPHQL_MANIFEST = Object.freeze({
  product: LARA_PRIORITY_PRODUCT_QUERY,
  quarantineToDraft: LARA_PRIORITY_PRODUCT_DRAFT_MUTATION,
});

export type LaraPriorityProductSnapshot = Readonly<{
  id: string;
  handle: string;
  title: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  updatedAt: string;
  vendor: string;
}>;

export type LaraPriorityQuarantineRuntime = Readonly<{
  connectionId: typeof LARA_AUDIT_CONNECTION.connectionId;
  shopId: typeof LARA_AUDIT_CONNECTION.shopId;
  shopDomain: typeof LARA_AUDIT_CONNECTION.shopDomain;
  readPriorityProduct(handle: string): Promise<LaraPriorityProductSnapshot>;
  quarantineProductToDraft(productId: string): Promise<LaraPriorityProductSnapshot>;
}>;

export type LaraPriorityQuarantineRuntimeErrorCode =
  | "connection_invalid"
  | "connection_unavailable"
  | "credential_unavailable"
  | "graphql_error"
  | "invalid_product"
  | "missing_read_products"
  | "missing_write_products"
  | "mutation_ambiguous"
  | "mutation_rejected"
  | "shop_mismatch"
  | "shopify_unavailable"
  | "unsupported_api_version";

export class LaraPriorityQuarantineRuntimeError extends Error {
  constructor(
    public readonly code: LaraPriorityQuarantineRuntimeErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "LaraPriorityQuarantineRuntimeError";
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

type ProductEnvelope = {
  data?: { product?: unknown };
  errors?: unknown;
};

type MutationEnvelope = {
  data?: {
    productUpdate?: {
      product?: unknown;
      userErrors?: unknown;
    };
  };
  errors?: unknown;
};

function runtimeError(
  code: LaraPriorityQuarantineRuntimeErrorCode,
  message: string,
  retryable = false,
) {
  return new LaraPriorityQuarantineRuntimeError(code, message, retryable);
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

function parseProduct(value: unknown): LaraPriorityProductSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError("invalid_product", "Shopify did not return the quarantine product.");
  }
  const product = value as Record<string, unknown>;
  if (
    typeof product.id !== "string" ||
    !PRODUCT_GID.test(product.id) ||
    typeof product.handle !== "string" ||
    !HANDLE.test(product.handle) ||
    typeof product.title !== "string" ||
    product.title.length > 500 ||
    (product.status !== "ACTIVE" &&
      product.status !== "DRAFT" &&
      product.status !== "ARCHIVED") ||
    typeof product.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(product.updatedAt)) ||
    typeof product.vendor !== "string" ||
    product.vendor.length > 255
  ) {
    throw runtimeError("invalid_product", "Shopify returned an invalid quarantine product.");
  }
  return Object.freeze({
    id: product.id,
    handle: product.handle,
    title: product.title,
    status: product.status,
    updatedAt: product.updatedAt,
    vendor: product.vendor,
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
      mutation ? "mutation_ambiguous" : "shopify_unavailable",
      mutation
        ? "The quarantine mutation outcome is ambiguous and must be reconciled."
        : "Shopify could not be reached for the quarantine read.",
      !mutation,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function requireUsableResponse(response: Response, mutation: boolean) {
  if (
    response.status >= 300 ||
    !response.ok ||
    response.headers.get("x-shopify-api-version") !== AUDIT_SHOPIFY_API_VERSION
  ) {
    if (response.headers.get("x-shopify-api-version") !== AUDIT_SHOPIFY_API_VERSION) {
      throw runtimeError(
        mutation ? "mutation_ambiguous" : "unsupported_api_version",
        mutation
          ? "Shopify served an unexpected version after the quarantine mutation; reconcile its state."
          : "Shopify served an unexpected API version.",
      );
    }
    throw runtimeError(
      mutation ? "mutation_ambiguous" : "shopify_unavailable",
      mutation
        ? "Shopify did not confirm the quarantine mutation; reconcile its state."
        : "Shopify rejected the quarantine read.",
      !mutation && (response.status === 429 || response.status >= 500),
    );
  }
}

async function readProduct(accessToken: string, handle: string) {
  if (!HANDLE.test(handle) || handle.length > 255) {
    throw runtimeError("invalid_product", "The quarantine product handle is invalid.");
  }
  const response = await postGraphql(
    accessToken,
    LARA_PRIORITY_PRODUCT_QUERY,
    { handle },
    false,
  );
  await requireUsableResponse(response, false);
  let envelope: ProductEnvelope;
  try {
    envelope = (await response.json()) as ProductEnvelope;
  } catch {
    throw runtimeError("graphql_error", "Shopify returned invalid quarantine JSON.");
  }
  if (envelope.errors || !envelope.data?.product) {
    throw runtimeError("graphql_error", "Shopify could not read the quarantine product.");
  }
  return parseProduct(envelope.data.product);
}

async function quarantineProduct(accessToken: string, productId: string) {
  if (!PRODUCT_GID.test(productId)) {
    throw runtimeError("invalid_product", "The quarantine product ID is invalid.");
  }
  // This object is the complete mutation input. Vendor is intentionally absent
  // and cannot be supplied by a caller.
  const product = Object.freeze({ id: productId, status: "DRAFT" as const });
  const response = await postGraphql(
    accessToken,
    LARA_PRIORITY_PRODUCT_DRAFT_MUTATION,
    { product },
    true,
  );
  await requireUsableResponse(response, true);
  let envelope: MutationEnvelope;
  try {
    envelope = (await response.json()) as MutationEnvelope;
  } catch {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned invalid mutation JSON; reconcile its state.",
    );
  }
  if (envelope.errors) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned a mutation-level error; reconcile its state.",
    );
  }
  const payload = envelope.data?.productUpdate;
  if (!payload || !Array.isArray(payload.userErrors)) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify omitted the mutation result; reconcile its state.",
    );
  }
  if (payload.userErrors.length > 0) {
    throw runtimeError("mutation_rejected", "Shopify rejected the quarantine mutation.");
  }
  try {
    return parseProduct(payload.product);
  } catch {
    // With no userErrors, a malformed/omitted response snapshot cannot prove
    // that Shopify declined the write. Preserve the prepared checkpoint and
    // reconcile by an exact Admin read instead of treating it as definitive.
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned an invalid mutation snapshot; reconcile its state.",
    );
  }
}

/** Create the exact Lara writer after re-verifying connection, grant and shop. */
export async function createLaraPriorityQuarantineRuntime(): Promise<LaraPriorityQuarantineRuntime> {
  const service = createServiceClient();
  if (!service) {
    throw runtimeError("connection_unavailable", "Server-side Shopify access is unavailable.");
  }
  const { data, error } = await service
    .from("audit_shopify_connections")
    .select(CONNECTION_COLUMNS)
    .eq("id", LARA_AUDIT_CONNECTION.connectionId)
    .maybeSingle();
  if (error || !data) {
    throw runtimeError("connection_unavailable", "The Lara audit connection is unavailable.");
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
    throw runtimeError("shop_mismatch", "The writer is not bound to the expected Lara shop.");
  }
  const storedScopes = [...new Set(row.granted_scopes as string[])].sort();
  if (!storedScopes.includes("read_products")) {
    throw runtimeError("missing_read_products", "The Lara app cannot read products.");
  }
  if (!storedScopes.includes("write_products")) {
    throw runtimeError("missing_write_products", "The Lara app cannot quarantine products.");
  }
  const ciphertext = credentialCiphertext(row.audit_shopify_credentials);
  if (!ciphertext) {
    throw runtimeError("credential_unavailable", "The Lara audit credential is unavailable.");
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
    throw runtimeError("credential_unavailable", "The Lara audit credential could not be used.");
  } finally {
    secret = "";
  }

  let verified;
  try {
    verified = await verifyAuditShop({ shopDomain: storedDomain, accessToken });
  } catch {
    throw runtimeError("shopify_unavailable", "Shopify could not verify the Lara shop.");
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
    throw runtimeError("connection_invalid", "The Shopify grant changed after connection.");
  }
  if (!verified.scopes.granted.includes("write_products")) {
    throw runtimeError("missing_write_products", "The verified app cannot quarantine products.");
  }

  return Object.freeze({
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    shopId: LARA_AUDIT_CONNECTION.shopId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    readPriorityProduct: (handle: string) => readProduct(accessToken, handle),
    quarantineProductToDraft: (productId: string) =>
      quarantineProduct(accessToken, productId),
  });
}
