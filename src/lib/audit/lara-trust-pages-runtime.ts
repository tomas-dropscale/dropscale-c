import "server-only";

import { decryptToken } from "@/lib/google-ads/crypto";
import { createServiceClient } from "@/lib/supabase/service";
import {
  LARA_TRUST_PAGE_TARGETS,
  type LaraTrustPageReader,
  type LaraTrustPageState,
  type LaraTrustPageWriteCommand,
  type LaraTrustPageWriter,
} from "./lara-trust-pages";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  buildShopifyRemediationCas,
  LARA_ROVINJ_REMEDIATION_SHOP,
  remediationSha256,
  type PageBeforeSnapshot,
  type PageRemediationCas,
} from "./shopify-remediation-plan";
import {
  AUDIT_SHOPIFY_API_VERSION,
  exchangeAuditClientCredentials,
  normalizeAuditShopDomain,
  verifyAuditShop,
} from "./shopify";

/**
 * Dedicated Shopify write boundary for the two approved Lara trust pages.
 *
 * It intentionally exposes no arbitrary GraphQL executor. The only mutation
 * document is `pageUpdate`, and its complete input contains only `body` for one
 * of the two hard-pinned page ids. All identity, publication and template
 * fields are re-read and protected by an optimistic compare-and-set first.
 */

const CONNECTION_COLUMNS =
  "id, status, shopify_shop_id, shopify_domain, shopify_client_id, granted_scopes, audit_shopify_credentials(client_secret_ciphertext)" as const;
const PAGE_GID = /^gid:\/\/shopify\/Page\/[1-9][0-9]*$/;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGE_BODY_BYTES = 500_000;

const TARGET_BY_ID = new Map<string, (typeof LARA_TRUST_PAGE_TARGETS)[number]>(
  LARA_TRUST_PAGE_TARGETS.map((target) => [target.resourceId, target] as const),
);

export const LARA_TRUST_PAGES_QUERY = `#graphql
  query LaraTrustPages($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Page {
        id
        title
        handle
        body
        templateSuffix
        isPublished
        publishedAt
        updatedAt
      }
    }
  }
`;

export const LARA_TRUST_PAGE_BODY_MUTATION = `#graphql
  mutation LaraTrustPageBody($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page {
        id
        title
        handle
        body
        templateSuffix
        isPublished
        publishedAt
        updatedAt
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

export const LARA_TRUST_PAGES_GRAPHQL_MANIFEST = Object.freeze({
  pages: LARA_TRUST_PAGES_QUERY,
  replaceBody: LARA_TRUST_PAGE_BODY_MUTATION,
});

export type LaraTrustPagesRuntime = LaraTrustPageReader &
  LaraTrustPageWriter &
  Readonly<{
    connectionId: typeof LARA_AUDIT_CONNECTION.connectionId;
    shopId: typeof LARA_AUDIT_CONNECTION.shopId;
    shopDomain: typeof LARA_AUDIT_CONNECTION.shopDomain;
  }>;

export type LaraTrustPagesRuntimeErrorCode =
  | "connection_invalid"
  | "connection_unavailable"
  | "credential_unavailable"
  | "graphql_error"
  | "invalid_page"
  | "invalid_target"
  | "missing_read_content"
  | "missing_write_content"
  | "mutation_ambiguous"
  | "shop_mismatch"
  | "shopify_unavailable"
  | "unsupported_api_version";

export class LaraTrustPagesRuntimeError extends Error {
  constructor(
    public readonly code: LaraTrustPagesRuntimeErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "LaraTrustPagesRuntimeError";
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

type PagesEnvelope = {
  data?: { nodes?: unknown };
  errors?: unknown;
};

type MutationEnvelope = {
  data?: {
    pageUpdate?: {
      page?: unknown;
      userErrors?: unknown;
    };
  };
  errors?: unknown;
};

function runtimeError(
  code: LaraTrustPagesRuntimeErrorCode,
  message: string,
  retryable = false,
) {
  return new LaraTrustPagesRuntimeError(code, message, retryable);
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

function exactTarget(resourceId: string, handle?: string) {
  const target = TARGET_BY_ID.get(resourceId);
  if (!target || (handle !== undefined && target.handle !== handle)) {
    throw runtimeError(
      "invalid_target",
      "The trust-page runtime only accepts the two exact approved Lara pages.",
    );
  }
  return target;
}

function assertPinnedShop(shop: {
  domain: string;
  shopId: string;
}): void {
  if (
    shop.domain !== LARA_ROVINJ_REMEDIATION_SHOP.domain ||
    shop.shopId !== LARA_ROVINJ_REMEDIATION_SHOP.shopId
  ) {
    throw runtimeError("shop_mismatch", "The trust-page request targets another shop.");
  }
}

function parsePage(value: unknown): LaraTrustPageState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError("invalid_page", "Shopify did not return a trust page.");
  }
  const page = value as Record<string, unknown>;
  if (
    typeof page.id !== "string" ||
    !PAGE_GID.test(page.id) ||
    typeof page.handle !== "string" ||
    !HANDLE.test(page.handle) ||
    typeof page.title !== "string" ||
    page.title.length > 255 ||
    typeof page.body !== "string" ||
    new TextEncoder().encode(page.body).byteLength > 1_000_000 ||
    (page.templateSuffix !== null && typeof page.templateSuffix !== "string") ||
    typeof page.isPublished !== "boolean" ||
    (page.publishedAt !== null &&
      (typeof page.publishedAt !== "string" ||
        !Number.isFinite(Date.parse(page.publishedAt)))) ||
    typeof page.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(page.updatedAt))
  ) {
    throw runtimeError("invalid_page", "Shopify returned an invalid trust page.");
  }
  const target = exactTarget(page.id, page.handle);
  if (page.title !== target.title) {
    throw runtimeError("invalid_page", "The protected trust-page title changed.");
  }
  return Object.freeze({
    id: page.id,
    title: page.title,
    handle: page.handle,
    bodyHtml: page.body,
    templateSuffix: page.templateSuffix,
    isPublished: page.isPublished,
    publishedAt: page.publishedAt,
    updatedAt: page.updatedAt,
  }) as LaraTrustPageState;
}

async function postGraphql(
  accessToken: string,
  document: string,
  variables: Record<string, unknown>,
  mutation: boolean,
) {
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
        ? "The page mutation outcome is ambiguous and must be reconciled."
        : "Shopify could not be reached for the trust-page read.",
      !mutation,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function requireUsableResponse(response: Response, mutation: boolean) {
  if (response.headers.get("x-shopify-api-version") !== AUDIT_SHOPIFY_API_VERSION) {
    throw runtimeError(
      mutation ? "mutation_ambiguous" : "unsupported_api_version",
      mutation
        ? "Shopify did not confirm the mutation API version; reconcile the page state."
        : "Shopify served an unexpected API version.",
    );
  }
  if (response.status >= 300 || !response.ok) {
    throw runtimeError(
      mutation ? "mutation_ambiguous" : "shopify_unavailable",
      mutation
        ? "Shopify did not confirm the page mutation; reconcile its state."
        : "Shopify rejected the trust-page read.",
      !mutation && (response.status === 429 || response.status >= 500),
    );
  }
}

function validateRequestedIds(resourceIds: readonly string[]) {
  if (
    resourceIds.length < 1 ||
    resourceIds.length > LARA_TRUST_PAGE_TARGETS.length ||
    new Set(resourceIds).size !== resourceIds.length
  ) {
    throw runtimeError("invalid_target", "The trust-page id set is invalid.");
  }
  resourceIds.forEach((resourceId) => exactTarget(resourceId));
  return [...resourceIds];
}

async function readPages(
  accessToken: string,
  input: Parameters<LaraTrustPageReader["readPages"]>[0],
): Promise<readonly LaraTrustPageState[]> {
  assertPinnedShop(input.shop);
  const ids = validateRequestedIds(input.resourceIds);
  const response = await postGraphql(
    accessToken,
    LARA_TRUST_PAGES_QUERY,
    { ids },
    false,
  );
  requireUsableResponse(response, false);
  let envelope: PagesEnvelope;
  try {
    envelope = (await response.json()) as PagesEnvelope;
  } catch {
    throw runtimeError("graphql_error", "Shopify returned invalid trust-page JSON.");
  }
  if (envelope.errors || !Array.isArray(envelope.data?.nodes)) {
    throw runtimeError("graphql_error", "Shopify could not read the trust pages.");
  }
  const pages = envelope.data.nodes
    .filter((node): node is NonNullable<typeof node> => node !== null)
    .map(parsePage);
  const byId = new Map(pages.map((page) => [page.id, page] as const));
  if (byId.size !== pages.length || pages.some((page) => !ids.includes(page.id))) {
    throw runtimeError("invalid_page", "Shopify returned an unexpected trust page.");
  }
  return Object.freeze(ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
}

function pageSnapshot(page: LaraTrustPageState): PageBeforeSnapshot {
  return {
    kind: "page",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    capturedAt: page.updatedAt,
    target: { resourceId: page.id, handle: page.handle },
    state: {
      title: page.title,
      bodyHtml: page.bodyHtml,
      templateSuffix: page.templateSuffix,
      isPublished: page.isPublished,
      publishedAt: page.publishedAt,
      updatedAt: page.updatedAt,
    },
  };
}

async function expectationMatches(
  current: LaraTrustPageState,
  command: LaraTrustPageWriteCommand,
) {
  const cas = (await buildShopifyRemediationCas(
    pageSnapshot(current),
  )) as PageRemediationCas;
  return (
    command.expected.updatedAt === current.updatedAt &&
    command.expected.bodySha256 === (await remediationSha256(current.bodyHtml)) &&
    command.expected.protectedFieldsSha256 ===
      (await remediationSha256(cas.protectedFields))
  );
}

async function mutateBody(
  accessToken: string,
  resourceId: string,
  bodyHtml: string,
) {
  const response = await postGraphql(
    accessToken,
    LARA_TRUST_PAGE_BODY_MUTATION,
    { id: resourceId, page: { body: bodyHtml } },
    true,
  );
  requireUsableResponse(response, true);
  let envelope: MutationEnvelope;
  try {
    envelope = (await response.json()) as MutationEnvelope;
  } catch {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned invalid mutation JSON; reconcile the page state.",
    );
  }
  if (envelope.errors) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned a mutation-level error; reconcile the page state.",
    );
  }
  const payload = envelope.data?.pageUpdate;
  if (!payload || !Array.isArray(payload.userErrors)) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify omitted the page mutation result; reconcile the page state.",
    );
  }
  if (payload.userErrors.length > 0) {
    return { status: "failed" as const, errorCode: "MUTATION_REJECTED" };
  }
  try {
    return { status: "written" as const, page: parsePage(payload.page) };
  } catch {
    // The mutation can already be committed even when Shopify returns an
    // unusable page projection. Keep this outcome reconcilable rather than
    // misclassifying it as a definite validation failure.
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned an invalid page after mutation; reconcile the page state.",
    );
  }
}

async function replaceBodyIfUnchanged(
  accessToken: string,
  command: LaraTrustPageWriteCommand,
): ReturnType<LaraTrustPageWriter["replaceBodyIfUnchanged"]> {
  assertPinnedShop(command.shop);
  exactTarget(command.target.resourceId, command.target.handle);
  if (
    typeof command.bodyHtml !== "string" ||
    new TextEncoder().encode(command.bodyHtml).byteLength > MAX_PAGE_BODY_BYTES
  ) {
    throw runtimeError("invalid_page", "The trust-page body is invalid.");
  }
  const [current] = await readPages(accessToken, {
    shop: command.shop,
    resourceIds: [command.target.resourceId],
  });
  if (!current) return { status: "failed", errorCode: "PAGE_NOT_FOUND" };
  if (!(await expectationMatches(current, command))) {
    return { status: "cas_mismatch", current };
  }

  const result = await mutateBody(accessToken, command.target.resourceId, command.bodyHtml);
  if (result.status === "failed") return result;
  if (
    result.page.id !== current.id ||
    result.page.handle !== current.handle ||
    result.page.title !== current.title ||
    result.page.templateSuffix !== current.templateSuffix ||
    result.page.isPublished !== current.isPublished ||
    result.page.publishedAt !== current.publishedAt ||
    result.page.bodyHtml !== command.bodyHtml
  ) {
    throw runtimeError(
      "mutation_ambiguous",
      "Shopify returned a page that failed protected-field verification.",
    );
  }
  return { status: "written", before: current, after: result.page };
}

/** Create a fresh-token, exact-shop reader/writer for this one repair batch. */
export async function createLaraTrustPagesRuntime(): Promise<LaraTrustPagesRuntime> {
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
  if (!storedScopes.includes("read_content")) {
    throw runtimeError("missing_read_content", "The Lara app cannot read pages.");
  }
  if (!storedScopes.includes("write_content")) {
    throw runtimeError("missing_write_content", "The Lara app cannot update pages.");
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
  if (!verified.scopes.granted.includes("read_content")) {
    throw runtimeError("missing_read_content", "The verified app cannot read pages.");
  }
  if (!verified.scopes.granted.includes("write_content")) {
    throw runtimeError("missing_write_content", "The verified app cannot update pages.");
  }

  return Object.freeze({
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    shopId: LARA_AUDIT_CONNECTION.shopId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    readPages: (input: Parameters<LaraTrustPageReader["readPages"]>[0]) =>
      readPages(accessToken, input),
    replaceBodyIfUnchanged: (command: LaraTrustPageWriteCommand) =>
      replaceBodyIfUnchanged(accessToken, command),
  });
}
