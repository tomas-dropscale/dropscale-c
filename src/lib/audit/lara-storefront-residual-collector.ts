import "server-only";

import {
  collectLaraStorefrontResidualMap,
  LARA_STOREFRONT_RESIDUAL_QUERY_MANIFEST,
  laraStorefrontResidualManifestSha256,
  laraStorefrontResidualSchemaSha256,
  LaraStorefrontResidualMapError,
  summariseLaraStorefrontResidualArtifact,
  type LaraStorefrontResidualSummary,
} from "./lara-storefront-residual-map";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  AuditShopifyRuntimeError,
  createAuditShopifyRuntime,
} from "./shopify-runtime";
import {
  AuditShopifyRunError,
  claimAuditShopifyRun,
  completeAuditShopifyRun,
  enqueueAuditShopifyRun,
  failAuditShopifyRun,
  getAuditShopifyRun,
  renewAuditShopifyRun,
} from "./shopify-runs";
import type { AuditShopifyRun } from "@/lib/supabase/types";

export const LARA_STOREFRONT_RESIDUAL_RUN_ID =
  "d09f89fe-c372-46e7-9d3b-7edd751d22fc" as const;

const REQUEST_SOURCE = "system.storefront_residual_map";
const REQUEST_NOTE =
  "Lara Rovinj fixed read-only storefront residual source and menu map";
const MAX_RETRIES = 2;
const LEASE_SECONDS = 300;
const BODY_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2_000_000;

export type LaraStorefrontResidualCollectorResult =
  | {
      runId: string;
      state: "completed" | "partial";
      summary: LaraStorefrontResidualSummary;
    }
  | { runId: string; state: "in_progress" }
  | { runId: string; state: "failed"; errorCode: string };

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function classifiedFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof AuditShopifyRuntimeError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof LaraStorefrontResidualMapError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof AuditShopifyRunError) {
    return { code: error.code, retryable: false };
  }
  return { code: "residual_map_failed", retryable: false };
}

function allowedThemeBodyHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase();
  return (
    host === "cdn.shopify.com" ||
    host.endsWith(".shopifycdn.com") ||
    host.endsWith(".shopifycloud.com") ||
    host === LARA_AUDIT_CONNECTION.shopDomain
  );
}

function allowedThemeBodyUrl(url: URL): boolean {
  if (allowedThemeBodyHost(url.hostname)) return true;
  return (
    url.hostname.toLocaleLowerCase() === "storage.googleapis.com" &&
    url.pathname.startsWith("/shopify")
  );
}

/**
 * Read a short-lived body URL returned directly by Shopify Admin GraphQL.
 * The URL never comes from the HTTP caller and is never persisted or logged.
 */
export async function readLaraShortLivedThemeBody(input: {
  url: string;
  expectedBytes: number;
  filename: string;
}): Promise<string> {
  if (
    typeof input.filename !== "string" ||
    !input.filename ||
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 0 ||
    input.expectedBytes > MAX_BODY_BYTES
  ) {
    throw new Error("Invalid bounded Shopify theme body evidence.");
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("Shopify returned an invalid short-lived theme body URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !allowedThemeBodyUrl(url)
  ) {
    throw new Error("Shopify returned a disallowed short-lived theme body URL.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.1" },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || response.status >= 300) {
    throw new Error("The short-lived Shopify theme body could not be read.");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("The short-lived Shopify theme body exceeded its byte cap.");
  }
  if (!response.body) {
    throw new Error("The short-lived Shopify theme body was empty.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > input.expectedBytes || byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("The short-lived Shopify theme body exceeded its exact size.");
    }
    chunks.push(chunk.value);
  }
  if (byteLength !== input.expectedBytes) {
    throw new Error("The short-lived Shopify theme body did not match its exact size.");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The short-lived Shopify theme body was not UTF-8 text.");
  }
}

function exactRunEvidence(input: {
  run: AuditShopifyRun;
  runId: string;
  requestedBy: string;
  schemaHash: string;
  manifestHash: string;
}): boolean {
  return (
    input.run.id === input.runId &&
    input.run.connection_id === LARA_AUDIT_CONNECTION.connectionId &&
    input.run.requested_by === input.requestedBy &&
    input.run.requested_actor_type === "system" &&
    input.run.shopify_domain === LARA_AUDIT_CONNECTION.shopDomain &&
    input.run.requested_source === REQUEST_SOURCE &&
    input.run.requested_note === REQUEST_NOTE &&
    input.run.schema_hash === input.schemaHash &&
    input.run.manifest_hash === input.manifestHash &&
    input.run.max_retries === MAX_RETRIES
  );
}

function completedResult(input: {
  run: AuditShopifyRun;
  runId: string;
  requestedBy: string;
  schemaHash: string;
  manifestHash: string;
}): LaraStorefrontResidualCollectorResult | null {
  if (
    input.run.state !== "completed" ||
    !input.run.artifact ||
    !exactRunEvidence(input)
  ) {
    return null;
  }
  const artifact = objectRecord(input.run.artifact);
  if (artifact?.queryManifestSha256 !== input.manifestHash) return null;
  const summary = summariseLaraStorefrontResidualArtifact(artifact);
  if (!summary) return null;
  return {
    runId: input.runId,
    state: summary.auditStatus === "complete" ? "completed" : "partial",
    summary,
  };
}

async function reconcileRun(input: {
  runId: string;
  requestedBy: string;
  schemaHash: string;
  manifestHash: string;
}): Promise<LaraStorefrontResidualCollectorResult> {
  const existing = await getAuditShopifyRun({
    runId: input.runId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
  });
  if (!existing) {
    return { runId: input.runId, state: "failed", errorCode: "run_not_found" };
  }
  if (!exactRunEvidence({ run: existing, ...input })) {
    return { runId: input.runId, state: "failed", errorCode: "run_evidence_mismatch" };
  }
  const completed = completedResult({ run: existing, ...input });
  if (completed) return completed;
  if (existing.state === "queued" || existing.state === "running") {
    return { runId: input.runId, state: "in_progress" };
  }
  return {
    runId: input.runId,
    state: "failed",
    errorCode: existing.error_code ?? "residual_map_failed",
  };
}

/** Execute or safely replay one fixed, durable, read-only Lara source map. */
export async function runLaraStorefrontResidualCollector(input: {
  requestedBy: string;
  leaseToken?: string;
}): Promise<LaraStorefrontResidualCollectorResult> {
  const runId = LARA_STOREFRONT_RESIDUAL_RUN_ID;
  const leaseToken = input.leaseToken ?? crypto.randomUUID();
  const schemaHash = await laraStorefrontResidualSchemaSha256();
  const manifestHash = await laraStorefrontResidualManifestSha256();
  const effectiveRunId = await enqueueAuditShopifyRun({
    runId,
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    requestedBy: input.requestedBy,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    source: REQUEST_SOURCE,
    note: REQUEST_NOTE,
    schemaHash,
    manifestHash,
    maxRetries: MAX_RETRIES,
    actorType: "system",
  });

  let claimed: AuditShopifyRun;
  try {
    claimed = await claimAuditShopifyRun({
      runId: effectiveRunId,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      leaseToken,
      leaseSeconds: LEASE_SECONDS,
    });
  } catch (error) {
    if (error instanceof AuditShopifyRunError && error.code === "run_not_found") {
      return reconcileRun({
        runId: effectiveRunId,
        requestedBy: input.requestedBy,
        schemaHash,
        manifestHash,
      });
    }
    throw error;
  }

  if (
    !exactRunEvidence({
      run: claimed,
      runId: effectiveRunId,
      requestedBy: input.requestedBy,
      schemaHash,
      manifestHash,
    })
  ) {
    return { runId: effectiveRunId, state: "failed", errorCode: "run_evidence_mismatch" };
  }

  let requestCount = 0;
  let shortBodyReadCount = 0;
  try {
    const runtime = await createAuditShopifyRuntime({
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      expectedShopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      expectedShopId: LARA_AUDIT_CONNECTION.shopId,
      allowedQueryDocuments: Object.values(
        LARA_STOREFRONT_RESIDUAL_QUERY_MANIFEST,
      ),
    });
    const mapperRuntime = {
      ...runtime,
      query: async <TData>(
        document: string,
        variables: Record<string, unknown> = {},
      ) => {
        await renewAuditShopifyRun({
          run: claimed,
          leaseToken,
          checkpoint: { requestCount, shortBodyReadCount },
          leaseSeconds: LEASE_SECONDS,
        });
        const data = await runtime.query<TData>(document, variables);
        requestCount += 1;
        return data;
      },
    };
    const artifact = await collectLaraStorefrontResidualMap({
      runtime: mapperRuntime,
      readShortLivedBody: async (bodyInput) => {
        await renewAuditShopifyRun({
          run: claimed,
          leaseToken,
          checkpoint: { requestCount, shortBodyReadCount },
          leaseSeconds: LEASE_SECONDS,
        });
        const content = await readLaraShortLivedThemeBody(bodyInput);
        shortBodyReadCount += 1;
        return content;
      },
    });
    if (artifact.queryManifestSha256 !== manifestHash) {
      throw new LaraStorefrontResidualMapError(
        "theme_body_invalid",
        "The completed mapper manifest digest changed during collection.",
      );
    }
    await renewAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: { requestCount, shortBodyReadCount, artifactPrepared: true },
      leaseSeconds: LEASE_SECONDS,
    });
    const completed = await completeAuditShopifyRun({
      run: claimed,
      leaseToken,
      artifact: artifact as unknown as Record<string, unknown>,
      checkpoint: {
        requestCount,
        shortBodyReadCount,
        completed: true,
      },
    });
    const result = completedResult({
      run: completed,
      runId: effectiveRunId,
      requestedBy: input.requestedBy,
      schemaHash,
      manifestHash,
    });
    if (!result) {
      return {
        runId: effectiveRunId,
        state: "failed",
        errorCode: "completed_evidence_invalid",
      };
    }
    return result;
  } catch (error) {
    const failure = classifiedFailure(error);
    try {
      const failed = await failAuditShopifyRun({
        run: claimed,
        leaseToken,
        errorCode: failure.code,
        retryable: failure.retryable,
        checkpoint: { requestCount, shortBodyReadCount },
      });
      if (failed.state === "queued" || failed.state === "running") {
        return { runId: effectiveRunId, state: "in_progress" };
      }
      if (failed.state === "failed") {
        return {
          runId: effectiveRunId,
          state: "failed",
          errorCode: failed.error_code ?? failure.code,
        };
      }
      return {
        runId: effectiveRunId,
        state: "failed",
        errorCode: "failure_state_invalid",
      };
    } catch {
      // The database may have committed before its response was lost. Re-read
      // the fixed row rather than masking the original classified failure.
    }
    try {
      return await reconcileRun({
        runId: effectiveRunId,
        requestedBy: input.requestedBy,
        schemaHash,
        manifestHash,
      });
    } catch {
      return { runId: effectiveRunId, state: "failed", errorCode: failure.code };
    }
  }
}
