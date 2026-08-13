import "server-only";

import {
  collectLaraMarketsDeliveryMap,
  LARA_MARKETS_DELIVERY_QUERY_MANIFEST,
  laraMarketsDeliveryManifestSha256,
  laraMarketsDeliverySchemaSha256,
  LaraMarketsDeliveryMapError,
  summariseLaraMarketsDeliveryArtifact,
  type LaraMarketsDeliverySummary,
} from "./lara-markets-delivery-map";
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

export const LARA_MARKETS_DELIVERY_RUN_ID =
  "1477f9be-a1da-42e7-af35-2e028d693a60" as const;

const REQUEST_SOURCE = "system.lara_markets_delivery_map";
const REQUEST_NOTE =
  "Lara Rovinj fixed read-only Markets, web presence, locale, currency and delivery map";
const MAX_RETRIES = 2;
const LEASE_SECONDS = 300;

export type LaraMarketsDeliveryCollectorResult =
  | {
      runId: string;
      state: "completed" | "partial";
      summary: LaraMarketsDeliverySummary;
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
  if (error instanceof LaraMarketsDeliveryMapError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof AuditShopifyRunError) {
    return { code: error.code, retryable: false };
  }
  return { code: "markets_delivery_map_failed", retryable: false };
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
}): LaraMarketsDeliveryCollectorResult | null {
  if (
    input.run.state !== "completed" ||
    !input.run.artifact ||
    !exactRunEvidence(input)
  ) {
    return null;
  }
  const artifact = objectRecord(input.run.artifact);
  if (artifact?.queryManifestSha256 !== input.manifestHash) return null;
  const summary = summariseLaraMarketsDeliveryArtifact(artifact);
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
}): Promise<LaraMarketsDeliveryCollectorResult> {
  const existing = await getAuditShopifyRun({
    runId: input.runId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
  });
  if (!existing) {
    return { runId: input.runId, state: "failed", errorCode: "run_not_found" };
  }
  if (!exactRunEvidence({ run: existing, ...input })) {
    return {
      runId: input.runId,
      state: "failed",
      errorCode: "run_evidence_mismatch",
    };
  }
  const completed = completedResult({ run: existing, ...input });
  if (completed) return completed;
  if (existing.state === "queued" || existing.state === "running") {
    return { runId: input.runId, state: "in_progress" };
  }
  return {
    runId: input.runId,
    state: "failed",
    errorCode: existing.error_code ?? "markets_delivery_map_failed",
  };
}

/** Execute or safely replay one fixed, durable, read-only Lara configuration map. */
export async function runLaraMarketsDeliveryCollector(input: {
  requestedBy: string;
  leaseToken?: string;
}): Promise<LaraMarketsDeliveryCollectorResult> {
  const runId = LARA_MARKETS_DELIVERY_RUN_ID;
  const leaseToken = input.leaseToken ?? crypto.randomUUID();
  const schemaHash = await laraMarketsDeliverySchemaSha256();
  const manifestHash = await laraMarketsDeliveryManifestSha256();
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
    return {
      runId: effectiveRunId,
      state: "failed",
      errorCode: "run_evidence_mismatch",
    };
  }

  let requestCount = 0;
  try {
    const runtime = await createAuditShopifyRuntime({
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      expectedShopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      expectedShopId: LARA_AUDIT_CONNECTION.shopId,
      allowedQueryDocuments: Object.values(LARA_MARKETS_DELIVERY_QUERY_MANIFEST),
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
          checkpoint: { requestCount },
          leaseSeconds: LEASE_SECONDS,
        });
        const data = await runtime.query<TData>(document, variables);
        requestCount += 1;
        return data;
      },
    };
    const artifact = await collectLaraMarketsDeliveryMap({ runtime: mapperRuntime });
    if (artifact.queryManifestSha256 !== manifestHash) {
      throw new LaraMarketsDeliveryMapError(
        "invalid_runtime",
        "The completed mapper manifest digest changed during collection.",
      );
    }
    if (!summariseLaraMarketsDeliveryArtifact(artifact)) {
      throw new LaraMarketsDeliveryMapError(
        "invalid_runtime",
        "The completed mapper artifact failed its bounded summary contract.",
      );
    }
    await renewAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: { requestCount, artifactPrepared: true },
      leaseSeconds: LEASE_SECONDS,
    });
    const completed = await completeAuditShopifyRun({
      run: claimed,
      leaseToken,
      artifact: artifact as unknown as Record<string, unknown>,
      checkpoint: { requestCount, completed: true },
    });
    const result = completedResult({
      run: completed,
      runId: effectiveRunId,
      requestedBy: input.requestedBy,
      schemaHash,
      manifestHash,
    });
    return (
      result ?? {
        runId: effectiveRunId,
        state: "failed",
        errorCode: "completed_evidence_invalid",
      }
    );
  } catch (error) {
    const failure = classifiedFailure(error);
    try {
      const failed = await failAuditShopifyRun({
        run: claimed,
        leaseToken,
        errorCode: failure.code,
        retryable: failure.retryable,
        checkpoint: { requestCount },
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
      // A write can commit before its response is lost. Re-read the fixed row.
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
