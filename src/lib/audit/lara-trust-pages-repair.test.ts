import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  claim: vi.fn(),
  renew: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  get: vi.fn(),
}));

vi.mock("./shopify-runs", () => {
  class AuditShopifyRunError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    AuditShopifyRunError,
    enqueueAuditShopifyRun: runMocks.enqueue,
    claimAuditShopifyRun: runMocks.claim,
    renewAuditShopifyRun: runMocks.renew,
    completeAuditShopifyRun: runMocks.complete,
    failAuditShopifyRun: runMocks.fail,
    getAuditShopifyRun: runMocks.get,
  };
});

vi.mock("./lara-trust-pages-runtime", () => {
  class LaraTrustPagesRuntimeError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    createLaraTrustPagesRuntime: vi.fn(),
    LaraTrustPagesRuntimeError,
    LARA_TRUST_PAGES_GRAPHQL_MANIFEST: {
      pages: "fixed-page-query",
      replaceBody: "fixed-page-update",
    },
  };
});

import {
  LARA_ABOUT_PAGE_BODY_HTML,
  LARA_CONTACT_PAGE_BODY_HTML,
  LARA_TRUST_PAGE_TARGETS,
  type LaraTrustPageState,
} from "./lara-trust-pages";
import {
  buildLaraTrustPagesDryRun,
  executeLaraTrustPagesRepair,
  LARA_TRUST_PAGES_REPAIR_RUN_ID,
  runLaraTrustPagesRepairOneShot,
} from "./lara-trust-pages-repair";
import {
  LaraTrustPagesRuntimeError as RuntimeError,
  type LaraTrustPagesRuntime,
} from "./lara-trust-pages-runtime";
import {
  buildShopifyRemediationCas,
  remediationSha256,
  type PageBeforeSnapshot,
  type PageRemediationCas,
} from "./shopify-remediation-plan";
import type { AuditShopifyRun } from "@/lib/supabase/types";

const AT = "2026-08-12T20:10:00.000Z";
const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const LEASE_TOKEN = "20000000-0000-4000-8000-000000000002";

function initialStates() {
  return new Map<string, LaraTrustPageState>([
    [
      LARA_TRUST_PAGE_TARGETS[0].resourceId,
      {
        id: LARA_TRUST_PAGE_TARGETS[0].resourceId,
        title: LARA_TRUST_PAGE_TARGETS[0].title,
        handle: LARA_TRUST_PAGE_TARGETS[0].handle,
        bodyHtml: "",
        templateSuffix: "contact",
        isPublished: true,
        publishedAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:00.000Z",
      },
    ],
    [
      LARA_TRUST_PAGE_TARGETS[1].resourceId,
      {
        id: LARA_TRUST_PAGE_TARGETS[1].resourceId,
        title: LARA_TRUST_PAGE_TARGETS[1].title,
        handle: LARA_TRUST_PAGE_TARGETS[1].handle,
        bodyHtml: "<p>Old About copy.</p>",
        templateSuffix: null,
        isPublished: true,
        publishedAt: "2026-08-01T11:00:00.000Z",
        updatedAt: "2026-08-11T11:00:00.000Z",
      },
    ],
  ]);
}

function snapshot(page: LaraTrustPageState): PageBeforeSnapshot {
  return {
    kind: "page",
    shop: {
      domain: "jwmtjg-fm.myshopify.com",
      shopId: "gid://shopify/Shop/95462097276",
    },
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

async function protectedDigest(page: LaraTrustPageState) {
  const cas = (await buildShopifyRemediationCas(snapshot(page))) as PageRemediationCas;
  return remediationSha256(cas.protectedFields);
}

function fakeRuntime(
  store = initialStates(),
  options: {
    failId?: string;
    casMismatchId?: string;
    concurrentDesiredId?: string;
    throwAfterId?: string;
    genericThrowAfterId?: string;
    throwOnRestoreId?: string;
  } = {},
) {
  let revision = 0;
  const originalBodies = new Map(
    [...store.entries()].map(([id, page]) => [id, page.bodyHtml] as const),
  );
  const writes: Array<{ resourceId: string; bodyHtml: string }> = [];
  const runtime: LaraTrustPagesRuntime = {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopId: "gid://shopify/Shop/95462097276",
    shopDomain: "jwmtjg-fm.myshopify.com",
    async readPages({ shop, resourceIds }) {
      expect(shop).toEqual({
        domain: "jwmtjg-fm.myshopify.com",
        shopId: "gid://shopify/Shop/95462097276",
      });
      return resourceIds
        .map((id) => store.get(id))
        .filter((page): page is LaraTrustPageState => Boolean(page))
        .map((page) => structuredClone(page));
    },
    async replaceBodyIfUnchanged(command) {
      const current = store.get(command.target.resourceId);
      if (!current) return { status: "failed", errorCode: "PAGE_NOT_FOUND" };
      if (options.concurrentDesiredId === current.id) {
        revision += 1;
        store.set(current.id, {
          ...structuredClone(current),
          bodyHtml: command.bodyHtml,
          updatedAt: `2026-08-12T21:${String(revision).padStart(2, "0")}:00.000Z`,
        });
      }
      if (options.failId === current.id) {
        return { status: "failed", errorCode: "SIMULATED" };
      }
      if (options.casMismatchId === current.id) {
        return {
          status: "cas_mismatch",
          current: structuredClone(store.get(current.id) ?? current),
        };
      }
      if (
        command.expected.updatedAt !== current.updatedAt ||
        command.expected.bodySha256 !== (await remediationSha256(current.bodyHtml)) ||
        command.expected.protectedFieldsSha256 !== (await protectedDigest(current))
      ) {
        return { status: "cas_mismatch", current: structuredClone(current) };
      }
      const before = structuredClone(current);
      revision += 1;
      const after = {
        ...structuredClone(current),
        bodyHtml: command.bodyHtml,
        updatedAt: `2026-08-12T20:${String(revision).padStart(2, "0")}:00.000Z`,
      };
      writes.push({ resourceId: after.id, bodyHtml: after.bodyHtml });
      store.set(after.id, after);
      if (options.throwAfterId === current.id && command.bodyHtml !== before.bodyHtml) {
        throw new RuntimeError("mutation_ambiguous", "lost apply response");
      }
      if (
        options.genericThrowAfterId === current.id &&
        command.bodyHtml !== before.bodyHtml
      ) {
        throw new Error("unexpected adapter error");
      }
      if (
        options.throwOnRestoreId === current.id &&
        command.bodyHtml === originalBodies.get(current.id) &&
        command.bodyHtml !== before.bodyHtml
      ) {
        throw new RuntimeError("mutation_ambiguous", "lost restore response");
      }
      return { status: "written", before, after: structuredClone(after) };
    },
  };
  return { runtime, store, writes };
}

function claimedRun(
  manifestHash: string,
  checkpoint: Record<string, unknown> = {},
  schemaHash = "a".repeat(64),
) {
  return {
    id: LARA_TRUST_PAGES_REPAIR_RUN_ID,
    connection_id: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    requested_by: ADMIN_ID,
    requested_actor_type: "system" as const,
    shopify_domain: "jwmtjg-fm.myshopify.com",
    state: "running" as const,
    requested_source: "system.trust_pages_repair",
    requested_note: "Authorised Lara Contact/About body repair with exact rollback material",
    schema_hash: schemaHash,
    manifest_hash: manifestHash,
    checkpoint,
    artifact: null,
    attempt_count: 1,
    retry_count: 0,
    max_retries: 2,
    next_attempt_at: null,
    lease_token: LEASE_TOKEN,
    lease_generation: 1,
    lease_acquired_at: AT,
    lease_renewed_at: AT,
    lease_expires_at: "2026-08-12T20:15:00.000Z",
    error_code: null,
    created_at: AT,
    updated_at: AT,
    started_at: AT,
    completed_at: null,
    failed_at: null,
  };
}

async function executeWith(runtime: LaraTrustPagesRuntime, oneShot = false) {
  const dryRun = await buildLaraTrustPagesDryRun({ runtime });
  let run: AuditShopifyRun = claimedRun(dryRun.planDigestSha256);
  let exists = false;
  runMocks.get.mockImplementation(async () => (exists ? run : null));
  runMocks.enqueue.mockImplementation(async (input) => {
    exists = true;
    run = {
      ...run,
      requested_by: input.requestedBy,
      requested_actor_type: input.actorType,
      requested_source: input.source,
      requested_note: input.note,
      schema_hash: input.schemaHash,
      manifest_hash: input.manifestHash,
      max_retries: input.maxRetries,
      state: "queued" as const,
      next_attempt_at: AT,
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    };
    return LARA_TRUST_PAGES_REPAIR_RUN_ID;
  });
  runMocks.claim.mockImplementation(async () => {
    run = {
      ...run,
      state: "running" as const,
      next_attempt_at: null,
      lease_token: LEASE_TOKEN,
      lease_acquired_at: AT,
      lease_renewed_at: AT,
      lease_expires_at: "2026-08-12T20:15:00.000Z",
    };
    return run;
  });
  runMocks.renew.mockImplementation(async ({ checkpoint }) => {
    run = { ...run, checkpoint };
    return run;
  });
  runMocks.complete.mockImplementation(async ({ checkpoint, artifact }) => {
    run = {
      ...run,
      state: "completed" as const,
      checkpoint,
      artifact,
      completed_at: AT,
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    };
    return run;
  });
  runMocks.fail.mockImplementation(async ({ checkpoint, errorCode, retryable }) => {
    run = {
      ...run,
      state: retryable ? ("queued" as const) : ("failed" as const),
      checkpoint,
      error_code: errorCode,
      failed_at: retryable ? null : AT,
      next_attempt_at: retryable ? AT : null,
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    };
    return run;
  });
  const result = oneShot
    ? await runLaraTrustPagesRepairOneShot({
        requestedBy: ADMIN_ID,
        leaseToken: LEASE_TOKEN,
        runtime,
        now: () => new Date(AT),
      })
    : await executeLaraTrustPagesRepair({
        approvedPlanDigestSha256: dryRun.planDigestSha256,
        requestedBy: ADMIN_ID,
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        leaseToken: LEASE_TOKEN,
        runtime,
        now: () => new Date(AT),
      });
  return { dryRun, result, run: () => run };
}

async function resumeWithCheckpoint({
  runtime,
  dryRun,
  sourceRun,
  checkpoint,
}: {
  runtime: LaraTrustPagesRuntime;
  dryRun: Awaited<ReturnType<typeof buildLaraTrustPagesDryRun>>;
  sourceRun: AuditShopifyRun;
  checkpoint: Record<string, unknown>;
}) {
  vi.clearAllMocks();
  let run: AuditShopifyRun = {
    ...sourceRun,
    state: "running",
    checkpoint: structuredClone(checkpoint),
    artifact: null,
    attempt_count: sourceRun.attempt_count + 1,
    lease_generation: sourceRun.lease_generation + 1,
    lease_token: LEASE_TOKEN,
    lease_acquired_at: AT,
    lease_renewed_at: AT,
    lease_expires_at: "2026-08-12T20:15:00.000Z",
    next_attempt_at: null,
    error_code: null,
    completed_at: null,
    failed_at: null,
  };
  runMocks.get.mockImplementation(async () => run);
  runMocks.claim.mockImplementation(async () => run);
  runMocks.renew.mockImplementation(async ({ checkpoint: nextCheckpoint }) => {
    run = { ...run, checkpoint: nextCheckpoint };
    return run;
  });
  runMocks.complete.mockImplementation(async ({ checkpoint: nextCheckpoint, artifact }) => {
    run = {
      ...run,
      state: "completed",
      checkpoint: nextCheckpoint,
      artifact,
      completed_at: AT,
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    };
    return run;
  });
  runMocks.fail.mockImplementation(
    async ({ checkpoint: nextCheckpoint, errorCode, retryable }) => {
      run = {
        ...run,
        state: retryable ? "queued" : "failed",
        checkpoint: nextCheckpoint,
        error_code: errorCode,
        next_attempt_at: retryable ? AT : null,
        failed_at: retryable ? null : AT,
        lease_token: null,
        lease_acquired_at: null,
        lease_renewed_at: null,
        lease_expires_at: null,
      };
      return run;
    },
  );
  const result = await executeLaraTrustPagesRepair({
    approvedPlanDigestSha256: dryRun.planDigestSha256,
    requestedBy: ADMIN_ID,
    runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
    leaseToken: LEASE_TOKEN,
    runtime,
    now: () => new Date(AT),
  });
  return { result, run: () => run };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the durable Lara trust-pages repair", () => {
  it("builds a stable server-owned dry run with exact backup and zero writes", async () => {
    const fixture = fakeRuntime();
    const first = await buildLaraTrustPagesDryRun({ runtime: fixture.runtime });
    const second = await buildLaraTrustPagesDryRun({ runtime: fixture.runtime });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
      mode: "dry-run",
      writesAttempted: 0,
      operations: [
        { resourceId: LARA_TRUST_PAGE_TARGETS[0].resourceId, handle: "kontakt" },
        { resourceId: LARA_TRUST_PAGE_TARGETS[1].resourceId, handle: "o-nama" },
      ],
    });
    expect(fixture.writes).toEqual([]);
  });

  it("checkpoints exact before/inverse material, writes one page at a time, and verifies both", async () => {
    const fixture = fakeRuntime();
    const { dryRun, result } = await executeWith(fixture.runtime);

    expect(result).toMatchObject({
      state: "completed",
      status: "verified",
      planDigestSha256: dryRun.planDigestSha256,
      verifiedCount: 2,
    });
    expect(fixture.writes).toEqual([
      {
        resourceId: LARA_TRUST_PAGE_TARGETS[0].resourceId,
        bodyHtml: LARA_CONTACT_PAGE_BODY_HTML,
      },
      {
        resourceId: LARA_TRUST_PAGE_TARGETS[1].resourceId,
        bodyHtml: LARA_ABOUT_PAGE_BODY_HTML,
      },
    ]);
    expect(runMocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        actorType: "system",
        maxRetries: 2,
        manifestHash: dryRun.planDigestSha256,
      }),
    );
    const firstCheckpoint = runMocks.renew.mock.calls[0]![0].checkpoint;
    expect(firstCheckpoint).toMatchObject({
      schemaVersion: "lara-trust-pages-repair.v1",
      material: {
        plan: { digestSha256: dryRun.planDigestSha256 },
        inverse: { digestSha256: dryRun.inverseDigestSha256 },
        beforeSnapshots: [
          expect.objectContaining({ state: expect.objectContaining({ bodyHtml: "" }) }),
          expect.objectContaining({
            state: expect.objectContaining({ bodyHtml: "<p>Old About copy.</p>" }),
          }),
        ],
      },
    });
    const artifact = runMocks.complete.mock.calls[0]![0].artifact;
    expect(artifact).toMatchObject({
      status: "verified",
      verifiedCount: 2,
      mutationFields: ["id", "body"],
      inverse: { digestSha256: dryRun.inverseDigestSha256 },
    });
    expect(JSON.stringify(artifact)).not.toContain("262");
    expect(new TextEncoder().encode(JSON.stringify(firstCheckpoint)).byteLength).toBeLessThan(
      60_000,
    );
  });

  it("generates dry-run evidence and applies it within one machine invocation", async () => {
    const fixture = fakeRuntime();
    const { dryRun, result } = await executeWith(fixture.runtime, true);

    expect(result).toMatchObject({
      state: "completed",
      status: "verified",
      planDigestSha256: dryRun.planDigestSha256,
      verifiedCount: 2,
    });
    expect(runMocks.get).toHaveBeenCalledWith({
      runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
      shopDomain: "jwmtjg-fm.myshopify.com",
    });
    expect(runMocks.enqueue).toHaveBeenCalledOnce();
    expect(fixture.writes).toHaveLength(2);
  });

  it("reconciles a lost mutation response and still completes exactly once", async () => {
    const fixture = fakeRuntime(initialStates(), {
      throwAfterId: LARA_TRUST_PAGE_TARGETS[0].resourceId,
    });
    const { result } = await executeWith(fixture.runtime);

    expect(result.state).toBe("completed");
    expect(fixture.writes).toHaveLength(2);
    expect(JSON.stringify(runMocks.complete.mock.calls[0]![0].artifact.journal)).toContain(
      "operation.reconciled",
    );
  });

  it("never attributes or restores a definite rejection that coincides with desired live copy", async () => {
    const contactId = LARA_TRUST_PAGE_TARGETS[0].resourceId;
    const fixture = fakeRuntime(initialStates(), {
      failId: contactId,
      concurrentDesiredId: contactId,
    });
    const { result } = await executeWith(fixture.runtime);

    expect(result).toMatchObject({
      state: "in_progress",
      status: "rollback_incomplete",
      errorCode: "repair_failed",
    });
    expect(fixture.store.get(contactId)?.bodyHtml).toBe(LARA_CONTACT_PAGE_BODY_HTML);
    expect(fixture.writes).toEqual([]);
    const failedCheckpoint = runMocks.fail.mock.calls[0]![0].checkpoint;
    expect(failedCheckpoint.applied).toEqual([]);
    expect(failedCheckpoint.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "operation.prepared",
          operationId: "lara-contact-trust-copy",
        }),
      ]),
    );
    expect(JSON.stringify(failedCheckpoint.journal)).not.toContain(
      "operation.reconcile_started",
    );
    expect(runMocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "trust_pages_rollback_incomplete",
        retryable: true,
      }),
    );
  });

  it("never reconciles a CAS mismatch through an unrelated desired-state readback", async () => {
    const contactId = LARA_TRUST_PAGE_TARGETS[0].resourceId;
    const fixture = fakeRuntime(initialStates(), {
      casMismatchId: contactId,
      concurrentDesiredId: contactId,
    });
    const { result } = await executeWith(fixture.runtime);

    expect(result).toMatchObject({
      state: "in_progress",
      status: "rollback_incomplete",
      errorCode: "page_drift",
    });
    expect(fixture.store.get(contactId)?.bodyHtml).toBe(LARA_CONTACT_PAGE_BODY_HTML);
    expect(fixture.writes).toEqual([]);
    const failedCheckpoint = runMocks.fail.mock.calls[0]![0].checkpoint;
    expect(failedCheckpoint.applied).toEqual([]);
    expect(JSON.stringify(failedCheckpoint.journal)).not.toContain(
      "operation.reconciled",
    );
  });

  it("does not treat an untyped adapter exception after a write as reconcilable", async () => {
    const contactId = LARA_TRUST_PAGE_TARGETS[0].resourceId;
    const fixture = fakeRuntime(initialStates(), { genericThrowAfterId: contactId });
    const { result } = await executeWith(fixture.runtime);

    expect(result).toMatchObject({
      state: "in_progress",
      status: "rollback_incomplete",
      errorCode: "repair_failed",
    });
    expect(fixture.store.get(contactId)?.bodyHtml).toBe(LARA_CONTACT_PAGE_BODY_HTML);
    expect(fixture.writes).toHaveLength(1);
    const failedCheckpoint = runMocks.fail.mock.calls[0]![0].checkpoint;
    expect(failedCheckpoint.applied).toEqual([]);
    expect(JSON.stringify(failedCheckpoint.journal)).not.toContain(
      "operation.reconcile_started",
    );
  });

  it("retries an incomplete rollback without attributing a merely prepared desired page", async () => {
    const contactId = LARA_TRUST_PAGE_TARGETS[0].resourceId;
    const fixture = fakeRuntime(initialStates(), {
      failId: contactId,
      concurrentDesiredId: contactId,
    });
    const first = await executeWith(fixture.runtime);
    expect(first.result.state).toBe("in_progress");
    const writesBeforeRetry = fixture.writes.length;

    const retryRuntime = fakeRuntime(fixture.store).runtime;
    const resumed = await resumeWithCheckpoint({
      runtime: retryRuntime,
      dryRun: first.dryRun,
      sourceRun: first.run(),
      checkpoint: first.run().checkpoint,
    });

    expect(resumed.result).toMatchObject({
      state: "in_progress",
      status: "rollback_incomplete",
      errorCode: "repair_failed",
    });
    expect(fixture.writes).toHaveLength(writesBeforeRetry);
    expect(fixture.store.get(contactId)?.bodyHtml).toBe(LARA_CONTACT_PAGE_BODY_HTML);
    expect((resumed.run().checkpoint as { applied: unknown[] }).applied).toEqual([]);
  });

  it("fails closed after a crash with only prepared evidence and a desired live page", async () => {
    const fixture = fakeRuntime();
    const completed = await executeWith(fixture.runtime);
    const preparedCheckpoint = runMocks.renew.mock.calls
      .map(([input]) => input.checkpoint as Record<string, unknown>)
      .find((checkpoint) => {
        const journal = checkpoint.journal as Array<{ event: string; operationId: string | null }>;
        const last = journal.at(-1);
        return (
          last?.event === "operation.prepared" &&
          last.operationId === "lara-contact-trust-copy"
        );
      });
    expect(preparedCheckpoint).toBeDefined();

    const originals = initialStates();
    fixture.store.set(
      LARA_TRUST_PAGE_TARGETS[1].resourceId,
      structuredClone(originals.get(LARA_TRUST_PAGE_TARGETS[1].resourceId)!),
    );
    const resumedRuntime = fakeRuntime(fixture.store).runtime;
    fixture.writes.length = 0;
    const resumed = await resumeWithCheckpoint({
      runtime: resumedRuntime,
      dryRun: completed.dryRun,
      sourceRun: completed.run(),
      checkpoint: preparedCheckpoint!,
    });

    expect(resumed.result).toMatchObject({
      state: "in_progress",
      status: "rollback_incomplete",
      errorCode: "page_drift",
    });
    expect(fixture.writes).toEqual([]);
    expect(
      fixture.store.get(LARA_TRUST_PAGE_TARGETS[0].resourceId)?.bodyHtml,
    ).toBe(LARA_CONTACT_PAGE_BODY_HTML);
  });

  it("resumes a crash only from a durable typed-ambiguous reconciliation marker", async () => {
    const fixture = fakeRuntime(initialStates(), {
      throwAfterId: LARA_TRUST_PAGE_TARGETS[0].resourceId,
    });
    const completed = await executeWith(fixture.runtime);
    const ambiguousCheckpoint = runMocks.renew.mock.calls
      .map(([input]) => input.checkpoint as Record<string, unknown>)
      .find((checkpoint) => {
        const journal = checkpoint.journal as Array<{ event: string; operationId: string | null }>;
        const last = journal.at(-1);
        return (
          last?.event === "operation.reconcile_started" &&
          last.operationId === "lara-contact-trust-copy"
        );
      });
    expect(ambiguousCheckpoint).toBeDefined();

    const originals = initialStates();
    fixture.store.set(
      LARA_TRUST_PAGE_TARGETS[1].resourceId,
      structuredClone(originals.get(LARA_TRUST_PAGE_TARGETS[1].resourceId)!),
    );
    fixture.writes.length = 0;
    const resumed = await resumeWithCheckpoint({
      runtime: fixture.runtime,
      dryRun: completed.dryRun,
      sourceRun: completed.run(),
      checkpoint: ambiguousCheckpoint!,
    });

    expect(resumed.result).toMatchObject({
      state: "completed",
      status: "verified",
      verifiedCount: 2,
    });
    expect(fixture.writes).toEqual([
      {
        resourceId: LARA_TRUST_PAGE_TARGETS[1].resourceId,
        bodyHtml: LARA_ABOUT_PAGE_BODY_HTML,
      },
    ]);
    expect(JSON.stringify(resumed.run().artifact)).toContain("operation.reconciled");
  });

  it("restores the first exact body when the second page cannot be verified", async () => {
    const originals = initialStates();
    const fixture = fakeRuntime(originals, {
      failId: LARA_TRUST_PAGE_TARGETS[1].resourceId,
    });
    const { result } = await executeWith(fixture.runtime);

    expect(result).toMatchObject({
      state: "failed",
      status: "rolled_back",
      errorCode: "repair_failed",
    });
    expect(fixture.store.get(LARA_TRUST_PAGE_TARGETS[0].resourceId)?.bodyHtml).toBe("");
    expect(fixture.store.get(LARA_TRUST_PAGE_TARGETS[1].resourceId)?.bodyHtml).toBe(
      "<p>Old About copy.</p>",
    );
    expect(fixture.writes).toHaveLength(2);
    const failure = runMocks.fail.mock.calls[0]![0];
    expect(failure.errorCode).toBe("trust_pages_rolled_back");
    expect(failure.checkpoint).toMatchObject({
      phase: "failed",
      failureCode: "repair_failed",
      restoredOperationIds: ["lara-contact-trust-copy"],
    });
  });

  it("reconciles a typed ambiguous rollback only after its durable restore marker", async () => {
    const fixture = fakeRuntime(initialStates(), {
      failId: LARA_TRUST_PAGE_TARGETS[1].resourceId,
      throwOnRestoreId: LARA_TRUST_PAGE_TARGETS[0].resourceId,
    });
    const { result } = await executeWith(fixture.runtime);

    expect(result).toMatchObject({
      state: "failed",
      status: "rolled_back",
      errorCode: "repair_failed",
    });
    expect(
      fixture.store.get(LARA_TRUST_PAGE_TARGETS[0].resourceId)?.bodyHtml,
    ).toBe("");
    const journal = runMocks.fail.mock.calls[0]![0].checkpoint.journal;
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "rollback.prepared",
          operationId: "lara-contact-trust-copy",
        }),
        expect.objectContaining({
          event: "rollback.reconcile_started",
          operationId: "lara-contact-trust-copy",
        }),
        expect.objectContaining({
          event: "rollback.reconciled",
          operationId: "lara-contact-trust-copy",
        }),
      ]),
    );
  });

  it("replays a completed run only after validating immutable evidence, artifact, checkpoint and live pages", async () => {
    const fixture = fakeRuntime();
    const completed = await executeWith(fixture.runtime);
    const completedRun = completed.run();
    const writesBeforeReplay = fixture.writes.length;
    runMocks.get.mockResolvedValue(completedRun);

    await expect(
      executeLaraTrustPagesRepair({
        approvedPlanDigestSha256: completed.dryRun.planDigestSha256,
        requestedBy: ADMIN_ID,
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        runtime: fixture.runtime,
      }),
    ).resolves.toMatchObject({
      state: "completed",
      status: "verified",
      verifiedCount: 2,
    });
    expect(fixture.writes).toHaveLength(writesBeforeReplay);
  });

  it("rejects immutable run-evidence mismatches before any replay work", async () => {
    const fixture = fakeRuntime();
    const completed = await executeWith(fixture.runtime);
    const completedRun = completed.run();
    const writesBeforeReplay = fixture.writes.length;
    const tamperedRuns: AuditShopifyRun[] = [
      { ...completedRun, schema_hash: "f".repeat(64) },
      { ...completedRun, requested_note: "different note" },
      { ...completedRun, max_retries: 3 },
      { ...completedRun, requested_by: "30000000-0000-4000-8000-000000000003" },
      { ...completedRun, requested_actor_type: "admin" },
    ];

    for (const tampered of tamperedRuns) {
      runMocks.get.mockResolvedValue(tampered);
      await expect(
        executeLaraTrustPagesRepair({
          approvedPlanDigestSha256: completed.dryRun.planDigestSha256,
          requestedBy: ADMIN_ID,
          runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
          runtime: fixture.runtime,
        }),
      ).rejects.toMatchObject({ code: "run_evidence_mismatch" });
    }
    expect(fixture.writes).toHaveLength(writesBeforeReplay);
  });

  it("rejects a tampered completed artifact or checkpoint", async () => {
    const fixture = fakeRuntime();
    const completed = await executeWith(fixture.runtime);
    const completedRun = completed.run();
    const writesBeforeReplay = fixture.writes.length;
    const artifactTampered = structuredClone(completedRun);
    (artifactTampered.artifact as Record<string, unknown>).status = "unverified";
    runMocks.get.mockResolvedValue(artifactTampered);
    await expect(
      executeLaraTrustPagesRepair({
        approvedPlanDigestSha256: completed.dryRun.planDigestSha256,
        requestedBy: ADMIN_ID,
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        runtime: fixture.runtime,
      }),
    ).rejects.toMatchObject({ code: "invalid_checkpoint" });

    const checkpointTampered = structuredClone(completedRun);
    const applied = (checkpointTampered.checkpoint as { applied: Array<{ after: LaraTrustPageState }> })
      .applied;
    applied[0]!.after.bodyHtml = "<p>Tampered checkpoint body.</p>";
    runMocks.get.mockResolvedValue(checkpointTampered);
    await expect(
      executeLaraTrustPagesRepair({
        approvedPlanDigestSha256: completed.dryRun.planDigestSha256,
        requestedBy: ADMIN_ID,
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        runtime: fixture.runtime,
      }),
    ).rejects.toMatchObject({ code: "invalid_checkpoint" });
    expect(fixture.writes).toHaveLength(writesBeforeReplay);
  });

  it("rejects completed evidence when either live page has drifted", async () => {
    const fixture = fakeRuntime();
    const completed = await executeWith(fixture.runtime);
    const contactId = LARA_TRUST_PAGE_TARGETS[0].resourceId;
    const contact = fixture.store.get(contactId)!;
    fixture.store.set(contactId, {
      ...contact,
      bodyHtml: "<p>Concurrent merchant copy.</p>",
      updatedAt: "2026-08-12T22:00:00.000Z",
    });
    const writesBeforeReplay = fixture.writes.length;
    runMocks.get.mockResolvedValue(completed.run());

    await expect(
      executeLaraTrustPagesRepair({
        approvedPlanDigestSha256: completed.dryRun.planDigestSha256,
        requestedBy: ADMIN_ID,
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        runtime: fixture.runtime,
      }),
    ).rejects.toMatchObject({ code: "page_not_verified" });
    expect(fixture.writes).toHaveLength(writesBeforeReplay);
  });

  it("rejects a changed reviewed digest before enqueue or mutation", async () => {
    const fixture = fakeRuntime();
    const dryRun = await buildLaraTrustPagesDryRun({ runtime: fixture.runtime });
    runMocks.get.mockResolvedValue(null);

    await expect(
      executeLaraTrustPagesRepair({
        approvedPlanDigestSha256: `${dryRun.planDigestSha256.slice(0, 63)}0`,
        requestedBy: ADMIN_ID,
        runId: LARA_TRUST_PAGES_REPAIR_RUN_ID,
        runtime: fixture.runtime,
      }),
    ).rejects.toMatchObject({ code: "approval_digest_mismatch" });
    expect(runMocks.enqueue).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });
});
