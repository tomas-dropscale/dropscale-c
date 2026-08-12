import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import type { AuditShopifyRun } from "@/lib/supabase/types";
import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_TEXT_BODY_INTEGRITY_POLICY,
  readLaraThemeUrgencySnapshot,
} from "./lara-theme-urgency-plan";
import {
  LARA_THEME_URGENCY_KACHING_HANDLING,
  LARA_THEME_URGENCY_LIVE_SCHEMA_VERSION,
  classifyLaraThemeUrgencyLiveState,
  laraThemeUrgencyOperationFilenames,
  prepareLaraThemeUrgencyLiveMaterial,
  verifyLaraThemeUrgencyLiveMaterial,
  type LaraThemeUrgencyLiveMaterial,
  type LaraThemeUrgencyLiveState,
} from "./lara-theme-urgency-live-contract";
import {
  LARA_THEME_URGENCY_GRAPHQL_MANIFEST,
  LARA_THEME_URGENCY_REST_ASSET_MANIFEST,
  LaraThemeUrgencyLiveRuntimeError,
  createLaraThemeUrgencyLiveRuntime,
  type LaraThemeUrgencyLiveRuntime,
} from "./lara-theme-urgency-live-runtime";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  canonicalRemediationJson,
  freezeRemediationValue,
  remediationSha256,
  type DeepReadonly,
} from "./shopify-remediation-plan";
import {
  AuditShopifyRunError,
  claimAuditShopifyRun,
  completeAuditShopifyRun,
  enqueueAuditShopifyRun,
  failAuditShopifyRun,
  getAuditShopifyRun,
  renewAuditShopifyRun,
} from "./shopify-runs";

export const LARA_THEME_URGENCY_BACKUP_RUN_ID =
  "7cd77f30-6334-4b6a-8420-e48e4af30e29" as const;
export const LARA_THEME_URGENCY_REPAIR_RUN_ID =
  "cb1a4cdd-989d-4a4d-91ce-e8b1bb461cbc" as const;
export const LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION =
  "lara-theme-urgency-one-shot.v1" as const;

const BACKUP_SOURCE = "system.theme_urgency_backup" as const;
const BACKUP_NOTE =
  "Full Lara theme source and inverse persisted before exact copy repair" as const;
const REPAIR_SOURCE = "system.theme_urgency_repair" as const;
const REPAIR_NOTE =
  "Exact Lara closing-sale, scarcity, high-demand and since-2015 theme copy repair" as const;
const LEASE_SECONDS = 300;
const YIELD_SECONDS = 10;
const MAX_UNCONFIRMED_RECONCILIATIONS = 6;
const MAX_ASYNC_JOB_POLLS = 12;
const MAX_ASYNC_JOB_AGE_MS = 30 * 60 * 1_000;
const MAX_JOURNAL_ENTRIES = 100;
const MAX_CHECKPOINT_BYTES = 60_000;
const MAX_DURABLE_BACKUP_ARTIFACT_BYTES = 8_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JOB_GID = /^gid:\/\/shopify\/Job\/[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

type BackupCheckpoint = {
  schemaVersion: typeof LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION;
  phase: "capture_persisted" | "material_ready";
  capturedAt: string;
  materialDigestSha256: string | null;
  planDigestSha256: string | null;
  artifactBytes: number | null;
};

type RepairPhase =
  | "prepared"
  | "mutation_intent"
  | "job_pending"
  | "verifying"
  | "verified"
  | "failed";

type RepairJournalEntry = {
  sequence: number;
  occurredAt: string;
  event:
    | "run.claimed"
    | "backup.verified"
    | "preflight.verified"
    | "mutation.intent_persisted"
    | "mutation.acknowledged"
    | "mutation.reconciled"
    | "job.pending"
    | "job.polled"
    | "job.done"
    | "verification.complete"
    | "run.failed";
  detail: Record<string, string | number | boolean | null>;
};

type RepairCheckpoint = {
  schemaVersion: typeof LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION;
  phase: RepairPhase;
  backupRunId: typeof LARA_THEME_URGENCY_BACKUP_RUN_ID;
  materialDigestSha256: string;
  planDigestSha256: string;
  operationFilenames: string[];
  mutationRequestedAt: string | null;
  jobId: string | null;
  jobPollCount: number;
  exemptionConfirmedByShopify: boolean;
  reconciliationCount: number;
  lastObservedState: LaraThemeUrgencyLiveState | null;
  failureCode: string | null;
  journal: RepairJournalEntry[];
};

type BackupArtifact = {
  schemaVersion: typeof LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION;
  kind: "full_theme_source_and_inverse";
  status: "persisted_before_write";
  runId: typeof LARA_THEME_URGENCY_BACKUP_RUN_ID;
  materialDigestSha256: string;
  planDigestSha256: string;
  materialBytes: number;
  persistedAt: string;
  material: LaraThemeUrgencyLiveMaterial;
};

export type LaraThemeUrgencyDryRunResult = DeepReadonly<{
  mode: "dry-run";
  writesAttempted: 0;
  repairRunId: typeof LARA_THEME_URGENCY_REPAIR_RUN_ID;
  backupRunId: typeof LARA_THEME_URGENCY_BACKUP_RUN_ID;
  materialDigestSha256: string;
  planDigestSha256: string;
  sourceSnapshotDigestSha256: string;
  operationCount: number;
  operationFilenames: string[];
  exactReplacementCount: number;
  kaching: LaraThemeUrgencyLiveMaterial["payload"]["kachingEvidence"] & {
    handling: typeof LARA_THEME_URGENCY_KACHING_HANDLING;
  };
  vendorMutationIncluded: false;
}>;

export type LaraThemeUrgencyRepairResult = DeepReadonly<{
  runId: typeof LARA_THEME_URGENCY_REPAIR_RUN_ID;
  state: "completed" | "failed" | "in_progress";
  stage: "backup" | "repair";
  status?: "verified" | "manual_intervention_required";
  planDigestSha256?: string;
  backupRunId?: typeof LARA_THEME_URGENCY_BACKUP_RUN_ID;
  verifiedFiles?: number;
  errorCode?: string;
  kachingStatus?: typeof LARA_THEME_URGENCY_KACHING_HANDLING.status;
}>;

export class LaraThemeUrgencyRepairError extends Error {
  constructor(
    public readonly code:
      | "backup_failed"
      | "backup_invalid"
      | "backup_source_drift"
      | "invalid_checkpoint"
      | "repair_evidence_mismatch"
      | "theme_state_drift"
      | "theme_write_unresolved",
    message: string,
  ) {
    super(message);
    this.name = "LaraThemeUrgencyRepairError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstRun(value: unknown): AuditShopifyRun | null {
  if (Array.isArray(value)) return (value[0] as AuditShopifyRun | undefined) ?? null;
  return (value as AuditShopifyRun | null) ?? null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function artifactBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalRemediationJson(value)).byteLength;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function terminalLeaseCleared(run: AuditShopifyRun): boolean {
  return (
    run.next_attempt_at === null &&
    run.lease_token === null &&
    run.lease_acquired_at === null &&
    run.lease_renewed_at === null &&
    run.lease_expires_at === null
  );
}

function activeRunStateIsConsistent(run: AuditShopifyRun): boolean {
  if (
    run.artifact !== null ||
    run.completed_at !== null ||
    run.failed_at !== null
  ) {
    return false;
  }
  if (run.state === "queued") {
    return (
      validTimestamp(run.next_attempt_at) &&
      run.lease_token === null &&
      run.lease_acquired_at === null &&
      run.lease_renewed_at === null &&
      run.lease_expires_at === null
    );
  }
  if (run.state === "running") {
    return (
      run.next_attempt_at === null &&
      typeof run.lease_token === "string" &&
      UUID.test(run.lease_token) &&
      validTimestamp(run.lease_acquired_at) &&
      validTimestamp(run.lease_renewed_at) &&
      validTimestamp(run.lease_expires_at) &&
      validTimestamp(run.started_at) &&
      run.error_code === null
    );
  }
  return false;
}

function assertRepairCheckpointBounded(checkpoint: RepairCheckpoint): void {
  const bytes = new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength;
  if (checkpoint.journal.length > MAX_JOURNAL_ENTRIES || bytes > MAX_CHECKPOINT_BYTES) {
    throw new LaraThemeUrgencyRepairError(
      "invalid_checkpoint",
      "The durable Lara theme checkpoint exceeded its fixed safety bound.",
    );
  }
}

async function schemaHash() {
  return remediationSha256({
    schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
    liveMaterialSchemaVersion: LARA_THEME_URGENCY_LIVE_SCHEMA_VERSION,
    shop: LARA_AUDIT_CONNECTION,
    files: LARA_THEME_URGENCY_FILES,
    graphql: LARA_THEME_URGENCY_GRAPHQL_MANIFEST,
    restAssetFallback: LARA_THEME_URGENCY_REST_ASSET_MANIFEST,
    textBodyIntegrityPolicy: LARA_THEME_URGENCY_TEXT_BODY_INTEGRITY_POLICY,
    backupBeforeMutation: true,
    asynchronousJobResume: true,
    maxAsyncJobPolls: MAX_ASYNC_JOB_POLLS,
    maxAsyncJobAgeMs: MAX_ASYNC_JOB_AGE_MS,
    automaticRollback: false,
    kachingIncludedInWrite: false,
    vendorMutationIncluded: false,
  });
}

async function backupManifestHash() {
  return remediationSha256({
    schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
    kind: "full_theme_source_and_inverse",
    runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
    shop: LARA_AUDIT_CONNECTION,
    files: LARA_THEME_URGENCY_FILES,
  });
}

function immutableEvidenceMatches(
  run: AuditShopifyRun,
  input: {
    runId: string;
    requestedBy: string;
    source: string;
    note: string;
    schemaHash: string;
    manifestHash: string;
  },
) {
  return (
    run.id === input.runId &&
    run.connection_id === LARA_AUDIT_CONNECTION.connectionId &&
    run.requested_by === input.requestedBy &&
    run.requested_actor_type === "system" &&
    run.shopify_domain === LARA_AUDIT_CONNECTION.shopDomain &&
    run.requested_source === input.source &&
    run.requested_note === input.note &&
    run.schema_hash === input.schemaHash &&
    run.manifest_hash === input.manifestHash &&
    run.max_retries === 3 &&
    Number.isInteger(run.attempt_count) &&
    run.attempt_count >= 0 &&
    Number.isInteger(run.retry_count) &&
    run.retry_count >= 0 &&
    run.retry_count <= run.max_retries &&
    run.retry_count <= run.attempt_count &&
    Number.isInteger(run.lease_generation) &&
    run.lease_generation === run.attempt_count &&
    validTimestamp(run.created_at) &&
    validTimestamp(run.updated_at) &&
    Date.parse(run.updated_at) >= Date.parse(run.created_at)
  );
}

function parseBackupCheckpoint(value: unknown): BackupCheckpoint | null {
  const record = objectRecord(value);
  if (!record || Object.keys(record).length === 0) return null;
  if (
    !exactKeys(record, [
      "schemaVersion",
      "phase",
      "capturedAt",
      "materialDigestSha256",
      "planDigestSha256",
      "artifactBytes",
    ]) ||
    record.schemaVersion !== LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION ||
    (record.phase !== "capture_persisted" && record.phase !== "material_ready") ||
    !validTimestamp(record.capturedAt) ||
    (record.materialDigestSha256 !== null &&
      (typeof record.materialDigestSha256 !== "string" ||
        !SHA256.test(record.materialDigestSha256))) ||
    (record.planDigestSha256 !== null &&
      (typeof record.planDigestSha256 !== "string" ||
        !SHA256.test(record.planDigestSha256))) ||
    (record.artifactBytes !== null &&
      (!Number.isInteger(record.artifactBytes) || Number(record.artifactBytes) < 1))
  ) {
    throw new LaraThemeUrgencyRepairError(
      "invalid_checkpoint",
      "The durable Lara theme backup checkpoint is malformed.",
    );
  }
  if (
    (record.phase === "capture_persisted" &&
      (record.materialDigestSha256 !== null ||
        record.planDigestSha256 !== null ||
        record.artifactBytes !== null)) ||
    (record.phase === "material_ready" &&
      (!record.materialDigestSha256 || !record.planDigestSha256 || !record.artifactBytes))
  ) {
    throw new LaraThemeUrgencyRepairError(
      "invalid_checkpoint",
      "The ready Lara theme backup checkpoint is incomplete.",
    );
  }
  return {
    schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
    phase: record.phase,
    capturedAt: record.capturedAt,
    materialDigestSha256: record.materialDigestSha256 as string | null,
    planDigestSha256: record.planDigestSha256 as string | null,
    artifactBytes: record.artifactBytes as number | null,
  };
}

async function parseBackupArtifact(value: unknown): Promise<BackupArtifact> {
  const artifact = objectRecord(value);
  if (
    !artifact ||
    !exactKeys(artifact, [
      "schemaVersion",
      "kind",
      "status",
      "runId",
      "materialDigestSha256",
      "planDigestSha256",
      "materialBytes",
      "persistedAt",
      "material",
    ]) ||
    artifact.schemaVersion !== LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION ||
    artifact.kind !== "full_theme_source_and_inverse" ||
    artifact.status !== "persisted_before_write" ||
    artifact.runId !== LARA_THEME_URGENCY_BACKUP_RUN_ID ||
    typeof artifact.materialDigestSha256 !== "string" ||
    !SHA256.test(artifact.materialDigestSha256) ||
    typeof artifact.planDigestSha256 !== "string" ||
    !SHA256.test(artifact.planDigestSha256) ||
    !Number.isInteger(artifact.materialBytes) ||
    Number(artifact.materialBytes) < 1 ||
    !validTimestamp(artifact.persistedAt)
  ) {
    throw new LaraThemeUrgencyRepairError(
      "backup_invalid",
      "The completed Lara theme backup artifact is invalid.",
    );
  }
  const material = await verifyLaraThemeUrgencyLiveMaterial(artifact.material);
  const typed: BackupArtifact = {
    schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
    kind: "full_theme_source_and_inverse",
    status: "persisted_before_write",
    runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
    materialDigestSha256: artifact.materialDigestSha256,
    planDigestSha256: artifact.planDigestSha256,
    materialBytes: Number(artifact.materialBytes),
    persistedAt: artifact.persistedAt,
    material,
  };
  if (
    typed.materialDigestSha256 !== material.digestSha256 ||
    typed.planDigestSha256 !== material.payload.plan.digestSha256 ||
    typed.materialBytes !== artifactBytes(material) ||
    artifactBytes(typed) > MAX_DURABLE_BACKUP_ARTIFACT_BYTES
  ) {
    throw new LaraThemeUrgencyRepairError(
      "backup_invalid",
      "The completed Lara theme backup evidence does not match its material.",
    );
  }
  return freezeRemediationValue(typed) as BackupArtifact;
}

function initialRepairCheckpoint(
  material: LaraThemeUrgencyLiveMaterial,
): RepairCheckpoint {
  return {
    schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
    phase: "prepared",
    backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
    materialDigestSha256: material.digestSha256,
    planDigestSha256: material.payload.plan.digestSha256,
    operationFilenames: laraThemeUrgencyOperationFilenames(material),
    mutationRequestedAt: null,
    jobId: null,
    jobPollCount: 0,
    exemptionConfirmedByShopify: false,
    reconciliationCount: 0,
    lastObservedState: null,
    failureCode: null,
    journal: [],
  };
}

function parseJournal(value: unknown): RepairJournalEntry[] {
  if (!Array.isArray(value) || value.length > MAX_JOURNAL_ENTRIES) {
    throw new LaraThemeUrgencyRepairError(
      "invalid_checkpoint",
      "The Lara theme repair journal is invalid.",
    );
  }
  return value.map((entry, index) => {
    const record = objectRecord(entry);
    const detail = objectRecord(record?.detail);
    if (
      !record ||
      !exactKeys(record, ["sequence", "occurredAt", "event", "detail"]) ||
      record.sequence !== index + 1 ||
      !validTimestamp(record.occurredAt) ||
      ![
        "run.claimed",
        "backup.verified",
        "preflight.verified",
        "mutation.intent_persisted",
        "mutation.acknowledged",
        "mutation.reconciled",
        "job.pending",
        "job.polled",
        "job.done",
        "verification.complete",
        "run.failed",
      ].includes(String(record.event)) ||
      !detail ||
      Object.values(detail).some(
        (item) =>
          item !== null &&
          typeof item !== "string" &&
          typeof item !== "number" &&
          typeof item !== "boolean",
      )
    ) {
      throw new LaraThemeUrgencyRepairError(
        "invalid_checkpoint",
        "A Lara theme repair journal entry is invalid.",
      );
    }
    return {
      sequence: index + 1,
      occurredAt: record.occurredAt as string,
      event: record.event as RepairJournalEntry["event"],
      detail: detail as RepairJournalEntry["detail"],
    };
  });
}

function parseRepairCheckpoint(
  value: unknown,
  material: LaraThemeUrgencyLiveMaterial,
): RepairCheckpoint | null {
  const record = objectRecord(value);
  if (!record || Object.keys(record).length === 0) return null;
  const phases: RepairPhase[] = [
    "prepared",
    "mutation_intent",
    "job_pending",
    "verifying",
    "verified",
    "failed",
  ];
  const states: LaraThemeUrgencyLiveState[] = [
    "before_exact",
    "after_exact",
    "mixed_transition",
    "drift",
  ];
  const expectedFilenames = laraThemeUrgencyOperationFilenames(material);
  if (
    !exactKeys(record, [
      "schemaVersion",
      "phase",
      "backupRunId",
      "materialDigestSha256",
      "planDigestSha256",
      "operationFilenames",
      "mutationRequestedAt",
      "jobId",
      "jobPollCount",
      "exemptionConfirmedByShopify",
      "reconciliationCount",
      "lastObservedState",
      "failureCode",
      "journal",
    ]) ||
    record.schemaVersion !== LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION ||
    !phases.includes(record.phase as RepairPhase) ||
    record.backupRunId !== LARA_THEME_URGENCY_BACKUP_RUN_ID ||
    record.materialDigestSha256 !== material.digestSha256 ||
    record.planDigestSha256 !== material.payload.plan.digestSha256 ||
    !Array.isArray(record.operationFilenames) ||
    canonicalRemediationJson(record.operationFilenames) !==
      canonicalRemediationJson(expectedFilenames) ||
    (record.mutationRequestedAt !== null && !validTimestamp(record.mutationRequestedAt)) ||
    (record.jobId !== null &&
      (typeof record.jobId !== "string" || !JOB_GID.test(record.jobId))) ||
    !Number.isInteger(record.jobPollCount) ||
    Number(record.jobPollCount) < 0 ||
    Number(record.jobPollCount) > MAX_ASYNC_JOB_POLLS ||
    typeof record.exemptionConfirmedByShopify !== "boolean" ||
    !Number.isInteger(record.reconciliationCount) ||
    Number(record.reconciliationCount) < 0 ||
    Number(record.reconciliationCount) > MAX_UNCONFIRMED_RECONCILIATIONS ||
    (record.lastObservedState !== null &&
      !states.includes(record.lastObservedState as LaraThemeUrgencyLiveState)) ||
    (record.failureCode !== null && typeof record.failureCode !== "string")
  ) {
    throw new LaraThemeUrgencyRepairError(
      "invalid_checkpoint",
      "The durable Lara theme repair checkpoint is malformed.",
    );
  }
  const phase = record.phase as RepairPhase;
  if (
    (phase === "prepared" &&
      (record.mutationRequestedAt !== null ||
        record.jobId !== null ||
        record.jobPollCount !== 0 ||
        record.exemptionConfirmedByShopify !== false ||
        record.reconciliationCount !== 0)) ||
    (phase === "mutation_intent" &&
      (record.mutationRequestedAt === null ||
        record.jobId !== null ||
        record.jobPollCount !== 0 ||
        record.exemptionConfirmedByShopify !== false)) ||
    (phase === "job_pending" &&
      (record.mutationRequestedAt === null ||
        record.jobId === null ||
        record.exemptionConfirmedByShopify !== true)) ||
    ((phase === "verifying" || phase === "verified") &&
      record.mutationRequestedAt === null) ||
    (phase === "verified" &&
      (record.lastObservedState !== "after_exact" || record.failureCode !== null)) ||
    (phase === "failed" &&
      (typeof record.failureCode !== "string" ||
        record.failureCode.length === 0 ||
        (record.mutationRequestedAt === null &&
          (record.jobId !== null ||
            record.jobPollCount !== 0 ||
            record.exemptionConfirmedByShopify !== false))))
  ) {
    throw new LaraThemeUrgencyRepairError(
      "invalid_checkpoint",
      "The durable Lara theme repair phase evidence is inconsistent.",
    );
  }
  return {
    schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
    phase,
    backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
    materialDigestSha256: record.materialDigestSha256 as string,
    planDigestSha256: record.planDigestSha256 as string,
    operationFilenames: [...expectedFilenames],
    mutationRequestedAt: record.mutationRequestedAt as string | null,
    jobId: record.jobId as string | null,
    jobPollCount: Number(record.jobPollCount),
    exemptionConfirmedByShopify: record.exemptionConfirmedByShopify,
    reconciliationCount: Number(record.reconciliationCount),
    lastObservedState: record.lastObservedState as LaraThemeUrgencyLiveState | null,
    failureCode: record.failureCode as string | null,
    journal: parseJournal(record.journal),
  };
}

async function yieldAuditRun({
  run,
  leaseToken,
  checkpoint,
}: {
  run: AuditShopifyRun;
  leaseToken: string;
  checkpoint: Record<string, unknown>;
}) {
  const service = createServiceClient();
  if (!service) {
    throw new AuditShopifyRunError(
      "server_not_configured",
      "Server-side audit runs are not configured.",
    );
  }
  const { data, error } = await service.rpc("yield_audit_shopify_run", {
    p_run_id: run.id,
    p_shopify_domain: run.shopify_domain,
    p_lease_token: leaseToken,
    p_lease_generation: run.lease_generation,
    p_checkpoint: checkpoint,
    p_continue_after_seconds: YIELD_SECONDS,
  });
  const yielded = firstRun(data);
  if (error || !yielded || yielded.state !== "queued") {
    throw new AuditShopifyRunError(
      "claim_failed",
      "The exact Lara theme run could not yield its lease.",
    );
  }
  return yielded;
}

async function loadCompletedBackup({
  run,
  requestedBy,
  schemaDigest,
  manifestDigest,
}: {
  run: AuditShopifyRun;
  requestedBy: string;
  schemaDigest: string;
  manifestDigest: string;
}) {
  if (
    !immutableEvidenceMatches(run, {
      runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      requestedBy,
      source: BACKUP_SOURCE,
      note: BACKUP_NOTE,
      schemaHash: schemaDigest,
      manifestHash: manifestDigest,
    }) ||
    run.state !== "completed" ||
    !run.completed_at ||
    !run.artifact ||
    run.error_code !== null ||
    run.failed_at !== null ||
    !terminalLeaseCleared(run) ||
    !validTimestamp(run.started_at) ||
    run.attempt_count < 1
  ) {
    throw new LaraThemeUrgencyRepairError(
      "backup_invalid",
      "The Lara theme backup run does not contain completed immutable evidence.",
    );
  }
  const artifact = await parseBackupArtifact(run.artifact);
  const checkpoint = parseBackupCheckpoint(run.checkpoint);
  if (
    !checkpoint ||
    checkpoint.phase !== "material_ready" ||
    checkpoint.capturedAt !== artifact.material.payload.capturedAt ||
    checkpoint.materialDigestSha256 !== artifact.materialDigestSha256 ||
    checkpoint.planDigestSha256 !== artifact.planDigestSha256 ||
    checkpoint.artifactBytes !== artifactBytes(artifact) ||
    Date.parse(artifact.persistedAt) < Date.parse(run.created_at) - 1_000 ||
    Date.parse(artifact.persistedAt) > Date.parse(run.completed_at) + 1_000
  ) {
    throw new LaraThemeUrgencyRepairError(
      "backup_invalid",
      "The Lara theme backup checkpoint, artifact or completion chronology is invalid.",
    );
  }
  return { run, artifact };
}

type EnsureBackupResult =
  | { state: "ready"; run: AuditShopifyRun; artifact: BackupArtifact }
  | { state: "in_progress" };

async function ensureDurableBackup({
  requestedBy,
  runtime,
  now,
  leaseToken,
}: {
  requestedBy: string;
  runtime: LaraThemeUrgencyLiveRuntime;
  now: () => Date;
  leaseToken: string;
}): Promise<EnsureBackupResult> {
  const schemaDigest = await schemaHash();
  const manifestDigest = await backupManifestHash();
  let existing = await getAuditShopifyRun({
    runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
  });
  if (existing?.state === "completed") {
    const loaded = await loadCompletedBackup({
      run: existing,
      requestedBy,
      schemaDigest,
      manifestDigest,
    });
    return { state: "ready", ...loaded };
  }
  if (existing?.state === "failed") {
    throw new LaraThemeUrgencyRepairError(
      "backup_failed",
      "The fixed Lara theme backup run failed before any theme write.",
    );
  }
  if (!existing) {
    const effectiveRunId = await enqueueAuditShopifyRun({
      runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      requestedBy,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      source: BACKUP_SOURCE,
      note: BACKUP_NOTE,
      schemaHash: schemaDigest,
      manifestHash: manifestDigest,
      maxRetries: 3,
      actorType: "system",
    });
    if (effectiveRunId !== LARA_THEME_URGENCY_BACKUP_RUN_ID) {
      throw new LaraThemeUrgencyRepairError(
        "backup_invalid",
        "The fixed Lara theme backup enqueue resolved to another run.",
      );
    }
  }

  let claimed: AuditShopifyRun;
  try {
    claimed = await claimAuditShopifyRun({
      runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      leaseToken,
      leaseSeconds: LEASE_SECONDS,
    });
  } catch (error) {
    if (error instanceof AuditShopifyRunError && error.code === "run_not_found") {
      existing = await getAuditShopifyRun({
        runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
        shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      });
      if (existing?.state === "completed") {
        const loaded = await loadCompletedBackup({
          run: existing,
          requestedBy,
          schemaDigest,
          manifestDigest,
        });
        return { state: "ready", ...loaded };
      }
      return { state: "in_progress" };
    }
    throw error;
  }
  if (
    !immutableEvidenceMatches(claimed, {
      runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      requestedBy,
      source: BACKUP_SOURCE,
      note: BACKUP_NOTE,
      schemaHash: schemaDigest,
      manifestHash: manifestDigest,
    })
  ) {
    throw new LaraThemeUrgencyRepairError(
      "backup_invalid",
      "The claimed Lara theme backup evidence changed.",
    );
  }

  let checkpoint = parseBackupCheckpoint(claimed.checkpoint);
  if (!checkpoint) {
    checkpoint = {
      schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
      phase: "capture_persisted",
      capturedAt: now().toISOString(),
      materialDigestSha256: null,
      planDigestSha256: null,
      artifactBytes: null,
    };
    claimed = await renewAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      leaseSeconds: LEASE_SECONDS,
    });
  }

  let material: LaraThemeUrgencyLiveMaterial;
  try {
    material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime,
      capturedAt: checkpoint.capturedAt,
    });
  } catch (error) {
    await failAuditShopifyRun({
      run: claimed,
      leaseToken,
      errorCode: "theme_backup_prepare_failed",
      retryable: false,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
    });
    throw error;
  }
  if (
    (checkpoint.materialDigestSha256 &&
      checkpoint.materialDigestSha256 !== material.digestSha256) ||
    (checkpoint.planDigestSha256 &&
      checkpoint.planDigestSha256 !== material.payload.plan.digestSha256)
  ) {
    await failAuditShopifyRun({
      run: claimed,
      leaseToken,
      errorCode: "theme_backup_source_drift",
      retryable: false,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
    });
    throw new LaraThemeUrgencyRepairError(
      "backup_source_drift",
      "The Lara theme source changed while its full backup was being persisted.",
    );
  }

  const persistedAt = now().toISOString();
  const draftArtifact = {
    schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
    kind: "full_theme_source_and_inverse" as const,
    status: "persisted_before_write" as const,
    runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
    materialDigestSha256: material.digestSha256,
    planDigestSha256: material.payload.plan.digestSha256,
    materialBytes: artifactBytes(material),
    persistedAt,
    material,
  };
  const artifact: BackupArtifact = draftArtifact;
  const bytes = artifactBytes(artifact);
  if (bytes > MAX_DURABLE_BACKUP_ARTIFACT_BYTES) {
    await failAuditShopifyRun({
      run: claimed,
      leaseToken,
      errorCode: "theme_backup_artifact_too_large",
      retryable: false,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
    });
    throw new LaraThemeUrgencyRepairError(
      "backup_invalid",
      "The complete Lara theme backup exceeds the durable artifact safety bound.",
    );
  }
  checkpoint = {
    ...checkpoint,
    phase: "material_ready",
    materialDigestSha256: material.digestSha256,
    planDigestSha256: material.payload.plan.digestSha256,
    artifactBytes: bytes,
  };
  claimed = await renewAuditShopifyRun({
    run: claimed,
    leaseToken,
    checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
    leaseSeconds: LEASE_SECONDS,
  });
  let completed: AuditShopifyRun;
  try {
    completed = await completeAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      artifact: structuredClone(artifact) as unknown as Record<string, unknown>,
    });
  } catch {
    const reconciled = await getAuditShopifyRun({
      runId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    });
    if (!reconciled || reconciled.state !== "completed") {
      return { state: "in_progress" };
    }
    completed = reconciled;
  }
  const loaded = await loadCompletedBackup({
    run: completed,
    requestedBy,
    schemaDigest,
    manifestDigest,
  });
  return { state: "ready", ...loaded };
}

export async function buildLaraThemeUrgencyDryRun({
  runtime: suppliedRuntime,
  now = () => new Date(),
}: {
  runtime?: LaraThemeUrgencyLiveRuntime;
  now?: () => Date;
} = {}): Promise<LaraThemeUrgencyDryRunResult> {
  const runtime = suppliedRuntime ?? (await createLaraThemeUrgencyLiveRuntime());
  const material = await prepareLaraThemeUrgencyLiveMaterial({
    runtime,
    capturedAt: now().toISOString(),
  });
  const operations = material.payload.plan.payload.operations;
  return freezeRemediationValue({
    mode: "dry-run" as const,
    writesAttempted: 0 as const,
    repairRunId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
    backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
    materialDigestSha256: material.digestSha256,
    planDigestSha256: material.payload.plan.digestSha256,
    sourceSnapshotDigestSha256: material.payload.sourceSnapshot.digestSha256,
    operationCount: operations.length,
    operationFilenames: operations.map((operation) => operation.target.filename),
    exactReplacementCount: operations.reduce(
      (total, operation) =>
        total +
        operation.exactChanges.reduce(
          (sum, change) => sum + change.expectedOccurrences,
          0,
        ),
      0,
    ),
    kaching: {
      ...material.payload.kachingEvidence,
      handling: LARA_THEME_URGENCY_KACHING_HANDLING,
    },
    vendorMutationIncluded: false as const,
  });
}

async function resultFromExistingRepair(
  run: AuditShopifyRun | null,
  evidence: {
    requestedBy: string;
    schemaHash: string;
    manifestHash: string;
    backupCompletedAt: string;
  },
  material: LaraThemeUrgencyLiveMaterial,
  runtime: LaraThemeUrgencyLiveRuntime,
): Promise<LaraThemeUrgencyRepairResult> {
  if (!run) {
    return freezeRemediationValue({
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      state: "in_progress" as const,
      stage: "repair" as const,
    });
  }
  if (
    !immutableEvidenceMatches(run, {
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      requestedBy: evidence.requestedBy,
      source: REPAIR_SOURCE,
      note: REPAIR_NOTE,
      schemaHash: evidence.schemaHash,
      manifestHash: evidence.manifestHash,
    })
  ) {
    throw new LaraThemeUrgencyRepairError(
      "repair_evidence_mismatch",
      "The fixed Lara theme repair evidence changed.",
    );
  }
  const checkpoint = parseRepairCheckpoint(run.checkpoint, material);
  const current = await readLaraThemeUrgencySnapshot({
    runtime,
    capturedAt: material.payload.capturedAt,
  });
  const observedState = await classifyLaraThemeUrgencyLiveState({
    material,
    current,
  });
  if (observedState === "drift") {
    throw new LaraThemeUrgencyRepairError(
      "theme_state_drift",
      "The live Lara theme no longer matches the immutable repair evidence.",
    );
  }
  if (run.state === "completed") {
    const artifact = objectRecord(run.artifact);
    const expectedFilenames = laraThemeUrgencyOperationFilenames(material);
    const expectedReplacementCount = material.payload.plan.payload.operations.reduce(
      (total, operation) =>
        total +
        operation.exactChanges.reduce(
          (sum, change) => sum + change.expectedOccurrences,
          0,
        ),
      0,
    );
    const expectedKaching = {
      ...material.payload.kachingEvidence,
      handling: LARA_THEME_URGENCY_KACHING_HANDLING,
    };
    const lastVerification = checkpoint?.journal
      .filter((entry) => entry.event === "verification.complete")
      .at(-1);
    if (
      !artifact ||
      !exactKeys(artifact, [
        "schemaVersion",
        "status",
        "runId",
        "planDigestSha256",
        "materialDigestSha256",
        "finalSnapshotDigestSha256",
        "backupRunId",
        "backupCompletedAt",
        "verifiedFiles",
        "filenames",
        "exactReplacementCount",
        "themeWriteExemptionConfirmedByShopify",
        "vendorMutationIncluded",
        "kachingWriteIncluded",
        "kaching",
        "journal",
        "completedAt",
      ]) ||
      artifact.schemaVersion !== LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION ||
      artifact.status !== "verified" ||
      artifact.runId !== LARA_THEME_URGENCY_REPAIR_RUN_ID ||
      artifact.planDigestSha256 !== evidence.manifestHash ||
      artifact.materialDigestSha256 !== material.digestSha256 ||
      typeof artifact.finalSnapshotDigestSha256 !== "string" ||
      !SHA256.test(artifact.finalSnapshotDigestSha256) ||
      artifact.finalSnapshotDigestSha256 !== current.digestSha256 ||
      artifact.backupRunId !== LARA_THEME_URGENCY_BACKUP_RUN_ID ||
      artifact.backupCompletedAt !== evidence.backupCompletedAt ||
      artifact.verifiedFiles !== expectedFilenames.length ||
      canonicalRemediationJson(artifact.filenames) !==
        canonicalRemediationJson(expectedFilenames) ||
      artifact.exactReplacementCount !== expectedReplacementCount ||
      typeof artifact.themeWriteExemptionConfirmedByShopify !== "boolean" ||
      artifact.vendorMutationIncluded !== false ||
      artifact.kachingWriteIncluded !== false ||
      canonicalRemediationJson(artifact.kaching) !==
        canonicalRemediationJson(expectedKaching) ||
      !checkpoint ||
      checkpoint.phase !== "verified" ||
      checkpoint.lastObservedState !== "after_exact" ||
      checkpoint.failureCode !== null ||
      lastVerification?.detail.finalSnapshotDigestSha256 !==
        artifact.finalSnapshotDigestSha256 ||
      checkpoint.exemptionConfirmedByShopify !==
        artifact.themeWriteExemptionConfirmedByShopify ||
      canonicalRemediationJson(artifact.journal) !==
        canonicalRemediationJson(checkpoint.journal) ||
      !validTimestamp(artifact.completedAt) ||
      !validTimestamp(run.completed_at) ||
      run.error_code !== null ||
      run.failed_at !== null ||
      !terminalLeaseCleared(run) ||
      !validTimestamp(run.started_at) ||
      run.attempt_count < 1 ||
      Date.parse(artifact.completedAt) < Date.parse(run.created_at) - 1_000 ||
      Date.parse(artifact.completedAt) > Date.parse(run.completed_at) + 1_000 ||
      observedState !== "after_exact"
    ) {
      throw new LaraThemeUrgencyRepairError(
        "repair_evidence_mismatch",
        "The completed Lara theme repair artifact is invalid.",
      );
    }
    return freezeRemediationValue({
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      state: "completed" as const,
      stage: "repair" as const,
      status: "verified" as const,
      planDigestSha256: evidence.manifestHash,
      backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      verifiedFiles: artifact.verifiedFiles,
      kachingStatus: LARA_THEME_URGENCY_KACHING_HANDLING.status,
    });
  }
  if (run.state === "failed") {
    const systemLeaseExpired = run.error_code === "lease_expired";
    if (
      !run.error_code ||
      (!systemLeaseExpired &&
        (!checkpoint ||
          checkpoint.phase !== "failed" ||
          checkpoint.failureCode !== run.error_code)) ||
      !validTimestamp(run.failed_at) ||
      run.completed_at !== null ||
      run.artifact !== null ||
      !terminalLeaseCleared(run) ||
      !validTimestamp(run.started_at) ||
      run.attempt_count < 1
    ) {
      throw new LaraThemeUrgencyRepairError(
        "repair_evidence_mismatch",
        "The failed Lara theme repair evidence is invalid.",
      );
    }
    return freezeRemediationValue({
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      state: "failed" as const,
      stage: "repair" as const,
      status: "manual_intervention_required" as const,
      planDigestSha256: evidence.manifestHash,
      backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      errorCode: run.error_code,
      kachingStatus: LARA_THEME_URGENCY_KACHING_HANDLING.status,
    });
  }
  if (
    !activeRunStateIsConsistent(run) ||
    (checkpoint === null &&
      (run.state !== "queued" || run.attempt_count !== 0 || run.retry_count !== 0)) ||
    checkpoint?.phase === "failed" ||
    (checkpoint?.phase === "prepared" && observedState !== "before_exact") ||
    (checkpoint?.phase === "verified" && observedState !== "after_exact")
  ) {
    throw new LaraThemeUrgencyRepairError(
      "repair_evidence_mismatch",
      "The active Lara theme repair evidence is inconsistent.",
    );
  }
  return freezeRemediationValue({
    runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
    state: "in_progress" as const,
    stage: "repair" as const,
    planDigestSha256: evidence.manifestHash,
    backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
  });
}

function classifiedFailure(error: unknown) {
  if (error instanceof LaraThemeUrgencyLiveRuntimeError) {
    return {
      code: error.code,
      retryable: error.retryable && error.code !== "mutation_ambiguous",
    };
  }
  if (error instanceof LaraThemeUrgencyRepairError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof AuditShopifyRunError) {
    return { code: error.code, retryable: true };
  }
  return { code: "theme_repair_failed", retryable: false };
}

export async function runLaraThemeUrgencyRepairOneShot({
  requestedBy,
  runtime: suppliedRuntime,
  now = () => new Date(),
  leaseToken = crypto.randomUUID(),
}: {
  requestedBy: string;
  runtime?: LaraThemeUrgencyLiveRuntime;
  now?: () => Date;
  leaseToken?: string;
}): Promise<LaraThemeUrgencyRepairResult> {
  const runtime = suppliedRuntime ?? (await createLaraThemeUrgencyLiveRuntime());
  const backup = await ensureDurableBackup({
    requestedBy,
    runtime,
    now,
    leaseToken,
  });
  if (backup.state === "in_progress") {
    return freezeRemediationValue({
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      state: "in_progress" as const,
      stage: "backup" as const,
    });
  }
  const material = backup.artifact.material;
  const schemaDigest = await schemaHash();
  const evidence = {
    requestedBy,
    schemaHash: schemaDigest,
    manifestHash: material.payload.plan.digestSha256,
    backupCompletedAt: backup.run.completed_at!,
  };
  const effectiveRunId = await enqueueAuditShopifyRun({
    runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    requestedBy,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    source: REPAIR_SOURCE,
    note: REPAIR_NOTE,
    schemaHash: schemaDigest,
    manifestHash: evidence.manifestHash,
    maxRetries: 3,
    actorType: "system",
  });
  if (effectiveRunId !== LARA_THEME_URGENCY_REPAIR_RUN_ID) {
    throw new LaraThemeUrgencyRepairError(
      "repair_evidence_mismatch",
      "The fixed Lara theme repair enqueue resolved to another run.",
    );
  }

  let claimed: AuditShopifyRun;
  try {
    claimed = await claimAuditShopifyRun({
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      leaseToken,
      leaseSeconds: LEASE_SECONDS,
    });
  } catch (error) {
    if (error instanceof AuditShopifyRunError && error.code === "run_not_found") {
      return resultFromExistingRepair(
        await getAuditShopifyRun({
          runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
          shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
        }),
        evidence,
        material,
        runtime,
      );
    }
    throw error;
  }
  if (
    !immutableEvidenceMatches(claimed, {
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      requestedBy,
      source: REPAIR_SOURCE,
      note: REPAIR_NOTE,
      schemaHash: schemaDigest,
      manifestHash: evidence.manifestHash,
    }) ||
    !backup.run.completed_at ||
    Date.parse(backup.run.completed_at) > Date.parse(claimed.created_at)
  ) {
    throw new LaraThemeUrgencyRepairError(
      "repair_evidence_mismatch",
      "The full Lara backup was not completed before the repair run.",
    );
  }

  const checkpoint =
    parseRepairCheckpoint(claimed.checkpoint, material) ??
    initialRepairCheckpoint(material);
  const append = (
    event: RepairJournalEntry["event"],
    detail: RepairJournalEntry["detail"] = {},
  ) => {
    if (checkpoint.journal.length >= MAX_JOURNAL_ENTRIES) {
      throw new LaraThemeUrgencyRepairError(
        "invalid_checkpoint",
        "The bounded Lara theme repair journal is full.",
      );
    }
    checkpoint.journal.push({
      sequence: checkpoint.journal.length + 1,
      occurredAt: now().toISOString(),
      event,
      detail,
    });
    assertRepairCheckpointBounded(checkpoint);
  };
  const persist = async () => {
    assertRepairCheckpointBounded(checkpoint);
    claimed = await renewAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      leaseSeconds: LEASE_SECONDS,
    });
  };
  const observe = async () => {
    const snapshot = await readLaraThemeUrgencySnapshot({
      runtime,
      capturedAt: material.payload.capturedAt,
    });
    const state = await classifyLaraThemeUrgencyLiveState({ material, current: snapshot });
    checkpoint.lastObservedState = state;
    return { state, snapshot };
  };
  const yieldCurrent = async () => {
    assertRepairCheckpointBounded(checkpoint);
    await yieldAuditRun({
      run: claimed,
      leaseToken,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
    });
    return freezeRemediationValue({
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      state: "in_progress" as const,
      stage: "repair" as const,
      planDigestSha256: material.payload.plan.digestSha256,
      backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
    });
  };

  if (!checkpoint.journal.some((entry) => entry.event === "run.claimed")) {
    append("run.claimed", {
      phase: checkpoint.phase,
      leaseGeneration: claimed.lease_generation,
    });
  }
  if (!checkpoint.journal.some((entry) => entry.event === "backup.verified")) {
    append("backup.verified", {
      backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      materialDigestSha256: material.digestSha256,
    });
  }

  try {
    checkpoint.failureCode = null;
    if (checkpoint.phase === "failed") {
      throw new LaraThemeUrgencyRepairError(
        "invalid_checkpoint",
        "A terminal Lara theme checkpoint cannot be resumed.",
      );
    }

    let observed = await observe();
    if (checkpoint.phase === "prepared") {
      if (observed.state !== "before_exact") {
        throw new LaraThemeUrgencyRepairError(
          "theme_state_drift",
          "The Lara theme no longer matches the durably backed-up source.",
        );
      }
      append("preflight.verified", {
        sourceSnapshotDigestSha256: material.payload.sourceSnapshot.digestSha256,
        operationCount: checkpoint.operationFilenames.length,
      });
      checkpoint.phase = "mutation_intent";
      checkpoint.mutationRequestedAt = now().toISOString();
      append("mutation.intent_persisted", {
        operationCount: checkpoint.operationFilenames.length,
      });
      await persist();

      try {
        const submitted = await runtime.submitApprovedPlan(material);
        checkpoint.exemptionConfirmedByShopify =
          submitted.exemptionConfirmedByShopify;
        append("mutation.acknowledged", {
          asynchronous: submitted.status === "pending",
          acknowledgedFiles: submitted.filenames.length,
        });
        if (submitted.status === "pending") {
          checkpoint.phase = "job_pending";
          checkpoint.jobId = submitted.jobId;
          append("job.pending", { jobId: submitted.jobId });
          await persist();
          return yieldCurrent();
        }
        checkpoint.phase = "verifying";
        await persist();
      } catch (error) {
        if (
          error instanceof LaraThemeUrgencyLiveRuntimeError &&
          error.code === "mutation_ambiguous"
        ) {
          checkpoint.reconciliationCount += 1;
          observed = await observe();
          append("mutation.reconciled", {
            observedState: observed.state,
            reconciliationCount: checkpoint.reconciliationCount,
          });
          if (observed.state === "after_exact") {
            checkpoint.phase = "verifying";
            await persist();
          } else if (
            observed.state !== "drift" &&
            checkpoint.reconciliationCount < MAX_UNCONFIRMED_RECONCILIATIONS
          ) {
            await persist();
            return yieldCurrent();
          } else {
            throw new LaraThemeUrgencyRepairError(
              observed.state === "drift"
                ? "theme_state_drift"
                : "theme_write_unresolved",
              "The unconfirmed Lara theme mutation could not be reconciled safely.",
            );
          }
        } else {
          throw error;
        }
      }
    } else if (checkpoint.phase === "mutation_intent") {
      checkpoint.reconciliationCount += 1;
      append("mutation.reconciled", {
        observedState: observed.state,
        reconciliationCount: checkpoint.reconciliationCount,
      });
      if (observed.state === "after_exact") {
        checkpoint.phase = "verifying";
        await persist();
      } else if (
        observed.state !== "drift" &&
        checkpoint.reconciliationCount < MAX_UNCONFIRMED_RECONCILIATIONS
      ) {
        await persist();
        return yieldCurrent();
      } else {
        throw new LaraThemeUrgencyRepairError(
          observed.state === "drift"
            ? "theme_state_drift"
            : "theme_write_unresolved",
          "The persisted Lara mutation intent has no safely attributable outcome.",
        );
      }
    } else if (checkpoint.phase === "job_pending") {
      const jobPollAt = now();
      const mutationRequestedAt = Date.parse(checkpoint.mutationRequestedAt!);
      if (
        checkpoint.jobPollCount >= MAX_ASYNC_JOB_POLLS ||
        jobPollAt.getTime() - mutationRequestedAt >= MAX_ASYNC_JOB_AGE_MS
      ) {
        throw new LaraThemeUrgencyRepairError(
          "theme_write_unresolved",
          "The asynchronous Lara theme job exceeded its finite polling window.",
        );
      }
      checkpoint.jobPollCount += 1;
      const job = await runtime.readAsyncJob(checkpoint.jobId!);
      append("job.polled", {
        jobId: job.id,
        done: job.done,
        jobPollCount: checkpoint.jobPollCount,
      });
      if (!job.done) {
        await persist();
        return yieldCurrent();
      }
      append("job.done", { jobId: job.id });
      checkpoint.phase = "verifying";
      await persist();
    }

    observed = await observe();
    if (
      (checkpoint.phase !== "verifying" && checkpoint.phase !== "verified") ||
      observed.state !== "after_exact"
    ) {
      if (
        checkpoint.phase === "verifying" &&
        observed.state !== "drift" &&
        checkpoint.reconciliationCount < MAX_UNCONFIRMED_RECONCILIATIONS
      ) {
        checkpoint.reconciliationCount += 1;
        await persist();
        return yieldCurrent();
      }
      throw new LaraThemeUrgencyRepairError(
        observed.state === "drift"
          ? "theme_state_drift"
          : "theme_write_unresolved",
        "The exact Lara theme postconditions were not verified.",
      );
    }

    if (checkpoint.phase !== "verified") {
      checkpoint.phase = "verified";
      checkpoint.reconciliationCount = Math.min(
        checkpoint.reconciliationCount,
        MAX_UNCONFIRMED_RECONCILIATIONS,
      );
      append("verification.complete", {
        verifiedFiles: checkpoint.operationFilenames.length,
        finalSnapshotDigestSha256: observed.snapshot.digestSha256,
        vendorMutationIncluded: false,
        kachingWriteIncluded: false,
      });
      await persist();
    }
    const artifact = {
      schemaVersion: LARA_THEME_URGENCY_REPAIR_SCHEMA_VERSION,
      status: "verified",
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      planDigestSha256: material.payload.plan.digestSha256,
      materialDigestSha256: material.digestSha256,
      finalSnapshotDigestSha256: observed.snapshot.digestSha256,
      backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      backupCompletedAt: backup.run.completed_at,
      verifiedFiles: checkpoint.operationFilenames.length,
      filenames: checkpoint.operationFilenames,
      exactReplacementCount: material.payload.plan.payload.operations.reduce(
        (total, operation) =>
          total +
          operation.exactChanges.reduce(
            (sum, change) => sum + change.expectedOccurrences,
            0,
          ),
        0,
      ),
      themeWriteExemptionConfirmedByShopify:
        checkpoint.exemptionConfirmedByShopify,
      vendorMutationIncluded: false,
      kachingWriteIncluded: false,
      kaching: {
        ...material.payload.kachingEvidence,
        handling: LARA_THEME_URGENCY_KACHING_HANDLING,
      },
      journal: checkpoint.journal,
      completedAt: now().toISOString(),
    };
    await completeAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      artifact,
    });
    return freezeRemediationValue({
      runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
      state: "completed" as const,
      stage: "repair" as const,
      status: "verified" as const,
      planDigestSha256: material.payload.plan.digestSha256,
      backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      verifiedFiles: checkpoint.operationFilenames.length,
      kachingStatus: LARA_THEME_URGENCY_KACHING_HANDLING.status,
    });
  } catch (error) {
    const failure = classifiedFailure(error);
    const willRetry =
      failure.retryable && claimed.retry_count < claimed.max_retries;
    checkpoint.failureCode = failure.code;
    if (checkpoint.journal.length < MAX_JOURNAL_ENTRIES) {
      append("run.failed", {
        errorCode: failure.code,
        retryable: willRetry,
        observedState: checkpoint.lastObservedState,
      });
    }
    checkpoint.phase = willRetry
      ? checkpoint.phase === "verified"
        ? "verifying"
        : checkpoint.phase
      : "failed";
    try {
      const failed = await failAuditShopifyRun({
        run: claimed,
        leaseToken,
        errorCode: failure.code,
        retryable: failure.retryable,
        checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      });
      return resultFromExistingRepair(failed, evidence, material, runtime);
    } catch {
      return resultFromExistingRepair(
        await getAuditShopifyRun({
          runId: LARA_THEME_URGENCY_REPAIR_RUN_ID,
          shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
        }),
        evidence,
        material,
        runtime,
      );
    }
  }
}
