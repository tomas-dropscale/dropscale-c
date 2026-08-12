import "server-only";

import {
  LARA_ABOUT_PAGE_BODY_HTML,
  LARA_CONTACT_PAGE_BODY_HTML,
  LARA_TRUST_PAGE_TARGETS,
  prepareLaraTrustPageBatch,
  type LaraTrustPageState,
  type PreparedLaraTrustPageBatch,
} from "./lara-trust-pages";
import {
  createLaraTrustPagesRuntime,
  LARA_TRUST_PAGES_GRAPHQL_MANIFEST,
  LaraTrustPagesRuntimeError,
  type LaraTrustPagesRuntime,
} from "./lara-trust-pages-runtime";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  buildShopifyRemediationCas,
  canonicalRemediationJson,
  freezeRemediationValue,
  LARA_ROVINJ_REMEDIATION_SHOP,
  parseShopifyRemediationBeforeSnapshot,
  remediationProtectedFields,
  remediationSha256,
  remediationSnapshotStateSha256,
  SHOPIFY_REMEDIATION_PLAN_SCHEMA_VERSION,
  verifyShopifyRemediationPlan,
  type DeepReadonly,
  type PageBeforeSnapshot,
  type PageRemediationCas,
  type PageReplaceOperation,
  type SealedShopifyRemediationPlan,
} from "./shopify-remediation-plan";
import {
  SHOPIFY_REMEDIATION_INVERSE_SCHEMA_VERSION,
  type SealedShopifyRemediationInverseManifest,
} from "./shopify-remediation-executor";
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

export const LARA_TRUST_PAGES_REPAIR_SCHEMA_VERSION =
  "lara-trust-pages-repair.v1" as const;
export const LARA_TRUST_PAGES_REPAIR_RUN_ID =
  "622f8f1d-bb20-4ecf-86ac-56f5f3a08be8" as const;
export const LARA_TRUST_PAGES_REPAIR_PLAN_CREATED_AT =
  "2026-08-12T20:00:00.000Z" as const;
export const LARA_TRUST_PAGES_REPAIR_PLAN_ID =
  "lara-trust-pages-contact-about-v1" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const LEASE_SECONDS = 300;
const MAX_RETRIES = 2;
const MAX_CHECKPOINT_BYTES = 60_000;
const MAX_JOURNAL_ENTRIES = 100;
const TRUST_PAGES_SOURCE = "system.trust_pages_repair" as const;
const TRUST_PAGES_NOTE =
  "Authorised Lara Contact/About body repair with exact rollback material" as const;
const APPROVED_BODY_BY_ID = Object.freeze({
  [LARA_TRUST_PAGE_TARGETS[0].resourceId]: LARA_CONTACT_PAGE_BODY_HTML,
  [LARA_TRUST_PAGE_TARGETS[1].resourceId]: LARA_ABOUT_PAGE_BODY_HTML,
});

type FixedMaterial = DeepReadonly<{
  plan: SealedShopifyRemediationPlan;
  inverse: SealedShopifyRemediationInverseManifest;
  beforeSnapshots: PageBeforeSnapshot[];
}>;

type AppliedPage = {
  operationId: string;
  after: LaraTrustPageState;
};

type TrustPagesJournalEntry = {
  sequence: number;
  occurredAt: string;
  event:
    | "run.claimed"
    | "run.material_persisted"
    | "run.preflight_verified"
    | "operation.prepared"
    | "operation.reconcile_started"
    | "operation.applied"
    | "operation.reconciled"
    | "rollback.started"
    | "rollback.prepared"
    | "rollback.reconcile_started"
    | "rollback.restored"
    | "rollback.reconciled"
    | "run.admin_verified"
    | "run.failed";
  operationId: string | null;
  resourceId: string | null;
  details: Record<string, string | number | boolean | null>;
};

type TrustPagesCheckpoint = {
  schemaVersion: typeof LARA_TRUST_PAGES_REPAIR_SCHEMA_VERSION;
  phase: "prepared" | "applying" | "rolling_back" | "verified" | "failed";
  planDigestSha256: string;
  material: FixedMaterial;
  nextOperationIndex: number;
  applied: AppliedPage[];
  restoredOperationIds: string[];
  failureCode: string | null;
  journal: TrustPagesJournalEntry[];
};

export type LaraTrustPagesDryRunResult = DeepReadonly<{
  runId: typeof LARA_TRUST_PAGES_REPAIR_RUN_ID;
  mode: "dry-run";
  writesAttempted: 0;
  planId: typeof LARA_TRUST_PAGES_REPAIR_PLAN_ID;
  planDigestSha256: string;
  inverseDigestSha256: string;
  operations: Array<{
    operationId: string;
    resourceId: string;
    handle: string;
    beforeStateSha256: string;
    projectedAfterStateSha256: string;
  }>;
}>;

export type LaraTrustPagesRepairResult = DeepReadonly<{
  runId: typeof LARA_TRUST_PAGES_REPAIR_RUN_ID;
  state: "completed" | "failed" | "in_progress";
  status?: "verified" | "rolled_back" | "rollback_incomplete";
  planDigestSha256?: string;
  verifiedCount?: number;
  errorCode?: string;
}>;

export class LaraTrustPagesRepairError extends Error {
  constructor(
    public readonly code:
      | "approval_digest_mismatch"
      | "invalid_checkpoint"
      | "invalid_plan"
      | "page_drift"
      | "page_not_verified"
      | "repair_failed"
      | "run_evidence_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "LaraTrustPagesRepairError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function checkpointBytes(value: TrustPagesCheckpoint): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertCheckpointBounded(value: TrustPagesCheckpoint): void {
  if (
    value.journal.length > MAX_JOURNAL_ENTRIES ||
    checkpointBytes(value) > MAX_CHECKPOINT_BYTES
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page checkpoint exceeds its fixed safety bound.",
    );
  }
}

function operationsFor(plan: SealedShopifyRemediationPlan) {
  return plan.payload.operations as readonly PageReplaceOperation[];
}

function inverseFor(material: FixedMaterial, operationId: string) {
  const inverse = material.inverse.payload.operations.find(
    (candidate) => candidate.originalOperationId === operationId,
  );
  if (!inverse || inverse.kind !== "page.restore_body") {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page inverse is incomplete.",
    );
  }
  return inverse;
}

function pageStateFromUnknown(value: unknown): LaraTrustPageState {
  const page = objectRecord(value);
  if (
    !page ||
    !exactKeys(page, [
      "id",
      "title",
      "handle",
      "bodyHtml",
      "templateSuffix",
      "isPublished",
      "publishedAt",
      "updatedAt",
    ]) ||
    typeof page.id !== "string" ||
    typeof page.title !== "string" ||
    page.title.length > 255 ||
    typeof page.handle !== "string" ||
    typeof page.bodyHtml !== "string" ||
    new TextEncoder().encode(page.bodyHtml).byteLength > 500_000 ||
    (page.templateSuffix !== null && typeof page.templateSuffix !== "string") ||
    (typeof page.templateSuffix === "string" && page.templateSuffix.length > 255) ||
    typeof page.isPublished !== "boolean" ||
    (page.publishedAt !== null &&
      (typeof page.publishedAt !== "string" ||
        !Number.isFinite(Date.parse(page.publishedAt)))) ||
    typeof page.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(page.updatedAt))
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page state is invalid.",
    );
  }
  const target = LARA_TRUST_PAGE_TARGETS.find((candidate) => candidate.resourceId === page.id);
  if (!target || target.handle !== page.handle || target.title !== page.title) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page identity is invalid.",
    );
  }
  return {
    id: page.id,
    title: page.title,
    handle: page.handle,
    bodyHtml: page.bodyHtml,
    templateSuffix: page.templateSuffix,
    isPublished: page.isPublished,
    publishedAt: page.publishedAt,
    updatedAt: page.updatedAt,
  };
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

async function expectedFor(page: LaraTrustPageState) {
  const cas = (await buildShopifyRemediationCas(pageSnapshot(page))) as PageRemediationCas;
  return freezeRemediationValue({
    updatedAt: page.updatedAt,
    bodySha256: await remediationSha256(page.bodyHtml),
    protectedFieldsSha256: await remediationSha256(cas.protectedFields),
  });
}

async function protectedFieldsMatch(
  page: LaraTrustPageState,
  operation: PageReplaceOperation,
) {
  return (
    page.id === operation.target.resourceId &&
    page.handle === operation.target.handle &&
    canonicalRemediationJson(await remediationProtectedFields(pageSnapshot(page))) ===
      canonicalRemediationJson(operation.cas.protectedFields)
  );
}

async function originalStateMatches(
  page: LaraTrustPageState,
  operation: PageReplaceOperation,
) {
  const cas = (await buildShopifyRemediationCas(pageSnapshot(page))) as PageRemediationCas;
  return (
    page.updatedAt === operation.cas.expectedUpdatedAt &&
    canonicalRemediationJson(cas) === canonicalRemediationJson(operation.cas)
  );
}

async function intendedStateMatches(
  page: LaraTrustPageState,
  operation: PageReplaceOperation,
) {
  return (
    page.bodyHtml === operation.change.bodyHtml &&
    (await protectedFieldsMatch(page, operation))
  );
}

async function restoredStateMatches(
  page: LaraTrustPageState,
  operation: PageReplaceOperation,
  material: FixedMaterial,
) {
  const inverse = inverseFor(material, operation.operationId);
  return (
    page.bodyHtml === inverse.restore.bodyHtml &&
    (await protectedFieldsMatch(page, operation))
  );
}

function assertInverseManifestShape(value: unknown): void {
  const inverse = objectRecord(value);
  const payload = objectRecord(inverse?.payload);
  const shop = objectRecord(payload?.shop);
  if (
    !inverse ||
    !payload ||
    !shop ||
    !exactKeys(inverse, ["payload", "digestSha256"]) ||
    !exactKeys(payload, [
      "schemaVersion",
      "sourcePlanSchemaVersion",
      "sourcePlanId",
      "sourcePlanDigestSha256",
      "runId",
      "createdAt",
      "shop",
      "operations",
    ]) ||
    !exactKeys(shop, ["domain", "shopId"]) ||
    payload.schemaVersion !== SHOPIFY_REMEDIATION_INVERSE_SCHEMA_VERSION ||
    payload.sourcePlanSchemaVersion !== SHOPIFY_REMEDIATION_PLAN_SCHEMA_VERSION ||
    typeof inverse.digestSha256 !== "string" ||
    !SHA256.test(inverse.digestSha256) ||
    typeof payload.sourcePlanDigestSha256 !== "string" ||
    !SHA256.test(payload.sourcePlanDigestSha256) ||
    !Array.isArray(payload.operations)
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page inverse shape is invalid.",
    );
  }
  for (const value of payload.operations) {
    const operation = objectRecord(value);
    const target = objectRecord(operation?.target);
    const cas = objectRecord(operation?.cas);
    const protectedFields = objectRecord(cas?.protectedFields);
    const restore = objectRecord(operation?.restore);
    if (
      !operation ||
      !target ||
      !cas ||
      !protectedFields ||
      !restore ||
      !exactKeys(operation, [
        "originalOperationId",
        "kind",
        "target",
        "cas",
        "restore",
      ]) ||
      !exactKeys(target, ["resourceId", "handle"]) ||
      !exactKeys(cas, ["expectedAfterStateSha256", "protectedFields"]) ||
      !exactKeys(protectedFields, [
        "handleSha256",
        "titleSha256",
        "templateSuffixSha256",
        "publicationSha256",
      ]) ||
      !exactKeys(restore, ["bodyHtml"]) ||
      operation.kind !== "page.restore_body" ||
      typeof operation.originalOperationId !== "string" ||
      typeof target.resourceId !== "string" ||
      typeof target.handle !== "string" ||
      typeof cas.expectedAfterStateSha256 !== "string" ||
      !SHA256.test(cas.expectedAfterStateSha256) ||
      Object.values(protectedFields).some(
        (digest) => typeof digest !== "string" || !SHA256.test(digest),
      ) ||
      typeof restore.bodyHtml !== "string" ||
      new TextEncoder().encode(restore.bodyHtml).byteLength > 500_000
    ) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "A durable trust-page inverse operation is invalid.",
      );
    }
  }
}

async function assertFixedMaterial(material: FixedMaterial): Promise<FixedMaterial> {
  assertInverseManifestShape(material.inverse);
  const plan = await verifyShopifyRemediationPlan(material.plan);
  const operations = operationsFor(plan);
  if (
    plan.payload.planId !== LARA_TRUST_PAGES_REPAIR_PLAN_ID ||
    plan.payload.createdAt !== LARA_TRUST_PAGES_REPAIR_PLAN_CREATED_AT ||
    plan.payload.executionMode !== "dry-run" ||
    plan.payload.shop.domain !== LARA_AUDIT_CONNECTION.shopDomain ||
    plan.payload.shop.shopId !== LARA_AUDIT_CONNECTION.shopId ||
    operations.length !== LARA_TRUST_PAGE_TARGETS.length
  ) {
    throw new LaraTrustPagesRepairError("invalid_plan", "The trust-page plan is not fixed.");
  }
  for (const [index, operation] of operations.entries()) {
    const target = LARA_TRUST_PAGE_TARGETS[index];
    if (
      !target ||
      operation.kind !== "page.replace_body" ||
      operation.operationId !== `lara-${target.key}-trust-copy` ||
      operation.target.resourceId !== target.resourceId ||
      operation.target.handle !== target.handle ||
      operation.change.bodyHtml !== APPROVED_BODY_BY_ID[target.resourceId]
    ) {
      throw new LaraTrustPagesRepairError(
        "invalid_plan",
        "The trust-page plan contains an unapproved operation.",
      );
    }
  }

  if (
    material.inverse.digestSha256 !==
      (await remediationSha256(material.inverse.payload)) ||
    material.inverse.payload.sourcePlanDigestSha256 !== plan.digestSha256 ||
    material.inverse.payload.sourcePlanId !== plan.payload.planId ||
    material.inverse.payload.runId !== LARA_TRUST_PAGES_REPAIR_RUN_ID ||
    material.inverse.payload.createdAt !== LARA_TRUST_PAGES_REPAIR_PLAN_CREATED_AT ||
    material.inverse.payload.shop.domain !== LARA_AUDIT_CONNECTION.shopDomain ||
    material.inverse.payload.shop.shopId !== LARA_AUDIT_CONNECTION.shopId ||
    material.inverse.payload.operations.length !== operations.length ||
    material.beforeSnapshots.length !== operations.length
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The trust-page inverse material is invalid.",
    );
  }

  const snapshots = material.beforeSnapshots.map((snapshot) => {
    const parsed = parseShopifyRemediationBeforeSnapshot(snapshot);
    if (parsed.kind !== "page") {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "The trust-page checkpoint contains a non-page snapshot.",
      );
    }
    return parsed as PageBeforeSnapshot;
  });

  for (const [index, operation] of operations.entries()) {
    const snapshot = snapshots[index];
    const inverse = material.inverse.payload.operations[index];
    if (
      !snapshot ||
      !inverse ||
      inverse.kind !== "page.restore_body" ||
      snapshot.target.resourceId !== operation.target.resourceId ||
      snapshot.target.handle !== operation.target.handle ||
      snapshot.state.title !== LARA_TRUST_PAGE_TARGETS[index]?.title ||
      inverse.originalOperationId !== operation.operationId ||
      inverse.target.resourceId !== operation.target.resourceId ||
      inverse.target.handle !== operation.target.handle ||
      inverse.restore.bodyHtml !== snapshot.state.bodyHtml ||
      canonicalRemediationJson(await buildShopifyRemediationCas(snapshot)) !==
        canonicalRemediationJson(operation.cas) ||
      canonicalRemediationJson(inverse.cas.protectedFields) !==
        canonicalRemediationJson(operation.cas.protectedFields)
    ) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "The trust-page before/inverse material no longer matches its plan.",
      );
    }
    const projected: PageBeforeSnapshot = {
      ...snapshot,
      state: { ...snapshot.state, bodyHtml: operation.change.bodyHtml },
    };
    if (
      inverse.cas.expectedAfterStateSha256 !==
      (await remediationSnapshotStateSha256(projected))
    ) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "The trust-page projected inverse digest is invalid.",
      );
    }
  }

  return freezeRemediationValue({ plan, inverse: material.inverse, beforeSnapshots: snapshots });
}

async function materialFromPrepared(prepared: PreparedLaraTrustPageBatch) {
  if (
    prepared.dryRun.status !== "dry_run_complete" ||
    !prepared.dryRun.inverseManifest ||
    prepared.dryRun.beforeSnapshots.some((snapshot) => snapshot.kind !== "page")
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_plan",
      "The fixed trust-page dry run did not produce rollback material.",
    );
  }
  return assertFixedMaterial({
    plan: prepared.plan,
    inverse: prepared.dryRun.inverseManifest,
    beforeSnapshots: prepared.dryRun.beforeSnapshots as readonly PageBeforeSnapshot[],
  });
}

async function prepareFixedMaterial(runtime: LaraTrustPagesRuntime) {
  const prepared = await prepareLaraTrustPageBatch({
    reader: runtime,
    runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
    occurredAt: LARA_TRUST_PAGES_REPAIR_PLAN_CREATED_AT,
  });
  return { prepared, material: await materialFromPrepared(prepared) };
}

export async function buildLaraTrustPagesDryRun({
  runtime: suppliedRuntime,
}: {
  runtime?: LaraTrustPagesRuntime;
} = {}): Promise<LaraTrustPagesDryRunResult> {
  const runtime = suppliedRuntime ?? (await createLaraTrustPagesRuntime());
  const { prepared, material } = await prepareFixedMaterial(runtime);
  return freezeRemediationValue({
    runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
    mode: "dry-run" as const,
    writesAttempted: 0 as const,
    planId: LARA_TRUST_PAGES_REPAIR_PLAN_ID,
    planDigestSha256: material.plan.digestSha256,
    inverseDigestSha256: material.inverse.digestSha256,
    operations: operationsFor(material.plan).map((operation, index) => ({
      operationId: operation.operationId,
      resourceId: operation.target.resourceId,
      handle: operation.target.handle,
      beforeStateSha256: operation.cas.beforeStateSha256,
      projectedAfterStateSha256:
        prepared.dryRun.operationResults[index]?.projectedAfterStateSha256 ?? "",
    })),
  });
}

function initialCheckpoint(material: FixedMaterial): TrustPagesCheckpoint {
  const checkpoint: TrustPagesCheckpoint = {
    schemaVersion: LARA_TRUST_PAGES_REPAIR_SCHEMA_VERSION,
    phase: "prepared",
    planDigestSha256: material.plan.digestSha256,
    material,
    nextOperationIndex: 0,
    applied: [],
    restoredOperationIds: [],
    failureCode: null,
    journal: [],
  };
  assertCheckpointBounded(checkpoint);
  return checkpoint;
}

async function assertCheckpointSemantics(
  checkpoint: TrustPagesCheckpoint,
): Promise<void> {
  const operations = operationsFor(checkpoint.material.plan);
  const operationById = new Map(
    operations.map((operation) => [operation.operationId, operation] as const),
  );
  const prepared = new Set<string>();
  const ambiguous = new Set<string>();
  const appliedEvents = new Set<string>();
  const rollbackPrepared = new Set<string>();
  const restoredEvents = new Set<string>();
  let preflightVerified = false;
  let materialPersisted = false;
  let rollbackStarted = false;
  let adminVerified = false;
  let failureAtJournalEnd = false;

  for (const entry of checkpoint.journal) {
    const operation = entry.operationId
      ? operationById.get(entry.operationId) ?? null
      : null;
    const operationEvent =
      entry.event.startsWith("operation.") ||
      (entry.event.startsWith("rollback.") && entry.event !== "rollback.started");
    if (
      operationEvent !== Boolean(operation) ||
      (operation && entry.resourceId !== operation.target.resourceId) ||
      (!operation && entry.resourceId !== null)
    ) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "A trust-page journal event is not bound to its exact operation.",
      );
    }
    if (failureAtJournalEnd && entry.event !== "run.claimed") {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "Only a new claimed attempt may follow a trust-page failure event.",
      );
    }

    switch (entry.event) {
      case "run.claimed":
        if (adminVerified) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "A trust-page run event follows a terminal journal event.",
          );
        }
        failureAtJournalEnd = false;
        break;
      case "run.material_persisted":
        if (adminVerified || materialPersisted || preflightVerified || rollbackStarted) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "The trust-page material journal is duplicated or out of order.",
          );
        }
        materialPersisted = true;
        break;
      case "run.preflight_verified":
        if (!materialPersisted || preflightVerified || prepared.size > 0 || rollbackStarted) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "The trust-page preflight journal is out of order.",
          );
        }
        preflightVerified = true;
        break;
      case "operation.prepared": {
        const operationId = operation!.operationId;
        const operationIndex = operations.findIndex(
          (candidate) => candidate.operationId === operationId,
        );
        if (
          !preflightVerified ||
          rollbackStarted ||
          prepared.has(operationId) ||
          operations
            .slice(0, operationIndex)
            .some((candidate) => !appliedEvents.has(candidate.operationId))
        ) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "A trust-page prepared event is not a contiguous forward operation.",
          );
        }
        prepared.add(operationId);
        break;
      }
      case "operation.reconcile_started": {
        const operationId = operation!.operationId;
        if (
          !prepared.has(operationId) ||
          appliedEvents.has(operationId)
        ) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "Trust-page mutation reconciliation lacks one prepared ambiguous operation.",
          );
        }
        ambiguous.add(operationId);
        break;
      }
      case "operation.applied": {
        const operationId = operation!.operationId;
        if (
          !prepared.has(operationId) ||
          ambiguous.has(operationId) ||
          appliedEvents.has(operationId) ||
          rollbackStarted
        ) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "A confirmed trust-page write has invalid journal provenance.",
          );
        }
        appliedEvents.add(operationId);
        break;
      }
      case "operation.reconciled": {
        const operationId = operation!.operationId;
        if (!ambiguous.has(operationId) || appliedEvents.has(operationId)) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "A reconciled trust-page write lacks typed ambiguous provenance.",
          );
        }
        appliedEvents.add(operationId);
        break;
      }
      case "rollback.started":
        if (!preflightVerified || adminVerified) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "The trust-page rollback journal is out of order.",
          );
        }
        rollbackStarted = true;
        break;
      case "rollback.prepared": {
        const operationId = operation!.operationId;
        if (
          !rollbackStarted ||
          !appliedEvents.has(operationId) ||
          restoredEvents.has(operationId)
        ) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "A trust-page rollback preparation is invalid.",
          );
        }
        rollbackPrepared.add(operationId);
        break;
      }
      case "rollback.reconcile_started": {
        const operationId = operation!.operationId;
        if (!rollbackPrepared.has(operationId) || restoredEvents.has(operationId)) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "Trust-page rollback reconciliation lacks a prepared restore.",
          );
        }
        break;
      }
      case "rollback.restored": {
        const operationId = operation!.operationId;
        if (!rollbackPrepared.has(operationId) || restoredEvents.has(operationId)) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "A trust-page restored event lacks its prepared rollback.",
          );
        }
        restoredEvents.add(operationId);
        break;
      }
      case "rollback.reconciled": {
        const operationId = operation!.operationId;
        if (!rollbackStarted || !appliedEvents.has(operationId) || restoredEvents.has(operationId)) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "A trust-page rollback reconciliation is invalid.",
          );
        }
        restoredEvents.add(operationId);
        break;
      }
      case "run.admin_verified":
        if (
          rollbackStarted ||
          adminVerified ||
          operations.some((operation) => !appliedEvents.has(operation.operationId))
        ) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "The trust-page Admin verification journal is incomplete.",
          );
        }
        adminVerified = true;
        break;
      case "run.failed":
        if (
          !rollbackStarted ||
          adminVerified
        ) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "The trust-page failure journal is not terminal.",
          );
        }
        failureAtJournalEnd = true;
        break;
    }
  }

  const appliedIds = new Set(checkpoint.applied.map((entry) => entry.operationId));
  if (
    appliedIds.size !== appliedEvents.size ||
    [...appliedIds].some((operationId) => !appliedEvents.has(operationId))
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable applied-page records do not match their journal.",
    );
  }
  for (const applied of checkpoint.applied) {
    const operation = operationById.get(applied.operationId);
    if (!operation || !(await intendedStateMatches(applied.after, operation))) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "A durable applied-page state does not match its approved copy.",
      );
    }
  }
  if (
    checkpoint.restoredOperationIds.length !== restoredEvents.size ||
    checkpoint.restoredOperationIds.some(
      (operationId) =>
        !restoredEvents.has(operationId) || !appliedIds.has(operationId),
    )
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable restored-page records do not match their journal.",
    );
  }

  const firstIncomplete = operations.findIndex(
    (operation) => !appliedIds.has(operation.operationId),
  );
  const derivedNextOperationIndex =
    firstIncomplete < 0 ? operations.length : firstIncomplete;
  if (
    checkpoint.nextOperationIndex !== derivedNextOperationIndex ||
    operations
      .slice(derivedNextOperationIndex + 1)
      .some((operation) => appliedIds.has(operation.operationId))
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page cursor is not a contiguous applied prefix.",
    );
  }

  const failurePhase = checkpoint.phase === "rolling_back" || checkpoint.phase === "failed";
  if (
    (failurePhase !== (checkpoint.failureCode !== null)) ||
    (!failurePhase && checkpoint.restoredOperationIds.length > 0) ||
    (checkpoint.phase === "prepared" &&
      (preflightVerified || appliedIds.size > 0 || rollbackStarted || adminVerified)) ||
    (checkpoint.phase === "applying" &&
      (!preflightVerified || rollbackStarted || adminVerified || failureAtJournalEnd)) ||
    (checkpoint.phase === "rolling_back" &&
      (!rollbackStarted || failureAtJournalEnd || adminVerified)) ||
    (checkpoint.phase === "failed" &&
      (!rollbackStarted || !failureAtJournalEnd || adminVerified)) ||
    (checkpoint.phase === "verified" &&
      (!adminVerified ||
        rollbackStarted ||
        failureAtJournalEnd ||
        appliedIds.size !== operations.length ||
        checkpoint.journal.at(-1)?.event !== "run.admin_verified"))
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page phase contradicts its journal.",
    );
  }
}

async function parseCheckpoint(value: unknown): Promise<TrustPagesCheckpoint | null> {
  const record = objectRecord(value);
  if (!record || Object.keys(record).length === 0) return null;
  const allowedPhases = new Set(["prepared", "applying", "rolling_back", "verified", "failed"]);
  if (
    record.schemaVersion !== LARA_TRUST_PAGES_REPAIR_SCHEMA_VERSION ||
    typeof record.phase !== "string" ||
    !allowedPhases.has(record.phase) ||
    typeof record.planDigestSha256 !== "string" ||
    !SHA256.test(record.planDigestSha256) ||
    !Number.isInteger(record.nextOperationIndex) ||
    Number(record.nextOperationIndex) < 0 ||
    Number(record.nextOperationIndex) > LARA_TRUST_PAGE_TARGETS.length ||
    !Array.isArray(record.applied) ||
    !Array.isArray(record.restoredOperationIds) ||
    (record.failureCode !== null && typeof record.failureCode !== "string") ||
    !Array.isArray(record.journal) ||
    !exactKeys(record, [
      "schemaVersion",
      "phase",
      "planDigestSha256",
      "material",
      "nextOperationIndex",
      "applied",
      "restoredOperationIds",
      "failureCode",
      "journal",
    ])
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page checkpoint is malformed.",
    );
  }
  const materialRecord = objectRecord(record.material);
  if (
    !materialRecord ||
    !exactKeys(materialRecord, ["plan", "inverse", "beforeSnapshots"])
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page repair material is missing.",
    );
  }
  const material = await assertFixedMaterial({
    plan: materialRecord.plan as SealedShopifyRemediationPlan,
    inverse: materialRecord.inverse as SealedShopifyRemediationInverseManifest,
    beforeSnapshots: materialRecord.beforeSnapshots as PageBeforeSnapshot[],
  });
  if (material.plan.digestSha256 !== record.planDigestSha256) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page plan digest changed.",
    );
  }

  const operations = operationsFor(material.plan);
  const applied: AppliedPage[] = [];
  for (const input of record.applied) {
    const item = objectRecord(input);
    if (!item || typeof item.operationId !== "string") {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "A durable applied-page record is invalid.",
      );
    }
    const operation = operations.find((candidate) => candidate.operationId === item.operationId);
    const after = pageStateFromUnknown(item.after);
    if (!operation || after.id !== operation.target.resourceId) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "A durable applied-page record targets the wrong page.",
      );
    }
    if (applied.some((candidate) => candidate.operationId === item.operationId)) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "A durable applied-page record is duplicated.",
      );
    }
    applied.push({ operationId: item.operationId, after });
  }
  const restoredOperationIds = record.restoredOperationIds.filter(
    (value): value is string => typeof value === "string",
  );
  if (
    restoredOperationIds.length !== record.restoredOperationIds.length ||
    new Set(restoredOperationIds).size !== restoredOperationIds.length ||
    restoredOperationIds.some(
      (operationId) => !operations.some((operation) => operation.operationId === operationId),
    )
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable restored-page record is invalid.",
    );
  }
  const journal = record.journal as TrustPagesJournalEntry[];
  const allowedEvents = new Set<TrustPagesJournalEntry["event"]>([
    "run.claimed",
    "run.material_persisted",
    "run.preflight_verified",
    "operation.prepared",
    "operation.reconcile_started",
    "operation.applied",
    "operation.reconciled",
    "rollback.started",
    "rollback.prepared",
    "rollback.reconcile_started",
    "rollback.restored",
    "rollback.reconciled",
    "run.admin_verified",
    "run.failed",
  ]);
  if (
    journal.length > MAX_JOURNAL_ENTRIES ||
    journal.some(
      (entry, index) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !exactKeys(entry as unknown as Record<string, unknown>, [
          "sequence",
          "occurredAt",
          "event",
          "operationId",
          "resourceId",
          "details",
        ]) ||
        entry.sequence !== index + 1 ||
        typeof entry.occurredAt !== "string" ||
        !Number.isFinite(Date.parse(entry.occurredAt)) ||
        !allowedEvents.has(entry.event) ||
        (entry.operationId !== null && typeof entry.operationId !== "string") ||
        (entry.resourceId !== null && typeof entry.resourceId !== "string") ||
        !objectRecord(entry.details) ||
        Object.keys(entry.details).some((key) => key.length > 100) ||
        Object.values(entry.details).some(
          (detail) =>
            (typeof detail === "string" && detail.length > 1_000) ||
            (typeof detail === "number" && !Number.isFinite(detail)) ||
            (detail !== null &&
              typeof detail !== "string" &&
              typeof detail !== "number" &&
              typeof detail !== "boolean"),
        ),
    )
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The durable trust-page journal is invalid.",
    );
  }
  const checkpoint: TrustPagesCheckpoint = {
    schemaVersion: LARA_TRUST_PAGES_REPAIR_SCHEMA_VERSION,
    phase: record.phase as TrustPagesCheckpoint["phase"],
    planDigestSha256: record.planDigestSha256,
    material,
    nextOperationIndex: Number(record.nextOperationIndex),
    applied,
    restoredOperationIds,
    failureCode: record.failureCode as string | null,
    journal: structuredClone(journal),
  };
  assertCheckpointBounded(checkpoint);
  await assertCheckpointSemantics(checkpoint);
  return checkpoint;
}

function resultFromExisting(existing: AuditShopifyRun | null): LaraTrustPagesRepairResult {
  if (existing?.state === "completed") {
    const artifact = objectRecord(existing.artifact);
    return freezeRemediationValue({
      runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
      state: "completed" as const,
      status: "verified" as const,
      planDigestSha256:
        typeof artifact?.planDigestSha256 === "string"
          ? artifact.planDigestSha256
          : existing.manifest_hash,
      verifiedCount:
        typeof artifact?.verifiedCount === "number" ? artifact.verifiedCount : undefined,
    });
  }
  if (existing?.state === "failed") {
    return freezeRemediationValue({
      runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
      state: "failed" as const,
      status:
        existing.error_code === "trust_pages_rolled_back"
          ? ("rolled_back" as const)
          : ("rollback_incomplete" as const),
      planDigestSha256: existing.manifest_hash,
      errorCode: existing.error_code ?? "repair_failed",
    });
  }
  return freezeRemediationValue({
    runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
    state: "in_progress" as const,
    planDigestSha256: existing?.manifest_hash,
  });
}

function sanitisedErrorCode(error: unknown) {
  if (
    error instanceof LaraTrustPagesRepairError ||
    error instanceof LaraTrustPagesRuntimeError
  ) {
    return error.code;
  }
  return "repair_failed";
}

async function trustPagesSchemaSha256(): Promise<string> {
  return remediationSha256({
    schemaVersion: LARA_TRUST_PAGES_REPAIR_SCHEMA_VERSION,
    graphqlManifest: LARA_TRUST_PAGES_GRAPHQL_MANIFEST,
    targets: LARA_TRUST_PAGE_TARGETS,
    approvedBodiesSha256: await Promise.all(
      LARA_TRUST_PAGE_TARGETS.map(async (target) => ({
        resourceId: target.resourceId,
        bodySha256: await remediationSha256(APPROVED_BODY_BY_ID[target.resourceId]),
      })),
    ),
  });
}

function immutableRunEvidenceMatches(
  run: AuditShopifyRun,
  input: {
    requestedBy: string;
    schemaHash: string;
    planDigestSha256: string;
  },
): boolean {
  return (
    run.id === LARA_TRUST_PAGES_REPAIR_RUN_ID &&
    run.connection_id === LARA_AUDIT_CONNECTION.connectionId &&
    run.requested_by === input.requestedBy &&
    run.requested_actor_type === "system" &&
    run.shopify_domain === LARA_AUDIT_CONNECTION.shopDomain &&
    run.requested_source === TRUST_PAGES_SOURCE &&
    run.requested_note === TRUST_PAGES_NOTE &&
    run.schema_hash === input.schemaHash &&
    run.manifest_hash === input.planDigestSha256 &&
    run.max_retries === MAX_RETRIES
  );
}

function assertImmutableRunEvidence(
  run: AuditShopifyRun,
  input: {
    requestedBy: string;
    schemaHash: string;
    planDigestSha256: string;
  },
): void {
  if (!immutableRunEvidenceMatches(run, input)) {
    throw new LaraTrustPagesRepairError(
      "run_evidence_mismatch",
      "The durable trust-page run does not match its immutable evidence.",
    );
  }
}

async function verifyTerminalArtifact(
  run: AuditShopifyRun,
  checkpoint: TrustPagesCheckpoint,
): Promise<void> {
  const artifact = objectRecord(run.artifact);
  const operations = operationsFor(checkpoint.material.plan);
  const expectedTargets = await Promise.all(
    operations.map(async (operation) => ({
      operationId: operation.operationId,
      resourceId: operation.target.resourceId,
      handle: operation.target.handle,
      intendedBodySha256: await remediationSha256(operation.change.bodyHtml),
    })),
  );
  if (
    !artifact ||
    !exactKeys(artifact, [
      "schemaVersion",
      "status",
      "runId",
      "planId",
      "planDigestSha256",
      "inverseDigestSha256",
      "verifiedCount",
      "mutationFields",
      "targets",
      "beforeSnapshots",
      "inverse",
      "journal",
      "completedAt",
    ]) ||
    artifact.schemaVersion !== LARA_TRUST_PAGES_REPAIR_SCHEMA_VERSION ||
    artifact.status !== "verified" ||
    artifact.runId !== LARA_TRUST_PAGES_REPAIR_RUN_ID ||
    artifact.planId !== LARA_TRUST_PAGES_REPAIR_PLAN_ID ||
    artifact.planDigestSha256 !== checkpoint.planDigestSha256 ||
    artifact.inverseDigestSha256 !== checkpoint.material.inverse.digestSha256 ||
    artifact.verifiedCount !== operations.length ||
    typeof artifact.completedAt !== "string" ||
    !Number.isFinite(Date.parse(artifact.completedAt)) ||
    canonicalRemediationJson(artifact.beforeSnapshots) !==
      canonicalRemediationJson(checkpoint.material.beforeSnapshots) ||
    canonicalRemediationJson(artifact.inverse) !==
      canonicalRemediationJson(checkpoint.material.inverse) ||
    canonicalRemediationJson(artifact.journal) !==
      canonicalRemediationJson(checkpoint.journal) ||
    canonicalRemediationJson(artifact.targets) !==
      canonicalRemediationJson(expectedTargets) ||
    canonicalRemediationJson(artifact.mutationFields) !==
      canonicalRemediationJson(["id", "body"])
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The completed trust-page artifact is invalid.",
    );
  }
}

async function verifyTerminalLiveState(
  runtime: LaraTrustPagesRuntime,
  checkpoint: TrustPagesCheckpoint,
): Promise<void> {
  if (
    checkpoint.phase !== "verified" ||
    checkpoint.nextOperationIndex !== LARA_TRUST_PAGE_TARGETS.length ||
    checkpoint.applied.length !== LARA_TRUST_PAGE_TARGETS.length ||
    checkpoint.restoredOperationIds.length !== 0 ||
    checkpoint.failureCode !== null ||
    checkpoint.journal.at(-1)?.event !== "run.admin_verified"
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The completed trust-page checkpoint is not verified.",
    );
  }
  for (const operation of operationsFor(checkpoint.material.plan)) {
    const [page] = await runtime.readPages({
      shop: LARA_ROVINJ_REMEDIATION_SHOP,
      resourceIds: [operation.target.resourceId],
    });
    if (!page || !(await intendedStateMatches(page, operation))) {
      throw new LaraTrustPagesRepairError(
        "page_not_verified",
        `The completed trust page drifted for ${operation.target.handle}.`,
      );
    }
  }
}

async function verifyFailedTerminalLiveState(
  runtime: LaraTrustPagesRuntime,
  run: AuditShopifyRun,
  checkpoint: TrustPagesCheckpoint,
): Promise<void> {
  if (
    checkpoint.phase !== "failed" ||
    checkpoint.failureCode === null ||
    checkpoint.journal.at(-1)?.event !== "run.failed"
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The failed trust-page checkpoint is not terminal.",
    );
  }
  const failureEntry = checkpoint.journal.at(-1)!;
  if (typeof failureEntry.details.rollbackComplete !== "boolean") {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The failed trust-page checkpoint omits rollback completeness.",
    );
  }
  let allRecordedRestoresVerified = true;
  for (const applied of checkpoint.applied) {
    const operation = operationsFor(checkpoint.material.plan).find(
      (candidate) => candidate.operationId === applied.operationId,
    );
    if (!operation) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "The failed trust-page checkpoint names an unknown operation.",
      );
    }
    const [page] = await runtime.readPages({
      shop: LARA_ROVINJ_REMEDIATION_SHOP,
      resourceIds: [operation.target.resourceId],
    });
    if (!page) {
      allRecordedRestoresVerified = false;
      continue;
    }
    const recordedRestored = checkpoint.restoredOperationIds.includes(
      operation.operationId,
    );
    const actuallyRestored = await restoredStateMatches(
      page,
      operation,
      checkpoint.material,
    );
    if (recordedRestored && !actuallyRestored) {
      throw new LaraTrustPagesRepairError(
        "page_not_verified",
        `A recorded trust-page rollback drifted for ${operation.target.handle}.`,
      );
    }
    if (!recordedRestored || !actuallyRestored) allRecordedRestoresVerified = false;
  }
  const rollbackComplete = failureEntry.details.rollbackComplete;
  if (
    (rollbackComplete && !allRecordedRestoresVerified) ||
    (rollbackComplete && run.error_code !== "trust_pages_rolled_back") ||
    (!rollbackComplete && run.error_code !== "trust_pages_rollback_incomplete")
  ) {
    throw new LaraTrustPagesRepairError(
      "invalid_checkpoint",
      "The failed trust-page run code contradicts its verified rollback state.",
    );
  }
}

async function verifiedResultFromExisting(
  existing: AuditShopifyRun | null,
  evidence: {
    requestedBy: string;
    schemaHash: string;
    planDigestSha256: string;
  },
  runtime: LaraTrustPagesRuntime,
): Promise<LaraTrustPagesRepairResult> {
  if (!existing) return resultFromExisting(null);
  assertImmutableRunEvidence(existing, evidence);
  if (existing.state === "completed") {
    const checkpoint = await parseCheckpoint(existing.checkpoint);
    if (!checkpoint) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "The completed trust-page run has no durable checkpoint.",
      );
    }
    await verifyTerminalArtifact(existing, checkpoint);
    await verifyTerminalLiveState(runtime, checkpoint);
  } else if (existing.state === "failed") {
    const checkpoint = await parseCheckpoint(existing.checkpoint);
    if (!checkpoint) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "The failed trust-page run has no durable checkpoint.",
      );
    }
    await verifyFailedTerminalLiveState(runtime, existing, checkpoint);
  } else {
    const checkpoint = await parseCheckpoint(existing.checkpoint);
    if (
      checkpoint &&
      checkpoint.planDigestSha256 !== evidence.planDigestSha256
    ) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "The active trust-page checkpoint changed its plan digest.",
      );
    }
  }
  return resultFromExisting(existing);
}

async function executeClaimedRun({
  run: initialRun,
  leaseToken,
  runtime,
  checkpoint: initialCheckpointValue,
  now,
}: {
  run: AuditShopifyRun;
  leaseToken: string;
  runtime: LaraTrustPagesRuntime;
  checkpoint: TrustPagesCheckpoint;
  now: () => Date;
}): Promise<LaraTrustPagesRepairResult> {
  let run = initialRun;
  const checkpoint = initialCheckpointValue;
  const operations = operationsFor(checkpoint.material.plan);
  const append = (
    event: TrustPagesJournalEntry["event"],
    operation: PageReplaceOperation | null,
    details: TrustPagesJournalEntry["details"] = {},
  ) => {
    checkpoint.journal.push({
      sequence: checkpoint.journal.length + 1,
      occurredAt: now().toISOString(),
      event,
      operationId: operation?.operationId ?? null,
      resourceId: operation?.target.resourceId ?? null,
      details,
    });
  };
  const persist = async () => {
    assertCheckpointBounded(checkpoint);
    run = await renewAuditShopifyRun({
      run,
      leaseToken,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      leaseSeconds: LEASE_SECONDS,
    });
  };
  const readOne = async (operation: PageReplaceOperation) => {
    const [page] = await runtime.readPages({
      shop: LARA_ROVINJ_REMEDIATION_SHOP,
      resourceIds: [operation.target.resourceId],
    });
    if (!page) {
      throw new LaraTrustPagesRepairError("page_drift", "A trust page is missing.");
    }
    return page;
  };
  const recordApplied = (operation: PageReplaceOperation, after: LaraTrustPageState) => {
    const existing = checkpoint.applied.find(
      (candidate) => candidate.operationId === operation.operationId,
    );
    if (existing) existing.after = structuredClone(after);
    else checkpoint.applied.push({ operationId: operation.operationId, after: structuredClone(after) });
    checkpoint.nextOperationIndex = Math.max(
      checkpoint.nextOperationIndex,
      operations.findIndex((candidate) => candidate.operationId === operation.operationId) + 1,
    );
  };
  const wasPrepared = (operation: PageReplaceOperation) =>
    checkpoint.journal.some(
      (entry) =>
        entry.event === "operation.prepared" &&
        entry.operationId === operation.operationId,
    );
  const wasAmbiguous = (operation: PageReplaceOperation) =>
    checkpoint.journal.some(
      (entry) =>
        entry.event === "operation.reconcile_started" &&
        entry.operationId === operation.operationId,
    );
  const wasRollbackPrepared = (operation: PageReplaceOperation) =>
    checkpoint.journal.some(
      (entry) =>
        entry.event === "rollback.prepared" &&
        entry.operationId === operation.operationId,
    );
  const wasRollbackAmbiguous = (operation: PageReplaceOperation) =>
    checkpoint.journal.some(
      (entry) =>
        entry.event === "rollback.reconcile_started" &&
        entry.operationId === operation.operationId,
    );

  const rollback = async (failureCode: string) => {
    checkpoint.failureCode = failureCode;
    checkpoint.phase = "rolling_back";
    append("rollback.started", null, { failureCode });
    await persist();

    let unresolved = false;
    // Recover only a mutation whose typed ambiguous outcome was durably
    // checkpointed. A merely prepared operation can also match the desired
    // copy because of an unrelated merchant edit and must never be attributed
    // to this run or automatically restored.
    for (const operation of operations) {
      if (
        checkpoint.applied.some(
          (candidate) => candidate.operationId === operation.operationId,
        ) ||
        !wasPrepared(operation)
      ) {
        continue;
      }
      try {
        const current = await readOne(operation);
        if (await intendedStateMatches(current, operation) && wasAmbiguous(operation)) {
          recordApplied(operation, current);
          append("operation.reconciled", operation, { recovery: "rollback" });
          await persist();
        } else if (!(await originalStateMatches(current, operation))) {
          unresolved = true;
        }
      } catch {
        unresolved = true;
      }
    }

    for (const operation of [...operations].reverse()) {
      if (
        !checkpoint.applied.some(
          (candidate) => candidate.operationId === operation.operationId,
        ) ||
        checkpoint.restoredOperationIds.includes(operation.operationId)
      ) {
        continue;
      }
      const inverse = inverseFor(checkpoint.material, operation.operationId);
      try {
        let current = await readOne(operation);
        if (await restoredStateMatches(current, operation, checkpoint.material)) {
          if (wasRollbackAmbiguous(operation)) {
            checkpoint.restoredOperationIds.push(operation.operationId);
            append("rollback.reconciled", operation, { alreadyRestored: true });
            await persist();
          } else {
            unresolved = true;
          }
          continue;
        }
        if (!(await intendedStateMatches(current, operation))) {
          unresolved = true;
          continue;
        }

        if (!wasRollbackPrepared(operation)) {
          append("rollback.prepared", operation, {
            restoreBodySha256: await remediationSha256(inverse.restore.bodyHtml),
          });
          await persist();
        }
        let mutationAmbiguous = false;
        try {
          const result = await runtime.replaceBodyIfUnchanged({
            shop: LARA_ROVINJ_REMEDIATION_SHOP,
            target: operation.target,
            expected: await expectedFor(current),
            bodyHtml: inverse.restore.bodyHtml,
          });
          if (result.status === "cas_mismatch") {
            throw new LaraTrustPagesRepairError(
              "page_drift",
              `The rollback CAS drifted for ${operation.target.handle}.`,
            );
          }
          if (result.status === "failed") {
            throw new LaraTrustPagesRepairError(
              "repair_failed",
              `Shopify rejected the rollback for ${operation.target.handle}.`,
            );
          }
        } catch (error) {
          if (
            !(error instanceof LaraTrustPagesRuntimeError) ||
            error.code !== "mutation_ambiguous"
          ) {
            throw error;
          }
          mutationAmbiguous = true;
          append("rollback.reconcile_started", operation, {
            mutationOutcome: "ambiguous",
          });
          await persist();
        }
        current = await readOne(operation);
        if (!(await restoredStateMatches(current, operation, checkpoint.material))) {
          unresolved = true;
          continue;
        }
        checkpoint.restoredOperationIds.push(operation.operationId);
        append(mutationAmbiguous ? "rollback.reconciled" : "rollback.restored", operation, {
          bodySha256: await remediationSha256(current.bodyHtml),
        });
        await persist();
      } catch (error) {
        if (error instanceof AuditShopifyRunError) throw error;
        unresolved = true;
      }
    }

    // A retry can arrive after an earlier invocation durably recorded a
    // restore. Re-read every page attributed to this run before declaring the
    // compensation complete; the journal alone is never final evidence.
    for (const applied of checkpoint.applied) {
      const operation = operations.find(
        (candidate) => candidate.operationId === applied.operationId,
      );
      if (!operation) {
        unresolved = true;
        continue;
      }
      try {
        const current = await readOne(operation);
        if (!(await restoredStateMatches(current, operation, checkpoint.material))) {
          unresolved = true;
        }
      } catch {
        unresolved = true;
      }
    }

    const allRestored = checkpoint.applied.every((applied) =>
      checkpoint.restoredOperationIds.includes(applied.operationId),
    );
    checkpoint.phase = "failed";
    append("run.failed", null, {
      failureCode,
      rollbackComplete: allRestored && !unresolved,
    });
    let failed: AuditShopifyRun;
    try {
      failed = await failAuditShopifyRun({
        run,
        leaseToken,
        errorCode:
          allRestored && !unresolved
            ? "trust_pages_rolled_back"
            : "trust_pages_rollback_incomplete",
        retryable: !allRestored || unresolved,
        checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      });
    } catch {
      const existing = await getAuditShopifyRun({
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      });
      return verifiedResultFromExisting(
        existing,
        {
          requestedBy: run.requested_by,
          schemaHash: run.schema_hash,
          planDigestSha256: checkpoint.planDigestSha256,
        },
        runtime,
      );
    }
    if (failed.state === "queued" || failed.state === "running") {
      assertImmutableRunEvidence(failed, {
        requestedBy: run.requested_by,
        schemaHash: run.schema_hash,
        planDigestSha256: checkpoint.planDigestSha256,
      });
      return freezeRemediationValue({
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        state: "in_progress" as const,
        status: "rollback_incomplete" as const,
        planDigestSha256: checkpoint.planDigestSha256,
        errorCode: failureCode,
      });
    }
    assertImmutableRunEvidence(failed, {
      requestedBy: run.requested_by,
      schemaHash: run.schema_hash,
      planDigestSha256: checkpoint.planDigestSha256,
    });
    await verifyFailedTerminalLiveState(runtime, failed, checkpoint);
    return freezeRemediationValue({
      runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
      state: "failed" as const,
      status:
        allRestored && !unresolved
          ? ("rolled_back" as const)
          : ("rollback_incomplete" as const),
      planDigestSha256: checkpoint.planDigestSha256,
      errorCode: failureCode,
    });
  };

  append("run.claimed", null, { leaseGeneration: run.lease_generation });
  try {
    if (checkpoint.phase === "rolling_back" || checkpoint.failureCode !== null) {
      return await rollback(checkpoint.failureCode ?? "repair_failed");
    }

    if (checkpoint.journal.length === 1) {
      append("run.material_persisted", null, {
        inverseDigestSha256: checkpoint.material.inverse.digestSha256,
        beforeSnapshotCount: checkpoint.material.beforeSnapshots.length,
      });
      await persist();
    }

    // Fresh runs require a whole-plan CAS before the first write. Resumed runs
    // recover only a contiguous prefix that this run durably prepared/applied.
    if (
      checkpoint.applied.length === 0 &&
      checkpoint.nextOperationIndex === 0 &&
      !operations.some((operation) => wasPrepared(operation))
    ) {
      for (const operation of operations) {
        const current = await readOne(operation);
        if (!(await originalStateMatches(current, operation))) {
          throw new LaraTrustPagesRepairError(
            "page_drift",
            `The trust-page CAS drifted for ${operation.target.handle}.`,
          );
        }
      }
      append("run.preflight_verified", null, { pageCount: operations.length });
      checkpoint.phase = "applying";
      await persist();
    } else {
      for (const [index, operation] of operations.entries()) {
        const current = await readOne(operation);
        const recorded = checkpoint.applied.some(
          (candidate) => candidate.operationId === operation.operationId,
        );
        if (recorded) {
          if (!(await intendedStateMatches(current, operation))) {
            throw new LaraTrustPagesRepairError(
              "page_drift",
              `A previously applied trust page drifted for ${operation.target.handle}.`,
            );
          }
          continue;
        }
        if (await intendedStateMatches(current, operation)) {
          if (!wasPrepared(operation) || !wasAmbiguous(operation)) {
            throw new LaraTrustPagesRepairError(
              "page_drift",
              `An unattributed trust-page change exists for ${operation.target.handle}.`,
            );
          }
          checkpoint.phase = "applying";
          recordApplied(operation, current);
          append("operation.reconciled", operation, { recovery: "apply" });
          await persist();
          continue;
        }
        const previousOperationsComplete = operations
          .slice(0, index)
          .every((candidate) =>
            checkpoint.applied.some(
              (applied) => applied.operationId === candidate.operationId,
            ),
          );
        if (
          !(await originalStateMatches(current, operation)) ||
          (!previousOperationsComplete && index < checkpoint.nextOperationIndex)
        ) {
          throw new LaraTrustPagesRepairError(
            "page_drift",
            `The resumable trust-page state drifted for ${operation.target.handle}.`,
          );
        }
      }
    }

    for (const [index, operation] of operations.entries()) {
      if (
        checkpoint.applied.some(
          (candidate) => candidate.operationId === operation.operationId,
        )
      ) {
        continue;
      }
      let current = await readOne(operation);
      if (!(await originalStateMatches(current, operation))) {
        throw new LaraTrustPagesRepairError(
          "page_drift",
          `The trust-page state drifted before ${operation.target.handle}.`,
        );
      }
      if (!wasPrepared(operation)) {
        append("operation.prepared", operation, {
          beforeStateSha256: operation.cas.beforeStateSha256,
          intendedBodySha256: await remediationSha256(operation.change.bodyHtml),
        });
        checkpoint.phase = "applying";
        checkpoint.nextOperationIndex = index;
        await persist();
      }

      let mutationAmbiguous = false;
      try {
        const result = await runtime.replaceBodyIfUnchanged({
          shop: LARA_ROVINJ_REMEDIATION_SHOP,
          target: operation.target,
          expected: await expectedFor(current),
          bodyHtml: operation.change.bodyHtml,
        });
        if (result.status === "cas_mismatch") {
          throw new LaraTrustPagesRepairError(
            "page_drift",
            `The writer CAS drifted for ${operation.target.handle}.`,
          );
        }
        if (result.status === "failed") {
          throw new LaraTrustPagesRepairError(
            "repair_failed",
            `Shopify rejected the trust-page write for ${operation.target.handle}.`,
          );
        }
        if (
          !(await originalStateMatches(result.before, operation)) ||
          !(await intendedStateMatches(result.after, operation))
        ) {
          throw new LaraTrustPagesRepairError(
            "page_not_verified",
            `The mutation response was not verified for ${operation.target.handle}.`,
          );
        }
      } catch (error) {
        if (
          !(error instanceof LaraTrustPagesRuntimeError) ||
          error.code !== "mutation_ambiguous"
        ) {
          throw error;
        }
        mutationAmbiguous = true;
        append("operation.reconcile_started", operation, {
          mutationOutcome: "ambiguous",
        });
        await persist();
      }
      current = await readOne(operation);
      if (!(await intendedStateMatches(current, operation))) {
        throw new LaraTrustPagesRepairError(
          "page_not_verified",
          `The trust-page write was not verified for ${operation.target.handle}.`,
        );
      }
      recordApplied(operation, current);
      append(mutationAmbiguous ? "operation.reconciled" : "operation.applied", operation, {
        bodySha256: await remediationSha256(current.bodyHtml),
        protectedFieldsPreserved: true,
      });
      checkpoint.nextOperationIndex = index + 1;
      await persist();
    }

    let verifiedCount = 0;
    for (const operation of operations) {
      const current = await readOne(operation);
      if (!(await intendedStateMatches(current, operation))) {
        throw new LaraTrustPagesRepairError(
          "page_not_verified",
          `Final Admin verification failed for ${operation.target.handle}.`,
        );
      }
      verifiedCount += 1;
    }
    append("run.admin_verified", null, { verifiedCount });
    checkpoint.phase = "verified";
    checkpoint.nextOperationIndex = operations.length;
    const targetDigests = await Promise.all(
      operations.map(async (operation) => ({
        operationId: operation.operationId,
        resourceId: operation.target.resourceId,
        handle: operation.target.handle,
        intendedBodySha256: await remediationSha256(operation.change.bodyHtml),
      })),
    );
    const artifact = {
      schemaVersion: LARA_TRUST_PAGES_REPAIR_SCHEMA_VERSION,
      status: "verified",
      runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
      planId: LARA_TRUST_PAGES_REPAIR_PLAN_ID,
      planDigestSha256: checkpoint.planDigestSha256,
      inverseDigestSha256: checkpoint.material.inverse.digestSha256,
      verifiedCount,
      mutationFields: ["id", "body"],
      targets: targetDigests,
      beforeSnapshots: checkpoint.material.beforeSnapshots,
      inverse: checkpoint.material.inverse,
      journal: checkpoint.journal,
      completedAt: now().toISOString(),
    };
    try {
      const completed = await completeAuditShopifyRun({
        run,
        leaseToken,
        checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
        artifact,
      });
      assertImmutableRunEvidence(completed, {
        requestedBy: run.requested_by,
        schemaHash: run.schema_hash,
        planDigestSha256: checkpoint.planDigestSha256,
      });
      const completedCheckpoint = await parseCheckpoint(completed.checkpoint);
      if (!completedCheckpoint) {
        throw new LaraTrustPagesRepairError(
          "invalid_checkpoint",
          "The completed trust-page run lost its checkpoint.",
        );
      }
      await verifyTerminalArtifact(completed, completedCheckpoint);
    } catch {
      const existing = await getAuditShopifyRun({
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      });
      if (existing?.state === "completed") {
        assertImmutableRunEvidence(existing, {
          requestedBy: run.requested_by,
          schemaHash: run.schema_hash,
          planDigestSha256: checkpoint.planDigestSha256,
        });
        const completedCheckpoint = await parseCheckpoint(existing.checkpoint);
        if (!completedCheckpoint) {
          throw new LaraTrustPagesRepairError(
            "invalid_checkpoint",
            "The completed trust-page run lost its checkpoint.",
          );
        }
        await verifyTerminalArtifact(existing, completedCheckpoint);
        await verifyTerminalLiveState(runtime, completedCheckpoint);
        return verifiedResultFromExisting(
          existing,
          {
            requestedBy: run.requested_by,
            schemaHash: run.schema_hash,
            planDigestSha256: checkpoint.planDigestSha256,
          },
          runtime,
        );
      }
      throw new AuditShopifyRunError(
        "complete_failed",
        "The verified trust-page completion could not be fenced.",
      );
    }
    return freezeRemediationValue({
      runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
      state: "completed" as const,
      status: "verified" as const,
      planDigestSha256: checkpoint.planDigestSha256,
      verifiedCount,
    });
  } catch (error) {
    if (error instanceof AuditShopifyRunError) {
      return verifiedResultFromExisting(
        await getAuditShopifyRun({
          runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
          shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
        }),
        {
          requestedBy: run.requested_by,
          schemaHash: run.schema_hash,
          planDigestSha256: checkpoint.planDigestSha256,
        },
        runtime,
      );
    }
    try {
      return await rollback(sanitisedErrorCode(error));
    } catch (rollbackError) {
      if (rollbackError instanceof AuditShopifyRunError) {
        return verifiedResultFromExisting(
          await getAuditShopifyRun({
            runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
            shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
          }),
          {
            requestedBy: run.requested_by,
            schemaHash: run.schema_hash,
            planDigestSha256: checkpoint.planDigestSha256,
          },
          runtime,
        );
      }
      throw rollbackError;
    }
  }
}

/**
 * Apply only the server-generated plan identified by its digest. No page id,
 * HTML body, plan payload, shop or run id is accepted from the caller.
 */
export async function executeLaraTrustPagesRepair({
  approvedPlanDigestSha256,
  requestedBy,
  runId,
  leaseToken = crypto.randomUUID(),
  runtime: suppliedRuntime,
  now = () => new Date(),
}: {
  approvedPlanDigestSha256: string;
  requestedBy: string;
  runId: typeof LARA_TRUST_PAGES_REPAIR_RUN_ID;
  leaseToken?: string;
  runtime?: LaraTrustPagesRuntime;
  now?: () => Date;
}): Promise<LaraTrustPagesRepairResult> {
  if (runId !== LARA_TRUST_PAGES_REPAIR_RUN_ID || !SHA256.test(approvedPlanDigestSha256)) {
    throw new LaraTrustPagesRepairError("invalid_plan", "The fixed trust-page run is invalid.");
  }

  const schemaHash = await trustPagesSchemaSha256();
  let existing = await getAuditShopifyRun({
    runId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
  });
  if (existing && existing.manifest_hash !== approvedPlanDigestSha256) {
    throw new LaraTrustPagesRepairError(
      "approval_digest_mismatch",
      "The reviewed trust-page digest does not match the durable run.",
    );
  }
  if (existing) {
    assertImmutableRunEvidence(existing, {
      requestedBy,
      schemaHash,
      planDigestSha256: approvedPlanDigestSha256,
    });
  }
  const runtime = suppliedRuntime ?? (await createLaraTrustPagesRuntime());
  if (existing?.state === "completed" || existing?.state === "failed") {
    return verifiedResultFromExisting(
      existing,
      {
        requestedBy,
        schemaHash,
        planDigestSha256: approvedPlanDigestSha256,
      },
      runtime,
    );
  }

  let material: FixedMaterial | null = null;
  if (!existing) {
    const prepared = await prepareFixedMaterial(runtime);
    material = prepared.material;
    if (material.plan.digestSha256 !== approvedPlanDigestSha256) {
      throw new LaraTrustPagesRepairError(
        "approval_digest_mismatch",
        "The live trust-page snapshot no longer matches the reviewed digest.",
      );
    }
    await enqueueAuditShopifyRun({
      runId,
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      requestedBy,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      source: TRUST_PAGES_SOURCE,
      note: TRUST_PAGES_NOTE,
      schemaHash,
      manifestHash: material.plan.digestSha256,
      maxRetries: MAX_RETRIES,
      actorType: "system",
    });
  }

  const enqueued = await getAuditShopifyRun({
    runId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
  });
  if (!enqueued) {
    throw new LaraTrustPagesRepairError(
      "run_evidence_mismatch",
      "The queued trust-page run could not be verified.",
    );
  }
  assertImmutableRunEvidence(enqueued, {
    requestedBy,
    schemaHash,
    planDigestSha256: approvedPlanDigestSha256,
  });

  let claimed: AuditShopifyRun;
  try {
    claimed = await claimAuditShopifyRun({
      runId,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      leaseToken,
      leaseSeconds: LEASE_SECONDS,
    });
  } catch (error) {
    if (error instanceof AuditShopifyRunError && error.code === "run_not_found") {
      existing = await getAuditShopifyRun({
        runId,
        shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      });
      return verifiedResultFromExisting(
        existing,
        {
          requestedBy,
          schemaHash,
          planDigestSha256: approvedPlanDigestSha256,
        },
        runtime,
      );
    }
    throw error;
  }

  let checkpoint = await parseCheckpoint(claimed.checkpoint);
  assertImmutableRunEvidence(claimed, {
    requestedBy,
    schemaHash,
    planDigestSha256: approvedPlanDigestSha256,
  });
  if (!checkpoint) {
    if (!material) {
      const prepared = await prepareFixedMaterial(runtime);
      material = prepared.material;
    }
    if (material.plan.digestSha256 !== approvedPlanDigestSha256) {
      throw new LaraTrustPagesRepairError(
        "approval_digest_mismatch",
        "The live trust-page snapshot no longer matches the reviewed digest.",
      );
    }
    checkpoint = initialCheckpoint(material);
  }
  if (
    checkpoint.planDigestSha256 !== approvedPlanDigestSha256 ||
    claimed.manifest_hash !== approvedPlanDigestSha256
  ) {
    throw new LaraTrustPagesRepairError(
      "approval_digest_mismatch",
      "The durable trust-page evidence does not match the reviewed digest.",
    );
  }

  return executeClaimedRun({
    run: claimed,
    leaseToken,
    runtime,
    checkpoint,
    now,
  });
}

/**
 * Machine entrypoint for a temporary recurring activation. On the first call
 * it generates the exact current dry run and immediately binds apply to that
 * digest. On a replay it reuses the manifest digest already stored under the
 * stable run id, allowing a lost/timed-out invocation to resume without
 * rebuilding a plan from partially changed pages.
 */
export async function runLaraTrustPagesRepairOneShot({
  requestedBy,
  runtime: suppliedRuntime,
  leaseToken,
  now,
}: {
  requestedBy: string;
  runtime?: LaraTrustPagesRuntime;
  leaseToken?: string;
  now?: () => Date;
}): Promise<LaraTrustPagesRepairResult> {
  const existing = await getAuditShopifyRun({
    runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
  });
  let approvedPlanDigestSha256: string;
  if (existing) {
    if (
      existing.id !== LARA_TRUST_PAGES_REPAIR_RUN_ID ||
      existing.connection_id !== LARA_AUDIT_CONNECTION.connectionId ||
      existing.requested_by !== requestedBy ||
      existing.shopify_domain !== LARA_AUDIT_CONNECTION.shopDomain ||
      existing.requested_source !== TRUST_PAGES_SOURCE ||
      existing.requested_note !== TRUST_PAGES_NOTE ||
      existing.requested_actor_type !== "system" ||
      existing.max_retries !== MAX_RETRIES ||
      !SHA256.test(existing.schema_hash) ||
      !SHA256.test(existing.manifest_hash)
    ) {
      throw new LaraTrustPagesRepairError(
        "invalid_checkpoint",
        "The stable trust-page run id is occupied by different evidence.",
      );
    }
    approvedPlanDigestSha256 = existing.manifest_hash;
  } else {
    const dryRun = await buildLaraTrustPagesDryRun({ runtime: suppliedRuntime });
    approvedPlanDigestSha256 = dryRun.planDigestSha256;
  }
  return executeLaraTrustPagesRepair({
    approvedPlanDigestSha256,
    requestedBy,
    runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
    runtime: suppliedRuntime,
    ...(leaseToken ? { leaseToken } : {}),
    ...(now ? { now } : {}),
  });
}
