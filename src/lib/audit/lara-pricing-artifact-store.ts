import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import {
  LARA_PRICING_SALE_SCHEMA_VERSION,
  type LaraPricingImmutableArtifactStore,
} from "./lara-pricing-sale-plan";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  canonicalRemediationJson,
  remediationSha256,
} from "./shopify-remediation-plan";

/**
 * Service-only Supabase adapter for the full Lara pricing before/inverse set.
 *
 * There is deliberately no route, list operation, public URL or signed URL.
 * The database table is unreadable even to `authenticated`; the preflight and
 * object RPCs require the service role and an exact audit-run pin. Writes require the
 * current live lease. Reads require that lease, or the same final generation
 * after the run becomes terminal so recovery evidence remains usable.
 */

export const LARA_PRICING_ARTIFACT_LIMITS = Object.freeze({
  maxProductBytes: 2 * 1024 * 1024,
  maxRootBytes: 4 * 1024 * 1024,
  maxObjectsPerRun: 2_001,
  maxBytesPerRun: 128 * 1024 * 1024,
} as const);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRODUCT_SUFFIX = /^products\/[0-9]{4}\.json$/;

const SECRET_KEY_EXACT = new Set([
  "token",
  "tokenhash",
  "invitetoken",
  "invitetokenhash",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "credential",
  "credentials",
  "ciphertext",
  "password",
  "passphrase",
  "privatekey",
  "apikey",
]);
const SECRET_KEY_PART =
  /(secret|token|password|passphrase|credential|ciphertext|authorization|privatekey|apikey|bearer)/;

type RpcResult = Readonly<{
  data: unknown;
  error: unknown;
}>;

export type LaraPricingArtifactRpcClient = Readonly<{
  rpc(name: string, args: Readonly<Record<string, unknown>>): Promise<RpcResult>;
}>;

type ArtifactRpcRow = Readonly<{
  artifact_key: string;
  digest_sha256: string;
  byte_length: number;
  canonical_json: string;
}>;

export type LaraPricingArtifactStoreContext = Readonly<{
  runId: string;
  leaseToken: string;
  leaseGeneration: number;
  /** Test seam only. Production callers omit it and receive the service client. */
  client?: LaraPricingArtifactRpcClient;
}>;

export async function preflightLaraPricingArtifactStore(
  context: LaraPricingArtifactStoreContext,
): Promise<void> {
  if (
    !context ||
    !UUID.test(context.runId) ||
    !UUID.test(context.leaseToken) ||
    !Number.isSafeInteger(context.leaseGeneration) ||
    context.leaseGeneration <= 0
  ) {
    throw fail("invalid_context", "The pricing artifact preflight requires an exact run lease pin.");
  }
  let client: LaraPricingArtifactRpcClient | null | undefined = context.client;
  if (!client) {
    try {
      client = createServiceClient() as unknown as LaraPricingArtifactRpcClient | null;
    } catch {
      throw fail("server_not_configured", "The private pricing artifact store is not configured.");
    }
  }
  if (!client) {
    throw fail("server_not_configured", "The private pricing artifact store is not configured.");
  }
  let response: RpcResult;
  try {
    response = await client.rpc("assert_audit_shopify_pricing_artifact_store_ready", {
      ...rpcArgs(context),
    });
  } catch {
    throw fail("server_not_configured", "The private pricing artifact migration is unavailable.");
  }
  if (response.error || response.data !== true) {
    throw fail("server_not_configured", "The private pricing artifact migration is unavailable.");
  }
}

export type LaraPricingArtifactStoreErrorCode =
  | "server_not_configured"
  | "invalid_context"
  | "invalid_artifact"
  | "artifact_digest_mismatch"
  | "artifact_byte_length_mismatch"
  | "artifact_write_failed"
  | "artifact_read_failed"
  | "artifact_stored_mismatch";

export class LaraPricingArtifactStoreError extends Error {
  constructor(
    public readonly code: LaraPricingArtifactStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LaraPricingArtifactStoreError";
  }
}

function fail(
  code: LaraPricingArtifactStoreErrorCode,
  message: string,
): LaraPricingArtifactStoreError {
  return new LaraPricingArtifactStoreError(code, message);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function secretShapedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return SECRET_KEY_EXACT.has(normalized) || SECRET_KEY_PART.test(normalized);
}

function hasSecretShapedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretShapedKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => secretShapedKey(key) || hasSecretShapedKey(child),
  );
}

function expectedPrefix(runId: string): string {
  return `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${runId}/`;
}

function artifactSuffix(key: string, runId: string): string | null {
  const prefix = expectedPrefix(runId);
  if (!key.startsWith(prefix)) return null;
  const suffix = key.slice(prefix.length);
  return suffix === "root.json" || PRODUCT_SUFFIX.test(suffix) ? suffix : null;
}

function assertArtifactKey(key: string, runId: string): string {
  if (
    typeof key !== "string" ||
    key.length > 500 ||
    key !== key.trim().toLowerCase() ||
    key.includes("..") ||
    artifactSuffix(key, runId) === null
  ) {
    throw fail(
      "invalid_artifact",
      "The immutable pricing artifact key is outside the pinned run namespace.",
    );
  }
  return key;
}

function onlyRpcRow(value: unknown): ArtifactRpcRow | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0] as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.artifact_key !== "string" ||
    typeof row.digest_sha256 !== "string" ||
    typeof row.byte_length !== "number" ||
    !Number.isSafeInteger(row.byte_length) ||
    typeof row.canonical_json !== "string"
  ) {
    return null;
  }
  return {
    artifact_key: row.artifact_key,
    digest_sha256: row.digest_sha256,
    byte_length: row.byte_length,
    canonical_json: row.canonical_json,
  };
}

function assertPayloadShape(
  value: unknown,
  suffix: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    hasSecretShapedKey(value)
  ) {
    throw fail(
      "invalid_artifact",
      "The immutable pricing artifact is not a safe JSON object.",
    );
  }
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== LARA_PRICING_SALE_SCHEMA_VERSION) {
    throw fail(
      "invalid_artifact",
      "The immutable pricing artifact schema is not approved.",
    );
  }
  if (suffix === "root.json") {
    const shop = payload.shop as Record<string, unknown> | null;
    const vendorPolicy = payload.vendorPolicy as Record<string, unknown> | null;
    if (
      payload.kind !== "persisted_plan_root" ||
      !shop ||
      shop.domain !== LARA_AUDIT_CONNECTION.shopDomain ||
      shop.shopId !== LARA_AUDIT_CONNECTION.shopId ||
      !vendorPolicy ||
      vendorPolicy.mutationsAllowed !== false
    ) {
      throw fail(
        "invalid_artifact",
        "The immutable pricing root is not pinned to Lara and the protected vendor policy.",
      );
    }
  } else if (payload.kind !== "catalogue_product_partition") {
    throw fail(
      "invalid_artifact",
      "The immutable pricing product partition kind is invalid.",
    );
  }
}

async function verifyStoredRow({
  row,
  key,
  runId,
  expectedCanonicalJson,
  expectedDigestSha256,
  expectedByteLength,
}: {
  row: ArtifactRpcRow;
  key: string;
  runId: string;
  expectedCanonicalJson?: string;
  expectedDigestSha256?: string;
  expectedByteLength?: number;
}): Promise<unknown> {
  const suffix = artifactSuffix(key, runId);
  if (
    suffix === null ||
    row.artifact_key !== key ||
    !SHA256.test(row.digest_sha256) ||
    row.byte_length < 1 ||
    row.byte_length !== utf8Length(row.canonical_json) ||
    (expectedCanonicalJson !== undefined &&
      row.canonical_json !== expectedCanonicalJson) ||
    (expectedDigestSha256 !== undefined &&
      row.digest_sha256 !== expectedDigestSha256) ||
    (expectedByteLength !== undefined && row.byte_length !== expectedByteLength)
  ) {
    throw fail(
      "artifact_stored_mismatch",
      "The stored immutable pricing artifact metadata does not match its reference.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.canonical_json);
  } catch {
    throw fail(
      "artifact_stored_mismatch",
      "The stored immutable pricing artifact is not JSON.",
    );
  }
  assertPayloadShape(parsed, suffix);
  if (
    canonicalRemediationJson(parsed) !== row.canonical_json ||
    (await remediationSha256(parsed)) !== row.digest_sha256
  ) {
    throw fail(
      "artifact_stored_mismatch",
      "The stored immutable pricing artifact failed canonical hash validation.",
    );
  }
  return parsed;
}

function rpcArgs(context: LaraPricingArtifactStoreContext) {
  return {
    p_run_id: context.runId,
    p_connection_id: LARA_AUDIT_CONNECTION.connectionId,
    p_shopify_domain: LARA_AUDIT_CONNECTION.shopDomain,
    p_shopify_shop_id: LARA_AUDIT_CONNECTION.shopId,
    p_lease_token: context.leaseToken,
    p_lease_generation: context.leaseGeneration,
  } as const;
}

/**
 * Build a store for one exact claimed audit run. The lease is part of every
 * RPC, so a reclaimed/stale Worker cannot add or read in-flight material. The
 * final generation remains a read-only pin after completion/failure.
 */
export function createLaraPricingArtifactStore(
  context: LaraPricingArtifactStoreContext,
): LaraPricingImmutableArtifactStore {
  if (
    !context ||
    !UUID.test(context.runId) ||
    !UUID.test(context.leaseToken) ||
    !Number.isSafeInteger(context.leaseGeneration) ||
    context.leaseGeneration <= 0
  ) {
    throw fail(
      "invalid_context",
      "The immutable pricing store requires an exact run lease pin.",
    );
  }

  let client: LaraPricingArtifactRpcClient | null | undefined = context.client;
  if (!client) {
    try {
      client = createServiceClient() as unknown as
        | LaraPricingArtifactRpcClient
        | null;
    } catch {
      throw fail(
        "server_not_configured",
        "The private pricing artifact store is not configured on this server.",
      );
    }
  }
  if (!client) {
    throw fail(
      "server_not_configured",
      "The private pricing artifact store is not configured on this server.",
    );
  }
  const baseArgs = rpcArgs(context);

  const read = async (keyInput: string): Promise<unknown> => {
    const key = assertArtifactKey(keyInput, context.runId);
    let response: RpcResult;
    try {
      response = await client.rpc("get_audit_shopify_pricing_artifact", {
        ...baseArgs,
        p_artifact_key: key,
      });
    } catch {
      throw fail(
        "artifact_read_failed",
        "The immutable pricing artifact could not be read under the current run pin.",
      );
    }
    const row = response.error ? null : onlyRpcRow(response.data);
    if (!row) {
      throw fail(
        "artifact_read_failed",
        "The immutable pricing artifact could not be read under the current run pin.",
      );
    }
    return verifyStoredRow({ row, key, runId: context.runId });
  };

  return Object.freeze({
    async putImmutableJson({ key: keyInput, value, digestSha256, byteLength }) {
      const key = assertArtifactKey(keyInput, context.runId);
      const suffix = artifactSuffix(key, context.runId);
      if (suffix === null) {
        throw fail("invalid_artifact", "The pricing artifact suffix is invalid.");
      }
      assertPayloadShape(value, suffix);

      let canonicalJson: string;
      try {
        canonicalJson = canonicalRemediationJson(value);
      } catch {
        throw fail(
          "invalid_artifact",
          "The immutable pricing artifact is not canonically serialisable.",
        );
      }
      const actualByteLength = utf8Length(canonicalJson);
      const maxBytes =
        suffix === "root.json"
          ? LARA_PRICING_ARTIFACT_LIMITS.maxRootBytes
          : LARA_PRICING_ARTIFACT_LIMITS.maxProductBytes;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 1 ||
        byteLength > maxBytes ||
        actualByteLength !== byteLength
      ) {
        throw fail(
          "artifact_byte_length_mismatch",
          "The immutable pricing artifact byte length is invalid.",
        );
      }
      if (
        typeof digestSha256 !== "string" ||
        !SHA256.test(digestSha256) ||
        (await remediationSha256(value)) !== digestSha256
      ) {
        throw fail(
          "artifact_digest_mismatch",
          "The immutable pricing artifact digest does not cover the exact value.",
        );
      }

      let response: RpcResult;
      try {
        response = await client.rpc("put_audit_shopify_pricing_artifact", {
          ...baseArgs,
          p_artifact_key: key,
          p_digest_sha256: digestSha256,
          p_byte_length: byteLength,
          p_canonical_json: canonicalJson,
        });
      } catch {
        throw fail(
          "artifact_write_failed",
          "The immutable pricing artifact was not durably acknowledged.",
        );
      }
      const row = response.error ? null : onlyRpcRow(response.data);
      if (!row) {
        throw fail(
          "artifact_write_failed",
          "The immutable pricing artifact was not durably acknowledged.",
        );
      }
      await verifyStoredRow({
        row,
        key,
        runId: context.runId,
        expectedCanonicalJson: canonicalJson,
        expectedDigestSha256: digestSha256,
        expectedByteLength: byteLength,
      });

      // A second RPC is intentional: it proves the row can be independently
      // read under the same exact pin after the create-if-absent transaction.
      const roundTrip = await read(key);
      if (canonicalRemediationJson(roundTrip) !== canonicalJson) {
        throw fail(
          "artifact_stored_mismatch",
          "The immutable pricing artifact failed read-after-write validation.",
        );
      }
    },
    getImmutableJson: read,
  });
}
