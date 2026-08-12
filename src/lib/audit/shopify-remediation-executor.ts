import "server-only";

import { z } from "zod";

import {
  SHOPIFY_REMEDIATION_PLAN_SCHEMA_VERSION,
  countExactRemediationOccurrences,
  freezeRemediationValue,
  parseShopifyRemediationBeforeSnapshot,
  remediationOperationTargetKey,
  remediationProtectedFields,
  remediationSha256,
  remediationSnapshotStateSha256,
  remediationSnapshotTargetKey,
  verifyShopifyRemediationPlan,
  type DeepReadonly,
  type PageBeforeSnapshot,
  type PageRemediationCas,
  type PolicyBeforeSnapshot,
  type PolicyRemediationCas,
  type ReadonlyShopifyRemediationOperation,
  type SealedShopifyRemediationPlan,
  type ShopifyRemediationBeforeSnapshot,
  type ShopifyRemediationBeforeSnapshotInput,
  type ThemeBeforeSnapshot,
  type ThemeRemediationCas,
} from "./shopify-remediation-plan";

/**
 * There is intentionally no writer here. This skeleton proves an immutable
 * plan against caller-supplied before snapshots and prepares rollback material.
 * It does not import the connected Shopify runtime, call fetch, persist state,
 * expose a route, or execute GraphQL/REST mutations.
 */
export const SHOPIFY_REMEDIATION_LIVE_WRITES_IMPLEMENTED = false as const;
export const SHOPIFY_REMEDIATION_INVERSE_SCHEMA_VERSION =
  "shopify-remediation-inverse.v1" as const;

export type ShopifyRemediationRunStatus =
  | "dry_run_complete"
  | "blocked_apply_disabled"
  | "blocked_precondition";

export type ShopifyRemediationOperationStatus = "would_apply" | "blocked";

export type ShopifyRemediationBlockCode =
  | "APPLY_DISABLED"
  | "DUPLICATE_SNAPSHOT"
  | "EXPECTED_CHECKSUM_MISMATCH"
  | "EXPECTED_OCCURRENCES_MISMATCH"
  | "EXPECTED_UPDATED_AT_MISMATCH"
  | "EXTRA_SNAPSHOT"
  | "MISSING_SNAPSHOT"
  | "NO_EFFECT"
  | "OPERATION_SNAPSHOT_KIND_MISMATCH"
  | "PROTECTED_FIELD_MISMATCH"
  | "STATE_CAS_MISMATCH";

export type ShopifyRemediationJournalEvent =
  | "run.apply_blocked"
  | "run.dry_run_completed"
  | "run.precondition_blocked"
  | "run.preparing"
  | "operation.blocked"
  | "operation.cas_validated"
  | "operation.would_apply";

type JournalScalar = string | number | boolean | null;

export type ShopifyRemediationJournalEntry = DeepReadonly<{
  sequence: number;
  occurredAt: string;
  runId: string;
  planId: string;
  planDigestSha256: string;
  event: ShopifyRemediationJournalEvent;
  operationId: string | null;
  details: Record<string, JournalScalar>;
}>;

export type ShopifyRemediationOperationResult = DeepReadonly<{
  operationId: string;
  kind: ReadonlyShopifyRemediationOperation["kind"];
  targetKey: string;
  status: ShopifyRemediationOperationStatus;
  blockCode: ShopifyRemediationBlockCode | null;
  beforeStateSha256: string | null;
  projectedAfterStateSha256: string | null;
}>;

type PageInverseOperation = {
  originalOperationId: string;
  kind: "page.restore_body";
  target: PageBeforeSnapshot["target"];
  cas: {
    expectedAfterStateSha256: string;
    protectedFields: PageRemediationCas["protectedFields"];
  };
  restore: { bodyHtml: string };
};

type PolicyInverseOperation = {
  originalOperationId: string;
  kind: "policy.restore_body";
  target: PolicyBeforeSnapshot["target"];
  cas: {
    expectedAfterStateSha256: string;
    protectedFields: PolicyRemediationCas["protectedFields"];
  };
  restore: { body: string };
};

type ThemeInverseOperation = {
  originalOperationId: string;
  kind: "theme.restore_asset_content";
  target: ThemeBeforeSnapshot["target"];
  cas: {
    expectedAfterStateSha256: string;
    protectedFields: ThemeRemediationCas["protectedFields"];
  };
  restore: { content: string };
};

export type ShopifyRemediationInverseOperation =
  | PageInverseOperation
  | PolicyInverseOperation
  | ThemeInverseOperation;

export type ShopifyRemediationInverseManifestPayload = DeepReadonly<{
  schemaVersion: typeof SHOPIFY_REMEDIATION_INVERSE_SCHEMA_VERSION;
  sourcePlanSchemaVersion: typeof SHOPIFY_REMEDIATION_PLAN_SCHEMA_VERSION;
  sourcePlanId: string;
  sourcePlanDigestSha256: string;
  runId: string;
  createdAt: string;
  shop: SealedShopifyRemediationPlan["payload"]["shop"];
  operations: ShopifyRemediationInverseOperation[];
}>;

export type SealedShopifyRemediationInverseManifest = DeepReadonly<{
  payload: ShopifyRemediationInverseManifestPayload;
  digestSha256: string;
}>;

export type PreparedShopifyRemediationRun = DeepReadonly<{
  runId: string;
  planId: string;
  planDigestSha256: string;
  executionMode: "dry-run" | "apply";
  status: ShopifyRemediationRunStatus;
  writesAttempted: 0;
  liveWriterAttached: false;
  operationResults: ShopifyRemediationOperationResult[];
  beforeSnapshots: ShopifyRemediationBeforeSnapshot[];
  inverseManifest: SealedShopifyRemediationInverseManifest | null;
  journal: ShopifyRemediationJournalEntry[];
}>;

const runIdSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });

type JournalWriter = (
  event: ShopifyRemediationJournalEvent,
  operationId?: string | null,
  details?: Record<string, JournalScalar>,
) => void;

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1],
    )
  );
}

function operationMatchesSnapshot(
  operation: ReadonlyShopifyRemediationOperation,
  snapshot: ShopifyRemediationBeforeSnapshot,
): boolean {
  return (
    (operation.kind === "page.replace_body" && snapshot.kind === "page") ||
    (operation.kind === "policy.replace_body" && snapshot.kind === "policy") ||
    (operation.kind === "theme.replace_exact_text" && snapshot.kind === "theme_asset")
  );
}

async function blockCodeForCas(
  operation: ReadonlyShopifyRemediationOperation,
  snapshot: ShopifyRemediationBeforeSnapshot,
): Promise<ShopifyRemediationBlockCode | null> {
  if (!operationMatchesSnapshot(operation, snapshot)) {
    return "OPERATION_SNAPSHOT_KIND_MISMATCH";
  }
  if (operation.cas.expectedUpdatedAt !== snapshot.state.updatedAt) {
    return "EXPECTED_UPDATED_AT_MISMATCH";
  }
  if (
    operation.kind === "theme.replace_exact_text" &&
    snapshot.kind === "theme_asset" &&
    operation.cas.expectedChecksumMd5 !== snapshot.state.checksumMd5
  ) {
    return "EXPECTED_CHECKSUM_MISMATCH";
  }

  const actualProtected = await remediationProtectedFields(snapshot);
  if (!sameRecord(operation.cas.protectedFields, actualProtected)) {
    return "PROTECTED_FIELD_MISMATCH";
  }
  const actualState = await remediationSnapshotStateSha256(snapshot);
  if (operation.cas.beforeStateSha256 !== actualState) {
    return "STATE_CAS_MISMATCH";
  }

  if (
    operation.kind === "page.replace_body" &&
    snapshot.kind === "page" &&
    operation.change.bodyHtml === snapshot.state.bodyHtml
  ) {
    return "NO_EFFECT";
  }
  if (
    operation.kind === "policy.replace_body" &&
    snapshot.kind === "policy" &&
    operation.change.body === snapshot.state.body
  ) {
    return "NO_EFFECT";
  }
  if (operation.kind === "theme.replace_exact_text" && snapshot.kind === "theme_asset") {
    if (
      countExactRemediationOccurrences(snapshot.state.content, operation.change.needle) !==
      operation.change.expectedOccurrences
    ) {
      return "EXPECTED_OCCURRENCES_MISMATCH";
    }
  }
  return null;
}

function projectSnapshot(
  operation: ReadonlyShopifyRemediationOperation,
  snapshot: ShopifyRemediationBeforeSnapshot,
): ShopifyRemediationBeforeSnapshot {
  if (operation.kind === "page.replace_body" && snapshot.kind === "page") {
    return {
      ...snapshot,
      state: { ...snapshot.state, bodyHtml: operation.change.bodyHtml },
    };
  }
  if (operation.kind === "policy.replace_body" && snapshot.kind === "policy") {
    return {
      ...snapshot,
      state: { ...snapshot.state, body: operation.change.body },
    };
  }
  if (operation.kind === "theme.replace_exact_text" && snapshot.kind === "theme_asset") {
    return {
      ...snapshot,
      state: {
        ...snapshot.state,
        content: snapshot.state.content.split(operation.change.needle).join(
          operation.change.replacement,
        ),
      },
    };
  }
  throw new TypeError("The remediation operation and before snapshot do not match.");
}

function inverseOperation(
  operation: ReadonlyShopifyRemediationOperation,
  before: ShopifyRemediationBeforeSnapshot,
  expectedAfterStateSha256: string,
): ShopifyRemediationInverseOperation {
  if (operation.kind === "page.replace_body" && before.kind === "page") {
    return {
      originalOperationId: operation.operationId,
      kind: "page.restore_body",
      target: before.target,
      cas: {
        expectedAfterStateSha256,
        protectedFields: operation.cas.protectedFields,
      },
      restore: { bodyHtml: before.state.bodyHtml },
    };
  }
  if (operation.kind === "policy.replace_body" && before.kind === "policy") {
    return {
      originalOperationId: operation.operationId,
      kind: "policy.restore_body",
      target: before.target,
      cas: {
        expectedAfterStateSha256,
        protectedFields: operation.cas.protectedFields,
      },
      restore: { body: before.state.body },
    };
  }
  if (operation.kind === "theme.replace_exact_text" && before.kind === "theme_asset") {
    return {
      originalOperationId: operation.operationId,
      kind: "theme.restore_asset_content",
      target: before.target,
      cas: {
        expectedAfterStateSha256,
        protectedFields: operation.cas.protectedFields,
      },
      restore: { content: before.state.content },
    };
  }
  throw new TypeError("The remediation operation and before snapshot do not match.");
}

async function sealInverseManifest(
  payload: ShopifyRemediationInverseManifestPayload,
): Promise<SealedShopifyRemediationInverseManifest> {
  return freezeRemediationValue({
    payload,
    digestSha256: await remediationSha256(payload),
  });
}

function blockedResult(
  operation: ReadonlyShopifyRemediationOperation,
  blockCode: ShopifyRemediationBlockCode,
  beforeStateSha256: string | null = null,
): ShopifyRemediationOperationResult {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    targetKey: remediationOperationTargetKey(operation),
    status: "blocked",
    blockCode,
    beforeStateSha256,
    projectedAfterStateSha256: null,
  };
}

/**
 * Prepare an all-or-nothing dry run. No adapter capable of writing is accepted,
 * and an `apply` plan is fail-closed before before-snapshot evaluation.
 */
export async function prepareLaraShopifyRemediationRun({
  sealedPlan: sealedPlanInput,
  snapshots: snapshotInputs,
  runId: runIdInput,
  occurredAt: occurredAtInput,
}: {
  sealedPlan: SealedShopifyRemediationPlan | unknown;
  snapshots?: readonly ShopifyRemediationBeforeSnapshotInput[];
  runId: string;
  occurredAt: string;
}): Promise<PreparedShopifyRemediationRun> {
  const sealedPlan = await verifyShopifyRemediationPlan(sealedPlanInput);
  const runId = runIdSchema.parse(runIdInput);
  const occurredAt = timestampSchema.parse(occurredAtInput);
  const entries: ShopifyRemediationJournalEntry[] = [];
  const append: JournalWriter = (event, operationId = null, details = {}) => {
    entries.push({
      sequence: entries.length + 1,
      occurredAt,
      runId,
      planId: sealedPlan.payload.planId,
      planDigestSha256: sealedPlan.digestSha256,
      event,
      operationId,
      details,
    });
  };

  append("run.preparing", null, {
    executionMode: sealedPlan.payload.executionMode,
    operationCount: sealedPlan.payload.operations.length,
    writesImplemented: SHOPIFY_REMEDIATION_LIVE_WRITES_IMPLEMENTED,
  });

  if (sealedPlan.payload.executionMode === "apply") {
    append("run.apply_blocked", null, { code: "APPLY_DISABLED" });
    return freezeRemediationValue({
      runId,
      planId: sealedPlan.payload.planId,
      planDigestSha256: sealedPlan.digestSha256,
      executionMode: "apply",
      status: "blocked_apply_disabled",
      writesAttempted: 0 as const,
      liveWriterAttached: false as const,
      operationResults: sealedPlan.payload.operations.map((operation) =>
        blockedResult(operation, "APPLY_DISABLED"),
      ),
      beforeSnapshots: [],
      inverseManifest: null,
      journal: entries,
    });
  }

  const snapshots: ShopifyRemediationBeforeSnapshot[] = [];
  for (const input of snapshotInputs ?? []) {
    snapshots.push(
      parseShopifyRemediationBeforeSnapshot(input) as ShopifyRemediationBeforeSnapshot,
    );
  }

  const snapshotsByTarget = new Map<string, ShopifyRemediationBeforeSnapshot>();
  const duplicateTargets = new Set<string>();
  for (const snapshot of snapshots) {
    const target = remediationSnapshotTargetKey(snapshot);
    if (snapshotsByTarget.has(target)) duplicateTargets.add(target);
    snapshotsByTarget.set(target, snapshot);
  }

  const plannedTargets = new Set(
    sealedPlan.payload.operations.map(remediationOperationTargetKey),
  );
  const extraTargets = [...snapshotsByTarget.keys()].filter(
    (target) => !plannedTargets.has(target),
  );
  const results: ShopifyRemediationOperationResult[] = [];

  for (const operation of sealedPlan.payload.operations) {
    const target = remediationOperationTargetKey(operation);
    if (duplicateTargets.has(target)) {
      results.push(blockedResult(operation, "DUPLICATE_SNAPSHOT"));
      append("operation.blocked", operation.operationId, {
        code: "DUPLICATE_SNAPSHOT",
        targetKey: target,
      });
      continue;
    }
    const snapshot = snapshotsByTarget.get(target);
    if (!snapshot) {
      results.push(blockedResult(operation, "MISSING_SNAPSHOT"));
      append("operation.blocked", operation.operationId, {
        code: "MISSING_SNAPSHOT",
        targetKey: target,
      });
      continue;
    }
    const beforeStateSha256 = await remediationSnapshotStateSha256(snapshot);
    const blockCode = await blockCodeForCas(operation, snapshot);
    if (blockCode) {
      results.push(blockedResult(operation, blockCode, beforeStateSha256));
      append("operation.blocked", operation.operationId, {
        code: blockCode,
        targetKey: target,
      });
      continue;
    }
    const projected = projectSnapshot(operation, snapshot);
    const projectedAfterStateSha256 = await remediationSnapshotStateSha256(projected);
    results.push({
      operationId: operation.operationId,
      kind: operation.kind,
      targetKey: target,
      status: "would_apply",
      blockCode: null,
      beforeStateSha256,
      projectedAfterStateSha256,
    });
    append("operation.cas_validated", operation.operationId, {
      targetKey: target,
    });
    append("operation.would_apply", operation.operationId, {
      targetKey: target,
    });
  }

  if (extraTargets.length > 0) {
    append("run.precondition_blocked", null, {
      code: "EXTRA_SNAPSHOT",
      extraSnapshotCount: extraTargets.length,
    });
  }

  const blocked =
    extraTargets.length > 0 || results.some((result) => result.status === "blocked");
  if (blocked) {
    if (extraTargets.length === 0) {
      append("run.precondition_blocked", null, {
        blockedOperationCount: results.filter((result) => result.status === "blocked").length,
      });
    }
    return freezeRemediationValue({
      runId,
      planId: sealedPlan.payload.planId,
      planDigestSha256: sealedPlan.digestSha256,
      executionMode: "dry-run",
      status: "blocked_precondition",
      writesAttempted: 0 as const,
      liveWriterAttached: false as const,
      operationResults: results,
      beforeSnapshots: snapshots,
      inverseManifest: null,
      journal: entries,
    });
  }

  const inverseOperations: ShopifyRemediationInverseOperation[] = [];
  for (const [index, operation] of sealedPlan.payload.operations.entries()) {
    const snapshot = snapshotsByTarget.get(remediationOperationTargetKey(operation));
    const result = results[index];
    if (!snapshot || !result?.projectedAfterStateSha256) {
      throw new TypeError("A validated remediation operation lost its before snapshot.");
    }
    inverseOperations.push(
      inverseOperation(operation, snapshot, result.projectedAfterStateSha256),
    );
  }

  const inversePayload: ShopifyRemediationInverseManifestPayload = {
    schemaVersion: SHOPIFY_REMEDIATION_INVERSE_SCHEMA_VERSION,
    sourcePlanSchemaVersion: SHOPIFY_REMEDIATION_PLAN_SCHEMA_VERSION,
    sourcePlanId: sealedPlan.payload.planId,
    sourcePlanDigestSha256: sealedPlan.digestSha256,
    runId,
    createdAt: occurredAt,
    shop: sealedPlan.payload.shop,
    operations: inverseOperations,
  };
  const inverseManifest = await sealInverseManifest(inversePayload);
  append("run.dry_run_completed", null, {
    operationCount: results.length,
    inverseManifestSha256: inverseManifest.digestSha256,
  });

  return freezeRemediationValue({
    runId,
    planId: sealedPlan.payload.planId,
    planDigestSha256: sealedPlan.digestSha256,
    executionMode: "dry-run",
    status: "dry_run_complete",
    writesAttempted: 0 as const,
    liveWriterAttached: false as const,
    operationResults: results,
    beforeSnapshots: snapshots,
    inverseManifest,
    journal: entries,
  });
}
