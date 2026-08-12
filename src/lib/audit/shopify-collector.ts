import "server-only";

import {
  AUDIT_BASELINE_QUERY_MANIFEST,
  type AuditGraphqlExecutor,
  auditBaselineManifestSha256,
  auditBaselineSchemaSha256,
  collectShopifyAuditBaseline,
} from "@/lib/audit/shopify-baseline";
import {
  AuditShopifyRuntimeError,
  createAuditShopifyRuntime,
} from "@/lib/audit/shopify-runtime";
import {
  AuditShopifyRunError,
  claimAuditShopifyRun,
  completeAuditShopifyRun,
  enqueueAuditShopifyRun,
  failAuditShopifyRun,
  getAuditShopifyRun,
  renewAuditShopifyRun,
} from "@/lib/audit/shopify-runs";

export const LARA_AUDIT_CONNECTION = Object.freeze({
  connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
  shopDomain: "jwmtjg-fm.myshopify.com",
  shopId: "gid://shopify/Shop/95462097276",
});

/**
 * Stable UUID for the temporary machine bootstrap. Repeated cron
 * deliveries replay this exact run instead of starting another Shopify read.
 */
export const LARA_INITIAL_BASELINE_RUN_ID =
  "6d481a86-9fbe-4b11-8be1-b665fb8d4b32";

export type LaraAuditCollectorResult = {
  runId: string;
  state: "completed" | "partial" | "in_progress" | "failed";
  artifact?: Record<string, unknown>;
  errorCode?: string;
};

function sanitisedError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof AuditShopifyRuntimeError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "_")
      .slice(0, 64);
    return { code: code.length >= 2 ? code : "collector_failed", retryable: false };
  }
  return { code: "collector_failed", retryable: false };
}

/**
 * Enqueue, claim and execute one exact Lara baseline. The caller must already
 * have authenticated an internal Dropscale admin (or a CRON_SECRET machine
 * request) before calling this service-role operation.
 */
export async function runLaraAuditBaseline({
  requestedBy,
  runId = crypto.randomUUID(),
  leaseToken = crypto.randomUUID(),
  trigger = "admin",
  note,
}: {
  requestedBy: string;
  runId?: string;
  leaseToken?: string;
  trigger?: "admin" | "system";
  note?: string | null;
}): Promise<LaraAuditCollectorResult> {
  const requestedNote =
    note === undefined
      ? trigger === "system"
        ? "Lara Rovinj authorised initial Shopify Admin baseline (machine bootstrap)"
        : "Lara Rovinj authorised Shopify Admin baseline"
      : note;
  const effectiveRunId = await enqueueAuditShopifyRun({
    runId,
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    requestedBy,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    source: trigger === "system" ? "system.initial_baseline" : "admin.baseline",
    note: requestedNote,
    schemaHash: await auditBaselineSchemaSha256(),
    manifestHash: await auditBaselineManifestSha256(),
    // The first deployment is intentionally synchronous and user-triggered.
    // Do not advertise a retry queue until a real background consumer exists.
    maxRetries: 0,
    actorType: trigger,
  });

  let claimed;
  try {
    claimed = await claimAuditShopifyRun({
      runId: effectiveRunId,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      leaseToken,
      leaseSeconds: 300,
    });
  } catch (error) {
    if (error instanceof AuditShopifyRunError && error.code === "run_not_found") {
      const existing = await getAuditShopifyRun({
        runId: effectiveRunId,
        shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      });
      if (existing?.state === "completed" && existing.artifact) {
        return {
          runId: effectiveRunId,
          state:
            existing.artifact.auditStatus === "complete" ? "completed" : "partial",
          artifact: existing.artifact,
        };
      }
      if (existing?.state === "failed") {
        return {
          runId: effectiveRunId,
          state: "failed",
          errorCode: existing.error_code ?? "collector_failed",
        };
      }
      return { runId: effectiveRunId, state: "in_progress" };
    }
    throw error;
  }

  try {
    const runtime = await createAuditShopifyRuntime({
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      expectedShopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      expectedShopId: LARA_AUDIT_CONNECTION.shopId,
      allowedQueryDocuments: Object.values(AUDIT_BASELINE_QUERY_MANIFEST),
    });
    let requestCount = 0;
    const execute: AuditGraphqlExecutor = async <TData>(document: string, variables?: Record<string, unknown>) => {
      // Extend the fenced lease before every bounded Shopify round trip. A
      // crashed Worker still expires; a healthy long baseline does not.
      await renewAuditShopifyRun({
        run: claimed,
        leaseToken,
        checkpoint: { requestCount },
        leaseSeconds: 300,
      });
      const data = await runtime.query<TData>(document, variables);
      requestCount += 1;
      return data;
    };
    const baseline = await collectShopifyAuditBaseline({
      execute,
      grantedScopes: runtime.grantedScopes,
    });
    const artifact = baseline as unknown as Record<string, unknown>;
    // Refresh once more after local summarisation and hashing. In particular,
    // this protects the final write when the last response contained a large
    // textual theme asset that took measurable CPU time to inspect.
    await renewAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: { requestCount, collectionPrepared: true },
      leaseSeconds: 300,
    });
    await completeAuditShopifyRun({ run: claimed, leaseToken, artifact });
    return {
      runId: effectiveRunId,
      state: baseline.auditStatus === "complete" ? "completed" : "partial",
      artifact,
    };
  } catch (error) {
    const failure = sanitisedError(error);
    try {
      await failAuditShopifyRun({
        run: claimed,
        leaseToken,
        errorCode: failure.code,
        retryable: failure.retryable,
      });
    } catch {
      // A response can be lost after the database committed, or another worker
      // can legitimately supersede this lease. Reconcile the durable row and
      // never replace the original safe failure with a secondary lease error.
      try {
        const existing = await getAuditShopifyRun({
          runId: effectiveRunId,
          shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
        });
        if (existing?.state === "completed" && existing.artifact) {
          return {
            runId: effectiveRunId,
            state:
              existing.artifact.auditStatus === "complete"
                ? "completed"
                : "partial",
            artifact: existing.artifact,
          };
        }
        if (existing?.state === "queued" || existing?.state === "running") {
          return { runId: effectiveRunId, state: "in_progress" };
        }
        if (existing?.state === "failed") {
          return {
            runId: effectiveRunId,
            state: "failed",
            errorCode: existing.error_code ?? failure.code,
          };
        }
      } catch {
        // The original classified error remains the only safe response when
        // reconciliation itself is unavailable.
      }
    }
    return {
      runId: effectiveRunId,
      state: "failed",
      errorCode: failure.code,
    };
  }
}
