import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import type { AuditShopifyRun } from "@/lib/supabase/types";
import {
  createLaraPricingArtifactStore,
  LaraPricingArtifactStoreError,
  preflightLaraPricingArtifactStore,
} from "./lara-pricing-artifact-store";
import {
  LARA_PRICING_LIVE_GRAPHQL_MANIFEST,
  LaraPricingLiveRuntimeError,
  createLaraPricingLiveRuntime,
  type LaraPricingBulkStatus,
  type LaraPricingDownloadedCatalogue,
  type LaraPricingLiveRuntime,
} from "./lara-pricing-live-runtime";
import {
  LARA_PRICING_BLAST_RADIUS,
  LARA_PRICING_LEGAL_BASIS,
  LARA_PRICING_SALE_PLAN_ID,
  LARA_PRICING_SALE_SCHEMA_VERSION,
  LARA_PRICING_VENDOR_POLICY,
  LaraPricingSalePlanError,
  loadLaraPricingPersistedRoot,
  loadLaraPricingProductArtifact,
  prepareLaraPricingSalePlan,
  type LaraPricingCatalogueSnapshot,
  type LaraPricingImmutableArtifactRef,
  type LaraPricingImmutableArtifactStore,
  type LaraPricingPersistedPlanRoot,
  type LaraPricingPreparedPlan,
  type LaraPricingProductArtifact,
} from "./lara-pricing-sale-plan";
import {
  LARA_PRICING_EXECUTION_SCHEMA_VERSION,
  LaraPricingExecutionError,
  LaraPricingMutationDefinitiveError,
  completeLaraPricingSaleVerification,
  executeLaraPricingSaleSlice,
  initialLaraPricingExecutionCheckpoint,
  laraPricingExecutionSchemaSha256,
  validateLaraPricingExecutionCheckpoint,
  type LaraPricingDurableCoordinator,
  type LaraPricingExecutionCheckpoint,
  type LaraPricingFinalVerification,
} from "./lara-pricing-sale-executor";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import {
  claimAuditShopifyRun,
  completeAuditShopifyRun,
  enqueueAuditShopifyRun,
  failAuditShopifyRun,
  getAuditShopifyRun,
  renewAuditShopifyRun,
} from "./shopify-runs";
import {
  LARA_ROVINJ_REMEDIATION_SHOP,
  canonicalRemediationJson,
  freezeRemediationValue,
  remediationSha256,
  type DeepReadonly,
} from "./shopify-remediation-plan";

export const LARA_PRICING_LIVE_REPAIR_SCHEMA_VERSION =
  "lara-pricing-sale-live-repair.v1" as const;
export const LARA_PRICING_LIVE_REPAIR_RUN_ID =
  "3c24f5b0-83ec-4df3-b534-d0d983a483f8" as const;

const RUN_SOURCE = "system.lara_pricing_sale_repair" as const;
const RUN_NOTE =
  "Pinned Lara repair: remove unsupported compare-at prices only; preserve selling prices, status, publication and vendor/brand." as const;
const MAX_RETRIES = 5;
const LEASE_SECONDS = 300;
const PREPARATION_PARTITIONS_PER_SLICE = 20;
const VERIFICATION_PARTITIONS_PER_SLICE = 40;
const START_RECOVERY_GRACE_MS = 60_000;
// Covers the worst fixed blast radius: two 480-poll Bulk windows, 100
// preparation slices, up to one ambiguous-response reconciliation slice for
// each of 2,000 products plus the normal mutation slices, 50 verification
// slices and a bounded margin for start/terminal reconciliation. This does not
// increase the 2,000-product/50,000-variant write ceiling or the two-attempt
// per-product ceiling.
const MAX_TOTAL_SLICES = 3_500;
// The counter also covers every integrity re-download used to persist/verify
// bounded partitions after completion, not only status polling.
const MAX_BULK_POLLS = 600;
const MAX_BULK_PENDING_ELAPSED_MS = 4 * 60 * 60 * 1_000;
// Shopify's completed Bulk result URL expires after seven days. Use a much
// shorter sealed replay window while still leaving room for 100 preparation
// and 50 verification slices after a slow query.
const MAX_BULK_REPLAY_ELAPSED_MS = 24 * 60 * 60 * 1_000;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LivePhase =
  | "source_start_pending"
  | "source_starting"
  | "source_polling"
  | "preparing"
  | "applying"
  | "verification_start_pending"
  | "verification_starting"
  | "verification_polling"
  | "verifying"
  | "verified"
  | "blocked";

type BulkCheckpoint = DeepReadonly<{
  requestedAt: string | null;
  operationId: string | null;
  completedAt: string | null;
  capturedAt: string | null;
  jsonlSha256: string | null;
  byteLength: number | null;
  catalogueDigestSha256: string | null;
  products: number | null;
  variants: number | null;
  variantsWithCompareAt: number | null;
  pollCount: number;
}>;

type LastEvent = DeepReadonly<{
  sequence: number;
  occurredAt: string;
  event: string;
  detailCode: string | null;
}>;

export type LaraPricingLiveCheckpoint = DeepReadonly<{
  schemaVersion: typeof LARA_PRICING_LIVE_REPAIR_SCHEMA_VERSION;
  runId: typeof LARA_PRICING_LIVE_REPAIR_RUN_ID;
  revision: number;
  sliceCount: number;
  phase: LivePhase;
  schemaHash: string;
  manifestHash: string;
  source: BulkCheckpoint;
  planCreatedAt: string | null;
  preparedPlanDigestSha256: string | null;
  nextPreparationOrdinal: number;
  rootRef: LaraPricingImmutableArtifactRef | null;
  rootDigestSha256: string | null;
  execution: LaraPricingExecutionCheckpoint | null;
  verification: BulkCheckpoint & {
    nextSourceOrdinal: number;
    missingSourceProducts: number;
    missingSourceVariants: number;
    sellingPriceDriftVariants: number;
    vendorDriftProducts: number;
    statusDriftProducts: number;
    publicationDriftProducts: number;
  };
  journalSequence: number;
  journalDigestSha256: string;
  lastEvent: LastEvent | null;
  blockedCode: string | null;
}>;

export type LaraPricingLiveRepairResult = DeepReadonly<{
  state: "in_progress" | "completed" | "failed";
  runId: typeof LARA_PRICING_LIVE_REPAIR_RUN_ID;
  phase: LivePhase;
  products: number | null;
  variants: number | null;
  targetVariants: number | null;
  processedProducts: number;
  errorCode: string | null;
}>;

export class LaraPricingLiveRepairError extends Error {
  constructor(
    public readonly code:
      | "invalid_run"
      | "invalid_checkpoint"
      | "run_metadata_mismatch"
      | "run_unavailable"
      | "durable_transition_failed"
      | "bulk_start_collision"
      | "source_integrity_mismatch"
      | "plan_integrity_mismatch"
      | "verification_failed"
      | "terminal_artifact_invalid"
      | "terminal_commit_ambiguous"
      | "terminal_failure_commit_ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "LaraPricingLiveRepairError";
  }
}

function emptyBulk(): BulkCheckpoint {
  return {
    requestedAt: null,
    operationId: null,
    completedAt: null,
    capturedAt: null,
    jsonlSha256: null,
    byteLength: null,
    catalogueDigestSha256: null,
    products: null,
    variants: null,
    variantsWithCompareAt: null,
    pollCount: 0,
  };
}

async function initialCheckpoint(
  schemaHash: string,
  manifestHash: string,
): Promise<LaraPricingLiveCheckpoint> {
  const initialJournal = await remediationSha256({
    schemaVersion: LARA_PRICING_LIVE_REPAIR_SCHEMA_VERSION,
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    journal: "empty",
  });
  return freezeRemediationValue({
    schemaVersion: LARA_PRICING_LIVE_REPAIR_SCHEMA_VERSION,
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    revision: 0,
    sliceCount: 0,
    phase: "source_start_pending" as const,
    schemaHash,
    manifestHash,
    source: emptyBulk(),
    planCreatedAt: null,
    preparedPlanDigestSha256: null,
    nextPreparationOrdinal: 0,
    rootRef: null,
    rootDigestSha256: null,
    execution: null,
    verification: {
      ...emptyBulk(),
      nextSourceOrdinal: 0,
      missingSourceProducts: 0,
      missingSourceVariants: 0,
      sellingPriceDriftVariants: 0,
      vendorDriftProducts: 0,
      statusDriftProducts: 0,
      publicationDriftProducts: 0,
    },
    journalSequence: 0,
    journalDigestSha256: initialJournal,
    lastEvent: null,
    blockedCode: null,
  });
}

function checkpointBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalRemediationJson(left) === canonicalRemediationJson(right);
  } catch {
    return false;
  }
}

function hasExactObjectKeys(value: unknown, expected: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validBulkCheckpoint(
  value: BulkCheckpoint,
  verification = false,
): boolean {
  const keys = [
    "requestedAt",
    "operationId",
    "completedAt",
    "capturedAt",
    "jsonlSha256",
    "byteLength",
    "catalogueDigestSha256",
    "products",
    "variants",
    "variantsWithCompareAt",
    "pollCount",
    ...(verification
      ? [
          "nextSourceOrdinal",
          "missingSourceProducts",
          "missingSourceVariants",
          "sellingPriceDriftVariants",
          "vendorDriftProducts",
          "statusDriftProducts",
          "publicationDriftProducts",
        ]
      : []),
  ];
  return (
    hasExactObjectKeys(value, keys) &&
    (value.requestedAt === null || Number.isFinite(Date.parse(value.requestedAt))) &&
    (value.operationId === null || /^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/.test(value.operationId)) &&
    (value.completedAt === null || Number.isFinite(Date.parse(value.completedAt))) &&
    (value.capturedAt === null || Number.isFinite(Date.parse(value.capturedAt))) &&
    (value.jsonlSha256 === null || SHA256.test(value.jsonlSha256)) &&
    (value.catalogueDigestSha256 === null || SHA256.test(value.catalogueDigestSha256)) &&
    (value.byteLength === null || (Number.isSafeInteger(value.byteLength) && value.byteLength > 0)) &&
    (value.products === null || (Number.isSafeInteger(value.products) && value.products > 0)) &&
    (value.variants === null || (Number.isSafeInteger(value.variants) && value.variants > 0)) &&
    (value.variantsWithCompareAt === null ||
      (Number.isSafeInteger(value.variantsWithCompareAt) && value.variantsWithCompareAt >= 0)) &&
    Number.isSafeInteger(value.pollCount) &&
    value.pollCount >= 0 &&
    value.pollCount <= MAX_BULK_POLLS
  );
}

function assertCheckpoint(
  value: unknown,
  expected: { schemaHash: string; manifestHash: string },
): asserts value is LaraPricingLiveCheckpoint {
  const item = value as LaraPricingLiveCheckpoint | null;
  const rootRefValid =
    item?.rootRef === null ||
    (item?.rootRef &&
      hasExactObjectKeys(item.rootRef, ["key", "digestSha256", "byteLength"]) &&
      item.rootRef.key ===
        `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${LARA_PRICING_LIVE_REPAIR_RUN_ID}/root.json` &&
      SHA256.test(item.rootRef.digestSha256) &&
      Number.isSafeInteger(item.rootRef.byteLength) &&
      item.rootRef.byteLength > 0 &&
      item.rootRef.byteLength <= LARA_PRICING_BLAST_RADIUS.maxRootArtifactBytes);
  const executionValid =
    item?.execution === null ||
    Boolean(
      item?.execution &&
        (() => {
          try {
            validateLaraPricingExecutionCheckpoint(item.execution);
            return (
              item.execution.schemaVersion ===
                LARA_PRICING_EXECUTION_SCHEMA_VERSION &&
              item.execution.runId === LARA_PRICING_LIVE_REPAIR_RUN_ID &&
              item.rootRef !== null &&
              sameCanonical(item.execution.rootRef, item.rootRef) &&
              item.execution.approvedPlanDigestSha256 === item.rootDigestSha256 &&
              item.execution.sourceCatalogueDigestSha256 ===
                item.source.catalogueDigestSha256 &&
              checkpointBytes(item.execution) < 8 * 1024
            );
          } catch {
            return false;
          }
        })(),
    );
  const planSealed = Boolean(
    item?.source.operationId && item.source.capturedAt &&
      item.source.jsonlSha256 && item.source.catalogueDigestSha256 &&
      item.source.products && item.source.variants &&
      item.planCreatedAt && item.preparedPlanDigestSha256,
  );
  const rootSealed = Boolean(
    item?.rootRef && item.rootDigestSha256 && item.execution && executionValid,
  );
  const needsPlan = Boolean(
    item && [
      "preparing", "applying", "verification_start_pending",
      "verification_starting", "verification_polling", "verifying",
      "verified", "blocked",
    ].includes(item.phase),
  );
  const needsRoot = Boolean(
    item && [
      "applying", "verification_start_pending", "verification_starting",
      "verification_polling", "verifying", "verified", "blocked",
    ].includes(item.phase),
  );
  const sourceSealed = Boolean(
    item?.source.requestedAt &&
      item.source.operationId &&
      item.source.completedAt &&
      item.source.capturedAt &&
      item.source.completedAt === item.source.capturedAt &&
      item.source.jsonlSha256 &&
      item.source.byteLength &&
      item.source.catalogueDigestSha256 &&
      item.source.products &&
      item.source.variants &&
      item.source.variantsWithCompareAt !== null,
  );
  const verificationSealed = Boolean(
    item?.verification.requestedAt &&
      item.verification.operationId &&
      item.verification.completedAt &&
      item.verification.capturedAt &&
      item.verification.completedAt === item.verification.capturedAt &&
      item.verification.jsonlSha256 &&
      item.verification.byteLength &&
      item.verification.catalogueDigestSha256 &&
      item.verification.products &&
      item.verification.variants &&
      item.verification.variantsWithCompareAt !== null,
  );
  const executionPhaseValid = Boolean(
    item &&
      (item.phase === "applying"
        ? item.execution &&
          [
            "ready",
            "applying",
            "reconciling",
            "verification_pending",
            "blocked",
          ].includes(item.execution.phase)
        : [
              "verification_start_pending",
              "verification_starting",
              "verification_polling",
            ].includes(item.phase)
          ? item.execution?.phase === "verification_pending"
          : item.phase === "verifying"
            ? item.execution &&
              ["verification_pending", "verified"].includes(
                item.execution.phase,
              )
            : item.phase === "verified"
              ? item.execution?.phase === "verified"
              : item.phase === "blocked"
                ? item.execution?.phase === "blocked"
                : item.execution === null),
  );
  const lastEventValid =
    item?.lastEvent === null
      ? item?.journalSequence === 0
      : Boolean(
          item?.lastEvent &&
            hasExactObjectKeys(item.lastEvent, [
              "sequence",
              "occurredAt",
              "event",
              "detailCode",
            ]) &&
            item.lastEvent.sequence === item.journalSequence &&
            item.lastEvent.sequence > 0 &&
            Number.isFinite(Date.parse(item.lastEvent.occurredAt)) &&
            /^[a-z0-9][a-z0-9._:-]{1,127}$/.test(item.lastEvent.event) &&
            (item.lastEvent.detailCode === null ||
              /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
                item.lastEvent.detailCode,
              )),
        );
  if (
    !item || typeof item !== "object" || Array.isArray(item) ||
    !hasExactObjectKeys(item, [
      "schemaVersion",
      "runId",
      "revision",
      "sliceCount",
      "phase",
      "schemaHash",
      "manifestHash",
      "source",
      "planCreatedAt",
      "preparedPlanDigestSha256",
      "nextPreparationOrdinal",
      "rootRef",
      "rootDigestSha256",
      "execution",
      "verification",
      "journalSequence",
      "journalDigestSha256",
      "lastEvent",
      "blockedCode",
    ]) ||
    item.schemaVersion !== LARA_PRICING_LIVE_REPAIR_SCHEMA_VERSION ||
    item.runId !== LARA_PRICING_LIVE_REPAIR_RUN_ID ||
    item.schemaHash !== expected.schemaHash || item.manifestHash !== expected.manifestHash ||
    !Number.isSafeInteger(item.revision) || item.revision < 0 ||
    !Number.isSafeInteger(item.sliceCount) || item.sliceCount < 0 ||
    item.sliceCount > MAX_TOTAL_SLICES ||
    ![
      "source_start_pending", "source_starting", "source_polling", "preparing",
      "applying", "verification_start_pending", "verification_starting",
      "verification_polling", "verifying", "verified", "blocked",
    ].includes(item.phase) ||
    !validBulkCheckpoint(item.source) ||
    !validBulkCheckpoint(item.verification, true) ||
    !Number.isSafeInteger(item.nextPreparationOrdinal) || item.nextPreparationOrdinal < 0 ||
    (item.source.products !== null &&
      item.nextPreparationOrdinal > item.source.products) ||
    !Number.isSafeInteger(item.verification.nextSourceOrdinal) || item.verification.nextSourceOrdinal < 0 ||
    (item.source.products !== null &&
      item.verification.nextSourceOrdinal > item.source.products) ||
    !nonNegativeSafeInteger(item.verification.missingSourceProducts) ||
    !nonNegativeSafeInteger(item.verification.missingSourceVariants) ||
    !nonNegativeSafeInteger(item.verification.sellingPriceDriftVariants) ||
    !nonNegativeSafeInteger(item.verification.vendorDriftProducts) ||
    !nonNegativeSafeInteger(item.verification.statusDriftProducts) ||
    !nonNegativeSafeInteger(item.verification.publicationDriftProducts) ||
    (item.planCreatedAt !== null && !Number.isFinite(Date.parse(item.planCreatedAt))) ||
    (item.preparedPlanDigestSha256 !== null && !SHA256.test(item.preparedPlanDigestSha256)) ||
    (item.rootDigestSha256 !== null && !SHA256.test(item.rootDigestSha256)) ||
    !Number.isSafeInteger(item.journalSequence) || item.journalSequence < 0 ||
    !SHA256.test(item.journalDigestSha256) || !lastEventValid ||
    !rootRefValid || !executionValid ||
    !executionPhaseValid ||
    (needsPlan && !planSealed) || (needsRoot && !rootSealed) ||
    (["preparing", "applying", "verification_start_pending", "verification_starting",
      "verification_polling", "verifying", "verified", "blocked"].includes(item.phase) &&
      !sourceSealed) ||
    (["verifying", "verified"].includes(item.phase) && !verificationSealed) ||
    (item.source.completedAt !== null &&
      item.source.requestedAt !== null &&
      Date.parse(item.source.completedAt) < Date.parse(item.source.requestedAt)) ||
    (item.planCreatedAt !== null &&
      item.source.completedAt !== null &&
      Date.parse(item.planCreatedAt) < Date.parse(item.source.completedAt)) ||
    (item.verification.requestedAt !== null &&
      item.source.completedAt !== null &&
      Date.parse(item.verification.requestedAt) < Date.parse(item.source.completedAt)) ||
    (item.verification.completedAt !== null &&
      item.verification.requestedAt !== null &&
      Date.parse(item.verification.completedAt) <
        Date.parse(item.verification.requestedAt)) ||
    (item.verification.operationId !== null &&
      item.verification.operationId === item.source.operationId) ||
    (item.phase === "source_starting" && !item.source.requestedAt) ||
    (item.phase === "source_polling" && !item.source.operationId) ||
    (item.phase === "verification_starting" &&
      !item.verification.requestedAt) ||
    (item.phase === "verification_polling" &&
      !item.verification.operationId) ||
    (item.phase === "verified" &&
      (item.execution?.phase !== "verified" ||
        item.verification.variantsWithCompareAt !== 0 ||
        item.verification.nextSourceOrdinal !== item.source.products ||
        item.verification.missingSourceProducts !== 0 ||
        item.verification.missingSourceVariants !== 0 ||
        item.verification.sellingPriceDriftVariants !== 0 ||
        item.verification.vendorDriftProducts !== 0 ||
        item.verification.statusDriftProducts !== 0 ||
        item.verification.publicationDriftProducts !== 0)) ||
    (item.phase === "blocked" && !item.blockedCode) ||
    (item.phase !== "blocked" && item.blockedCode !== null) ||
    checkpointBytes(item) >= 60 * 1024
  ) {
    throw new LaraPricingLiveRepairError(
      "invalid_checkpoint",
      "The fenced Lara pricing checkpoint is invalid.",
    );
  }
}

async function withEvent(
  checkpoint: LaraPricingLiveCheckpoint,
  patch: Partial<LaraPricingLiveCheckpoint>,
  event: string,
  detailCode: string | null = null,
  now = new Date(),
): Promise<LaraPricingLiveCheckpoint> {
  const lastEvent: LastEvent = {
    sequence: checkpoint.journalSequence + 1,
    occurredAt: now.toISOString(),
    event,
    detailCode,
  };
  const journalDigestSha256 = await remediationSha256({
    previous: checkpoint.journalDigestSha256,
    event: lastEvent,
  });
  return freezeRemediationValue({
    ...checkpoint,
    ...patch,
    revision: checkpoint.revision + 1,
    journalSequence: lastEvent.sequence,
    journalDigestSha256,
    lastEvent,
  }) as LaraPricingLiveCheckpoint;
}

async function liveSchemaHash(): Promise<string> {
  return remediationSha256({
    liveSchema: LARA_PRICING_LIVE_REPAIR_SCHEMA_VERSION,
    planSchema: LARA_PRICING_SALE_SCHEMA_VERSION,
    executionSchema: LARA_PRICING_EXECUTION_SCHEMA_VERSION,
    executionContractSha256: await laraPricingExecutionSchemaSha256(),
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    shop: LARA_ROVINJ_REMEDIATION_SHOP,
    source: RUN_SOURCE,
    note: RUN_NOTE,
    maxRetries: MAX_RETRIES,
    preparationPartitionsPerSlice: PREPARATION_PARTITIONS_PER_SLICE,
    verificationPartitionsPerSlice: VERIFICATION_PARTITIONS_PER_SLICE,
    maxTotalSlices: MAX_TOTAL_SLICES,
    maxBulkPolls: MAX_BULK_POLLS,
    maxBulkPendingElapsedMs: MAX_BULK_PENDING_ELAPSED_MS,
    maxBulkReplayElapsedMs: MAX_BULK_REPLAY_ELAPSED_MS,
    mutation: {
      fields: ["id", "compareAtPrice"],
      compareAtPrice: null,
      allowPartialUpdates: false,
      vendorMutationAllowed: false,
      sellingPriceMutationAllowed: false,
      productStatusMutationAllowed: false,
      publicationMutationAllowed: false,
    },
  });
}

async function liveManifestHash(): Promise<string> {
  return remediationSha256(LARA_PRICING_LIVE_GRAPHQL_MANIFEST);
}

export async function laraPricingLiveRepairRequestEvidence() {
  return freezeRemediationValue({
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    connectionId: LARA_AUDIT_CONNECTION.connectionId,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    shopId: LARA_AUDIT_CONNECTION.shopId,
    source: RUN_SOURCE,
    note: RUN_NOTE,
    maxRetries: MAX_RETRIES,
    actorType: "system" as const,
    schemaHash: await liveSchemaHash(),
    manifestHash: await liveManifestHash(),
  });
}

function validateRun(
  run: AuditShopifyRun,
  expected: { requestedBy: string; schemaHash: string; manifestHash: string },
): void {
  if (
    run.id !== LARA_PRICING_LIVE_REPAIR_RUN_ID ||
    run.connection_id !== LARA_AUDIT_CONNECTION.connectionId ||
    run.shopify_domain !== LARA_AUDIT_CONNECTION.shopDomain ||
    run.requested_by !== expected.requestedBy ||
    run.requested_actor_type !== "system" ||
    run.requested_source !== RUN_SOURCE || run.requested_note !== RUN_NOTE ||
    run.schema_hash !== expected.schemaHash || run.manifest_hash !== expected.manifestHash ||
    run.max_retries !== MAX_RETRIES
  ) {
    throw new LaraPricingLiveRepairError(
      "run_metadata_mismatch",
      "The durable Lara pricing run does not match its fixed request evidence.",
    );
  }
}

function validateTerminalRunState(run: AuditShopifyRun): void {
  const leaseFree =
    run.lease_token === null &&
    run.lease_acquired_at === null &&
    run.lease_renewed_at === null &&
    run.lease_expires_at === null &&
    run.next_attempt_at === null;
  const completedValid =
    run.state === "completed" &&
    run.artifact !== null &&
    run.error_code === null &&
    run.completed_at !== null &&
    run.failed_at === null;
  const failedValid =
    run.state === "failed" &&
    run.artifact === null &&
    run.error_code !== null &&
    run.completed_at === null &&
    run.failed_at !== null;
  if (!leaseFree || (!completedValid && !failedValid)) {
    throw new LaraPricingLiveRepairError(
      "run_metadata_mismatch",
      "The terminal Lara pricing run state is not lease-free and internally consistent.",
    );
  }
}

function validateFailureTransition(
  run: AuditShopifyRun,
  expected: { requestedBy: string; schemaHash: string; manifestHash: string },
  expectedErrorCode: string,
): void {
  validateRun(run, expected);
  if (run.state === "failed") {
    validateTerminalRunState(run);
    if (run.error_code !== expectedErrorCode) {
      throw new LaraPricingLiveRepairError(
        "run_metadata_mismatch",
        "The pricing terminal failure did not preserve its exact error evidence.",
      );
    }
    return;
  }
  if (
    run.state !== "queued" ||
    run.artifact !== null ||
    run.error_code !== expectedErrorCode ||
    run.next_attempt_at === null ||
    run.lease_token !== null ||
    run.lease_acquired_at !== null ||
    run.lease_renewed_at !== null ||
    run.lease_expires_at !== null
  ) {
    throw new LaraPricingLiveRepairError(
      "run_metadata_mismatch",
      "The pricing failure transition did not produce an exact queued or failed state.",
    );
  }
}

function firstRun(value: unknown): AuditShopifyRun | null {
  if (Array.isArray(value)) return (value[0] as AuditShopifyRun | undefined) ?? null;
  return (value as AuditShopifyRun | null) ?? null;
}

async function yieldRun(
  run: AuditShopifyRun,
  leaseValue: string,
  checkpoint: LaraPricingLiveCheckpoint,
  delaySeconds = 0,
): Promise<AuditShopifyRun> {
  const service = createServiceClient();
  if (!service) throw new LaraPricingLiveRepairError("run_unavailable", "The run service is unavailable.");
  const { data, error } = await service.rpc("yield_audit_shopify_run", {
    p_run_id: run.id,
    p_shopify_domain: run.shopify_domain,
    p_lease_token: leaseValue,
    p_lease_generation: run.lease_generation,
    p_checkpoint: checkpoint as unknown as Record<string, unknown>,
    p_continue_after_seconds: delaySeconds,
  });
  const yielded = firstRun(data);
  if (error || !yielded || yielded.state !== "queued") {
    throw new LaraPricingLiveRepairError(
      "durable_transition_failed",
      "The bounded pricing slice could not yield its fenced checkpoint.",
    );
  }
  return yielded;
}

function result(
  state: LaraPricingLiveRepairResult["state"],
  checkpoint: LaraPricingLiveCheckpoint,
  errorCode: string | null = null,
): LaraPricingLiveRepairResult {
  const processedProducts =
    checkpoint.phase === "preparing"
      ? checkpoint.nextPreparationOrdinal
      : checkpoint.phase === "applying"
        ? checkpoint.execution?.nextOperationIndex ?? 0
        : checkpoint.verification.nextSourceOrdinal;
  return freezeRemediationValue({
    state,
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    phase: checkpoint.phase,
    products: checkpoint.source.products,
    variants: checkpoint.source.variants,
    targetVariants: checkpoint.source.variantsWithCompareAt,
    processedProducts,
    errorCode,
  });
}

function terminalArtifactValid(
  value: unknown,
  checkpoint: LaraPricingLiveCheckpoint,
): boolean {
  const item = value as Record<string, unknown> | null;
  const shop = item?.shop as Record<string, unknown> | undefined;
  const source = item?.source as Record<string, unknown> | undefined;
  const plan = item?.plan as Record<string, unknown> | undefined;
  const vendorPolicy = plan?.vendorPolicy as Record<string, unknown> | undefined;
  const verification = item?.verification as Record<string, unknown> | undefined;
  const mutation = item?.mutation as Record<string, unknown> | undefined;
  const journal = item?.journal as Record<string, unknown> | undefined;
  return Boolean(
    item &&
      hasExactObjectKeys(item, [
        "schemaVersion",
        "planSchemaVersion",
        "executionSchemaVersion",
        "runId",
        "shop",
        "source",
        "plan",
        "mutation",
        "verification",
        "journal",
      ]) &&
      hasExactObjectKeys(shop, ["connectionId", "domain", "shopId"]) &&
      hasExactObjectKeys(source, [
        "bulkOperationId",
        "completedAt",
        "capturedAt",
        "jsonlSha256",
        "byteLength",
        "catalogueDigestSha256",
        "products",
        "variants",
        "variantsWithCompareAt",
      ]) &&
      hasExactObjectKeys(plan, [
        "preparedPlanDigestSha256",
        "rootDigestSha256",
        "rootRef",
        "vendorPolicy",
      ]) &&
      hasExactObjectKeys(mutation, [
        "inputFields",
        "compareAtPrice",
        "sellingPriceChanged",
        "vendorChanged",
        "productStatusChanged",
        "publicationChanged",
        "allowPartialUpdates",
        "appliedProducts",
        "appliedVariants",
        "externallyCompliantProducts",
        "externallyCompliantVariants",
      ]) &&
      hasExactObjectKeys(verification, [
        "bulkOperationId",
        "completedAt",
        "capturedAt",
        "jsonlSha256",
        "byteLength",
        "catalogueDigestSha256",
        "products",
        "variants",
        "nonNullCompareAtVariants",
        "missingSourceProducts",
        "missingSourceVariants",
        "sellingPriceDriftVariants",
        "vendorDriftProducts",
        "statusDriftProducts",
        "publicationDriftProducts",
      ]) &&
      hasExactObjectKeys(journal, ["sequence", "digestSha256", "lastEvent"]) &&
      item.schemaVersion === LARA_PRICING_LIVE_REPAIR_SCHEMA_VERSION &&
      item.runId === LARA_PRICING_LIVE_REPAIR_RUN_ID &&
      item.planSchemaVersion === LARA_PRICING_SALE_SCHEMA_VERSION &&
      item.executionSchemaVersion === LARA_PRICING_EXECUTION_SCHEMA_VERSION &&
      shop?.connectionId === LARA_AUDIT_CONNECTION.connectionId &&
      shop?.domain === LARA_AUDIT_CONNECTION.shopDomain &&
      shop?.shopId === LARA_AUDIT_CONNECTION.shopId &&
      source?.bulkOperationId === checkpoint.source.operationId &&
      source?.completedAt === checkpoint.source.completedAt &&
      source?.capturedAt === checkpoint.source.capturedAt &&
      source?.jsonlSha256 === checkpoint.source.jsonlSha256 &&
      source?.byteLength === checkpoint.source.byteLength &&
      source?.catalogueDigestSha256 === checkpoint.source.catalogueDigestSha256 &&
      source?.products === checkpoint.source.products &&
      source?.variants === checkpoint.source.variants &&
      source?.variantsWithCompareAt === checkpoint.source.variantsWithCompareAt &&
      plan?.preparedPlanDigestSha256 === checkpoint.preparedPlanDigestSha256 &&
      plan?.rootDigestSha256 === checkpoint.rootDigestSha256 &&
      sameCanonical(plan?.rootRef, checkpoint.rootRef) &&
      vendorPolicy?.mutationsAllowed === false &&
      sameCanonical(vendorPolicy, LARA_PRICING_VENDOR_POLICY) &&
      verification?.bulkOperationId === checkpoint.verification.operationId &&
      verification?.completedAt === checkpoint.verification.completedAt &&
      verification?.capturedAt === checkpoint.verification.capturedAt &&
      verification?.jsonlSha256 === checkpoint.verification.jsonlSha256 &&
      verification?.byteLength === checkpoint.verification.byteLength &&
      verification?.catalogueDigestSha256 ===
        checkpoint.verification.catalogueDigestSha256 &&
      verification?.products === checkpoint.verification.products &&
      verification?.variants === checkpoint.verification.variants &&
      verification?.nonNullCompareAtVariants === 0 &&
      verification?.missingSourceProducts === 0 &&
      verification?.missingSourceVariants === 0 &&
      verification?.sellingPriceDriftVariants === 0 &&
      verification?.vendorDriftProducts === 0 &&
      verification?.statusDriftProducts === 0 &&
      verification?.publicationDriftProducts === 0 &&
      Array.isArray(mutation?.inputFields) &&
      sameCanonical(mutation.inputFields, ["id", "compareAtPrice"]) &&
      mutation?.compareAtPrice === null &&
      mutation?.allowPartialUpdates === false &&
      mutation?.sellingPriceChanged === false &&
      mutation?.vendorChanged === false &&
      mutation?.productStatusChanged === false &&
      mutation?.publicationChanged === false &&
      mutation?.appliedProducts === checkpoint.execution?.appliedProducts &&
      mutation?.appliedVariants === checkpoint.execution?.appliedVariants &&
      mutation?.externallyCompliantProducts ===
        checkpoint.execution?.externallyCompliantProducts &&
      mutation?.externallyCompliantVariants ===
        checkpoint.execution?.externallyCompliantVariants &&
      journal?.sequence === checkpoint.journalSequence &&
      journal?.digestSha256 === checkpoint.journalDigestSha256 &&
      sameCanonical(journal?.lastEvent, checkpoint.lastEvent),
  );
}

async function persist(
  state: { run: AuditShopifyRun; checkpoint: LaraPricingLiveCheckpoint },
  leaseValue: string,
  next: LaraPricingLiveCheckpoint,
): Promise<void> {
  assertCheckpoint(next, {
    schemaHash: state.checkpoint.schemaHash,
    manifestHash: state.checkpoint.manifestHash,
  });
  if (next.revision !== state.checkpoint.revision + 1) {
    throw new LaraPricingLiveRepairError("durable_transition_failed", "The checkpoint revision is stale.");
  }
  const renewed = await renewAuditShopifyRun({
    run: state.run,
    leaseToken: leaseValue,
    checkpoint: next as unknown as Record<string, unknown>,
    leaseSeconds: LEASE_SECONDS,
  });
  if (
    renewed.lease_generation !== state.run.lease_generation ||
    renewed.lease_token !== leaseValue
  ) {
    throw new LaraPricingLiveRepairError("durable_transition_failed", "The run fence changed.");
  }
  state.run = renewed;
  state.checkpoint = next;
}

function immutableRef(key: string, value: unknown): Promise<LaraPricingImmutableArtifactRef> {
  const canonical = canonicalRemediationJson(value);
  return remediationSha256(value).then((digestSha256) =>
    freezeRemediationValue({
      key,
      digestSha256,
      byteLength: new TextEncoder().encode(canonical).byteLength,
    }),
  );
}

function operationMap(plan: LaraPricingPreparedPlan) {
  return new Map(plan.operations.map((operation) => [operation.target.productId, operation]));
}

async function productArtifact(
  plan: LaraPricingPreparedPlan,
  runId: string,
  ordinal: number,
  byProduct = operationMap(plan),
): Promise<{ artifact: LaraPricingProductArtifact; ref: LaraPricingImmutableArtifactRef }> {
  const product = plan.catalogue.products[ordinal];
  if (!product || !plan.catalogue.productDigestsSha256[ordinal]) {
    throw new LaraPricingLiveRepairError("plan_integrity_mismatch", "A pricing product partition is missing.");
  }
  const artifact: LaraPricingProductArtifact = freezeRemediationValue({
    schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    kind: "catalogue_product_partition" as const,
    ordinal,
    sourceCatalogueDigestSha256: plan.sourceCatalogueDigestSha256,
    productDigestSha256: plan.catalogue.productDigestsSha256[ordinal],
    product,
    operation: byProduct.get(product.id) ?? null,
  });
  const key = `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${runId}/products/${String(ordinal).padStart(4, "0")}.json`;
  return { artifact, ref: await immutableRef(key, artifact) };
}

async function persistPreparationSlice(input: {
  plan: LaraPricingPreparedPlan;
  store: LaraPricingImmutableArtifactStore;
  startOrdinal: number;
}): Promise<number> {
  const byProduct = operationMap(input.plan);
  const end = Math.min(
    input.plan.catalogue.products.length,
    input.startOrdinal + PREPARATION_PARTITIONS_PER_SLICE,
  );
  for (let ordinal = input.startOrdinal; ordinal < end; ordinal += 1) {
    const { artifact, ref } = await productArtifact(
      input.plan,
      LARA_PRICING_LIVE_REPAIR_RUN_ID,
      ordinal,
      byProduct,
    );
    if (ref.byteLength > LARA_PRICING_BLAST_RADIUS.maxProductArtifactBytes) {
      throw new LaraPricingLiveRepairError("plan_integrity_mismatch", "A product partition is too large.");
    }
    await input.store.putImmutableJson({ ...ref, value: artifact });
  }
  return end;
}

async function buildPersistedRoot(
  plan: LaraPricingPreparedPlan,
): Promise<{ root: LaraPricingPersistedPlanRoot; rootRef: LaraPricingImmutableArtifactRef }> {
  const partitions: Array<LaraPricingPersistedPlanRoot["productPartitions"][number]> = [];
  const byProduct = operationMap(plan);
  for (let ordinal = 0; ordinal < plan.catalogue.products.length; ordinal += 1) {
    const { artifact, ref } = await productArtifact(
      plan,
      LARA_PRICING_LIVE_REPAIR_RUN_ID,
      ordinal,
      byProduct,
    );
    partitions.push({
      ordinal,
      productId: artifact.product.id,
      productDigestSha256: artifact.productDigestSha256,
      affectedVariants: artifact.operation?.change.variants.length ?? 0,
      ref,
    });
  }
  const operations = partitions
    .filter((partition) => partition.affectedVariants > 0)
    .map((partition, operationIndex) => {
      const operation = byProduct.get(partition.productId);
      if (!operation) throw new LaraPricingLiveRepairError("plan_integrity_mismatch", "A root operation is missing.");
      return {
        operationIndex,
        operationId: operation.operationId,
        productOrdinal: partition.ordinal,
        productId: partition.productId,
        operationDigestSha256: operation.digestSha256,
        affectedVariants: partition.affectedVariants,
        partitionRef: partition.ref,
      };
    });
  const payload = {
    schemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    kind: "persisted_plan_root" as const,
    planId: LARA_PRICING_SALE_PLAN_ID,
    createdAt: plan.createdAt,
    executionMode: "dry-run" as const,
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    sourceCatalogueDigestSha256: plan.sourceCatalogueDigestSha256,
    sourceBulkOperationId: plan.sourceBulkOperationId,
    legalBasis: LARA_PRICING_LEGAL_BASIS,
    vendorPolicy: LARA_PRICING_VENDOR_POLICY,
    counts: plan.counts,
    productPartitions: partitions,
    operations,
    preparedPlanDigestSha256: plan.digestSha256,
  };
  const root: LaraPricingPersistedPlanRoot = freezeRemediationValue({
    ...payload,
    digestSha256: await remediationSha256(payload),
  });
  const rootRef = await immutableRef(
    `lara-pricing/${LARA_PRICING_SALE_SCHEMA_VERSION}/${LARA_PRICING_LIVE_REPAIR_RUN_ID}/root.json`,
    root,
  );
  if (rootRef.byteLength > LARA_PRICING_BLAST_RADIUS.maxRootArtifactBytes) {
    throw new LaraPricingLiveRepairError("plan_integrity_mismatch", "The pricing root is too large.");
  }
  return { root, rootRef };
}

function assertSameDownload(
  saved: BulkCheckpoint,
  download: LaraPricingDownloadedCatalogue,
): void {
  if (
    saved.operationId !== download.catalogue.bulk.operationId ||
    saved.jsonlSha256 !== download.jsonlSha256 ||
    saved.byteLength !== download.byteLength ||
    saved.catalogueDigestSha256 !== download.catalogue.digestSha256 ||
    saved.products !== download.catalogue.counts.products ||
    saved.variants !== download.catalogue.counts.variants ||
    saved.variantsWithCompareAt !== download.catalogue.counts.variantsWithCompareAt
  ) {
    throw new LaraPricingLiveRepairError(
      "source_integrity_mismatch",
      "A repeated catalogue download no longer matches its sealed integrity proof.",
    );
  }
}

function bulkFromDownload(
  requestedAt: string,
  status: LaraPricingBulkStatus,
  capturedAt: string,
  download: LaraPricingDownloadedCatalogue,
  pollCount: number,
): BulkCheckpoint {
  if (
    status.id !== download.catalogue.bulk.operationId ||
    status.status !== "COMPLETED" ||
    status.completedAt !== download.catalogue.bulk.completedAt ||
    status.rootObjectCount !== String(download.catalogue.bulk.rootObjectCount) ||
    status.objectCount !== String(download.catalogue.bulk.objectCount) ||
    status.fileSize !== String(download.byteLength)
  ) {
    throw new LaraPricingLiveRepairError(
      "source_integrity_mismatch",
      "The completed bulk metadata changed across its sealed download boundary.",
    );
  }
  return freezeRemediationValue({
    requestedAt,
    operationId: status.id,
    completedAt: status.completedAt,
    capturedAt,
    jsonlSha256: download.jsonlSha256,
    byteLength: download.byteLength,
    catalogueDigestSha256: download.catalogue.digestSha256,
    products: download.catalogue.counts.products,
    variants: download.catalogue.counts.variants,
    variantsWithCompareAt: download.catalogue.counts.variantsWithCompareAt,
    pollCount,
  });
}

function completedBulk(status: LaraPricingBulkStatus): void {
  if (status.status !== "COMPLETED" || !status.completedAt || !status.hasResult) {
    throw new LaraPricingLiveRepairError("source_integrity_mismatch", "The bulk operation is not a full completion.");
  }
}

async function advanceBulkStart(input: {
  stage: "source" | "verification";
  runtime: LaraPricingLiveRuntime;
  state: { run: AuditShopifyRun; checkpoint: LaraPricingLiveCheckpoint };
  leaseValue: string;
}): Promise<"advanced" | "waiting"> {
  const phasePrefix = input.stage === "source" ? "source" : "verification";
  const saved = input.state.checkpoint[input.stage];
  if (saved.requestedAt === null) {
    const requestedAt = new Date().toISOString();
    const next = await withEvent(
      input.state.checkpoint,
      {
        phase: `${phasePrefix}_starting` as LivePhase,
        [input.stage]: { ...saved, requestedAt },
      },
      `${phasePrefix}.start_prepared`,
    );
    await persist(input.state, input.leaseValue, next);
  }
  const requestedAt = input.state.checkpoint[input.stage].requestedAt;
  if (!requestedAt) throw new LaraPricingLiveRepairError("invalid_checkpoint", "The bulk start timestamp is missing.");
  if (Date.now() - Date.parse(requestedAt) > MAX_BULK_PENDING_ELAPSED_MS) {
    throw new LaraPricingLiveRepairError(
      "source_integrity_mismatch",
      "The fixed catalogue bulk start exceeded its total deadline.",
    );
  }

  const otherOperationId =
    input.stage === "verification"
      ? input.state.checkpoint.source.operationId
      : input.state.checkpoint.verification.operationId;
  const recovered = (
    await input.runtime.recoverExactCatalogueStarts(requestedAt)
  ).filter((item) => item.id !== otherOperationId);
  if (
    recovered.some(
      (item) => Date.parse(item.createdAt) < Date.parse(requestedAt),
    )
  ) {
    throw new LaraPricingLiveRepairError(
      "bulk_start_collision",
      "An exact catalogue query exists inside the bounded start clock-skew window.",
    );
  }
  if (recovered.length > 1) {
    throw new LaraPricingLiveRepairError(
      "bulk_start_collision",
      "More than one exact catalogue query matches the prepared start boundary.",
    );
  }
  let operation = recovered[0] ?? null;
  if (!operation && Date.now() - Date.parse(requestedAt) < START_RECOVERY_GRACE_MS) {
    return "waiting";
  }
  if (!operation) {
    try {
      operation = await input.runtime.startCatalogueBulk();
    } catch (error) {
      if (
        error instanceof LaraPricingLiveRuntimeError &&
        error.code === "bulk_start_ambiguous"
      ) {
        return "waiting";
      }
      if (
        error instanceof LaraPricingLiveRuntimeError &&
        error.code === "bulk_start_rejected" &&
        error.retryable
      ) {
        return "waiting";
      }
      throw error;
    }
  }
  const next = await withEvent(
    input.state.checkpoint,
    {
      phase: `${phasePrefix}_polling` as LivePhase,
      [input.stage]: {
        ...input.state.checkpoint[input.stage],
        operationId: operation.id,
      },
    },
    `${phasePrefix}.start_acknowledged`,
  );
  await persist(input.state, input.leaseValue, next);
  return "advanced";
}

async function recordBulkPoll(input: {
  stage: "source" | "verification";
  state: { run: AuditShopifyRun; checkpoint: LaraPricingLiveCheckpoint };
  leaseValue: string;
}): Promise<string> {
  const saved = input.state.checkpoint[input.stage];
  if (!saved.operationId || !saved.requestedAt) {
    throw new LaraPricingLiveRepairError(
      "invalid_checkpoint",
      "The fixed catalogue poll evidence is incomplete.",
    );
  }
  const elapsedAnchor = saved.completedAt ?? saved.requestedAt;
  const elapsedLimit = saved.completedAt
    ? MAX_BULK_REPLAY_ELAPSED_MS
    : MAX_BULK_PENDING_ELAPSED_MS;
  if (
    saved.pollCount >= MAX_BULK_POLLS ||
    Date.now() - Date.parse(elapsedAnchor) > elapsedLimit
  ) {
    throw new LaraPricingLiveRepairError(
      "source_integrity_mismatch",
      "The fixed catalogue bulk poll exceeded its count or elapsed deadline.",
    );
  }
  const next = await withEvent(
    input.state.checkpoint,
    {
      [input.stage]: { ...saved, pollCount: saved.pollCount + 1 },
    },
    `${input.stage}.poll_recorded`,
  );
  await persist(input.state, input.leaseValue, next);
  return saved.operationId;
}

function createCoordinator(input: {
  state: { run: AuditShopifyRun; checkpoint: LaraPricingLiveCheckpoint };
  leaseValue: string;
}): LaraPricingDurableCoordinator {
  return Object.freeze({
    async load({ runId, fence }) {
      if (
        runId !== LARA_PRICING_LIVE_REPAIR_RUN_ID ||
        fence !== input.leaseValue || !input.state.checkpoint.execution
      ) {
        throw new LaraPricingExecutionError("INVALID_CHECKPOINT", "The pricing execution fence is invalid.");
      }
      return {
        revision: input.state.checkpoint.revision,
        checkpoint: input.state.checkpoint.execution,
      };
    },
    async transition({ runId, fence, expectedRevision, checkpoint, event }) {
      if (
        runId !== LARA_PRICING_LIVE_REPAIR_RUN_ID || fence !== input.leaseValue ||
        expectedRevision !== input.state.checkpoint.revision ||
        event.sequence !== checkpoint.lastJournalSequence
      ) {
        throw new LaraPricingExecutionError("DURABLE_TRANSITION_FAILED", "The pricing transition fence is stale.");
      }
      const next = await withEvent(
        input.state.checkpoint,
        { execution: checkpoint },
        `execution.${event.event}`,
        event.detailCode,
        new Date(event.occurredAt),
      );
      await persist(input.state, input.leaseValue, next);
      return { revision: input.state.checkpoint.revision };
    },
  });
}

async function preparePlanFromSource(
  runtime: LaraPricingLiveRuntime,
  checkpoint: LaraPricingLiveCheckpoint,
): Promise<{ download: LaraPricingDownloadedCatalogue; plan: LaraPricingPreparedPlan }> {
  if (!checkpoint.source.operationId || !checkpoint.source.capturedAt || !checkpoint.planCreatedAt) {
    throw new LaraPricingLiveRepairError("invalid_checkpoint", "The sealed source catalogue is incomplete.");
  }
  const download = await runtime.downloadCompletedCatalogue({
    operationId: checkpoint.source.operationId,
    capturedAt: checkpoint.source.capturedAt,
  });
  assertSameDownload(checkpoint.source, download);
  const plan = await prepareLaraPricingSalePlan({
    catalogue: download.catalogue,
    createdAt: checkpoint.planCreatedAt,
  });
  if (plan.digestSha256 !== checkpoint.preparedPlanDigestSha256) {
    throw new LaraPricingLiveRepairError("plan_integrity_mismatch", "The sealed pricing plan digest changed.");
  }
  return { download, plan };
}

async function verifySourceSlice(input: {
  root: LaraPricingPersistedPlanRoot;
  store: LaraPricingImmutableArtifactStore;
  fresh: LaraPricingCatalogueSnapshot;
  checkpoint: LaraPricingLiveCheckpoint;
}): Promise<{
  nextOrdinal: number;
  missingProducts: number;
  missingVariants: number;
  priceDrift: number;
  vendorDrift: number;
  statusDrift: number;
  publicationDrift: number;
}> {
  const start = input.checkpoint.verification.nextSourceOrdinal;
  const end = Math.min(
    input.root.productPartitions.length,
    start + VERIFICATION_PARTITIONS_PER_SLICE,
  );
  const freshByProduct = new Map(input.fresh.products.map((product) => [product.id, product]));
  let missingProducts = 0;
  let missingVariants = 0;
  let priceDrift = 0;
  let vendorDrift = 0;
  let statusDrift = 0;
  let publicationDrift = 0;
  for (let ordinal = start; ordinal < end; ordinal += 1) {
    const sourceRef = input.root.productPartitions[ordinal];
    if (!sourceRef || sourceRef.ordinal !== ordinal) {
      throw new LaraPricingLiveRepairError("plan_integrity_mismatch", "The source root ordinal is invalid.");
    }
    const source = await loadLaraPricingProductArtifact({
      store: input.store,
      ref: sourceRef.ref,
      expectedCatalogueDigest: input.root.sourceCatalogueDigestSha256,
    });
    const fresh = freshByProduct.get(source.product.id);
    if (!fresh) {
      missingProducts += 1;
      missingVariants += source.product.variants.length;
      continue;
    }
    if (fresh.vendor !== source.product.vendor) vendorDrift += 1;
    if (fresh.status !== source.product.status) statusDrift += 1;
    if (fresh.publishedAt !== source.product.publishedAt) publicationDrift += 1;
    const freshVariants = new Map(fresh.variants.map((variant) => [variant.id, variant]));
    for (const before of source.product.variants) {
      const after = freshVariants.get(before.id);
      if (!after) missingVariants += 1;
      else if (after.price !== before.price) priceDrift += 1;
    }
  }
  return {
    nextOrdinal: end,
    missingProducts,
    missingVariants,
    priceDrift,
    vendorDrift,
    statusDrift,
    publicationDrift,
  };
}

function terminalArtifact(
  checkpoint: LaraPricingLiveCheckpoint,
): Record<string, unknown> {
  return {
    schemaVersion: LARA_PRICING_LIVE_REPAIR_SCHEMA_VERSION,
    planSchemaVersion: LARA_PRICING_SALE_SCHEMA_VERSION,
    executionSchemaVersion: LARA_PRICING_EXECUTION_SCHEMA_VERSION,
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    shop: {
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      domain: LARA_AUDIT_CONNECTION.shopDomain,
      shopId: LARA_AUDIT_CONNECTION.shopId,
    },
    source: {
      bulkOperationId: checkpoint.source.operationId,
      completedAt: checkpoint.source.completedAt,
      capturedAt: checkpoint.source.capturedAt,
      jsonlSha256: checkpoint.source.jsonlSha256,
      byteLength: checkpoint.source.byteLength,
      catalogueDigestSha256: checkpoint.source.catalogueDigestSha256,
      products: checkpoint.source.products,
      variants: checkpoint.source.variants,
      variantsWithCompareAt: checkpoint.source.variantsWithCompareAt,
    },
    plan: {
      preparedPlanDigestSha256: checkpoint.preparedPlanDigestSha256,
      rootDigestSha256: checkpoint.rootDigestSha256,
      rootRef: checkpoint.rootRef,
      vendorPolicy: LARA_PRICING_VENDOR_POLICY,
    },
    mutation: {
      inputFields: ["id", "compareAtPrice"],
      compareAtPrice: null,
      sellingPriceChanged: false,
      vendorChanged: false,
      productStatusChanged: false,
      publicationChanged: false,
      allowPartialUpdates: false,
      appliedProducts: checkpoint.execution?.appliedProducts ?? null,
      appliedVariants: checkpoint.execution?.appliedVariants ?? null,
      externallyCompliantProducts:
        checkpoint.execution?.externallyCompliantProducts ?? null,
      externallyCompliantVariants:
        checkpoint.execution?.externallyCompliantVariants ?? null,
    },
    verification: {
      bulkOperationId: checkpoint.verification.operationId,
      completedAt: checkpoint.verification.completedAt,
      capturedAt: checkpoint.verification.capturedAt,
      jsonlSha256: checkpoint.verification.jsonlSha256,
      byteLength: checkpoint.verification.byteLength,
      catalogueDigestSha256: checkpoint.verification.catalogueDigestSha256,
      products: checkpoint.verification.products,
      variants: checkpoint.verification.variants,
      nonNullCompareAtVariants: checkpoint.verification.variantsWithCompareAt,
      missingSourceProducts: checkpoint.verification.missingSourceProducts,
      missingSourceVariants: checkpoint.verification.missingSourceVariants,
      sellingPriceDriftVariants:
        checkpoint.verification.sellingPriceDriftVariants,
      vendorDriftProducts: checkpoint.verification.vendorDriftProducts,
      statusDriftProducts: checkpoint.verification.statusDriftProducts,
      publicationDriftProducts:
        checkpoint.verification.publicationDriftProducts,
    },
    journal: {
      sequence: checkpoint.journalSequence,
      digestSha256: checkpoint.journalDigestSha256,
      lastEvent: checkpoint.lastEvent,
    },
  };
}

function executionVerificationIsSealed(
  checkpoint: LaraPricingLiveCheckpoint,
): boolean {
  const execution = checkpoint.execution;
  const verification = checkpoint.verification;
  return Boolean(
    execution?.phase === "verified" &&
      execution.freshVerificationDigestSha256 ===
        verification.catalogueDigestSha256 &&
      execution.freshVerificationProducts === verification.products &&
      execution.freshVerificationVariants === verification.variants &&
      verification.variantsWithCompareAt === 0 &&
      verification.nextSourceOrdinal === checkpoint.source.products &&
      verification.missingSourceProducts === 0 &&
      verification.missingSourceVariants === 0 &&
      verification.sellingPriceDriftVariants === 0 &&
      verification.vendorDriftProducts === 0 &&
      verification.statusDriftProducts === 0 &&
      verification.publicationDriftProducts === 0,
  );
}

async function validateSealedRootReplay(
  run: AuditShopifyRun,
  checkpoint: LaraPricingLiveCheckpoint,
  leaseToken: string,
  retryTransientRead: boolean,
): Promise<void> {
  if (
    !checkpoint.rootRef ||
    !checkpoint.rootDigestSha256 ||
    !checkpoint.preparedPlanDigestSha256 ||
    !checkpoint.execution
  ) {
    throw new LaraPricingLiveRepairError(
      "terminal_artifact_invalid",
      "The sealed pricing proof is missing its immutable root reference.",
    );
  }

  let root: LaraPricingPersistedPlanRoot;
  try {
    const store = createLaraPricingArtifactStore({
      runId: run.id,
      leaseToken,
      leaseGeneration: run.lease_generation,
    });
    root = await loadLaraPricingPersistedRoot({
      store,
      ref: checkpoint.rootRef,
    });
  } catch (error) {
    // A database/network read failure is safe to retry because the object is
    // immutable. Shape, digest, namespace and stored-byte failures are
    // evidence failures and must remain terminal/non-retryable.
    if (
      retryTransientRead &&
      error instanceof LaraPricingArtifactStoreError &&
      error.code === "artifact_read_failed"
    ) {
      throw error;
    }
    throw new LaraPricingLiveRepairError(
      "terminal_artifact_invalid",
      "The sealed pricing root could not be replayed from immutable storage.",
    );
  }

  const execution = checkpoint.execution;
  const resolvedProducts =
    execution.appliedProducts + execution.externallyCompliantProducts;
  const resolvedVariants =
    execution.appliedVariants + execution.externallyCompliantVariants;
  if (
    root.digestSha256 !== checkpoint.rootDigestSha256 ||
    root.digestSha256 !== execution.approvedPlanDigestSha256 ||
    root.preparedPlanDigestSha256 !== checkpoint.preparedPlanDigestSha256 ||
    root.sourceCatalogueDigestSha256 !== checkpoint.source.catalogueDigestSha256 ||
    root.sourceCatalogueDigestSha256 !==
      execution.sourceCatalogueDigestSha256 ||
    root.sourceBulkOperationId !== checkpoint.source.operationId ||
    root.counts.products !== checkpoint.source.products ||
    root.counts.variants !== checkpoint.source.variants ||
    root.counts.variantsWithCompareAt !==
      checkpoint.source.variantsWithCompareAt ||
    root.counts.mutationVariants !==
      checkpoint.source.variantsWithCompareAt ||
    root.operations.length !== root.counts.operationProducts ||
    root.productPartitions.length !== root.counts.products ||
    execution.nextOperationIndex !== root.operations.length ||
    resolvedProducts !== root.counts.operationProducts ||
    resolvedVariants !== root.counts.mutationVariants
  ) {
    throw new LaraPricingLiveRepairError(
      "terminal_artifact_invalid",
      "The sealed pricing proof does not match its immutable root.",
    );
  }
}

async function commitVerifiedRun(
  state: { run: AuditShopifyRun; checkpoint: LaraPricingLiveCheckpoint },
  leaseValue: string,
): Promise<AuditShopifyRun> {
  if (
    state.checkpoint.phase !== "verified" ||
    !executionVerificationIsSealed(state.checkpoint)
  ) {
    throw new LaraPricingLiveRepairError(
      "terminal_artifact_invalid",
      "The verified pricing checkpoint is not sealed for completion.",
    );
  }
  const artifact = terminalArtifact(state.checkpoint);
  if (!terminalArtifactValid(artifact, state.checkpoint)) {
    throw new LaraPricingLiveRepairError(
      "terminal_artifact_invalid",
      "The final pricing proof is invalid.",
    );
  }
  // Validate the large, immutable evidence while this exact lease still owns
  // the run. A malformed counter/root replay must never be made terminal and
  // only discovered after the completion fence has been released.
  await validateSealedRootReplay(
    state.run,
    state.checkpoint,
    leaseValue,
    true,
  );
  try {
    return await completeAuditShopifyRun({
      run: state.run,
      leaseToken: leaseValue,
      checkpoint: state.checkpoint as unknown as Record<string, unknown>,
      artifact,
    });
  } catch {
    // Completion is a fenced database transition, but its acknowledgement can
    // still be lost. Re-read before classifying it, and never convert this
    // ambiguity into a definitive failed run.
    let current: AuditShopifyRun | null = null;
    try {
      current = await getAuditShopifyRun({
        runId: state.run.id,
        shopDomain: state.run.shopify_domain,
      });
    } catch {
      // The terminal RPC and the reconciliation read are both ambiguous. The
      // retryable typed error below leaves the sealed checkpoint recoverable.
    }
    if (current) {
      validateRun(current, {
        requestedBy: state.run.requested_by,
        schemaHash: state.checkpoint.schemaHash,
        manifestHash: state.checkpoint.manifestHash,
      });
      if (current.state === "completed") return current;
    }
    throw new LaraPricingLiveRepairError(
      "terminal_commit_ambiguous",
      "The sealed pricing completion was not durably acknowledged.",
    );
  }
}

async function commitBlockedRun(
  state: { run: AuditShopifyRun; checkpoint: LaraPricingLiveCheckpoint },
  leaseValue: string,
  expected: { requestedBy: string; schemaHash: string; manifestHash: string },
): Promise<AuditShopifyRun> {
  if (
    state.checkpoint.phase !== "blocked" ||
    state.checkpoint.execution?.phase !== "blocked" ||
    !state.checkpoint.blockedCode ||
    state.checkpoint.blockedCode !== state.checkpoint.execution.blockedCode
  ) {
    throw new LaraPricingLiveRepairError(
      "invalid_checkpoint",
      "The blocked pricing checkpoint is not internally sealed.",
    );
  }
  const errorCode = "pricing_execution_blocked";
  let failed: AuditShopifyRun;
  try {
    failed = await failAuditShopifyRun({
      run: state.run,
      leaseToken: leaseValue,
      checkpoint: state.checkpoint as unknown as Record<string, unknown>,
      errorCode,
      retryable: false,
    });
  } catch {
    // A failure transition can commit even when its response is lost. Re-read
    // before yielding the sealed blocked checkpoint for a safe retry.
    let current: AuditShopifyRun | null = null;
    try {
      current = await getAuditShopifyRun({
        runId: state.run.id,
        shopDomain: state.run.shopify_domain,
      });
    } catch {
      // The typed ambiguity below preserves the blocked checkpoint for retry.
    }
    if (current) {
      validateRun(current, expected);
      if (current.state === "failed") {
        validateTerminalRunState(current);
        if (current.error_code !== errorCode) {
          throw new LaraPricingLiveRepairError(
            "run_metadata_mismatch",
            "The blocked pricing failure preserved another error code.",
          );
        }
        return current;
      }
    }
    throw new LaraPricingLiveRepairError(
      "terminal_failure_commit_ambiguous",
      "The sealed pricing failure was not durably acknowledged.",
    );
  }
  validateFailureTransition(failed, expected, errorCode);
  if (failed.state !== "failed") {
    throw new LaraPricingLiveRepairError(
      "run_metadata_mismatch",
      "A definitive blocked pricing run did not become failed.",
    );
  }
  return failed;
}

async function validateCompletedReplay(
  run: AuditShopifyRun,
  checkpoint: LaraPricingLiveCheckpoint,
): Promise<void> {
  if (
    checkpoint.phase !== "verified" ||
    !checkpoint.rootRef ||
    !checkpoint.rootDigestSha256 ||
    !checkpoint.execution ||
    !executionVerificationIsSealed(checkpoint) ||
    !terminalArtifactValid(run.artifact, checkpoint)
  ) {
    throw new LaraPricingLiveRepairError(
      "terminal_artifact_invalid",
      "The completed pricing evidence is not internally sealed.",
    );
  }

  // Terminal reads are generation-pinned and read-only in migration 0045; the
  // non-null token is deliberately ephemeral and ignored by that SQL branch.
  await validateSealedRootReplay(
    run,
    checkpoint,
    crypto.randomUUID(),
    false,
  );
}

function safeErrorCode(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof LaraPricingMutationDefinitiveError) {
    return { code: "pricing_mutation_rejected", retryable: error.retryable };
  }
  if (error instanceof LaraPricingLiveRuntimeError) {
    return { code: `pricing_${error.code}`.slice(0, 64), retryable: error.retryable };
  }
  if (error instanceof LaraPricingArtifactStoreError) {
    return {
      code: `pricing_${error.code}`.slice(0, 64),
      retryable: ["artifact_read_failed", "artifact_write_failed"].includes(
        error.code,
      ),
    };
  }
  if (error instanceof LaraPricingSalePlanError) {
    return { code: `pricing_${error.code.toLowerCase()}`.slice(0, 64), retryable: false };
  }
  if (error instanceof LaraPricingExecutionError) {
    return {
      code: `pricing_${error.code.toLowerCase()}`.slice(0, 64),
      retryable: error.code === "DURABLE_TRANSITION_FAILED",
    };
  }
  if (error instanceof LaraPricingLiveRepairError) {
    return {
      code: `pricing_${error.code}`.slice(0, 64),
      retryable: [
        "durable_transition_failed",
        "terminal_commit_ambiguous",
        "terminal_failure_commit_ambiguous",
      ].includes(error.code),
    };
  }
  return { code: "pricing_internal_failure", retryable: false };
}

/**
 * Advance one bounded slice. This function never accepts a shop, query, URL,
 * product id, price, digest or mutation value from its caller.
 */
export async function runLaraPricingLiveRepairOneShot(input: {
  requestedBy: string;
  runtimeFactory?: () => Promise<LaraPricingLiveRuntime>;
}): Promise<LaraPricingLiveRepairResult> {
  if (!UUID.test(input.requestedBy)) {
    throw new LaraPricingLiveRepairError("invalid_run", "The machine sponsor is invalid.");
  }
  const evidence = await laraPricingLiveRepairRequestEvidence();
  const schemaHash = evidence.schemaHash;
  const manifestHash = evidence.manifestHash;
  const expected = { requestedBy: input.requestedBy, schemaHash, manifestHash };
  let existing = await getAuditShopifyRun({
    runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
    shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
  });
  if (!existing) {
    const effectiveId = await enqueueAuditShopifyRun({
      runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
      connectionId: LARA_AUDIT_CONNECTION.connectionId,
      requestedBy: input.requestedBy,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      source: RUN_SOURCE,
      note: RUN_NOTE,
      schemaHash,
      manifestHash,
      maxRetries: MAX_RETRIES,
      actorType: "system",
    });
    if (effectiveId !== LARA_PRICING_LIVE_REPAIR_RUN_ID) {
      throw new LaraPricingLiveRepairError("run_metadata_mismatch", "Another run owns the pricing manifest.");
    }
    existing = await getAuditShopifyRun({
      runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    });
  }
  if (!existing) throw new LaraPricingLiveRepairError("run_unavailable", "The pricing run is unavailable.");
  validateRun(existing, expected);
  if (existing.state === "completed") {
    validateTerminalRunState(existing);
    assertCheckpoint(existing.checkpoint, { schemaHash, manifestHash });
    await validateCompletedReplay(existing, existing.checkpoint);
    return result("completed", existing.checkpoint);
  }
  if (existing.state === "failed") {
    validateTerminalRunState(existing);
    assertCheckpoint(existing.checkpoint, { schemaHash, manifestHash });
    return result("failed", existing.checkpoint, existing.error_code);
  }

  const leaseValue = crypto.randomUUID();
  let claimed: AuditShopifyRun;
  try {
    claimed = await claimAuditShopifyRun({
      runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
      leaseToken: leaseValue,
      leaseSeconds: LEASE_SECONDS,
    });
  } catch {
    const current = await getAuditShopifyRun({
      runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
      shopDomain: LARA_AUDIT_CONNECTION.shopDomain,
    });
    if (!current) throw new LaraPricingLiveRepairError("run_unavailable", "The pricing run disappeared.");
    validateRun(current, expected);
    if (current.state === "completed") {
      validateTerminalRunState(current);
      assertCheckpoint(current.checkpoint, { schemaHash, manifestHash });
      await validateCompletedReplay(current, current.checkpoint);
      return result("completed", current.checkpoint);
    }
    if (current.state === "failed") {
      validateTerminalRunState(current);
      assertCheckpoint(current.checkpoint, { schemaHash, manifestHash });
      return result("failed", current.checkpoint, current.error_code);
    }
    const cp = Object.keys(current.checkpoint).length
      ? current.checkpoint
      : await initialCheckpoint(schemaHash, manifestHash);
    assertCheckpoint(cp, { schemaHash, manifestHash });
    return result("in_progress", cp);
  }
  validateRun(claimed, expected);

  let checkpoint: LaraPricingLiveCheckpoint;
  if (Object.keys(claimed.checkpoint).length === 0) {
    checkpoint = await initialCheckpoint(schemaHash, manifestHash);
  } else {
    assertCheckpoint(claimed.checkpoint, { schemaHash, manifestHash });
    checkpoint = claimed.checkpoint;
  }
  const state = { run: claimed, checkpoint };
  let terminalCommitted = false;
  if (Object.keys(claimed.checkpoint).length === 0) {
    const initialized = await withEvent(checkpoint, {}, "run.claimed");
    await persist(state, leaseValue, initialized);
  }

  const runtimeFactory = input.runtimeFactory ?? createLaraPricingLiveRuntime;
  try {
    await preflightLaraPricingArtifactStore({
      runId: state.run.id,
      leaseToken: leaseValue,
      leaseGeneration: state.run.lease_generation,
    });
    // Two explicit crash-recovery boundaries close the only terminal windows:
    // execution proof may have been durably sealed before the outer phase, or
    // the outer verified checkpoint may have been sealed before run completion.
    // Reconcile those boundaries before charging a new work slice: a crash on
    // the final permitted slice must not strand already-sealed terminal proof.
    if (
      state.checkpoint.phase === "verifying" &&
      state.checkpoint.execution?.phase === "verified"
    ) {
      if (!executionVerificationIsSealed(state.checkpoint)) {
        throw new LaraPricingLiveRepairError(
          "terminal_artifact_invalid",
          "The resumed execution verification is not fully sealed.",
        );
      }
      const verified = await withEvent(
        state.checkpoint,
        { phase: "verified" },
        "run.verified_reconciled",
      );
      await persist(state, leaseValue, verified);
    }
    if (state.checkpoint.phase === "verified") {
      const completed = await commitVerifiedRun(state, leaseValue);
      terminalCommitted = true;
      validateRun(completed, expected);
      validateTerminalRunState(completed);
      assertCheckpoint(completed.checkpoint, { schemaHash, manifestHash });
      await validateCompletedReplay(completed, completed.checkpoint);
      return result("completed", completed.checkpoint);
    }

    // The nested executor persists its blocked state before the outer phase.
    // Reconcile either side of that failure crash window before slice budget
    // accounting or runtime creation, then seal an exact terminal failure.
    if (
      state.checkpoint.phase === "applying" &&
      state.checkpoint.execution?.phase === "blocked"
    ) {
      const blockedCode = state.checkpoint.execution.blockedCode;
      if (!blockedCode) {
        throw new LaraPricingLiveRepairError(
          "invalid_checkpoint",
          "The resumed blocked pricing execution has no evidence code.",
        );
      }
      const blocked = await withEvent(
        state.checkpoint,
        { phase: "blocked", blockedCode },
        "execution.blocked_reconciled",
        blockedCode,
      );
      await persist(state, leaseValue, blocked);
    }
    if (state.checkpoint.phase === "blocked") {
      const failed = await commitBlockedRun(state, leaseValue, expected);
      return result("failed", state.checkpoint, failed.error_code);
    }

    if (
      state.checkpoint.phase === "applying" &&
      state.checkpoint.execution?.phase === "verification_pending"
    ) {
      const verificationPending = await withEvent(
        state.checkpoint,
        { phase: "verification_start_pending" },
        "verification.required_reconciled",
      );
      await persist(state, leaseValue, verificationPending);
    }

    if (state.checkpoint.sliceCount >= MAX_TOTAL_SLICES) {
      throw new LaraPricingLiveRepairError(
        "run_unavailable",
        "The pricing repair exhausted its bounded slice budget.",
      );
    }
    const sliceStarted = await withEvent(
      state.checkpoint,
      { sliceCount: state.checkpoint.sliceCount + 1 },
      "run.slice_started",
    );
    await persist(state, leaseValue, sliceStarted);

    const runtime = await runtimeFactory();

    if (state.checkpoint.phase === "source_start_pending" || state.checkpoint.phase === "source_starting") {
      const advanced = await advanceBulkStart({
        stage: "source", runtime, state, leaseValue,
      });
      if (advanced === "waiting") {
        await yieldRun(state.run, leaseValue, state.checkpoint, 30);
        return result("in_progress", state.checkpoint);
      }
    }

    if (state.checkpoint.phase === "source_polling") {
      const id = await recordBulkPoll({
        stage: "source",
        state,
        leaseValue,
      });
      const status = await runtime.pollCatalogueBulk(id);
      if (["CREATED", "RUNNING", "CANCELING"].includes(status.status)) {
        await yieldRun(state.run, leaseValue, state.checkpoint, 30);
        return result("in_progress", state.checkpoint);
      }
      if (status.status !== "COMPLETED") {
        throw new LaraPricingLiveRuntimeError("bulk_failed", "The source catalogue bulk query failed.");
      }
      completedBulk(status);
      const capturedAt = status.completedAt as string;
      const planCreatedAt = new Date().toISOString();
      await recordBulkPoll({ stage: "source", state, leaseValue });
      const download = await runtime.downloadCompletedCatalogue({ operationId: id, capturedAt });
      const plan = await prepareLaraPricingSalePlan({ catalogue: download.catalogue, createdAt: planCreatedAt });
      const next = await withEvent(
        state.checkpoint,
        {
          phase: "preparing",
          source: bulkFromDownload(
            state.checkpoint.source.requestedAt as string,
            status,
            capturedAt,
            download,
            state.checkpoint.source.pollCount,
          ),
          planCreatedAt,
          preparedPlanDigestSha256: plan.digestSha256,
          nextPreparationOrdinal: 0,
        },
        "source.catalogue_sealed",
      );
      await persist(state, leaseValue, next);
    }

    if (state.checkpoint.phase === "preparing") {
      await recordBulkPoll({ stage: "source", state, leaseValue });
      const { plan } = await preparePlanFromSource(runtime, state.checkpoint);
      // The private adapter is constructed only after this exact run has a
      // current claimed lease and never crosses the route boundary.
      const store = createLaraPricingArtifactStore({
        runId: state.run.id,
        leaseToken: leaseValue,
        leaseGeneration: state.run.lease_generation,
      });
      const nextOrdinal = await persistPreparationSlice({
        plan,
        store,
        startOrdinal: state.checkpoint.nextPreparationOrdinal,
      });
      if (nextOrdinal < plan.catalogue.products.length) {
        const next = await withEvent(
          state.checkpoint,
          { nextPreparationOrdinal: nextOrdinal },
          "plan.partitions_persisted",
        );
        await persist(state, leaseValue, next);
        await yieldRun(state.run, leaseValue, state.checkpoint);
        return result("in_progress", state.checkpoint);
      }
      const { root, rootRef } = await buildPersistedRoot(plan);
      await store.putImmutableJson({ ...rootRef, value: root });
      const execution = initialLaraPricingExecutionCheckpoint({
        runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
        rootRef,
        root,
        approvedPlanDigestSha256: root.digestSha256,
      });
      const next = await withEvent(
        state.checkpoint,
        {
          phase: "applying",
          nextPreparationOrdinal: nextOrdinal,
          rootRef,
          rootDigestSha256: root.digestSha256,
          execution,
        },
        "plan.root_approved",
      );
      await persist(state, leaseValue, next);
    }

    if (state.checkpoint.phase === "applying") {
      if (!state.checkpoint.rootDigestSha256) {
        throw new LaraPricingLiveRepairError("invalid_checkpoint", "The approved root digest is missing.");
      }
      const store = createLaraPricingArtifactStore({
        runId: state.run.id,
        leaseToken: leaseValue,
        leaseGeneration: state.run.lease_generation,
      });
      const coordinator = createCoordinator({ state, leaseValue });
      const slice = await executeLaraPricingSaleSlice({
        runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
        fence: leaseValue,
        approvedPlanDigestSha256: state.checkpoint.rootDigestSha256,
        store,
        coordinator,
        runtime,
      });
      if (slice.phase === "blocked") {
        const next = await withEvent(
          state.checkpoint,
          { phase: "blocked", blockedCode: slice.checkpoint.blockedCode },
          "execution.blocked",
          slice.checkpoint.blockedCode,
        );
        await persist(state, leaseValue, next);
        const failed = await commitBlockedRun(state, leaseValue, expected);
        return result("failed", state.checkpoint, failed.error_code);
      }
      if (slice.phase === "verification_pending") {
        const next = await withEvent(
          state.checkpoint,
          { phase: "verification_start_pending" },
          "verification.required",
        );
        await persist(state, leaseValue, next);
      } else {
        await yieldRun(state.run, leaseValue, state.checkpoint);
        return result("in_progress", state.checkpoint);
      }
    }

    if (
      state.checkpoint.phase === "verification_start_pending" ||
      state.checkpoint.phase === "verification_starting"
    ) {
      const advanced = await advanceBulkStart({
        stage: "verification", runtime, state, leaseValue,
      });
      if (advanced === "waiting") {
        await yieldRun(state.run, leaseValue, state.checkpoint, 30);
        return result("in_progress", state.checkpoint);
      }
    }

    if (state.checkpoint.phase === "verification_polling") {
      const id = await recordBulkPoll({
        stage: "verification",
        state,
        leaseValue,
      });
      const status = await runtime.pollCatalogueBulk(id);
      if (["CREATED", "RUNNING", "CANCELING"].includes(status.status)) {
        await yieldRun(state.run, leaseValue, state.checkpoint, 30);
        return result("in_progress", state.checkpoint);
      }
      if (status.status !== "COMPLETED") {
        throw new LaraPricingLiveRuntimeError("bulk_failed", "The verification bulk query failed.");
      }
      completedBulk(status);
      const capturedAt = status.completedAt as string;
      await recordBulkPoll({ stage: "verification", state, leaseValue });
      const download = await runtime.downloadCompletedCatalogue({ operationId: id, capturedAt });
      if (download.catalogue.counts.variantsWithCompareAt !== 0) {
        throw new LaraPricingLiveRepairError("verification_failed", "Compare-at prices remain after repair.");
      }
      const next = await withEvent(
        state.checkpoint,
        {
          phase: "verifying",
          verification: {
            ...bulkFromDownload(
              state.checkpoint.verification.requestedAt as string,
              status,
              capturedAt,
              download,
              state.checkpoint.verification.pollCount,
            ),
            nextSourceOrdinal: 0,
            missingSourceProducts: 0,
            missingSourceVariants: 0,
            sellingPriceDriftVariants: 0,
            vendorDriftProducts: 0,
            statusDriftProducts: 0,
            publicationDriftProducts: 0,
          },
        },
        "verification.catalogue_sealed",
      );
      await persist(state, leaseValue, next);
    }

    if (state.checkpoint.phase === "verifying") {
      const verification = state.checkpoint.verification;
      if (!verification.operationId || !verification.capturedAt || !state.checkpoint.rootRef) {
        throw new LaraPricingLiveRepairError("invalid_checkpoint", "Verification evidence is incomplete.");
      }
      await recordBulkPoll({ stage: "verification", state, leaseValue });
      const verificationAfterPoll = state.checkpoint.verification;
      const fresh = await runtime.downloadCompletedCatalogue({
        operationId: verification.operationId,
        capturedAt: verification.capturedAt,
      });
      assertSameDownload(verificationAfterPoll, fresh);
      if (fresh.catalogue.counts.variantsWithCompareAt !== 0) {
        throw new LaraPricingLiveRepairError("verification_failed", "Compare-at prices remain after repair.");
      }
      const store = createLaraPricingArtifactStore({
        runId: state.run.id,
        leaseToken: leaseValue,
        leaseGeneration: state.run.lease_generation,
      });
      const root = await loadLaraPricingPersistedRoot({ store, ref: state.checkpoint.rootRef });
      const slice = await verifySourceSlice({ root, store, fresh: fresh.catalogue, checkpoint: state.checkpoint });
      const nextVerification = {
        ...verificationAfterPoll,
        nextSourceOrdinal: slice.nextOrdinal,
        missingSourceProducts:
          verificationAfterPoll.missingSourceProducts + slice.missingProducts,
        missingSourceVariants:
          verificationAfterPoll.missingSourceVariants + slice.missingVariants,
        sellingPriceDriftVariants:
          verificationAfterPoll.sellingPriceDriftVariants + slice.priceDrift,
        vendorDriftProducts:
          verificationAfterPoll.vendorDriftProducts + slice.vendorDrift,
        statusDriftProducts:
          verificationAfterPoll.statusDriftProducts + slice.statusDrift,
        publicationDriftProducts:
          verificationAfterPoll.publicationDriftProducts +
          slice.publicationDrift,
      };
      if (
        nextVerification.missingSourceProducts > 0 ||
        nextVerification.missingSourceVariants > 0 ||
        nextVerification.sellingPriceDriftVariants > 0 ||
        nextVerification.vendorDriftProducts > 0 ||
        nextVerification.statusDriftProducts > 0 ||
        nextVerification.publicationDriftProducts > 0
      ) {
        throw new LaraPricingLiveRepairError(
          "verification_failed",
          "The fresh catalogue did not preserve every protected product, variant, selling price, vendor, status and publication field.",
        );
      }
      let next = await withEvent(
        state.checkpoint,
        { verification: nextVerification },
        "verification.source_prices_checked",
      );
      await persist(state, leaseValue, next);
      if (slice.nextOrdinal < root.productPartitions.length) {
        await yieldRun(state.run, leaseValue, state.checkpoint);
        return result("in_progress", state.checkpoint);
      }
      const proof: LaraPricingFinalVerification = {
        status: "verified",
        freshCatalogueDigestSha256: fresh.catalogue.digestSha256,
        freshProducts: fresh.catalogue.counts.products,
        freshVariants: fresh.catalogue.counts.variants,
        nonNullCompareAtVariants: 0,
        missingSourceProducts: 0,
        missingSourceVariants: 0,
        sellingPriceDriftVariants: 0,
        vendorDriftProducts: 0,
        statusDriftProducts: 0,
        publicationDriftProducts: 0,
        blockedCode: null,
      };
      await completeLaraPricingSaleVerification({
        runId: LARA_PRICING_LIVE_REPAIR_RUN_ID,
        fence: leaseValue,
        coordinator: createCoordinator({ state, leaseValue }),
        verification: proof,
      });
      next = await withEvent(state.checkpoint, { phase: "verified" }, "run.verified");
      await persist(state, leaseValue, next);
      const completed = await commitVerifiedRun(state, leaseValue);
      terminalCommitted = true;
      validateRun(completed, expected);
      validateTerminalRunState(completed);
      assertCheckpoint(completed.checkpoint, { schemaHash, manifestHash });
      await validateCompletedReplay(completed, completed.checkpoint);
      return result("completed", completed.checkpoint);
    }

    await yieldRun(state.run, leaseValue, state.checkpoint);
    return result("in_progress", state.checkpoint);
  } catch (error) {
    if (terminalCommitted) throw error;
    const classified = safeErrorCode(error);
    const failed = await failAuditShopifyRun({
      run: state.run,
      leaseToken: leaseValue,
      checkpoint: state.checkpoint as unknown as Record<string, unknown>,
      errorCode: classified.code,
      retryable: classified.retryable,
    });
    validateFailureTransition(failed, expected, classified.code);
    if (failed.state === "queued") {
      return result("in_progress", state.checkpoint, classified.code);
    }
    return result("failed", state.checkpoint, classified.code);
  }
}
