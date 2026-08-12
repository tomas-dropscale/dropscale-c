import "server-only";

import { z } from "zod";

import { LARA_PRIORITY_PRODUCT_HANDLES } from "./shopify-baseline";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  createLaraPriorityQuarantineRuntime,
  LARA_PRIORITY_QUARANTINE_GRAPHQL_MANIFEST,
  LaraPriorityQuarantineRuntimeError,
  type LaraPriorityProductSnapshot,
  type LaraPriorityQuarantineRuntime,
} from "./shopify-priority-quarantine-runtime";
import {
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

export const LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION =
  "lara-priority-quarantine.v1" as const;
export const LARA_PRIORITY_QUARANTINE_PLAN_ID =
  "lara-priority-quarantine-active-to-draft-v1" as const;
export const LARA_PRIORITY_QUARANTINE_PURPOSE =
  "Quarantine the ten fixed Lara priority products while their identity or claims are repaired." as const;
export const LARA_PRIORITY_QUARANTINE_VENDOR = "Lara Rovinj" as const;
export const LARA_PRIORITY_QUARANTINE_RUN_ID =
  "9766fd58-5abc-45c9-a248-fd12bd8fd27c" as const;
export const LARA_PRIORITY_QUARANTINE_MAX_RETRIES = 3 as const;

const QUARANTINE_SOURCE = "system.priority_quarantine" as const;
const QUARANTINE_NOTE =
  "Authorised Lara priority quarantine: ten fixed ACTIVE products to DRAFT" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const timestampSchema = z.string().datetime({ offset: true });

const quarantineOperationSchema = z
  .object({
    operationId: z.string().regex(/^quarantine-[0-9]{2}$/),
    kind: z.literal("product.quarantine_to_draft"),
    target: z
      .object({
        productId: z.string().regex(PRODUCT_GID),
        handle: z.enum(LARA_PRIORITY_PRODUCT_HANDLES),
      })
      .strict(),
    cas: z
      .object({
        beforeStateSha256: z.string().regex(SHA256),
        expectedTitle: z.string().min(1).max(500),
        expectedStatus: z.literal("ACTIVE"),
        expectedUpdatedAt: timestampSchema,
        expectedVendor: z.literal(LARA_PRIORITY_QUARANTINE_VENDOR),
      })
      .strict(),
    change: z.object({ status: z.literal("DRAFT") }).strict(),
    inverse: z.object({ status: z.literal("ACTIVE") }).strict(),
  })
  .strict();

const quarantinePlanPayloadSchema = z
  .object({
    schemaVersion: z.literal(LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION),
    planId: z.literal(LARA_PRIORITY_QUARANTINE_PLAN_ID),
    connectionId: z.literal(LARA_AUDIT_CONNECTION.connectionId),
    shop: z
      .object({
        domain: z.literal(LARA_AUDIT_CONNECTION.shopDomain),
        shopId: z.literal(LARA_AUDIT_CONNECTION.shopId),
      })
      .strict(),
    createdAt: timestampSchema,
    purpose: z.literal(LARA_PRIORITY_QUARANTINE_PURPOSE),
    operations: z.array(quarantineOperationSchema).length(LARA_PRIORITY_PRODUCT_HANDLES.length),
  })
  .strict()
  .superRefine((plan, context) => {
    const productIds = new Set<string>();
    plan.operations.forEach((operation, index) => {
      const expectedHandle = LARA_PRIORITY_PRODUCT_HANDLES[index];
      const expectedOperationId = `quarantine-${String(index + 1).padStart(2, "0")}`;
      if (operation.target.handle !== expectedHandle) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "target", "handle"],
          message: "The quarantine plan must contain the fixed handles in fixed order.",
        });
      }
      if (operation.operationId !== expectedOperationId) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "operationId"],
          message: "The quarantine operation id does not match its fixed slot.",
        });
      }
      if (productIds.has(operation.target.productId)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "target", "productId"],
          message: "A product can only appear once in the quarantine plan.",
        });
      }
      productIds.add(operation.target.productId);
    });
  });

const sealedQuarantinePlanSchema = z
  .object({
    payload: quarantinePlanPayloadSchema,
    digestSha256: z.string().regex(SHA256),
  })
  .strict();

export type LaraPriorityQuarantinePlanPayload = z.output<
  typeof quarantinePlanPayloadSchema
>;
export type SealedLaraPriorityQuarantinePlan = DeepReadonly<
  z.output<typeof sealedQuarantinePlanSchema>
>;
type QuarantineOperation = z.output<typeof quarantineOperationSchema>;

type QuarantineJournalEntry = {
  sequence: number;
  occurredAt: string;
  event:
    | "run.claimed"
    | "run.preflight_verified"
    | "operation.prepared"
    | "operation.applied"
    | "operation.reconcile_started"
    | "operation.reconciled"
    | "run.admin_verified"
    | "run.failed";
  operationId: string | null;
  targetHandle: string | null;
  details: Record<string, string | number | boolean | null>;
};

type QuarantineCheckpoint = {
  schemaVersion: typeof LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION;
  phase: "applying" | "ready_to_complete" | "failed" | "verified";
  planDigestSha256: string;
  sealedPlan: z.output<typeof sealedQuarantinePlanSchema>;
  approvedRepairPlan: {
    planId: typeof LARA_PRIORITY_QUARANTINE_PLAN_ID;
    digestSha256: string;
    operations: Array<{
      operationId: string;
      productId: string;
      handle: (typeof LARA_PRIORITY_PRODUCT_HANDLES)[number];
      beforeStateSha256: string;
      fromStatus: "ACTIVE";
      toStatus: "DRAFT";
      restoreStatus: "ACTIVE";
      protectedVendor: typeof LARA_PRIORITY_QUARANTINE_VENDOR;
    }>;
  };
  nextOperationIndex: number;
  journal: QuarantineJournalEntry[];
};

const approvedOperationSchema = z
  .object({
    operationId: z.string().regex(/^quarantine-[0-9]{2}$/),
    productId: z.string().regex(PRODUCT_GID),
    handle: z.enum(LARA_PRIORITY_PRODUCT_HANDLES),
    beforeStateSha256: z.string().regex(SHA256),
    fromStatus: z.literal("ACTIVE"),
    toStatus: z.literal("DRAFT"),
    restoreStatus: z.literal("ACTIVE"),
    protectedVendor: z.literal(LARA_PRIORITY_QUARANTINE_VENDOR),
  })
  .strict();

const approvedRepairPlanSchema = z
  .object({
    planId: z.literal(LARA_PRIORITY_QUARANTINE_PLAN_ID),
    digestSha256: z.string().regex(SHA256),
    operations: z
      .array(approvedOperationSchema)
      .length(LARA_PRIORITY_PRODUCT_HANDLES.length),
  })
  .strict();

const journalDetailValueSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const quarantineJournalEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    occurredAt: timestampSchema,
    event: z.enum([
      "run.claimed",
      "run.preflight_verified",
      "operation.prepared",
      "operation.applied",
      "operation.reconcile_started",
      "operation.reconciled",
      "run.admin_verified",
      "run.failed",
    ]),
    operationId: z.string().regex(/^quarantine-[0-9]{2}$/).nullable(),
    targetHandle: z.enum(LARA_PRIORITY_PRODUCT_HANDLES).nullable(),
    details: z.record(z.string().max(100), journalDetailValueSchema),
  })
  .strict();

const quarantineCheckpointSchema = z
  .object({
    schemaVersion: z.literal(LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION),
    phase: z.enum(["applying", "ready_to_complete", "failed", "verified"]),
    planDigestSha256: z.string().regex(SHA256),
    sealedPlan: sealedQuarantinePlanSchema,
    approvedRepairPlan: approvedRepairPlanSchema,
    nextOperationIndex: z
      .number()
      .int()
      .min(0)
      .max(LARA_PRIORITY_PRODUCT_HANDLES.length),
    journal: z.array(quarantineJournalEntrySchema).max(250),
  })
  .strict();

type OperationLifecycle =
  | "pending"
  | "prepared"
  | "ambiguous"
  | "applied"
  | "reconciled";

type ParsedCheckpoint = {
  checkpoint: QuarantineCheckpoint;
  lifecycle: OperationLifecycle[];
  preflightVerified: boolean;
  adminVerified: boolean;
};

export type LaraPriorityQuarantineResult = DeepReadonly<{
  runId: typeof LARA_PRIORITY_QUARANTINE_RUN_ID;
  state: "completed" | "failed" | "in_progress";
  planDigestSha256?: string;
  verifiedCount?: number;
  errorCode?: string;
}>;

export class LaraPriorityQuarantineError extends Error {
  constructor(
    public readonly code:
      | "invalid_plan"
      | "plan_digest_mismatch"
      | "invalid_checkpoint"
      | "run_evidence_mismatch"
      | "product_not_active"
      | "product_drift"
      | "product_not_verified",
    message: string,
  ) {
    super(message);
    this.name = "LaraPriorityQuarantineError";
  }
}

async function productStateSha256(product: LaraPriorityProductSnapshot) {
  return remediationSha256({
    id: product.id,
    handle: product.handle,
    title: product.title,
    status: product.status,
    updatedAt: product.updatedAt,
    vendor: product.vendor,
  });
}

async function sealPlan(payload: LaraPriorityQuarantinePlanPayload) {
  const parsed = quarantinePlanPayloadSchema.parse(payload);
  return freezeRemediationValue({
    payload: parsed,
    digestSha256: await remediationSha256(parsed),
  });
}

export async function verifyLaraPriorityQuarantinePlan(
  input: unknown,
): Promise<SealedLaraPriorityQuarantinePlan> {
  let plan: z.output<typeof sealedQuarantinePlanSchema>;
  try {
    plan = sealedQuarantinePlanSchema.parse(input);
  } catch {
    throw new LaraPriorityQuarantineError(
      "invalid_plan",
      "The Lara priority quarantine plan is invalid.",
    );
  }
  if ((await remediationSha256(plan.payload)) !== plan.digestSha256) {
    throw new LaraPriorityQuarantineError(
      "plan_digest_mismatch",
      "The Lara priority quarantine plan digest does not match.",
    );
  }
  return freezeRemediationValue(plan);
}

export async function buildLaraPriorityQuarantinePlan({
  now = () => new Date(),
  runtime: suppliedRuntime,
}: {
  now?: () => Date;
  runtime?: LaraPriorityQuarantineRuntime;
} = {}): Promise<SealedLaraPriorityQuarantinePlan> {
  const runtime = suppliedRuntime ?? (await createLaraPriorityQuarantineRuntime());
  const operations: QuarantineOperation[] = [];
  for (const [index, handle] of LARA_PRIORITY_PRODUCT_HANDLES.entries()) {
    const product = await runtime.readPriorityProduct(handle);
    if (product.handle !== handle || product.vendor !== LARA_PRIORITY_QUARANTINE_VENDOR) {
      throw new LaraPriorityQuarantineError(
        "product_drift",
        `The fixed quarantine target ${handle} no longer matches its protected identity.`,
      );
    }
    if (product.status !== "ACTIVE") {
      throw new LaraPriorityQuarantineError(
        "product_not_active",
        `The fixed quarantine target ${handle} is not ACTIVE.`,
      );
    }
    operations.push({
      operationId: `quarantine-${String(index + 1).padStart(2, "0")}`,
      kind: "product.quarantine_to_draft",
      target: { productId: product.id, handle },
      cas: {
        beforeStateSha256: await productStateSha256(product),
        expectedTitle: product.title,
        expectedStatus: "ACTIVE",
        expectedUpdatedAt: product.updatedAt,
        expectedVendor: LARA_PRIORITY_QUARANTINE_VENDOR,
      },
      change: { status: "DRAFT" },
      inverse: { status: "ACTIVE" },
    });
  }
  return sealPlan({
    schemaVersion: LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION,
    planId: LARA_PRIORITY_QUARANTINE_PLAN_ID,
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    shop: {
      domain: LARA_AUDIT_CONNECTION.shopDomain,
      shopId: LARA_AUDIT_CONNECTION.shopId,
    },
    createdAt: now().toISOString(),
    purpose: LARA_PRIORITY_QUARANTINE_PURPOSE,
    operations,
  });
}

function approvedRepairPlan(
  plan: SealedLaraPriorityQuarantinePlan,
): QuarantineCheckpoint["approvedRepairPlan"] {
  return {
    planId: plan.payload.planId,
    digestSha256: plan.digestSha256,
    operations: plan.payload.operations.map((operation) => ({
      operationId: operation.operationId,
      productId: operation.target.productId,
      handle: operation.target.handle,
      beforeStateSha256: operation.cas.beforeStateSha256,
      fromStatus: operation.cas.expectedStatus,
      toStatus: operation.change.status,
      restoreStatus: operation.inverse.status,
      protectedVendor: operation.cas.expectedVendor,
    })),
  };
}

function emptyCheckpoint(value: unknown): value is Record<string, never> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function checkpointError(message: string): never {
  throw new LaraPriorityQuarantineError("invalid_checkpoint", message);
}

function validateCheckpointJournal(
  checkpointValue: QuarantineCheckpoint,
  plan: SealedLaraPriorityQuarantinePlan,
): Omit<ParsedCheckpoint, "checkpoint"> {
  const lifecycle: OperationLifecycle[] = plan.payload.operations.map(() => "pending");
  let preflightVerified = false;
  let adminVerified = false;

  for (const [journalIndex, entry] of checkpointValue.journal.entries()) {
    if (entry.sequence !== journalIndex + 1) {
      checkpointError("The quarantine checkpoint journal sequence is invalid.");
    }
    const isOperationEvent = entry.event.startsWith("operation.");
    if (!isOperationEvent) {
      if (entry.operationId !== null || entry.targetHandle !== null) {
        checkpointError("A run-level checkpoint event names a product operation.");
      }
      if (entry.event === "run.preflight_verified") {
        if (preflightVerified || lifecycle.some((state) => state !== "pending")) {
          checkpointError("The quarantine preflight checkpoint is out of order.");
        }
        preflightVerified = true;
      } else if (entry.event === "run.admin_verified") {
        if (lifecycle.some((state) => state !== "applied" && state !== "reconciled")) {
          checkpointError("The quarantine Admin verification precedes an operation.");
        }
        adminVerified = true;
      }
      continue;
    }

    const operationIndex = plan.payload.operations.findIndex(
      (operation) => operation.operationId === entry.operationId,
    );
    if (operationIndex < 0) {
      checkpointError("The quarantine checkpoint names an unknown operation.");
    }
    const operation = plan.payload.operations[operationIndex]!;
    if (entry.targetHandle !== operation.target.handle || !preflightVerified) {
      checkpointError("The quarantine operation checkpoint is not bound to its plan target.");
    }
    if (
      lifecycle.slice(0, operationIndex).some(
        (state) => state !== "applied" && state !== "reconciled",
      ) ||
      lifecycle.slice(operationIndex + 1).some((state) => state !== "pending")
    ) {
      checkpointError("The quarantine operation checkpoint is not contiguous.");
    }

    switch (entry.event) {
      case "operation.prepared":
        if (lifecycle[operationIndex] !== "pending") {
          checkpointError("The quarantine operation was prepared more than once.");
        }
        lifecycle[operationIndex] = "prepared";
        break;
      case "operation.reconcile_started":
        if (lifecycle[operationIndex] !== "prepared") {
          checkpointError("Quarantine reconciliation lacks a durable prepared event.");
        }
        lifecycle[operationIndex] = "ambiguous";
        break;
      case "operation.applied":
        if (lifecycle[operationIndex] !== "prepared") {
          checkpointError("A confirmed quarantine write lacks its prepared event.");
        }
        lifecycle[operationIndex] = "applied";
        break;
      case "operation.reconciled":
        if (
          lifecycle[operationIndex] !== "prepared" &&
          lifecycle[operationIndex] !== "ambiguous"
        ) {
          checkpointError("A reconciled quarantine write lacks ambiguous evidence.");
        }
        lifecycle[operationIndex] = "reconciled";
        break;
    }
  }

  const derivedNextIndex = lifecycle.findIndex(
    (state) => state !== "applied" && state !== "reconciled",
  );
  const nextOperationIndex =
    derivedNextIndex < 0 ? plan.payload.operations.length : derivedNextIndex;
  if (checkpointValue.nextOperationIndex !== nextOperationIndex) {
    checkpointError("The quarantine checkpoint cursor does not match its journal.");
  }
  if (checkpointValue.phase === "applying" && adminVerified) {
    checkpointError("An applying quarantine checkpoint cannot already be Admin-verified.");
  }
  if (
    (checkpointValue.phase === "ready_to_complete" ||
      checkpointValue.phase === "verified") &&
    (!adminVerified || nextOperationIndex !== plan.payload.operations.length)
  ) {
    checkpointError("The quarantine completion checkpoint is incomplete.");
  }

  return { lifecycle, preflightVerified, adminVerified };
}

async function parseClaimedCheckpoint(
  value: unknown,
  plan: SealedLaraPriorityQuarantinePlan,
): Promise<ParsedCheckpoint | null> {
  if (emptyCheckpoint(value)) return null;

  let checkpointValue: QuarantineCheckpoint;
  try {
    checkpointValue = quarantineCheckpointSchema.parse(value) as QuarantineCheckpoint;
  } catch {
    checkpointError("The persisted quarantine checkpoint is invalid.");
  }
  if (
    checkpointValue.planDigestSha256 !== plan.digestSha256 ||
    checkpointValue.sealedPlan.digestSha256 !== plan.digestSha256 ||
    (await remediationSha256(checkpointValue.sealedPlan)) !==
      (await remediationSha256(plan)) ||
    checkpointValue.approvedRepairPlan.digestSha256 !== plan.digestSha256 ||
    (await remediationSha256(checkpointValue.approvedRepairPlan)) !==
      (await remediationSha256(approvedRepairPlan(plan)))
  ) {
    checkpointError("The persisted quarantine checkpoint does not match the sealed plan.");
  }
  const journalState = validateCheckpointJournal(checkpointValue, plan);
  return { checkpoint: checkpointValue, ...journalState };
}

function protectedFieldsMatch(
  current: LaraPriorityProductSnapshot,
  operation: QuarantineOperation,
) {
  return (
    current.id === operation.target.productId &&
    current.handle === operation.target.handle &&
    current.title === operation.cas.expectedTitle &&
    current.vendor === operation.cas.expectedVendor
  );
}

async function classifyCurrentState(
  current: LaraPriorityProductSnapshot,
  operation: QuarantineOperation,
  allowDraftAfterAttempt = false,
): Promise<"active_exact" | "draft_reconciled"> {
  if (!protectedFieldsMatch(current, operation)) {
    throw new LaraPriorityQuarantineError(
      "product_drift",
      `Protected identity drifted for ${operation.target.handle}.`,
    );
  }
  if (allowDraftAfterAttempt && current.status === "DRAFT") return "draft_reconciled";
  if (
    current.status !== operation.cas.expectedStatus ||
    current.updatedAt !== operation.cas.expectedUpdatedAt ||
    (await productStateSha256(current)) !== operation.cas.beforeStateSha256
  ) {
    throw new LaraPriorityQuarantineError(
      "product_drift",
      `The compare-and-swap state drifted for ${operation.target.handle}.`,
    );
  }
  return "active_exact";
}

function classifiedFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof LaraPriorityQuarantineError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof LaraPriorityQuarantineRuntimeError) {
    return {
      code: error.code,
      retryable: error.code === "mutation_ambiguous" || error.retryable,
    };
  }
  if (error instanceof AuditShopifyRunError) {
    return {
      code: error.code,
      retryable:
        error.code === "claim_failed" ||
        error.code === "complete_failed" ||
        error.code === "fail_failed" ||
        error.code === "server_not_configured",
    };
  }
  return { code: "quarantine_failed", retryable: false };
}

function immutableRunEvidenceMatches(
  run: NonNullable<Awaited<ReturnType<typeof getAuditShopifyRun>>>,
  input: {
    requestedBy: string;
    schemaHash: string;
    planDigestSha256: string;
  },
) {
  return (
    run.id === LARA_PRIORITY_QUARANTINE_RUN_ID &&
    run.connection_id === LARA_AUDIT_CONNECTION.connectionId &&
    run.requested_by === input.requestedBy &&
    run.requested_actor_type === "system" &&
    run.shopify_domain === LARA_AUDIT_CONNECTION.shopDomain &&
    run.requested_source === QUARANTINE_SOURCE &&
    run.requested_note === QUARANTINE_NOTE &&
    run.schema_hash === input.schemaHash &&
    run.manifest_hash === input.planDigestSha256 &&
    run.max_retries === LARA_PRIORITY_QUARANTINE_MAX_RETRIES
  );
}

function resultFromExisting(
  existing: Awaited<ReturnType<typeof getAuditShopifyRun>>,
  evidence: {
    requestedBy: string;
    schemaHash: string;
    planDigestSha256: string;
  },
): LaraPriorityQuarantineResult {
  if (existing && !immutableRunEvidenceMatches(existing, evidence)) {
    return freezeRemediationValue({
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      state: "failed" as const,
      errorCode: "run_evidence_mismatch",
    });
  }
  if (existing?.state === "completed") {
    const artifact = existing.artifact as Record<string, unknown> | null;
    if (
      artifact?.schemaVersion !== LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION ||
      artifact.status !== "verified" ||
      artifact.runId !== LARA_PRIORITY_QUARANTINE_RUN_ID ||
      artifact.planId !== LARA_PRIORITY_QUARANTINE_PLAN_ID ||
      artifact.planDigestSha256 !== evidence.planDigestSha256 ||
      artifact.verifiedCount !== LARA_PRIORITY_PRODUCT_HANDLES.length ||
      artifact.protectedVendor !== LARA_PRIORITY_QUARANTINE_VENDOR
    ) {
      return freezeRemediationValue({
        runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
        state: "failed" as const,
        errorCode: "invalid_checkpoint",
      });
    }
    return freezeRemediationValue({
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      state: "completed" as const,
      planDigestSha256: evidence.planDigestSha256,
      verifiedCount: LARA_PRIORITY_PRODUCT_HANDLES.length,
    });
  }
  if (existing?.state === "failed") {
    return freezeRemediationValue({
      runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
      state: "failed" as const,
      errorCode: existing.error_code ?? "quarantine_failed",
    });
  }
  return freezeRemediationValue({
    runId: LARA_PRIORITY_QUARANTINE_RUN_ID,
    state: "in_progress" as const,
  });
}

async function quarantineSchemaSha256() {
  return remediationSha256({
    schemaVersion: LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION,
    graphqlManifest: LARA_PRIORITY_QUARANTINE_GRAPHQL_MANIFEST,
  });
}

/**
 * Resolve the exact plan for a recurring one-shot trigger.
 *
 * Once any operation can have been attempted, the complete sealed plan lives
 * in the durable checkpoint. A later tick must call this resolver instead of
 * rebuilding from Shopify, because a legitimate DRAFT prefix no longer meets
 * the original all-ACTIVE plan builder precondition.
 */
export async function resolveLaraPriorityQuarantinePlan({
  requestedBy,
  runId,
  runtime,
  now,
}: {
  requestedBy: string;
  runId: typeof LARA_PRIORITY_QUARANTINE_RUN_ID;
  runtime?: LaraPriorityQuarantineRuntime;
  now?: () => Date;
}): Promise<SealedLaraPriorityQuarantinePlan> {
  if (runId !== LARA_PRIORITY_QUARANTINE_RUN_ID) {
    throw new LaraPriorityQuarantineError("invalid_plan", "The one-shot run ID is invalid.");
  }
  const existing = await getAuditShopifyRun({
    runId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
  });
  if (!existing || emptyCheckpoint(existing.checkpoint)) {
    // An empty checkpoint is safe to rebuild: execute never calls Shopify's
    // mutation until operation.prepared (which includes the full sealed plan)
    // has been durably renewed.
    return buildLaraPriorityQuarantinePlan({ runtime, now });
  }

  let candidate: unknown;
  try {
    candidate = quarantineCheckpointSchema.parse(existing.checkpoint).sealedPlan;
  } catch {
    throw new LaraPriorityQuarantineError(
      "invalid_checkpoint",
      "The stored quarantine plan cannot be recovered from its checkpoint.",
    );
  }
  const plan = await verifyLaraPriorityQuarantinePlan(candidate);
  const evidence = {
    requestedBy,
    schemaHash: await quarantineSchemaSha256(),
    planDigestSha256: plan.digestSha256,
  };
  if (!immutableRunEvidenceMatches(existing, evidence)) {
    throw new LaraPriorityQuarantineError(
      "run_evidence_mismatch",
      "The stored quarantine plan does not match the immutable run evidence.",
    );
  }
  await parseClaimedCheckpoint(existing.checkpoint, plan);
  return plan;
}

/** Execute the sealed one-shot plan with a fenced, durable per-operation journal. */
export async function executeLaraPriorityQuarantine({
  sealedPlan: planInput,
  requestedBy,
  runId,
  leaseToken = crypto.randomUUID(),
  runtime: suppliedRuntime,
  now = () => new Date(),
}: {
  sealedPlan: unknown;
  requestedBy: string;
  runId: typeof LARA_PRIORITY_QUARANTINE_RUN_ID;
  leaseToken?: string;
  runtime?: LaraPriorityQuarantineRuntime;
  now?: () => Date;
}): Promise<LaraPriorityQuarantineResult> {
  if (runId !== LARA_PRIORITY_QUARANTINE_RUN_ID) {
    throw new LaraPriorityQuarantineError("invalid_plan", "The one-shot run ID is invalid.");
  }
  const plan = await verifyLaraPriorityQuarantinePlan(planInput);
  const schemaHash = await quarantineSchemaSha256();
  const evidence = {
    requestedBy,
    schemaHash,
    planDigestSha256: plan.digestSha256,
  };
  const effectiveRunId = await enqueueAuditShopifyRun({
    runId,
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    requestedBy,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    source: QUARANTINE_SOURCE,
    note: QUARANTINE_NOTE,
    schemaHash,
    manifestHash: plan.digestSha256,
    maxRetries: LARA_PRIORITY_QUARANTINE_MAX_RETRIES,
    actorType: "system",
  });
  if (effectiveRunId !== runId) {
    throw new LaraPriorityQuarantineError(
      "run_evidence_mismatch",
      "The one-shot quarantine enqueue resolved to a different run.",
    );
  }

  let claimed: Awaited<ReturnType<typeof claimAuditShopifyRun>>;
  try {
    claimed = await claimAuditShopifyRun({
      runId,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      leaseToken,
      leaseSeconds: 300,
    });
  } catch (error) {
    if (error instanceof AuditShopifyRunError && error.code === "run_not_found") {
      return resultFromExisting(
        await getAuditShopifyRun({
          runId,
          shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
        }),
        evidence,
      );
    }
    throw error;
  }

  let journal: QuarantineJournalEntry[] = [];
  let lifecycle: OperationLifecycle[] = plan.payload.operations.map(() => "pending");
  let preflightVerified = false;
  let adminVerified = false;
  let nextOperationIndex = 0;
  let phase: QuarantineCheckpoint["phase"] = "applying";
  const append = (
    event: QuarantineJournalEntry["event"],
    operation: QuarantineOperation | null,
    details: QuarantineJournalEntry["details"] = {},
  ) => {
    journal.push({
      sequence: journal.length + 1,
      occurredAt: now().toISOString(),
      event,
      operationId: operation?.operationId ?? null,
      targetHandle: operation?.target.handle ?? null,
      details,
    });
  };
  const checkpoint = (phase: QuarantineCheckpoint["phase"]): QuarantineCheckpoint => ({
    schemaVersion: LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION,
    phase,
    planDigestSha256: plan.digestSha256,
    sealedPlan: structuredClone(plan) as z.output<typeof sealedQuarantinePlanSchema>,
    approvedRepairPlan: approvedRepairPlan(plan),
    nextOperationIndex,
    journal: structuredClone(journal),
  });
  const persist = async (checkpointPhase: QuarantineCheckpoint["phase"]) => {
    claimed = await renewAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: checkpoint(checkpointPhase),
      leaseSeconds: 300,
    });
  };

  try {
    if (
      claimed.state !== "running" ||
      claimed.lease_token !== leaseToken ||
      !immutableRunEvidenceMatches(claimed, evidence)
    ) {
      throw new LaraPriorityQuarantineError(
        "run_evidence_mismatch",
        "The claimed quarantine run does not match its immutable evidence.",
      );
    }
    const resumed = await parseClaimedCheckpoint(claimed.checkpoint, plan);
    if (resumed) {
      if (resumed.checkpoint.phase === "failed" || resumed.checkpoint.phase === "verified") {
        throw new LaraPriorityQuarantineError(
          "invalid_checkpoint",
          "A terminal quarantine checkpoint cannot be resumed.",
        );
      }
      journal = structuredClone(resumed.checkpoint.journal);
      lifecycle = [...resumed.lifecycle];
      preflightVerified = resumed.preflightVerified;
      adminVerified = resumed.adminVerified;
      nextOperationIndex = resumed.checkpoint.nextOperationIndex;
      phase = resumed.checkpoint.phase;
    }
    append("run.claimed", null, {
      operationCount: plan.payload.operations.length,
      attemptCount: claimed.attempt_count,
      resumed: resumed !== null,
    });

    const runtime = suppliedRuntime ?? (await createLaraPriorityQuarantineRuntime());

    if (!preflightVerified) {
      // Before the first durable prepared event, all ten targets must still be
      // the exact ACTIVE states sealed into the plan. This makes an empty
      // checkpoint safe after a crashed lease: no mutation can have been
      // attempted without first persisting operation.prepared.
      for (const operation of plan.payload.operations) {
        const current = await runtime.readPriorityProduct(operation.target.handle);
        await classifyCurrentState(current, operation as QuarantineOperation);
      }
      preflightVerified = true;
      append("run.preflight_verified", null, {
        operationCount: plan.payload.operations.length,
      });
      phase = "applying";
      await persist(phase);
    } else {
      // Recovery proves all ten live states before any new mutation. Only the
      // durable contiguous prefix may be DRAFT. The one prepared/ambiguous
      // operation may be exact ACTIVE or protected DRAFT; all later targets
      // must still be their exact sealed ACTIVE states.
      for (const [index, readonlyOperation] of plan.payload.operations.entries()) {
        const operation = readonlyOperation as QuarantineOperation;
        const current = await runtime.readPriorityProduct(operation.target.handle);
        const operationState = lifecycle[index]!;
        if (operationState === "applied" || operationState === "reconciled") {
          if ((await classifyCurrentState(current, operation, true)) !== "draft_reconciled") {
            throw new LaraPriorityQuarantineError(
              "product_drift",
              `The durable quarantine prefix is no longer DRAFT for ${operation.target.handle}.`,
            );
          }
        } else if (operationState === "prepared" || operationState === "ambiguous") {
          await classifyCurrentState(current, operation, true);
        } else {
          await classifyCurrentState(current, operation);
        }
      }
    }

    for (let index = nextOperationIndex; index < plan.payload.operations.length; index += 1) {
      const readonlyOperation = plan.payload.operations[index]!;
      const operation = readonlyOperation as QuarantineOperation;
      nextOperationIndex = index;
      let current = await runtime.readPriorityProduct(operation.target.handle);
      let currentState = await classifyCurrentState(
        current,
        operation,
        lifecycle[index] === "prepared" || lifecycle[index] === "ambiguous",
      );

      if (lifecycle[index] === "pending") {
        if (currentState !== "active_exact") {
          throw new LaraPriorityQuarantineError(
            "product_drift",
            `An unprepared quarantine target is already DRAFT: ${operation.target.handle}.`,
          );
        }
        append("operation.prepared", operation, {
          beforeStateSha256: operation.cas.beforeStateSha256,
          fromStatus: "ACTIVE",
          toStatus: "DRAFT",
        });
        lifecycle[index] = "prepared";
        phase = "applying";
        await persist(phase);
      }

      if (currentState === "draft_reconciled") {
        if (lifecycle[index] === "prepared") {
          append("operation.reconcile_started", operation, {
            mutationOutcome: "checkpointed_prepared_commit_ambiguous",
          });
          lifecycle[index] = "ambiguous";
          await persist("applying");
        }
        append("operation.reconciled", operation, {
          status: "DRAFT",
          protectedVendorPreserved: true,
        });
        lifecycle[index] = "reconciled";
        nextOperationIndex = index + 1;
        await persist("applying");
        continue;
      }

      // productUpdate has no CAS primitive. The sealed-state comparison has an
      // unavoidable read/write window, so read the exact ACTIVE state again
      // after the durable prepared checkpoint, then validate both the mutation
      // response and a fresh Shopify Admin readback.
      current = await runtime.readPriorityProduct(operation.target.handle);
      await classifyCurrentState(current, operation);

      let mutationResult: LaraPriorityProductSnapshot;
      try {
        mutationResult = await runtime.quarantineProductToDraft(operation.target.productId);
      } catch (error) {
        if (
          !(error instanceof LaraPriorityQuarantineRuntimeError) ||
          error.code !== "mutation_ambiguous"
        ) {
          // mutation_rejected is definitive: it is never reconciled via an
          // unrelated live DRAFT state and never retried by this attempt.
          throw error;
        }
        if (lifecycle[index] === "prepared") {
          append("operation.reconcile_started", operation, {
            mutationOutcome: "ambiguous",
          });
          lifecycle[index] = "ambiguous";
        }
        await persist("applying");
        current = await runtime.readPriorityProduct(operation.target.handle);
        currentState = await classifyCurrentState(current, operation, true);
        if (currentState === "active_exact") {
          // Nothing was applied according to the readback. Preserve the exact
          // ambiguous checkpoint and let the bounded queue retry safely.
          throw error;
        }
        append("operation.reconciled", operation, {
          status: "DRAFT",
          protectedVendorPreserved: true,
        });
        lifecycle[index] = "reconciled";
        nextOperationIndex = index + 1;
        await persist("applying");
        continue;
      }

      if (
        (await classifyCurrentState(mutationResult, operation, true)) !== "draft_reconciled"
      ) {
        throw new LaraPriorityQuarantineError(
          "product_not_verified",
          `Shopify did not return a verified DRAFT for ${operation.target.handle}.`,
        );
      }
      current = await runtime.readPriorityProduct(operation.target.handle);
      currentState = await classifyCurrentState(current, operation, true);
      if (currentState !== "draft_reconciled") {
        throw new LaraPriorityQuarantineError(
          "product_not_verified",
          `The quarantine write was not verified for ${operation.target.handle}.`,
        );
      }
      const appliedEvent =
        lifecycle[index] === "ambiguous" ? "operation.reconciled" : "operation.applied";
      append(appliedEvent, operation, {
        status: "DRAFT",
        protectedVendorPreserved: true,
      });
      lifecycle[index] = appliedEvent === "operation.applied" ? "applied" : "reconciled";
      nextOperationIndex = index + 1;
      await persist("applying");
    }

    let verifiedCount = 0;
    for (const readonlyOperation of plan.payload.operations) {
      const operation = readonlyOperation as QuarantineOperation;
      const current = await runtime.readPriorityProduct(operation.target.handle);
      if (
        current.status !== "DRAFT" ||
        !protectedFieldsMatch(current, operation) ||
        current.vendor !== LARA_PRIORITY_QUARANTINE_VENDOR
      ) {
        throw new LaraPriorityQuarantineError(
          "product_not_verified",
          `Final Admin verification failed for ${operation.target.handle}.`,
        );
      }
      verifiedCount += 1;
    }
    append("run.admin_verified", null, { verifiedCount });
    adminVerified = true;
    nextOperationIndex = plan.payload.operations.length;
    phase = "ready_to_complete";
    await persist(phase);
    const finalCheckpoint = checkpoint("verified");
    const artifact = {
      schemaVersion: LARA_PRIORITY_QUARANTINE_SCHEMA_VERSION,
      status: "verified",
      runId,
      planId: plan.payload.planId,
      planDigestSha256: plan.digestSha256,
      verifiedCount,
      protectedVendor: LARA_PRIORITY_QUARANTINE_VENDOR,
      mutationFields: ["id", "status"],
      recordedRestoreEvidence: plan.payload.operations.map((operation) => ({
        operationId: operation.operationId,
        productId: operation.target.productId,
        handle: operation.target.handle,
        restoreStatus: operation.inverse.status,
      })),
      journal: finalCheckpoint.journal,
      completedAt: now().toISOString(),
      restoreEvidenceNote:
        "Recorded rollback evidence only; no automatic inverse executor is exposed.",
    };
    await completeAuditShopifyRun({
      run: claimed,
      leaseToken,
      checkpoint: finalCheckpoint,
      artifact,
    });
    return freezeRemediationValue({
      runId,
      state: "completed" as const,
      planDigestSha256: plan.digestSha256,
      verifiedCount,
    });
  } catch (error) {
    const failure = classifiedFailure(error);
    append("run.failed", null, {
      errorCode: failure.code,
      retryable: failure.retryable,
    });
    const retryBudgetAvailable =
      failure.retryable && claimed.retry_count < claimed.max_retries;
    const failurePhase: QuarantineCheckpoint["phase"] = retryBudgetAvailable
      ? adminVerified
        ? "ready_to_complete"
        : "applying"
      : "failed";
    const failedCheckpoint = checkpoint(failurePhase);
    try {
      const failed = await failAuditShopifyRun({
        run: claimed,
        leaseToken,
        errorCode: failure.code,
        retryable: failure.retryable,
        checkpoint: failedCheckpoint,
      });
      if (failed.state === "queued" || failed.state === "running") {
        return freezeRemediationValue({ runId, state: "in_progress" as const });
      }
      if (failed.state === "completed") {
        return resultFromExisting(failed, evidence);
      }
      if (failed.state === "failed") {
        return freezeRemediationValue({
          runId,
          state: "failed" as const,
          errorCode: failed.error_code ?? failure.code,
        });
      }
    } catch {
      // The fenced database state remains authoritative if failure recording
      // races with a lease expiry or a response is lost.
      try {
        const existing = await getAuditShopifyRun({
          runId,
          shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
        });
        if (existing) return resultFromExisting(existing, evidence);
      } catch {
        // If both the transition and reconciliation response are unavailable,
        // the durable lease/checkpoint remains authoritative.
      }
    }
    if (failure.retryable) {
      return freezeRemediationValue({ runId, state: "in_progress" as const });
    }
    return freezeRemediationValue({
      runId,
      state: "failed" as const,
      errorCode: failure.code,
    });
  }
}
