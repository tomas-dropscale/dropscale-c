import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import type { AuditShopifyRun } from "@/lib/supabase/types";

export class AuditShopifyRunError extends Error {
  constructor(
    public readonly code:
      | "server_not_configured"
      | "enqueue_failed"
      | "claim_failed"
      | "complete_failed"
      | "fail_failed"
      | "run_not_found",
    message: string,
  ) {
    super(message);
    this.name = "AuditShopifyRunError";
  }
}

function serviceOrThrow() {
  const service = createServiceClient();
  if (!service) {
    throw new AuditShopifyRunError(
      "server_not_configured",
      "Server-side audit runs are not configured.",
    );
  }
  return service;
}

function firstRun(value: unknown): AuditShopifyRun | null {
  if (Array.isArray(value)) return (value[0] as AuditShopifyRun | undefined) ?? null;
  return (value as AuditShopifyRun | null) ?? null;
}

export async function enqueueAuditShopifyRun(input: {
  runId: string;
  connectionId: string;
  requestedBy: string;
  shopDomain: string;
  source: string;
  note: string | null;
  schemaHash: string;
  manifestHash: string;
  maxRetries?: number;
}) {
  const { data, error } = await serviceOrThrow().rpc("enqueue_audit_shopify_run", {
    p_run_id: input.runId,
    p_connection_id: input.connectionId,
    p_requested_by: input.requestedBy,
    p_shopify_domain: input.shopDomain,
    p_requested_source: input.source,
    p_requested_note: input.note,
    p_schema_hash: input.schemaHash,
    p_manifest_hash: input.manifestHash,
    p_max_retries: input.maxRetries ?? 3,
    p_checkpoint: {},
  });
  if (error || typeof data !== "string") {
    throw new AuditShopifyRunError("enqueue_failed", "The audit run could not be queued.");
  }
  return data;
}

export async function claimAuditShopifyRun(input: {
  runId: string;
  shopDomain: string;
  leaseToken: string;
  leaseSeconds?: number;
}): Promise<AuditShopifyRun> {
  const { data, error } = await serviceOrThrow().rpc("claim_audit_shopify_run", {
    p_lease_token: input.leaseToken,
    p_run_id: input.runId,
    p_shopify_domain: input.shopDomain,
    p_lease_seconds: input.leaseSeconds ?? 300,
  });
  const run = firstRun(data);
  if (error) {
    throw new AuditShopifyRunError("claim_failed", "The audit run could not be claimed.");
  }
  if (!run) {
    throw new AuditShopifyRunError("run_not_found", "No ready audit run was found.");
  }
  return run;
}

export async function getAuditShopifyRun(input: {
  runId: string;
  shopDomain: string;
}): Promise<AuditShopifyRun | null> {
  const { data, error } = await serviceOrThrow()
    .from("audit_shopify_runs")
    .select("*")
    .eq("id", input.runId)
    .eq("shopify_domain", input.shopDomain)
    .maybeSingle();
  if (error) {
    throw new AuditShopifyRunError("claim_failed", "The audit run could not be loaded.");
  }
  return (data as AuditShopifyRun | null) ?? null;
}

export async function renewAuditShopifyRun(input: {
  run: AuditShopifyRun;
  leaseToken: string;
  checkpoint?: Record<string, unknown>;
  leaseSeconds?: number;
}): Promise<AuditShopifyRun> {
  const { data, error } = await serviceOrThrow().rpc("renew_audit_shopify_run", {
    p_run_id: input.run.id,
    p_shopify_domain: input.run.shopify_domain,
    p_lease_token: input.leaseToken,
    p_lease_generation: input.run.lease_generation,
    p_checkpoint: input.checkpoint ?? input.run.checkpoint,
    p_lease_seconds: input.leaseSeconds ?? 300,
  });
  const renewed = firstRun(data);
  if (error || !renewed || renewed.state !== "running") {
    throw new AuditShopifyRunError("claim_failed", "The audit run lease could not be renewed.");
  }
  return renewed;
}

export async function completeAuditShopifyRun(input: {
  run: AuditShopifyRun;
  leaseToken: string;
  artifact: Record<string, unknown>;
}) {
  const { data, error } = await serviceOrThrow().rpc("complete_audit_shopify_run", {
    p_run_id: input.run.id,
    p_shopify_domain: input.run.shopify_domain,
    p_lease_token: input.leaseToken,
    p_lease_generation: input.run.lease_generation,
    p_checkpoint: { completed: true },
    p_artifact: input.artifact,
  });
  const completed = firstRun(data);
  if (error || !completed || completed.state !== "completed") {
    throw new AuditShopifyRunError(
      "complete_failed",
      "The audit run could not be completed.",
    );
  }
  return completed;
}

export async function failAuditShopifyRun(input: {
  run: AuditShopifyRun;
  leaseToken: string;
  errorCode: string;
  retryable: boolean;
}) {
  const { data, error } = await serviceOrThrow().rpc("fail_audit_shopify_run", {
    p_run_id: input.run.id,
    p_shopify_domain: input.run.shopify_domain,
    p_lease_token: input.leaseToken,
    p_lease_generation: input.run.lease_generation,
    p_checkpoint: { failedAt: new Date().toISOString() },
    p_error_code: input.errorCode,
    p_retryable: input.retryable,
    p_retry_after_seconds: 30,
  });
  const failed = firstRun(data);
  if (error || !failed) {
    throw new AuditShopifyRunError("fail_failed", "The audit run failure was not recorded.");
  }
  return failed;
}
