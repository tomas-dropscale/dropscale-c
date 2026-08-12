import "server-only";

import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_SCHEMA_VERSION,
  LARA_THEME_URGENCY_THEME,
  LARA_THEME_VENDOR_POLICY,
  LaraThemeUrgencyPlanError,
  buildLaraThemeUrgencyPlan,
  readLaraThemeUrgencySnapshot,
  verifyLaraThemeUrgencyPlan,
  type LaraThemeUrgencyFilename,
  type LaraThemeUrgencyOperation,
  type LaraThemeUrgencyPlanPayload,
  type LaraThemeUrgencyReadRuntime,
  type LaraThemeUrgencySnapshot,
  type SealedLaraThemeUrgencyPlan,
} from "./lara-theme-urgency-plan";
import {
  LARA_ROVINJ_REMEDIATION_SHOP,
  canonicalRemediationJson,
  freezeRemediationValue,
  remediationSha256,
  type DeepReadonly,
} from "./shopify-remediation-plan";

export const LARA_THEME_URGENCY_BACKUP_SCHEMA_VERSION =
  "lara-theme-urgency-backup.v1" as const;
const MAX_DURABLE_BACKUP_ARTIFACT_BYTES = 8_000_000;

/** Fixed 2026-07 mutation document for a separately authenticated writer adapter. */
export const LARA_THEME_FILES_UPSERT_MUTATION = `#graphql
  mutation LaraThemeUrgencyFilesUpsert(
    $themeId: ID!
    $files: [OnlineStoreThemeFilesUpsertFileInput!]!
  ) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      job { id }
      userErrors { code field filename message }
    }
  }
`;

/** A writer adapter can use this fixed query to wait for an asynchronous upsert job. */
export const LARA_THEME_JOB_QUERY = `#graphql
  query LaraThemeUrgencyJob($jobId: ID!) {
    job(id: $jobId) { id done }
  }
`;

export type LaraThemeUrgencyBackupArtifact = DeepReadonly<{
  payload: {
    schemaVersion: typeof LARA_THEME_URGENCY_BACKUP_SCHEMA_VERSION;
    sourcePlanSchemaVersion: typeof LARA_THEME_URGENCY_SCHEMA_VERSION;
    sourcePlanId: string;
    sourcePlanDigestSha256: string;
    runId: string;
    createdAt: string;
    shop: typeof LARA_ROVINJ_REMEDIATION_SHOP;
    theme: SealedLaraThemeUrgencyPlan["payload"]["theme"];
    vendorPolicy: typeof LARA_THEME_VENDOR_POLICY;
    files: Array<{
      filename: LaraThemeUrgencyFilename;
      beforeContent: string;
      beforeContentSha256: string;
      plannedAfterContentSha256: string;
    }>;
  };
  digestSha256: string;
}>;

export type LaraThemeUrgencyBackupStore = Readonly<{
  persist(
    artifact: LaraThemeUrgencyBackupArtifact,
  ): Promise<{ artifactId: string; digestSha256: string }>;
}>;

export type LaraThemeUrgencyWriteRequest = DeepReadonly<{
  themeId: typeof LARA_THEME_URGENCY_THEME.id;
  reason: "apply";
  sourcePlanDigestSha256: string;
  files: Array<{
    filename: LaraThemeUrgencyFilename;
    body: { type: "TEXT"; value: string };
  }>;
}>;

/**
 * Deliberately separate from AuditShopifyRuntime: that runtime remains query-only.
 * The adapter must use API 2026-07, a fresh credential and the fixed mutation above.
 */
export type LaraThemeUrgencyWriter = Readonly<{
  shopDomain: typeof LARA_ROVINJ_REMEDIATION_SHOP.domain;
  shopId: typeof LARA_ROVINJ_REMEDIATION_SHOP.shopId;
  themeId: typeof LARA_THEME_URGENCY_THEME.id;
  apiVersion: "2026-07";
  grantedScopes: readonly string[];
  upsertThemeFiles(request: LaraThemeUrgencyWriteRequest): Promise<{
    filenames: readonly LaraThemeUrgencyFilename[];
    jobId: string | null;
    completed: true;
  }>;
}>;

export type LaraThemeUrgencyExecutionStatus =
  | "applied"
  | "dry_run_complete"
  | "failed_no_change"
  | "manual_intervention_required";

export type LaraThemeUrgencyExecutionResult = DeepReadonly<{
  runId: string;
  planId: string;
  planDigestSha256: string;
  status: LaraThemeUrgencyExecutionStatus;
  writesAttempted: number;
  backupArtifactId: string | null;
  backupDigestSha256: string | null;
  appliedFiles: LaraThemeUrgencyFilename[];
  /** Exact after-state files eligible only for a separately reviewed recovery. */
  manualRecoveryFiles: LaraThemeUrgencyFilename[];
  errorCode: string | null;
  preflightSnapshotDigestSha256: string;
  finalSnapshotDigestSha256: string | null;
}>;

export class LaraThemeUrgencyExecutionError extends Error {
  constructor(
    public readonly code:
      | "BACKUP_NOT_DURABLE"
      | "BACKUP_TOO_LARGE"
      | "AMBIGUOUS_ACTIVE_COPY"
      | "INVALID_BACKUP_STORE"
      | "INVALID_EXECUTION_INPUT"
      | "INVALID_WRITER"
      | "KACHING_WRITE_BLOCKED"
      | "NO_EXACT_OPERATIONS"
      | "PREFLIGHT_CAS_MISMATCH"
      | "PREFLIGHT_PLAN_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "LaraThemeUrgencyExecutionError";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertTimestamp(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new LaraThemeUrgencyExecutionError(
      "INVALID_EXECUTION_INPUT",
      "The Lara execution timestamp is invalid.",
    );
  }
}

function assertWriter(writer: LaraThemeUrgencyWriter): void {
  if (
    writer.shopDomain !== LARA_ROVINJ_REMEDIATION_SHOP.domain ||
    writer.shopId !== LARA_ROVINJ_REMEDIATION_SHOP.shopId ||
    writer.themeId !== LARA_THEME_URGENCY_THEME.id ||
    writer.apiVersion !== "2026-07" ||
    !writer.grantedScopes.includes("write_themes") ||
    typeof writer.upsertThemeFiles !== "function"
  ) {
    throw new LaraThemeUrgencyExecutionError(
      "INVALID_WRITER",
      "The mutation writer is not pinned to the exact Lara theme and API 2026-07.",
    );
  }
}

function sourceFileMap(payload: LaraThemeUrgencyPlanPayload) {
  return new Map(payload.sourceFiles.map((file) => [file.filename, file]));
}

function snapshotFileMap(snapshot: LaraThemeUrgencySnapshot) {
  return new Map(snapshot.files.map((file) => [file.filename, file]));
}

function sameFilenameSet(
  actual: readonly LaraThemeUrgencyFilename[],
  expected: readonly LaraThemeUrgencyFilename[],
): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((filename) => actual.includes(filename))
  );
}

function assertFreshSourceCas(
  plan: SealedLaraThemeUrgencyPlan,
  fresh: LaraThemeUrgencySnapshot,
): void {
  if (
    fresh.theme.name !== plan.payload.theme.name ||
    fresh.theme.nameSha256 !== plan.payload.theme.nameSha256 ||
    fresh.theme.role !== plan.payload.theme.role ||
    fresh.theme.roleSha256 !== plan.payload.theme.roleSha256
  ) {
    throw new LaraThemeUrgencyExecutionError(
      "PREFLIGHT_CAS_MISMATCH",
      "The protected Lara main theme identity changed after planning.",
    );
  }
  const expected = sourceFileMap(plan.payload);
  const actual = snapshotFileMap(fresh);
  for (const filename of LARA_THEME_URGENCY_FILES) {
    const before = expected.get(filename);
    const current = actual.get(filename);
    if (
      !before ||
      !current ||
      before.updatedAt !== current.updatedAt ||
      before.checksumMd5 !== current.checksumMd5 ||
      before.contentType !== current.contentType ||
      before.size !== current.size ||
      before.contentSha256 !== current.contentSha256
    ) {
      throw new LaraThemeUrgencyExecutionError(
        "PREFLIGHT_CAS_MISMATCH",
        `The exact pre-write state changed for ${filename}.`,
      );
    }
  }
}

async function assertFreshPlanMatches(
  plan: SealedLaraThemeUrgencyPlan,
  fresh: LaraThemeUrgencySnapshot,
): Promise<void> {
  const reboundStable = {
    shop: fresh.shop,
    capturedAt: plan.payload.sourceCapturedAt,
    theme: fresh.theme,
    files: fresh.files,
  };
  const rebound = freezeRemediationValue({
    ...reboundStable,
    digestSha256: await remediationSha256(reboundStable),
  }) as LaraThemeUrgencySnapshot;
  const rebuilt = await buildLaraThemeUrgencyPlan({
    snapshot: rebound,
    planId: plan.payload.planId,
    createdAt: plan.payload.createdAt,
    executionMode: plan.payload.executionMode,
    purpose: plan.payload.purpose,
  });
  if (rebuilt.digestSha256 !== plan.digestSha256) {
    throw new LaraThemeUrgencyExecutionError(
      "PREFLIGHT_PLAN_MISMATCH",
      "The exact Lara transformations no longer rebuild the sealed plan.",
    );
  }
}

async function backupArtifact(
  plan: SealedLaraThemeUrgencyPlan,
  fresh: LaraThemeUrgencySnapshot,
  runId: string,
  createdAt: string,
): Promise<LaraThemeUrgencyBackupArtifact> {
  const operations = new Map(
    plan.payload.operations.map((operation) => [
      operation.target.filename,
      operation,
    ]),
  );
  const freshFiles = snapshotFileMap(fresh);
  const files = LARA_THEME_URGENCY_FILES.map((filename) => {
    const source = freshFiles.get(filename);
    if (!source) {
      throw new LaraThemeUrgencyExecutionError(
        "INVALID_EXECUTION_INPUT",
        `The exact backup source is missing ${filename}.`,
      );
    }
    const operation = operations.get(filename);
    return {
      filename,
      beforeContent: source.content,
      beforeContentSha256: source.contentSha256,
      plannedAfterContentSha256:
        operation?.after.contentSha256 ?? source.contentSha256,
    };
  });
  const payload: LaraThemeUrgencyBackupArtifact["payload"] = {
    schemaVersion: LARA_THEME_URGENCY_BACKUP_SCHEMA_VERSION,
    sourcePlanSchemaVersion: LARA_THEME_URGENCY_SCHEMA_VERSION,
    sourcePlanId: plan.payload.planId,
    sourcePlanDigestSha256: plan.digestSha256,
    runId,
    createdAt,
    shop: LARA_ROVINJ_REMEDIATION_SHOP,
    theme: plan.payload.theme,
    vendorPolicy: LARA_THEME_VENDOR_POLICY,
    files,
  };
  return freezeRemediationValue({
    payload,
    digestSha256: await remediationSha256(payload),
  });
}

function writeRequest(
  plan: SealedLaraThemeUrgencyPlan,
  operations: readonly LaraThemeUrgencyOperation[],
): LaraThemeUrgencyWriteRequest {
  return {
    themeId: LARA_THEME_URGENCY_THEME.id,
    reason: "apply",
    sourcePlanDigestSha256: plan.digestSha256,
    files: operations.map((operation) => ({
      filename: operation.target.filename,
      body: {
        type: "TEXT",
        value: operation.after.content,
      },
    })),
  };
}

function operationState(
  operation: LaraThemeUrgencyOperation,
  snapshot: LaraThemeUrgencySnapshot,
): "after" | "before" | "unknown" {
  const file = snapshot.files.find(
    (candidate) => candidate.filename === operation.target.filename,
  );
  if (!file) return "unknown";
  if (file.contentSha256 === operation.after.contentSha256) return "after";
  if (file.contentSha256 === operation.before.contentSha256) return "before";
  return "unknown";
}

function sameSourceFile(
  before: LaraThemeUrgencySnapshot["files"][number],
  after: LaraThemeUrgencySnapshot["files"][number],
): boolean {
  return (
    before.filename === after.filename &&
    before.updatedAt === after.updatedAt &&
    before.checksumMd5 === after.checksumMd5 &&
    before.contentType === after.contentType &&
    before.size === after.size &&
    before.contentSha256 === after.contentSha256 &&
    before.content === after.content
  );
}

function exactPostconditionSatisfied(
  plan: SealedLaraThemeUrgencyPlan,
  before: LaraThemeUrgencySnapshot,
  after: LaraThemeUrgencySnapshot,
): boolean {
  const operations = new Map(
    plan.payload.operations.map((operation) => [
      operation.target.filename,
      operation,
    ]),
  );
  const beforeFiles = snapshotFileMap(before);
  const afterFiles = snapshotFileMap(after);
  return LARA_THEME_URGENCY_FILES.every((filename) => {
    const operation = operations.get(filename);
    if (operation) return operationState(operation, after) === "after";
    const original = beforeFiles.get(filename);
    const observed = afterFiles.get(filename);
    return Boolean(original && observed && sameSourceFile(original, observed));
  });
}

async function safeRead(
  runtime: LaraThemeUrgencyReadRuntime,
  capturedAt: string,
): Promise<LaraThemeUrgencySnapshot | null> {
  try {
    return await readLaraThemeUrgencySnapshot({ runtime, capturedAt });
  } catch {
    return null;
  }
}

async function inspectPostWriteFailure({
  plan,
  runtime,
  capturedAt,
}: {
  plan: SealedLaraThemeUrgencyPlan;
  runtime: LaraThemeUrgencyReadRuntime;
  capturedAt: string;
}): Promise<{
  status: Extract<LaraThemeUrgencyExecutionStatus, "failed_no_change" | "manual_intervention_required">;
  manualRecoveryFiles: LaraThemeUrgencyFilename[];
  finalSnapshot: LaraThemeUrgencySnapshot | null;
}> {
  const current = await safeRead(runtime, capturedAt);
  if (!current) {
    return {
      status: "manual_intervention_required",
      manualRecoveryFiles: [],
      finalSnapshot: null,
    };
  }
  const states = plan.payload.operations.map((operation) => ({
    operation,
    state: operationState(operation, current),
  }));
  if (states.every(({ state }) => state === "before")) {
    return {
      status: "failed_no_change",
      manualRecoveryFiles: [],
      finalSnapshot: current,
    };
  }
  const manualRecoveryFiles = states
    .filter(({ state }) => state === "after")
    .map(({ operation }) => operation.target.filename);
  return {
    status: "manual_intervention_required",
    manualRecoveryFiles,
    finalSnapshot: current,
  };
}

/**
 * Single-batch executor. It re-reads all fixed sources, rebuilds the plan,
 * persists all eight raw bodies, writes once, and verifies every changed body.
 * A partial or ambiguous result is evidence for manual recovery, never a
 * trigger for an automatic rollback write.
 */
export async function executeLaraThemeUrgencyPlan({
  sealedPlan,
  readRuntime,
  writer,
  backupStore,
  runId,
  occurredAt,
}: {
  sealedPlan: SealedLaraThemeUrgencyPlan;
  readRuntime: LaraThemeUrgencyReadRuntime;
  writer?: LaraThemeUrgencyWriter;
  backupStore?: LaraThemeUrgencyBackupStore;
  runId: string;
  occurredAt: string;
}): Promise<LaraThemeUrgencyExecutionResult> {
  const plan = await verifyLaraThemeUrgencyPlan(sealedPlan);
  if (!UUID.test(runId)) {
    throw new LaraThemeUrgencyExecutionError(
      "INVALID_EXECUTION_INPUT",
      "The Lara execution run id is invalid.",
    );
  }
  assertTimestamp(occurredAt);
  if (plan.payload.operations.length === 0) {
    throw new LaraThemeUrgencyExecutionError(
      "NO_EXACT_OPERATIONS",
      "The sealed plan contains no exact theme changes.",
    );
  }
  if (plan.payload.blockers.some((blocker) => blocker.code === "AMBIGUOUS_ACTIVE_COPY")) {
    throw new LaraThemeUrgencyExecutionError(
      "AMBIGUOUS_ACTIVE_COPY",
      "The sealed plan retains unsupported active copy without an approved exact replacement.",
    );
  }
  if (
    plan.payload.operations.some(
      (operation) => operation.target.filename === "config/settings_data.json",
    )
  ) {
    throw new LaraThemeUrgencyExecutionError(
      "KACHING_WRITE_BLOCKED",
      "The Kaching settings source is evidence-only in this copy batch.",
    );
  }

  const fresh = await readLaraThemeUrgencySnapshot({
    runtime: readRuntime,
    capturedAt: occurredAt,
  });
  assertFreshSourceCas(plan, fresh);
  await assertFreshPlanMatches(plan, fresh);

  if (plan.payload.executionMode === "dry-run") {
    return freezeRemediationValue({
      runId,
      planId: plan.payload.planId,
      planDigestSha256: plan.digestSha256,
      status: "dry_run_complete" as const,
      writesAttempted: 0,
      backupArtifactId: null,
      backupDigestSha256: null,
      appliedFiles: [],
      manualRecoveryFiles: [],
      errorCode: null,
      preflightSnapshotDigestSha256: fresh.digestSha256,
      finalSnapshotDigestSha256: fresh.digestSha256,
    });
  }

  if (!writer) {
    throw new LaraThemeUrgencyExecutionError(
      "INVALID_WRITER",
      "An apply plan requires the separately authenticated Lara writer.",
    );
  }
  assertWriter(writer);
  if (!backupStore || typeof backupStore.persist !== "function") {
    throw new LaraThemeUrgencyExecutionError(
      "INVALID_BACKUP_STORE",
      "An apply plan requires a durable backup store.",
    );
  }

  const backup = await backupArtifact(plan, fresh, runId, occurredAt);
  if (
    new TextEncoder().encode(serializeLaraThemeUrgencyBackup(backup)).byteLength >
    MAX_DURABLE_BACKUP_ARTIFACT_BYTES
  ) {
    throw new LaraThemeUrgencyExecutionError(
      "BACKUP_TOO_LARGE",
      "The complete eight-file backup exceeds the durable artifact limit; no write was attempted.",
    );
  }
  let persisted: Awaited<ReturnType<LaraThemeUrgencyBackupStore["persist"]>>;
  try {
    persisted = await backupStore.persist(backup);
  } catch {
    throw new LaraThemeUrgencyExecutionError(
      "BACKUP_NOT_DURABLE",
      "The inverse artifact was not durably acknowledged; no write was attempted.",
    );
  }
  if (
    !persisted.artifactId.trim() ||
    persisted.digestSha256 !== backup.digestSha256
  ) {
    throw new LaraThemeUrgencyExecutionError(
      "BACKUP_NOT_DURABLE",
      "The durable backup acknowledgement did not match the sealed inverse artifact.",
    );
  }

  try {
    const response = await writer.upsertThemeFiles(
      writeRequest(plan, plan.payload.operations),
    );
    if (
      response.completed !== true ||
      !sameFilenameSet(
        response.filenames,
        plan.payload.operations.map((operation) => operation.target.filename),
      )
    ) {
      throw new TypeError("Shopify did not confirm the complete fixed write set.");
    }
    const verified = await readLaraThemeUrgencySnapshot({
      runtime: readRuntime,
      capturedAt: occurredAt,
    });
    if (
      verified.theme.name !== plan.payload.theme.name ||
      !exactPostconditionSatisfied(plan, fresh, verified)
    ) {
      throw new TypeError("The Lara theme write did not satisfy every postcondition.");
    }
    return freezeRemediationValue({
      runId,
      planId: plan.payload.planId,
      planDigestSha256: plan.digestSha256,
      status: "applied" as const,
      writesAttempted: 1,
      backupArtifactId: persisted.artifactId,
      backupDigestSha256: persisted.digestSha256,
      appliedFiles: plan.payload.operations.map(
        (operation) => operation.target.filename,
      ),
      manualRecoveryFiles: [],
      errorCode: null,
      preflightSnapshotDigestSha256: fresh.digestSha256,
      finalSnapshotDigestSha256: verified.digestSha256,
    });
  } catch {
    const inspection = await inspectPostWriteFailure({
      plan,
      runtime: readRuntime,
      capturedAt: occurredAt,
    });
    return freezeRemediationValue({
      runId,
      planId: plan.payload.planId,
      planDigestSha256: plan.digestSha256,
      status: inspection.status,
      writesAttempted: 1,
      backupArtifactId: persisted.artifactId,
      backupDigestSha256: persisted.digestSha256,
      appliedFiles: [],
      manualRecoveryFiles: inspection.manualRecoveryFiles,
      errorCode:
        inspection.status === "manual_intervention_required"
          ? "POST_WRITE_STATE_UNSAFE"
          : "SHOPIFY_WRITE_FAILED",
      preflightSnapshotDigestSha256: fresh.digestSha256,
      finalSnapshotDigestSha256:
        inspection.finalSnapshot?.digestSha256 ?? null,
    });
  }
}

/** Utility for artifact adapters that need the canonical bytes covered by the digest. */
export function serializeLaraThemeUrgencyBackup(
  artifact: LaraThemeUrgencyBackupArtifact,
): string {
  return canonicalRemediationJson(artifact);
}

export function isLaraThemeUrgencyPlanError(
  error: unknown,
): error is LaraThemeUrgencyPlanError | LaraThemeUrgencyExecutionError {
  return (
    error instanceof LaraThemeUrgencyPlanError ||
    error instanceof LaraThemeUrgencyExecutionError
  );
}
