import "server-only";

import { z } from "zod";

import {
  prepareLaraShopifyRemediationRun,
  type PreparedShopifyRemediationRun,
  type ShopifyRemediationInverseOperation,
} from "./shopify-remediation-executor";
import {
  LARA_ROVINJ_REMEDIATION_SHOP,
  buildShopifyRemediationCas,
  canonicalRemediationJson,
  freezeRemediationValue,
  remediationSha256,
  sealShopifyRemediationPlan,
  verifyShopifyRemediationPlan,
  type DeepReadonly,
  type PageBeforeSnapshot,
  type PageRemediationCas,
  type PageReplaceOperation,
  type SealedShopifyRemediationPlan,
} from "./shopify-remediation-plan";

/**
 * The two low-risk trust pages explicitly approved for Lara Rovinj.
 *
 * The page ids, handles and titles came from the Shopify Admin baseline. The
 * replacement bodies deliberately contain no company number, VAT id, phone,
 * return address, trading-history claim or assertion about where products are
 * manufactured. The accepted store vendor/brand is outside this batch.
 */
export const LARA_TRUST_PAGE_TARGETS = Object.freeze([
  Object.freeze({
    key: "contact",
    resourceId: "gid://shopify/Page/697904923004",
    handle: "kontakt",
    title: "Kontakt",
  }),
  Object.freeze({
    key: "about",
    resourceId: "gid://shopify/Page/697974849916",
    handle: "o-nama",
    title: "O Nama",
  }),
] as const);

export const LARA_CONTACT_PAGE_BODY_HTML = `<p>Za pitanja o proizvodima, narudžbama, dostavi ili povratu obratite nam se e-poštom.</p>
<h2>Podaci o trgovcu</h2>
<p>Internetsku trgovinu <strong>Lara Rovinj</strong> vodi Marta Neto.</p>
<p><strong>Poslovna adresa</strong><br>Rua Capitão Manuel Tavares<br>3885-232 Cortegaça<br>Portugal</p>
<h2>E-pošta</h2>
<p><a href="mailto:info@lararovinj.com">info@lararovinj.com</a></p>
<p>Ako nam se obraćate u vezi s narudžbom, navedite broj narudžbe i e-adresu korištenu pri kupnji.</p>
<h2>Povrati</h2>
<p>Prije slanja proizvoda radi povrata javite nam se e-poštom kako biste dobili odgovarajuće upute. Nemojte slati povrat na navedenu poslovnu adresu bez prethodne potvrde.</p>`;

export const LARA_ABOUT_PAGE_BODY_HTML = `<p><strong>Lara Rovinj</strong> je internetska trgovina koju vodi Marta Neto iz Portugala.</p>
<p>Na ovoj stranici možete pregledavati proizvode iz aktualne ponude. Podaci važni za odluku o kupnji, uključujući opis proizvoda, cijenu, dostupne opcije, dostavu i povrate, nalaze se na odgovarajućim stranicama trgovine.</p>
<h2>Tko vodi trgovinu</h2>
<p>Marta Neto<br>Rua Capitão Manuel Tavares<br>3885-232 Cortegaça<br>Portugal</p>
<h2>Kontakt</h2>
<p>Za pitanja nam pišite na <a href="mailto:info@lararovinj.com">info@lararovinj.com</a>.</p>`;

const BODY_BY_KEY = Object.freeze({
  contact: LARA_CONTACT_PAGE_BODY_HTML,
  about: LARA_ABOUT_PAGE_BODY_HTML,
} as const);

export const LARA_TRUST_NAVIGATION_ASSESSMENT = freezeRemediationValue({
  status: "blocked_missing_exact_snapshot" as const,
  candidateMenus: ["footer", "main"] as const,
  desiredLinks: [
    { title: "Kontakt", resourceId: LARA_TRUST_PAGE_TARGETS[0].resourceId },
    { title: "O Nama", resourceId: LARA_TRUST_PAGE_TARGETS[1].resourceId },
  ],
  reason:
    "No exact target menu ids and complete ordered item snapshots were approved for this batch. A generic menu replacement could overwrite unrelated navigation.",
  requiredBeforePlanning: [
    "Exact menu resource id and handle",
    "Complete ordered menu tree immediately before the change",
    "A precise insertion position for each missing link",
    "A reversible full-tree inverse guarded by a current-state digest",
  ],
});

const pageStateSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().max(255),
    handle: z.string().min(1).max(255),
    bodyHtml: z.string().max(1_000_000),
    templateSuffix: z.string().max(255).nullable(),
    isPublished: z.boolean(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type LaraTrustPageState = z.output<typeof pageStateSchema>;

type LaraTrustPageTarget = (typeof LARA_TRUST_PAGE_TARGETS)[number];

export type LaraTrustPageReader = Readonly<{
  readPages(input: {
    shop: typeof LARA_ROVINJ_REMEDIATION_SHOP;
    resourceIds: readonly string[];
  }): Promise<readonly LaraTrustPageState[]>;
}>;

export type LaraTrustPageWriteExpectation = DeepReadonly<{
  updatedAt: string;
  bodySha256: string;
  protectedFieldsSha256: string;
}>;

export type LaraTrustPageWriteCommand = DeepReadonly<{
  shop: typeof LARA_ROVINJ_REMEDIATION_SHOP;
  target: { resourceId: string; handle: string };
  expected: LaraTrustPageWriteExpectation;
  bodyHtml: string;
}>;

/**
 * A concrete adapter must implement this as an optimistic compare-and-set:
 * re-read the page, reject when any expectation differs, and submit only the
 * `body` field to Shopify's partial `pageUpdate` mutation. This module never
 * imports credentials, a connected runtime, fetch, a route or a job trigger.
 */
export type LaraTrustPageWriter = Readonly<{
  replaceBodyIfUnchanged(
    command: LaraTrustPageWriteCommand,
  ): Promise<
    | { status: "written"; before: LaraTrustPageState; after: LaraTrustPageState }
    | { status: "cas_mismatch"; current: LaraTrustPageState }
    | { status: "failed"; errorCode: string }
  >;
}>;

type LaraTrustPageWriteResult = Awaited<
  ReturnType<LaraTrustPageWriter["replaceBodyIfUnchanged"]>
>;

export type PreparedLaraTrustPageBatch = DeepReadonly<{
  plan: SealedShopifyRemediationPlan;
  dryRun: PreparedShopifyRemediationRun;
  navigationAssessment: typeof LARA_TRUST_NAVIGATION_ASSESSMENT;
}>;

export type LaraTrustPageBatchExecutionStatus =
  | "dry_run_complete"
  | "blocked_precondition"
  | "apply_complete"
  | "apply_failed_rolled_back"
  | "apply_failed_rollback_incomplete";

export type LaraTrustPageBatchExecutionResult = DeepReadonly<{
  status: LaraTrustPageBatchExecutionStatus;
  planDigestSha256: string;
  writesAttempted: number;
  writesCompleted: number;
  rollbacksAttempted: number;
  rollbacksCompleted: number;
  blockedOperationId: string | null;
  blockCode: string | null;
}>;

export class LaraTrustPageBatchError extends Error {
  constructor(
    public readonly code:
      | "invalid_page_snapshot"
      | "missing_page"
      | "unexpected_page"
      | "page_identity_mismatch"
      | "invalid_prepared_batch"
      | "approval_digest_mismatch"
      | "writer_required",
    message: string,
  ) {
    super(message);
    this.name = "LaraTrustPageBatchError";
  }
}

function expectedTarget(resourceId: string): LaraTrustPageTarget | null {
  return (
    LARA_TRUST_PAGE_TARGETS.find((target) => target.resourceId === resourceId) ?? null
  );
}

function parsePageState(input: unknown): LaraTrustPageState {
  const parsed = pageStateSchema.safeParse(input);
  if (!parsed.success) {
    throw new LaraTrustPageBatchError(
      "invalid_page_snapshot",
      "Shopify returned an invalid trust-page snapshot.",
    );
  }
  return parsed.data;
}

function assertPageIdentity(
  state: LaraTrustPageState,
  target: LaraTrustPageTarget,
): void {
  if (
    state.id !== target.resourceId ||
    state.handle !== target.handle ||
    state.title !== target.title
  ) {
    throw new LaraTrustPageBatchError(
      "page_identity_mismatch",
      `The ${target.key} page no longer matches the approved id, handle and title.`,
    );
  }
}

async function readExactPages(
  reader: LaraTrustPageReader,
  resourceIds: readonly string[] = LARA_TRUST_PAGE_TARGETS.map(
    (target) => target.resourceId,
  ),
): Promise<LaraTrustPageState[]> {
  const raw = await reader.readPages({
    shop: LARA_ROVINJ_REMEDIATION_SHOP,
    resourceIds,
  });
  const pages = raw.map(parsePageState);
  const byId = new Map<string, LaraTrustPageState>();

  for (const page of pages) {
    const target = expectedTarget(page.id);
    if (!target || !resourceIds.includes(page.id)) {
      throw new LaraTrustPageBatchError(
        "unexpected_page",
        "The trust-page reader returned a page outside the exact approved target set.",
      );
    }
    if (byId.has(page.id)) {
      throw new LaraTrustPageBatchError(
        "unexpected_page",
        "The trust-page reader returned a duplicate page snapshot.",
      );
    }
    assertPageIdentity(page, target);
    byId.set(page.id, page);
  }

  return resourceIds.map((resourceId) => {
    const page = byId.get(resourceId);
    if (!page) {
      throw new LaraTrustPageBatchError(
        "missing_page",
        "Shopify did not return every exact approved trust page.",
      );
    }
    return page;
  });
}

function beforeSnapshot(
  state: LaraTrustPageState,
  capturedAt: string,
): PageBeforeSnapshot {
  return {
    kind: "page",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    capturedAt,
    target: { resourceId: state.id, handle: state.handle },
    state: {
      title: state.title,
      bodyHtml: state.bodyHtml,
      templateSuffix: state.templateSuffix,
      isPublished: state.isPublished,
      publishedAt: state.publishedAt,
      updatedAt: state.updatedAt,
    },
  };
}

async function operationForSnapshot(
  snapshot: PageBeforeSnapshot,
): Promise<PageReplaceOperation> {
  const target = expectedTarget(snapshot.target.resourceId);
  if (!target) {
    throw new LaraTrustPageBatchError(
      "unexpected_page",
      "A trust-page operation targeted an unapproved page.",
    );
  }
  return {
    operationId: `lara-${target.key}-trust-copy`,
    kind: "page.replace_body",
    reason: `Replace only the ${target.key} body with the merchant-approved business identity and contact copy.`,
    evidenceRefs: [
      "merchant:identity:marta-neto",
      `shopify-admin-baseline:${target.resourceId}`,
    ],
    target: snapshot.target,
    cas: (await buildShopifyRemediationCas(snapshot)) as PageRemediationCas,
    change: { bodyHtml: BODY_BY_KEY[target.key] },
  };
}

export async function prepareLaraTrustPageBatch({
  reader,
  runId,
  occurredAt,
}: {
  reader: LaraTrustPageReader;
  runId: string;
  occurredAt: string;
}): Promise<PreparedLaraTrustPageBatch> {
  const pages = await readExactPages(reader);
  const snapshots = pages.map((page) => beforeSnapshot(page, occurredAt));
  const operations = await Promise.all(snapshots.map(operationForSnapshot));
  const plan = await sealShopifyRemediationPlan({
    planId: "lara-trust-pages-contact-about-v1",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    createdAt: occurredAt,
    purpose:
      "Prepare the exact Contact and About trust-copy replacement while preserving every non-body page field.",
    executionMode: "dry-run",
    operations,
  });
  const dryRun = await prepareLaraShopifyRemediationRun({
    sealedPlan: plan,
    snapshots,
    runId,
    occurredAt,
  });
  if (dryRun.status !== "dry_run_complete" || !dryRun.inverseManifest) {
    throw new LaraTrustPageBatchError(
      "invalid_prepared_batch",
      "The Contact and About plan did not pass its immutable dry-run preconditions.",
    );
  }
  return freezeRemediationValue({
    plan,
    dryRun,
    navigationAssessment: LARA_TRUST_NAVIGATION_ASSESSMENT,
  });
}

async function protectedFieldsSha256(cas: PageRemediationCas): Promise<string> {
  return remediationSha256(cas.protectedFields);
}

async function writeExpectation(
  snapshot: PageBeforeSnapshot,
): Promise<LaraTrustPageWriteExpectation> {
  const cas = (await buildShopifyRemediationCas(snapshot)) as PageRemediationCas;
  return freezeRemediationValue({
    updatedAt: cas.expectedUpdatedAt,
    bodySha256: await remediationSha256(snapshot.state.bodyHtml),
    protectedFieldsSha256: await protectedFieldsSha256(cas),
  });
}

async function operationCasMatchesState(
  operation: PageReplaceOperation,
  state: LaraTrustPageState,
): Promise<boolean> {
  const actual = (await buildShopifyRemediationCas(
    beforeSnapshot(state, state.updatedAt),
  )) as PageRemediationCas;
  return canonicalRemediationJson(actual) === canonicalRemediationJson(operation.cas);
}

async function protectedStateMatchesOperation(
  operation: PageReplaceOperation,
  state: LaraTrustPageState,
): Promise<boolean> {
  const actual = (await buildShopifyRemediationCas(
    beforeSnapshot(state, state.updatedAt),
  )) as PageRemediationCas;
  return (
    canonicalRemediationJson(actual.protectedFields) ===
    canonicalRemediationJson(operation.cas.protectedFields)
  );
}

async function verifyPreparedBatch(
  prepared: PreparedLaraTrustPageBatch,
): Promise<{
  plan: SealedShopifyRemediationPlan;
  inverse: NonNullable<PreparedShopifyRemediationRun["inverseManifest"]>;
}> {
  const plan = await verifyShopifyRemediationPlan(prepared.plan);
  const inverse = prepared.dryRun.inverseManifest;
  if (
    prepared.dryRun.status !== "dry_run_complete" ||
    !inverse ||
    inverse.payload.sourcePlanDigestSha256 !== plan.digestSha256 ||
    inverse.digestSha256 !== (await remediationSha256(inverse.payload)) ||
    plan.payload.operations.length !== LARA_TRUST_PAGE_TARGETS.length ||
    plan.payload.operations.some((operation) => operation.kind !== "page.replace_body")
  ) {
    throw new LaraTrustPageBatchError(
      "invalid_prepared_batch",
      "The prepared trust-page plan or its inverse is invalid.",
    );
  }
  return { plan, inverse };
}

function executionResult(
  value: Omit<LaraTrustPageBatchExecutionResult, "planDigestSha256">,
  planDigestSha256: string,
): LaraTrustPageBatchExecutionResult {
  return freezeRemediationValue({ ...value, planDigestSha256 });
}

async function rollbackWrittenPages({
  reader,
  writer,
  operations,
  inverseOperations,
  writtenAfter,
}: {
  reader: LaraTrustPageReader;
  writer: LaraTrustPageWriter;
  operations: readonly PageReplaceOperation[];
  inverseOperations: readonly ShopifyRemediationInverseOperation[];
  writtenAfter: ReadonlyMap<string, LaraTrustPageState>;
}): Promise<{ attempted: number; completed: number }> {
  let attempted = 0;
  let completed = 0;
  for (const operation of [...operations].reverse()) {
    const after = writtenAfter.get(operation.operationId);
    if (!after) continue;
    const inverse = inverseOperations.find(
      (candidate) => candidate.originalOperationId === operation.operationId,
    );
    if (!inverse || inverse.kind !== "page.restore_body") continue;
    attempted += 1;
    const afterSnapshot = beforeSnapshot(after, after.updatedAt);
    const result = await callWriterSafely(writer, {
      shop: LARA_ROVINJ_REMEDIATION_SHOP,
      target: inverse.target,
      expected: await writeExpectation(afterSnapshot),
      bodyHtml: inverse.restore.bodyHtml,
    });
    if (
      result.status === "written" &&
      result.after.bodyHtml === inverse.restore.bodyHtml &&
      (await protectedStateMatchesOperation(operation, result.after))
    ) {
      completed += 1;
      continue;
    }
    // A network exception can happen after Shopify accepted the mutation. A
    // fresh read is the only safe way to distinguish that case from failure;
    // never issue a second blind restore.
    try {
      const [observed] = await readExactPages(reader, [operation.target.resourceId]);
      if (
        observed?.bodyHtml === inverse.restore.bodyHtml &&
        (await protectedStateMatchesOperation(operation, observed))
      ) {
        completed += 1;
      }
    } catch {
      // Keep this rollback incomplete. The caller receives a fail-closed
      // result and can inspect the store before any further attempt.
    }
  }
  return { attempted, completed };
}

async function callWriterSafely(
  writer: LaraTrustPageWriter,
  command: LaraTrustPageWriteCommand,
): Promise<LaraTrustPageWriteResult> {
  try {
    return await writer.replaceBodyIfUnchanged(command);
  } catch {
    return { status: "failed", errorCode: "ADAPTER_THROW" };
  }
}

/**
 * Revalidates the exact page CAS before doing anything. `dry-run` never
 * requires or calls a writer. `apply` additionally requires the caller to
 * echo the sealed plan digest and inject a CAS-aware partial-body writer.
 */
export async function executeLaraTrustPageBatch({
  prepared,
  reader,
  mode = "dry-run",
  approvedPlanDigestSha256,
  writer,
}: {
  prepared: PreparedLaraTrustPageBatch;
  reader: LaraTrustPageReader;
  mode?: "dry-run" | "apply";
  approvedPlanDigestSha256?: string;
  writer?: LaraTrustPageWriter;
}): Promise<LaraTrustPageBatchExecutionResult> {
  const { plan, inverse } = await verifyPreparedBatch(prepared);
  if (mode === "apply" && approvedPlanDigestSha256 !== plan.digestSha256) {
    throw new LaraTrustPageBatchError(
      "approval_digest_mismatch",
      "Apply requires the exact digest of the reviewed immutable plan.",
    );
  }
  if (mode === "apply" && !writer) {
    throw new LaraTrustPageBatchError(
      "writer_required",
      "Apply requires an explicitly injected CAS-aware page writer.",
    );
  }

  const operations = plan.payload.operations as readonly PageReplaceOperation[];
  const preflight = await readExactPages(reader);
  for (const operation of operations) {
    const state = preflight.find((page) => page.id === operation.target.resourceId);
    if (!state || !(await operationCasMatchesState(operation, state))) {
      return executionResult(
        {
          status: "blocked_precondition",
          writesAttempted: 0,
          writesCompleted: 0,
          rollbacksAttempted: 0,
          rollbacksCompleted: 0,
          blockedOperationId: operation.operationId,
          blockCode: "PAGE_CAS_MISMATCH",
        },
        plan.digestSha256,
      );
    }
  }

  if (mode === "dry-run") {
    return executionResult(
      {
        status: "dry_run_complete",
        writesAttempted: 0,
        writesCompleted: 0,
        rollbacksAttempted: 0,
        rollbacksCompleted: 0,
        blockedOperationId: null,
        blockCode: null,
      },
      plan.digestSha256,
    );
  }

  const connectedWriter = writer as LaraTrustPageWriter;
  const writtenAfter = new Map<string, LaraTrustPageState>();
  let writesAttempted = 0;
  let writesCompleted = 0;

  for (const operation of operations) {
    const [current] = await readExactPages(reader, [operation.target.resourceId]);
    if (!current || !(await operationCasMatchesState(operation, current))) {
      const rollback = await rollbackWrittenPages({
        reader,
        writer: connectedWriter,
        operations,
        inverseOperations: inverse.payload.operations,
        writtenAfter,
      });
      return executionResult(
        {
          status:
            rollback.attempted === rollback.completed
              ? "apply_failed_rolled_back"
              : "apply_failed_rollback_incomplete",
          writesAttempted,
          writesCompleted,
          rollbacksAttempted: rollback.attempted,
          rollbacksCompleted: rollback.completed,
          blockedOperationId: operation.operationId,
          blockCode: "PAGE_CAS_MISMATCH",
        },
        plan.digestSha256,
      );
    }

    writesAttempted += 1;
    const write = await callWriterSafely(connectedWriter, {
      shop: LARA_ROVINJ_REMEDIATION_SHOP,
      target: operation.target,
      expected: await writeExpectation(beforeSnapshot(current, current.updatedAt)),
      bodyHtml: operation.change.bodyHtml,
    });
    let blockCode: string | null = null;
    if (write.status === "cas_mismatch") blockCode = "WRITER_CAS_MISMATCH";
    if (write.status === "failed") blockCode = `WRITER_${write.errorCode}`;
    if (write.status === "written") {
      const beforeMatches = await operationCasMatchesState(operation, write.before);
      const protectedAfter = await protectedStateMatchesOperation(operation, write.after);
      if (
        !beforeMatches ||
        write.after.id !== operation.target.resourceId ||
        write.after.bodyHtml !== operation.change.bodyHtml ||
        !protectedAfter
      ) {
        blockCode = "WRITE_VERIFICATION_FAILED";
        writtenAfter.set(operation.operationId, write.after);
      } else {
        writesCompleted += 1;
        writtenAfter.set(operation.operationId, write.after);
        continue;
      }
    }

    let unresolvedWrite = false;
    if (write.status !== "written") {
      try {
        const [observed] = await readExactPages(reader, [operation.target.resourceId]);
        if (
          observed?.bodyHtml === operation.change.bodyHtml &&
          (await protectedStateMatchesOperation(operation, observed))
        ) {
          // The adapter may have lost its response after Shopify accepted the
          // mutation. Treat it as changed only for the purpose of restoring the
          // reviewed inverse; never continue forward from an uncertain write.
          writtenAfter.set(operation.operationId, observed);
        } else if (!observed || !(await operationCasMatchesState(operation, observed))) {
          unresolvedWrite = true;
        }
      } catch {
        unresolvedWrite = true;
      }
    }

    const rollback = await rollbackWrittenPages({
      reader,
      writer: connectedWriter,
      operations,
      inverseOperations: inverse.payload.operations,
      writtenAfter,
    });
    return executionResult(
      {
        status:
          !unresolvedWrite && rollback.attempted === rollback.completed
            ? "apply_failed_rolled_back"
            : "apply_failed_rollback_incomplete",
        writesAttempted,
        writesCompleted,
        rollbacksAttempted: rollback.attempted,
        rollbacksCompleted: rollback.completed,
        blockedOperationId: operation.operationId,
        blockCode,
      },
      plan.digestSha256,
    );
  }

  return executionResult(
    {
      status: "apply_complete",
      writesAttempted,
      writesCompleted,
      rollbacksAttempted: 0,
      rollbacksCompleted: 0,
      blockedOperationId: null,
      blockCode: null,
    },
    plan.digestSha256,
  );
}
