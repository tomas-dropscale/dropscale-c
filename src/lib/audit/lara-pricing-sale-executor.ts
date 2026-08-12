import "server-only";

import {
  LARA_PRICING_BLAST_RADIUS,
  LARA_PRICING_SALE_SCHEMA_VERSION,
  LaraPricingSalePlanError,
  laraPricingProductStateSha256,
  loadLaraPricingPersistedRoot,
  loadLaraPricingProductArtifact,
  verifyLaraPricingCatalogueSnapshot,
  type LaraPricingCatalogueSnapshot,
  type LaraPricingImmutableArtifactRef,
  type LaraPricingImmutableArtifactStore,
  type LaraPricingPersistedPlanRoot,
  type LaraPricingProductOperation,
  type LaraPricingProductSnapshot,
} from "./lara-pricing-sale-plan";
import {
  freezeRemediationValue,
  remediationSha256,
  type DeepReadonly,
} from "./shopify-remediation-plan";

/**
 * Bounded, resumable execution core for the persisted Lara pricing plan.
 *
 * It has no credential loader, route, cron, database implementation or live
 * trigger. Those boundaries are injected. In particular, the durable
 * coordinator must fence transitions and the artifact store must remain
 * service-only. This keeps the large 38k-variant before/inverse material out
 * of the 64 KiB `audit_shopify_runs.checkpoint` column.
 */

export const LARA_PRICING_EXECUTION_SCHEMA_VERSION =
  "lara-pricing-sale-execution.v1" as const;
export const LARA_PRICING_MAX_MUTATIONS_PER_SLICE = 10 as const;
export const LARA_PRICING_MAX_OPERATIONS_PER_SLICE = 25 as const;
export const LARA_PRICING_MAX_ATTEMPTS_PER_PRODUCT = 2 as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type LaraPricingExecutionPhase =
  | "ready"
  | "applying"
  | "reconciling"
  | "verification_pending"
  | "verified"
  | "blocked";

export type LaraPricingExecutionCheckpoint = DeepReadonly<{
  schemaVersion: typeof LARA_PRICING_EXECUTION_SCHEMA_VERSION;
  runId: string;
  phase: LaraPricingExecutionPhase;
  rootRef: LaraPricingImmutableArtifactRef;
  rootDigestSha256: string;
  approvedPlanDigestSha256: string;
  sourceCatalogueDigestSha256: string;
  nextOperationIndex: number;
  currentOperationIndex: number | null;
  currentOperationDigestSha256: string | null;
  attemptsForCurrentOperation: number;
  appliedProducts: number;
  appliedVariants: number;
  externallyCompliantProducts: number;
  externallyCompliantVariants: number;
  lastJournalSequence: number;
  freshVerificationDigestSha256: string | null;
  freshVerificationProducts: number | null;
  freshVerificationVariants: number | null;
  blockedCode: string | null;
}>;

export type LaraPricingJournalEvent = DeepReadonly<{
  schemaVersion: typeof LARA_PRICING_EXECUTION_SCHEMA_VERSION;
  sequence: number;
  occurredAt: string;
  event:
    | "run.ready"
    | "operation.prepared"
    | "operation.reconciled"
    | "operation.applied"
    | "operation.rejected"
    | "operation.observed_compliant"
    | "operation.blocked"
    | "run.verification_pending"
    | "run.verified";
  operationIndex: number | null;
  operationId: string | null;
  productId: string | null;
  operationDigestSha256: string | null;
  affectedVariants: number;
  detailCode: string | null;
}>;

export type LaraPricingDurableCoordinator = Readonly<{
  /** Load the small fenced checkpoint; large plan material is never returned here. */
  load(input: {
    runId: string;
    fence: string;
  }): Promise<{ revision: number; checkpoint: LaraPricingExecutionCheckpoint }>;
  /**
   * Atomically CAS the checkpoint and append the event. The implementation
   * must reject a stale revision or fence and must never overwrite an event.
   */
  transition(input: {
    runId: string;
    fence: string;
    expectedRevision: number;
    checkpoint: LaraPricingExecutionCheckpoint;
    event: LaraPricingJournalEvent;
  }): Promise<{ revision: number }>;
}>;

export type LaraPricingRepairRuntime = Readonly<{
  /** Must return every variant for the product, paginating the fixed read query. */
  readFullProduct(productId: string): Promise<LaraPricingProductSnapshot>;
  /**
   * The adapter exposes no arbitrary GraphQL and no price value. Its sole
   * mutation must send exactly `{ id, compareAtPrice: null }` for every id and
   * `allowPartialUpdates: false`.
   */
  clearCompareAtPricesAtomic(input: {
    productId: string;
    variantIds: readonly string[];
    allowPartialUpdates: false;
  }): Promise<void>;
}>;

export class LaraPricingExecutionError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CHECKPOINT"
      | "APPROVAL_DIGEST_MISMATCH"
      | "PLAN_ARTIFACT_INVALID"
      | "OPERATION_DRIFT"
      | "WRITE_NOT_VERIFIED"
      | "TOO_MANY_ATTEMPTS"
      | "DURABLE_TRANSITION_FAILED"
      | "FINAL_VERIFICATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "LaraPricingExecutionError";
  }
}

/**
 * The only write failure that may deliberately leave an operation in the
 * durable reconciliation state. Runtime adapters must use this class solely
 * when Shopify might already have committed the fixed mutation but the
 * acknowledgement was lost or unusable. Definite rejections and arbitrary
 * exceptions must escape the executor so the run lifecycle can classify them
 * explicitly instead of attributing an unrelated external change to us.
 */
export class LaraPricingMutationAmbiguousError extends Error {
  constructor(message = "The fixed pricing mutation outcome is ambiguous.") {
    super(message);
    this.name = "LaraPricingMutationAmbiguousError";
  }
}

/** Shopify definitively did not apply the fixed mutation. */
export class LaraPricingMutationDefinitiveError extends Error {
  public readonly code = "mutation_rejected" as const;

  constructor(
    message = "Shopify definitively rejected the fixed pricing mutation.",
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "LaraPricingMutationDefinitiveError";
  }
}

function checkpointJsonBytes(checkpoint: LaraPricingExecutionCheckpoint): number {
  return new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength;
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function assertCheckpointShape(checkpoint: LaraPricingExecutionCheckpoint): void {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new LaraPricingExecutionError(
      "INVALID_CHECKPOINT",
      "The bounded Lara pricing checkpoint is invalid.",
    );
  }
  const currentOperationPairValid =
    (checkpoint.currentOperationIndex === null &&
      checkpoint.currentOperationDigestSha256 === null) ||
    (Number.isSafeInteger(checkpoint.currentOperationIndex) &&
      Number(checkpoint.currentOperationIndex) >= 0 &&
      typeof checkpoint.currentOperationDigestSha256 === "string" &&
      SHA256.test(checkpoint.currentOperationDigestSha256));
  const freshVerificationValid =
    checkpoint.phase === "verified"
      ? typeof checkpoint.freshVerificationDigestSha256 === "string" &&
        SHA256.test(checkpoint.freshVerificationDigestSha256) &&
        Number.isSafeInteger(checkpoint.freshVerificationProducts) &&
        Number(checkpoint.freshVerificationProducts) > 0 &&
        Number.isSafeInteger(checkpoint.freshVerificationVariants) &&
        Number(checkpoint.freshVerificationVariants) > 0
      : checkpoint.freshVerificationDigestSha256 === null &&
        checkpoint.freshVerificationProducts === null &&
        checkpoint.freshVerificationVariants === null;
  if (
    !hasExactKeys(checkpoint, [
      "schemaVersion",
      "runId",
      "phase",
      "rootRef",
      "rootDigestSha256",
      "approvedPlanDigestSha256",
      "sourceCatalogueDigestSha256",
      "nextOperationIndex",
      "currentOperationIndex",
      "currentOperationDigestSha256",
      "attemptsForCurrentOperation",
      "appliedProducts",
      "appliedVariants",
      "externallyCompliantProducts",
      "externallyCompliantVariants",
      "lastJournalSequence",
      "freshVerificationDigestSha256",
      "freshVerificationProducts",
      "freshVerificationVariants",
      "blockedCode",
    ]) ||
    !hasExactKeys(checkpoint.rootRef, ["key", "digestSha256", "byteLength"]) ||
    checkpoint.schemaVersion !== LARA_PRICING_EXECUTION_SCHEMA_VERSION ||
    ![
      "ready",
      "applying",
      "reconciling",
      "verification_pending",
      "verified",
      "blocked",
    ].includes(checkpoint.phase) ||
    !UUID.test(checkpoint.runId) ||
    checkpoint.rootRef.key !==
      `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${checkpoint.runId}/root.json` ||
    !SHA256.test(checkpoint.rootRef.digestSha256) ||
    !Number.isSafeInteger(checkpoint.rootRef.byteLength) ||
    checkpoint.rootRef.byteLength < 1 ||
    checkpoint.rootRef.byteLength > LARA_PRICING_BLAST_RADIUS.maxRootArtifactBytes ||
    !SHA256.test(checkpoint.rootDigestSha256) ||
    !SHA256.test(checkpoint.approvedPlanDigestSha256) ||
    !SHA256.test(checkpoint.sourceCatalogueDigestSha256) ||
    checkpoint.rootRef.digestSha256 !== checkpoint.rootDigestSha256 ||
    !Number.isInteger(checkpoint.nextOperationIndex) ||
    checkpoint.nextOperationIndex < 0 ||
    checkpoint.nextOperationIndex > LARA_PRICING_BLAST_RADIUS.maxProducts ||
    !currentOperationPairValid ||
    !Number.isSafeInteger(checkpoint.attemptsForCurrentOperation) ||
    checkpoint.attemptsForCurrentOperation < 0 ||
    checkpoint.attemptsForCurrentOperation > LARA_PRICING_MAX_ATTEMPTS_PER_PRODUCT ||
    !Number.isSafeInteger(checkpoint.appliedProducts) ||
    checkpoint.appliedProducts < 0 ||
    checkpoint.appliedProducts > LARA_PRICING_BLAST_RADIUS.maxProducts ||
    !Number.isSafeInteger(checkpoint.appliedVariants) ||
    checkpoint.appliedVariants < 0 ||
    checkpoint.appliedVariants > LARA_PRICING_BLAST_RADIUS.maxAffectedVariants ||
    !Number.isSafeInteger(checkpoint.externallyCompliantProducts) ||
    checkpoint.externallyCompliantProducts < 0 ||
    checkpoint.externallyCompliantProducts > LARA_PRICING_BLAST_RADIUS.maxProducts ||
    !Number.isSafeInteger(checkpoint.externallyCompliantVariants) ||
    checkpoint.externallyCompliantVariants < 0 ||
    checkpoint.externallyCompliantVariants >
      LARA_PRICING_BLAST_RADIUS.maxAffectedVariants ||
    !Number.isSafeInteger(checkpoint.lastJournalSequence) ||
    checkpoint.lastJournalSequence < 0 ||
    (checkpoint.phase === "reconciling" &&
      (checkpoint.currentOperationIndex !== checkpoint.nextOperationIndex ||
        checkpoint.attemptsForCurrentOperation < 1)) ||
    (["ready", "applying", "verification_pending", "verified"].includes(
      checkpoint.phase,
    ) &&
      (checkpoint.currentOperationIndex !== null ||
        checkpoint.attemptsForCurrentOperation !== 0)) ||
    (checkpoint.phase === "blocked"
      ? typeof checkpoint.blockedCode !== "string" ||
        !/^[A-Z0-9][A-Z0-9_]{1,127}$/.test(checkpoint.blockedCode)
      : checkpoint.blockedCode !== null) ||
    !freshVerificationValid ||
    checkpointJsonBytes(checkpoint) >= 8 * 1024
  ) {
    throw new LaraPricingExecutionError(
      "INVALID_CHECKPOINT",
      "The bounded Lara pricing checkpoint is invalid.",
    );
  }
}

/** Runtime validation for checkpoint JSON loaded from the durable run row. */
export function validateLaraPricingExecutionCheckpoint(
  checkpoint: LaraPricingExecutionCheckpoint,
): void {
  assertCheckpointShape(checkpoint);
}

function eventFor({
  checkpoint,
  occurredAt,
  event,
  operation = null,
  operationIndex = null,
  detailCode = null,
}: {
  checkpoint: LaraPricingExecutionCheckpoint;
  occurredAt: string;
  event: LaraPricingJournalEvent["event"];
  operation?: LaraPricingProductOperation | null;
  operationIndex?: number | null;
  detailCode?: string | null;
}): LaraPricingJournalEvent {
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new LaraPricingExecutionError(
      "INVALID_CHECKPOINT",
      "The durable journal timestamp is invalid.",
    );
  }
  return freezeRemediationValue({
    schemaVersion: LARA_PRICING_EXECUTION_SCHEMA_VERSION,
    sequence: checkpoint.lastJournalSequence + 1,
    occurredAt,
    event,
    operationIndex,
    operationId: operation?.operationId ?? null,
    productId: operation?.target.productId ?? null,
    operationDigestSha256: operation?.digestSha256 ?? null,
    affectedVariants: operation?.change.variants.length ?? 0,
    detailCode,
  });
}

async function durableTransition({
  coordinator,
  fence,
  revision,
  checkpoint,
  event,
}: {
  coordinator: LaraPricingDurableCoordinator;
  fence: string;
  revision: number;
  checkpoint: LaraPricingExecutionCheckpoint;
  event: LaraPricingJournalEvent;
}): Promise<{ revision: number; checkpoint: LaraPricingExecutionCheckpoint }> {
  const next = freezeRemediationValue({
    ...checkpoint,
    lastJournalSequence: event.sequence,
  });
  assertCheckpointShape(next);
  let transitioned: { revision: number };
  try {
    transitioned = await coordinator.transition({
      runId: next.runId,
      fence,
      expectedRevision: revision,
      checkpoint: next,
      event,
    });
  } catch {
    throw new LaraPricingExecutionError(
      "DURABLE_TRANSITION_FAILED",
      "The fenced pricing checkpoint could not be persisted.",
    );
  }
  if (!Number.isInteger(transitioned.revision) || transitioned.revision <= revision) {
    throw new LaraPricingExecutionError(
      "DURABLE_TRANSITION_FAILED",
      "The pricing checkpoint transition did not advance its revision.",
    );
  }
  return { revision: transitioned.revision, checkpoint: next };
}

export function initialLaraPricingExecutionCheckpoint({
  runId,
  rootRef,
  root,
  approvedPlanDigestSha256,
}: {
  runId: string;
  rootRef: LaraPricingImmutableArtifactRef;
  root: LaraPricingPersistedPlanRoot;
  approvedPlanDigestSha256: string;
}): LaraPricingExecutionCheckpoint {
  if (
    !UUID.test(runId) ||
    approvedPlanDigestSha256 !== root.digestSha256 ||
    !SHA256.test(rootRef.digestSha256) ||
    rootRef.byteLength < 1 ||
    root.schemaVersion !== LARA_PRICING_SALE_SCHEMA_VERSION
  ) {
    throw new LaraPricingExecutionError(
      "APPROVAL_DIGEST_MISMATCH",
      "The reviewed immutable pricing plan digest is required before execution.",
    );
  }
  const checkpoint = freezeRemediationValue({
    schemaVersion: LARA_PRICING_EXECUTION_SCHEMA_VERSION,
    runId,
    phase: "ready" as const,
    rootRef,
    rootDigestSha256: rootRef.digestSha256,
    approvedPlanDigestSha256,
    sourceCatalogueDigestSha256: root.sourceCatalogueDigestSha256,
    nextOperationIndex: 0,
    currentOperationIndex: null,
    currentOperationDigestSha256: null,
    attemptsForCurrentOperation: 0,
    appliedProducts: 0,
    appliedVariants: 0,
    externallyCompliantProducts: 0,
    externallyCompliantVariants: 0,
    lastJournalSequence: 0,
    freshVerificationDigestSha256: null,
    freshVerificationProducts: null,
    freshVerificationVariants: null,
    blockedCode: null,
  });
  assertCheckpointShape(checkpoint);
  return checkpoint;
}

type CurrentStateClassification = "before_exact" | "after_exact" | "drift";

function assertCheckpointMatchesRoot(
  checkpoint: LaraPricingExecutionCheckpoint,
  root: LaraPricingPersistedPlanRoot,
): void {
  const resolvedProducts =
    checkpoint.appliedProducts + checkpoint.externallyCompliantProducts;
  const resolvedVariants =
    checkpoint.appliedVariants + checkpoint.externallyCompliantVariants;
  const expectedResolvedVariants = root.operations
    .slice(0, checkpoint.nextOperationIndex)
    .reduce((count, operation) => count + operation.affectedVariants, 0);
  const current = root.operations[checkpoint.nextOperationIndex];
  const currentRequired = ["reconciling", "blocked"].includes(
    checkpoint.phase,
  );
  const allResolvedRequired = [
    "verification_pending",
    "verified",
  ].includes(checkpoint.phase);
  if (
    resolvedProducts !== checkpoint.nextOperationIndex ||
    resolvedVariants !== expectedResolvedVariants ||
    (checkpoint.phase === "ready" && checkpoint.nextOperationIndex !== 0) ||
    (allResolvedRequired &&
      checkpoint.nextOperationIndex !== root.operations.length) ||
    (currentRequired &&
      (!current ||
        checkpoint.currentOperationIndex !== current.operationIndex ||
        checkpoint.currentOperationDigestSha256 !==
          current.operationDigestSha256))
  ) {
    throw new LaraPricingExecutionError(
      "INVALID_CHECKPOINT",
      "The pricing execution counters do not reconcile with the immutable root.",
    );
  }
}

async function classifyCurrentState(
  current: LaraPricingProductSnapshot,
  operation: LaraPricingProductOperation,
): Promise<CurrentStateClassification> {
  if ((await laraPricingProductStateSha256(current)) === operation.cas.beforeStateSha256) {
    return "before_exact";
  }
  const before = operation.sourceProduct;
  if (
    current.id !== before.id ||
    current.handle !== before.handle ||
    current.title !== before.title ||
    current.vendor !== before.vendor ||
    current.status !== before.status ||
    current.publishedAt !== before.publishedAt ||
    current.variants.length !== before.variants.length ||
    new Set(current.variants.map((variant) => variant.id)).size !==
      current.variants.length
  ) {
    return "drift";
  }
  const changedIds = new Set(operation.change.variants.map((variant) => variant.id));
  const beforeById = new Map(before.variants.map((variant) => [variant.id, variant]));
  let allTargetsStillBefore = true;
  let allTargetsAfter = true;
  for (const variant of current.variants) {
    const expected = beforeById.get(variant.id);
    if (
      !expected ||
      variant.title !== expected.title ||
      variant.price !== expected.price
    ) {
      return "drift";
    }
    if (changedIds.has(variant.id)) {
      if (variant.compareAtPrice !== expected.compareAtPrice) {
        allTargetsStillBefore = false;
      }
      if (variant.compareAtPrice !== null) allTargetsAfter = false;
    } else if (variant.compareAtPrice !== expected.compareAtPrice) {
      return "drift";
    }
  }
  // Shopify documents that Product.updatedAt can move for inventory activity.
  // Timestamps are retained as evidence but are not mutation gates when every
  // protected value is still exact. This avoids blocking a catalogue-wide
  // price repair merely because an order adjusted inventory in the meantime.
  if (allTargetsStillBefore) return "before_exact";
  if (allTargetsAfter) return "after_exact";
  return "drift";
}

async function blockCurrentOperation({
  coordinator,
  fence,
  revision,
  checkpoint,
  operation,
  operationIndex,
  occurredAt,
  code,
}: {
  coordinator: LaraPricingDurableCoordinator;
  fence: string;
  revision: number;
  checkpoint: LaraPricingExecutionCheckpoint;
  operation: LaraPricingProductOperation;
  operationIndex: number;
  occurredAt: string;
  code: string;
}) {
  const event = eventFor({
    checkpoint,
    occurredAt,
    event: "operation.blocked",
    operation,
    operationIndex,
    detailCode: code,
  });
  return durableTransition({
    coordinator,
    fence,
    revision,
    checkpoint: freezeRemediationValue({
      ...checkpoint,
      phase: "blocked" as const,
      currentOperationIndex: operationIndex,
      currentOperationDigestSha256: operation.digestSha256,
      blockedCode: code,
    }),
    event,
  });
}

async function finishOperation({
  coordinator,
  fence,
  revision,
  checkpoint,
  operation,
  operationIndex,
  occurredAt,
  outcome,
}: {
  coordinator: LaraPricingDurableCoordinator;
  fence: string;
  revision: number;
  checkpoint: LaraPricingExecutionCheckpoint;
  operation: LaraPricingProductOperation;
  operationIndex: number;
  occurredAt: string;
  outcome: "applied" | "reconciled" | "observed_compliant";
}) {
  const external = outcome === "observed_compliant";
  const event = eventFor({
    checkpoint,
    occurredAt,
    event:
      outcome === "applied"
        ? "operation.applied"
        : outcome === "reconciled"
          ? "operation.reconciled"
          : "operation.observed_compliant",
    operation,
    operationIndex,
    detailCode: external ? "EXTERNAL_ALREADY_COMPLIANT" : null,
  });
  return durableTransition({
    coordinator,
    fence,
    revision,
    checkpoint: freezeRemediationValue({
      ...checkpoint,
      phase: "applying" as const,
      nextOperationIndex: operationIndex + 1,
      currentOperationIndex: null,
      currentOperationDigestSha256: null,
      attemptsForCurrentOperation: 0,
      appliedProducts: checkpoint.appliedProducts + (external ? 0 : 1),
      appliedVariants:
        checkpoint.appliedVariants +
        (external ? 0 : operation.change.variants.length),
      externallyCompliantProducts:
        checkpoint.externallyCompliantProducts + (external ? 1 : 0),
      externallyCompliantVariants:
        checkpoint.externallyCompliantVariants +
        (external ? operation.change.variants.length : 0),
      blockedCode: null,
    }),
    event,
  });
}

export type LaraPricingExecutionSliceResult = DeepReadonly<{
  phase: LaraPricingExecutionPhase;
  checkpoint: LaraPricingExecutionCheckpoint;
  mutationsAttempted: number;
  operationsProcessed: number;
}>;

/**
 * Execute a small slice. A `reconciling` checkpoint is persisted before the
 * network mutation, so a crash at any later instruction can never cause a
 * blind duplicate write on resume.
 */
export async function executeLaraPricingSaleSlice({
  runId,
  fence,
  approvedPlanDigestSha256,
  store,
  coordinator,
  runtime,
  now = () => new Date(),
  maxMutations = LARA_PRICING_MAX_MUTATIONS_PER_SLICE,
  maxOperations = LARA_PRICING_MAX_OPERATIONS_PER_SLICE,
}: {
  runId: string;
  fence: string;
  approvedPlanDigestSha256: string;
  store: LaraPricingImmutableArtifactStore;
  coordinator: LaraPricingDurableCoordinator;
  runtime: LaraPricingRepairRuntime;
  now?: () => Date;
  maxMutations?: number;
  maxOperations?: number;
}): Promise<LaraPricingExecutionSliceResult> {
  if (
    !UUID.test(runId) ||
    !fence ||
    !SHA256.test(approvedPlanDigestSha256) ||
    !Number.isInteger(maxMutations) ||
    maxMutations < 1 ||
    maxMutations > LARA_PRICING_MAX_MUTATIONS_PER_SLICE ||
    !Number.isInteger(maxOperations) ||
    maxOperations < 1 ||
    maxOperations > LARA_PRICING_MAX_OPERATIONS_PER_SLICE
  ) {
    throw new LaraPricingExecutionError(
      "INVALID_CHECKPOINT",
      "The pricing execution slice input is invalid.",
    );
  }

  let loaded = await coordinator.load({ runId, fence });
  let revision = loaded.revision;
  let checkpoint = loaded.checkpoint;
  assertCheckpointShape(checkpoint);
  if (
    checkpoint.runId !== runId ||
    checkpoint.approvedPlanDigestSha256 !== approvedPlanDigestSha256
  ) {
    throw new LaraPricingExecutionError(
      "APPROVAL_DIGEST_MISMATCH",
      "The execution approval does not match the durable pricing checkpoint.",
    );
  }
  const root = await loadLaraPricingPersistedRoot({
    store,
    ref: checkpoint.rootRef,
  });
  if (
    root.digestSha256 !== approvedPlanDigestSha256 ||
    root.sourceCatalogueDigestSha256 !== checkpoint.sourceCatalogueDigestSha256 ||
    checkpoint.nextOperationIndex > root.operations.length
  ) {
    throw new LaraPricingExecutionError(
      "APPROVAL_DIGEST_MISMATCH",
      "The persisted pricing root does not match the reviewed plan.",
    );
  }
  assertCheckpointMatchesRoot(checkpoint, root);
  if (
    checkpoint.phase === "verified" ||
    checkpoint.phase === "blocked" ||
    checkpoint.phase === "verification_pending"
  ) {
    return freezeRemediationValue({
      phase: checkpoint.phase,
      checkpoint,
      mutationsAttempted: 0,
      operationsProcessed: 0,
    });
  }

  if (checkpoint.phase === "ready") {
    const event = eventFor({
      checkpoint,
      occurredAt: now().toISOString(),
      event: "run.ready",
      detailCode: "IMMUTABLE_PLAN_APPROVED",
    });
    loaded = await durableTransition({
      coordinator,
      fence,
      revision,
      checkpoint: freezeRemediationValue({
        ...checkpoint,
        phase: "applying" as const,
      }),
      event,
    });
    revision = loaded.revision;
    checkpoint = loaded.checkpoint;
  }

  let mutationsAttempted = 0;
  let operationsProcessed = 0;
  while (
    checkpoint.nextOperationIndex < root.operations.length &&
    mutationsAttempted < maxMutations &&
    operationsProcessed < maxOperations
  ) {
    const operationIndex = checkpoint.nextOperationIndex;
    const reference = root.operations[operationIndex];
    if (!reference || reference.operationIndex !== operationIndex) {
      throw new LaraPricingExecutionError(
        "PLAN_ARTIFACT_INVALID",
        "The pricing operation index is not contiguous.",
      );
    }
    const partition = await loadLaraPricingProductArtifact({
      store,
      ref: reference.partitionRef,
      expectedCatalogueDigest: root.sourceCatalogueDigestSha256,
    });
    const operation = partition.operation;
    if (
      !operation ||
      operation.digestSha256 !== reference.operationDigestSha256 ||
      operation.target.productId !== reference.productId ||
      operation.change.variants.length !== reference.affectedVariants ||
      operation.change.variants.length < 1 ||
      operation.change.variants.length >
        LARA_PRICING_BLAST_RADIUS.maxAffectedVariantsPerProduct
    ) {
      throw new LaraPricingExecutionError(
        "PLAN_ARTIFACT_INVALID",
        "The immutable pricing product operation is invalid.",
      );
    }

    const current = await runtime.readFullProduct(operation.target.productId);
    const classification = await classifyCurrentState(current, operation);
    const resumingAttempt =
      checkpoint.phase === "reconciling" &&
      checkpoint.currentOperationIndex === operationIndex &&
      checkpoint.currentOperationDigestSha256 === operation.digestSha256;

    if (classification === "drift") {
      loaded = await blockCurrentOperation({
        coordinator,
        fence,
        revision,
        checkpoint,
        operation,
        operationIndex,
        occurredAt: now().toISOString(),
        code: "PRODUCT_OR_PRICE_CAS_DRIFT",
      });
      return freezeRemediationValue({
        phase: loaded.checkpoint.phase,
        checkpoint: loaded.checkpoint,
        mutationsAttempted,
        operationsProcessed,
      });
    }

    if (classification === "after_exact") {
      loaded = await finishOperation({
        coordinator,
        fence,
        revision,
        checkpoint,
        operation,
        operationIndex,
        occurredAt: now().toISOString(),
        outcome: resumingAttempt ? "reconciled" : "observed_compliant",
      });
      revision = loaded.revision;
      checkpoint = loaded.checkpoint;
      operationsProcessed += 1;
      continue;
    }

    if (
      resumingAttempt &&
      checkpoint.attemptsForCurrentOperation >=
        LARA_PRICING_MAX_ATTEMPTS_PER_PRODUCT
    ) {
      loaded = await blockCurrentOperation({
        coordinator,
        fence,
        revision,
        checkpoint,
        operation,
        operationIndex,
        occurredAt: now().toISOString(),
        code: "MAX_PRODUCT_ATTEMPTS_REACHED",
      });
      return freezeRemediationValue({
        phase: loaded.checkpoint.phase,
        checkpoint: loaded.checkpoint,
        mutationsAttempted,
        operationsProcessed,
      });
    }

    // Persist a state that means "the mutation may have happened" before the
    // network call. If the Worker dies on the next instruction, resume reads
    // and reconciles rather than issuing a blind duplicate mutation.
    const prepared = eventFor({
      checkpoint,
      occurredAt: now().toISOString(),
      event: "operation.prepared",
      operation,
      operationIndex,
      detailCode: "MUTATION_MAY_FOLLOW",
    });
    loaded = await durableTransition({
      coordinator,
      fence,
      revision,
      checkpoint: freezeRemediationValue({
        ...checkpoint,
        phase: "reconciling" as const,
        currentOperationIndex: operationIndex,
        currentOperationDigestSha256: operation.digestSha256,
        attemptsForCurrentOperation:
          checkpoint.attemptsForCurrentOperation + 1,
      }),
      event: prepared,
    });
    revision = loaded.revision;
    checkpoint = loaded.checkpoint;
    mutationsAttempted += 1;

    try {
      await runtime.clearCompareAtPricesAtomic({
        productId: operation.target.productId,
        variantIds: operation.change.variants.map((variant) => variant.id),
        allowPartialUpdates: false,
      });
    } catch (error) {
      if (error instanceof LaraPricingMutationDefinitiveError) {
        const rejected = eventFor({
          checkpoint,
          occurredAt: now().toISOString(),
          event: "operation.rejected",
          operation,
          operationIndex,
          detailCode: "MUTATION_DEFINITIVELY_REJECTED",
        });
        loaded = await durableTransition({
          coordinator,
          fence,
          revision,
          checkpoint: freezeRemediationValue({
            ...checkpoint,
            phase: "applying" as const,
            currentOperationIndex: null,
            currentOperationDigestSha256: null,
            attemptsForCurrentOperation: 0,
          }),
          event: rejected,
        });
        checkpoint = loaded.checkpoint;
        throw error;
      }
      if (!(error instanceof LaraPricingMutationAmbiguousError)) throw error;
      // The checkpoint is intentionally left in reconciliation. A response can
      // be lost after Shopify commits, so this invocation does not guess or
      // automatically restore the legally unsupported compare-at prices.
      return freezeRemediationValue({
        phase: checkpoint.phase,
        checkpoint,
        mutationsAttempted,
        operationsProcessed,
      });
    }

    let observed: LaraPricingProductSnapshot;
    try {
      observed = await runtime.readFullProduct(operation.target.productId);
    } catch {
      return freezeRemediationValue({
        phase: checkpoint.phase,
        checkpoint,
        mutationsAttempted,
        operationsProcessed,
      });
    }
    const afterWrite = await classifyCurrentState(observed, operation);
    if (afterWrite !== "after_exact") {
      if (afterWrite === "drift") {
        loaded = await blockCurrentOperation({
          coordinator,
          fence,
          revision,
          checkpoint,
          operation,
          operationIndex,
          occurredAt: now().toISOString(),
          code: "POST_WRITE_STATE_DRIFT",
        });
        return freezeRemediationValue({
          phase: loaded.checkpoint.phase,
          checkpoint: loaded.checkpoint,
          mutationsAttempted,
          operationsProcessed,
        });
      }
      // Exact before-state means Shopify did not apply the mutation. Leave the
      // run resumable; the capped attempt counter prevents an endless loop.
      return freezeRemediationValue({
        phase: checkpoint.phase,
        checkpoint,
        mutationsAttempted,
        operationsProcessed,
      });
    }
    loaded = await finishOperation({
      coordinator,
      fence,
      revision,
      checkpoint,
      operation,
      operationIndex,
      occurredAt: now().toISOString(),
      outcome: "applied",
    });
    revision = loaded.revision;
    checkpoint = loaded.checkpoint;
    operationsProcessed += 1;
  }

  if (checkpoint.nextOperationIndex === root.operations.length) {
    const event = eventFor({
      checkpoint,
      occurredAt: now().toISOString(),
      event: "run.verification_pending",
      detailCode: "FRESH_ADMIN_BULK_QUERY_REQUIRED",
    });
    loaded = await durableTransition({
      coordinator,
      fence,
      revision,
      checkpoint: freezeRemediationValue({
        ...checkpoint,
        phase: "verification_pending" as const,
      }),
      event,
    });
    checkpoint = loaded.checkpoint;
  }

  return freezeRemediationValue({
    phase: checkpoint.phase,
    checkpoint,
    mutationsAttempted,
    operationsProcessed,
  });
}

export type LaraPricingFinalVerification = DeepReadonly<{
  status: "verified" | "blocked";
  freshCatalogueDigestSha256: string;
  freshProducts: number;
  freshVariants: number;
  nonNullCompareAtVariants: number;
  missingSourceProducts: number;
  missingSourceVariants: number;
  sellingPriceDriftVariants: number;
  vendorDriftProducts: number;
  statusDriftProducts: number;
  publicationDriftProducts: number;
  blockedCode: string | null;
}>;

/**
 * Terminal proof from a second, fresh Admin Bulk Query. There are no status or
 * publication exclusions: ACTIVE, DRAFT, ARCHIVED and UNLISTED variants must all have a
 * null compare-at price. New products are accepted only when they also comply;
 * every source variant must still exist at the same selling price.
 */
export async function verifyLaraPricingSaleRepair({
  root,
  store,
  freshCatalogue,
}: {
  root: LaraPricingPersistedPlanRoot;
  store: LaraPricingImmutableArtifactStore;
  freshCatalogue: LaraPricingCatalogueSnapshot;
}): Promise<LaraPricingFinalVerification> {
  const verifiedFreshCatalogue = await verifyLaraPricingCatalogueSnapshot(
    freshCatalogue,
  );
  const freshByProduct = new Map(
    verifiedFreshCatalogue.products.map((product) => [product.id, product]),
  );
  const nonNullCompareAtVariants = verifiedFreshCatalogue.products.reduce(
    (count, product) =>
      count + product.variants.filter((variant) => variant.compareAtPrice !== null).length,
    0,
  );
  let missingSourceProducts = 0;
  let missingSourceVariants = 0;
  let sellingPriceDriftVariants = 0;
  let vendorDriftProducts = 0;
  let statusDriftProducts = 0;
  let publicationDriftProducts = 0;

  for (const partitionRef of root.productPartitions) {
    const partition = await loadLaraPricingProductArtifact({
      store,
      ref: partitionRef.ref,
      expectedCatalogueDigest: root.sourceCatalogueDigestSha256,
    });
    const fresh = freshByProduct.get(partition.product.id);
    if (!fresh) {
      missingSourceProducts += 1;
      missingSourceVariants += partition.product.variants.length;
      continue;
    }
    if (fresh.vendor !== partition.product.vendor) vendorDriftProducts += 1;
    if (fresh.status !== partition.product.status) statusDriftProducts += 1;
    if (fresh.publishedAt !== partition.product.publishedAt) {
      publicationDriftProducts += 1;
    }
    const freshVariants = new Map(
      fresh.variants.map((variant) => [variant.id, variant]),
    );
    for (const sourceVariant of partition.product.variants) {
      const current = freshVariants.get(sourceVariant.id);
      if (!current) {
        missingSourceVariants += 1;
      } else if (current.price !== sourceVariant.price) {
        sellingPriceDriftVariants += 1;
      }
    }
  }

  let blockedCode: string | null = null;
  if (nonNullCompareAtVariants > 0) blockedCode = "COMPARE_AT_REMAINS";
  else if (missingSourceProducts > 0 || missingSourceVariants > 0) {
    blockedCode = "SOURCE_CATALOGUE_MISSING";
  } else if (sellingPriceDriftVariants > 0) blockedCode = "SELLING_PRICE_DRIFT";
  else if (vendorDriftProducts > 0) blockedCode = "VENDOR_DRIFT";
  else if (statusDriftProducts > 0) blockedCode = "PRODUCT_STATUS_DRIFT";
  else if (publicationDriftProducts > 0) blockedCode = "PUBLICATION_DRIFT";
  return freezeRemediationValue({
    status: blockedCode ? ("blocked" as const) : ("verified" as const),
    freshCatalogueDigestSha256: verifiedFreshCatalogue.digestSha256,
    freshProducts: verifiedFreshCatalogue.counts.products,
    freshVariants: verifiedFreshCatalogue.counts.variants,
    nonNullCompareAtVariants,
    missingSourceProducts,
    missingSourceVariants,
    sellingPriceDriftVariants,
    vendorDriftProducts,
    statusDriftProducts,
    publicationDriftProducts,
    blockedCode,
  });
}

export async function completeLaraPricingSaleVerification({
  runId,
  fence,
  coordinator,
  verification,
  now = () => new Date(),
}: {
  runId: string;
  fence: string;
  coordinator: LaraPricingDurableCoordinator;
  verification: LaraPricingFinalVerification;
  now?: () => Date;
}): Promise<LaraPricingExecutionCheckpoint> {
  const loaded = await coordinator.load({ runId, fence });
  const checkpoint = loaded.checkpoint;
  assertCheckpointShape(checkpoint);
  if (checkpoint.runId !== runId || checkpoint.phase !== "verification_pending") {
    throw new LaraPricingExecutionError(
      "INVALID_CHECKPOINT",
      "Pricing verification is only allowed after every operation is resolved.",
    );
  }
  if (verification.status !== "verified" || verification.blockedCode !== null) {
    throw new LaraPricingExecutionError(
      "FINAL_VERIFICATION_FAILED",
      "A fresh full-catalogue Bulk Query did not prove the pricing repair.",
    );
  }
  const event = eventFor({
    checkpoint,
    occurredAt: now().toISOString(),
    event: "run.verified",
    detailCode: "FRESH_BULK_QUERY_ZERO_COMPARE_AT",
  });
  const transitioned = await durableTransition({
    coordinator,
    fence,
    revision: loaded.revision,
    checkpoint: freezeRemediationValue({
      ...checkpoint,
      phase: "verified" as const,
      freshVerificationDigestSha256: verification.freshCatalogueDigestSha256,
      freshVerificationProducts: verification.freshProducts,
      freshVerificationVariants: verification.freshVariants,
      blockedCode: null,
    }),
    event,
  });
  return transitioned.checkpoint;
}

export async function laraPricingExecutionSchemaSha256(): Promise<string> {
  return remediationSha256({
    planSchema: LARA_PRICING_SALE_SCHEMA_VERSION,
    executionSchema: LARA_PRICING_EXECUTION_SCHEMA_VERSION,
    maxMutationsPerSlice: LARA_PRICING_MAX_MUTATIONS_PER_SLICE,
    maxOperationsPerSlice: LARA_PRICING_MAX_OPERATIONS_PER_SLICE,
    maxAttemptsPerProduct: LARA_PRICING_MAX_ATTEMPTS_PER_PRODUCT,
  });
}

export function isLaraPricingPlanArtifactError(
  error: unknown,
): error is LaraPricingSalePlanError {
  return error instanceof LaraPricingSalePlanError;
}
