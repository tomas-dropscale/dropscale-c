import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  enqueue: vi.fn(),
  claim: vi.fn(),
  renew: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  get: vi.fn(),
  serviceRpc: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/google-ads/crypto", () => ({
  decryptToken: vi.fn(),
}));
vi.mock("./shopify-runs", () => {
  class AuditShopifyRunError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    AuditShopifyRunError,
    enqueueAuditShopifyRun: mocks.enqueue,
    claimAuditShopifyRun: mocks.claim,
    renewAuditShopifyRun: mocks.renew,
    completeAuditShopifyRun: mocks.complete,
    failAuditShopifyRun: mocks.fail,
    getAuditShopifyRun: mocks.get,
  };
});

import type { AuditShopifyRun } from "@/lib/supabase/types";
import { AuditShopifyRunError } from "./shopify-runs";
import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_THEME,
  type LaraThemeUrgencyFilename,
} from "./lara-theme-urgency-plan";
import {
  LARA_THEME_URGENCY_BACKUP_RUN_ID,
  LARA_THEME_URGENCY_REPAIR_RUN_ID,
  buildLaraThemeUrgencyDryRun,
  runLaraThemeUrgencyRepairOneShot,
} from "./lara-theme-urgency-live-repair";
import type { LaraThemeUrgencyLiveMaterial } from "./lara-theme-urgency-live-contract";
import {
  LaraThemeUrgencyLiveRuntimeError,
  type LaraThemeUrgencyLiveRuntime,
} from "./lara-theme-urgency-live-runtime";
import { LARA_ROVINJ_REMEDIATION_SHOP } from "./shopify-remediation-plan";

const REQUESTED_BY = "10000000-0000-4000-8000-000000000001";
const AT = "2026-08-12T21:45:00.000Z";
const MD5 = "0123456789abcdef0123456789abcdef";
const AFTER_MD5 = "abcdef0123456789abcdef0123456789";
const JOB_ID = "gid://shopify/Job/ae8d210d-90e0-4912-96d0-96d45c5e8fbb";

type FileState = { content: string; updatedAt: string; checksumMd5: string };

let runs: Map<string, AuditShopifyRun>;
let order: string[];

function makeRun(input: {
  id: string;
  connectionId: string;
  requestedBy: string;
  shopDomain: string;
  source: string;
  note: string | null;
  schemaHash: string;
  manifestHash: string;
  maxRetries?: number;
  actorType?: "admin" | "system";
}) {
  const createdAt = AT;
  return {
    id: input.id,
    connection_id: input.connectionId,
    requested_by: input.requestedBy,
    requested_actor_type: input.actorType ?? "admin",
    shopify_domain: input.shopDomain,
    state: "queued" as const,
    requested_source: input.source,
    requested_note: input.note,
    schema_hash: input.schemaHash,
    manifest_hash: input.manifestHash,
    checkpoint: {},
    artifact: null,
    attempt_count: 0,
    retry_count: 0,
    max_retries: input.maxRetries ?? 3,
    next_attempt_at: createdAt,
    lease_token: null,
    lease_generation: 0,
    lease_acquired_at: null,
    lease_renewed_at: null,
    lease_expires_at: null,
    error_code: null,
    created_at: createdAt,
    updated_at: createdAt,
    started_at: null,
    completed_at: null,
    failed_at: null,
  } satisfies AuditShopifyRun;
}

function sourceState() {
  const state = new Map<LaraThemeUrgencyFilename, FileState>();
  for (const filename of LARA_THEME_URGENCY_FILES) {
    state.set(filename, {
      content: filename.endsWith(".json")
        ? "{}"
        : `{% comment %}${filename}{% endcomment %}`,
      updatedAt: AT,
      checksumMd5: MD5,
    });
  }
  state.set("blocks/ai_gen_block_a974a97.liquid", {
    content:
      "Lara Rovinj zatvara svoja vrata. Veliko rasprodavanje cijele trgovine. Posljednji dani, posljednje veličine.",
    updatedAt: AT,
    checksumMd5: MD5,
  });
  state.set("sections/main-product.liquid", {
    content:
      "Posljednji komadi. Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane.",
    updatedAt: AT,
    checksumMd5: MD5,
  });
  state.set("templates/product.json", {
    content: '{"claim":"Hrvatski brend od 2015."}',
    updatedAt: AT,
    checksumMd5: MD5,
  });
  state.set("config/settings_data.json", {
    content:
      '{"current":{"blocks":{"timer":{"type":"shopify://apps/kaching-cart/blocks/embed/abc123","disabled":false}}}}',
    updatedAt: AT,
    checksumMd5: MD5,
  });
  return state;
}

function liveRuntime(
  state: Map<LaraThemeUrgencyFilename, FileState>,
  submit: LaraThemeUrgencyLiveRuntime["submitApprovedPlan"],
  readJob: LaraThemeUrgencyLiveRuntime["readAsyncJob"] = vi.fn(async (jobId) => ({
    id: jobId,
    done: true,
  })),
) {
  const query = vi.fn(
    async (_document: string, variables?: Record<string, unknown>): Promise<unknown> => {
      const filename = (variables?.filenames as LaraThemeUrgencyFilename[])[0]!;
      const file = state.get(filename)!;
      return {
        theme: {
          id: LARA_THEME_URGENCY_THEME.id,
          name: "symmetry",
          role: "MAIN",
          files: {
            nodes: [
              {
                filename,
                checksumMd5: createHash("md5")
                  .update(file.content, "utf8")
                  .digest("hex"),
                contentType: filename.endsWith(".json")
                  ? "application/json"
                  : "text/x-liquid",
                size: new TextEncoder().encode(file.content).byteLength,
                updatedAt: file.updatedAt,
                body: {
                  __typename: "OnlineStoreThemeFileBodyText",
                  content: file.content,
                },
              },
            ],
            userErrors: [],
          },
        },
      };
    },
  );
  return {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: LARA_ROVINJ_REMEDIATION_SHOP.domain,
    shopId: LARA_ROVINJ_REMEDIATION_SHOP.shopId,
    grantedScopes: ["read_themes", "write_themes"],
    apiVersion: "2026-07",
    themeId: LARA_THEME_URGENCY_THEME.id,
    themeFileWriteRequirement: "write_themes_and_shopify_exemption",
    query,
    readExactThemeAsset: vi.fn(async () => {
      throw new Error("REST fallback was not expected for literal test fixtures");
    }),
    submitApprovedPlan: submit,
    readAsyncJob: readJob,
  } as LaraThemeUrgencyLiveRuntime;
}

function applyMaterial(
  state: Map<LaraThemeUrgencyFilename, FileState>,
  material: Parameters<LaraThemeUrgencyLiveRuntime["submitApprovedPlan"]>[0],
) {
  for (const operation of material.payload.plan.payload.operations) {
    state.set(operation.target.filename, {
      content: operation.after.content,
      updatedAt: "2026-08-12T21:48:00.000Z",
      checksumMd5: AFTER_MD5,
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  runs = new Map();
  order = [];
  mocks.createServiceClient.mockReturnValue({ rpc: mocks.serviceRpc });
  mocks.enqueue.mockImplementation(async (input) => {
    if (!runs.has(input.runId)) {
      runs.set(input.runId, makeRun({ ...input, id: input.runId }));
    }
    return input.runId;
  });
  mocks.get.mockImplementation(async ({ runId }: { runId: string }) =>
    runs.get(runId) ?? null,
  );
  mocks.claim.mockImplementation(
    async ({ runId, leaseToken }: { runId: string; leaseToken: string }) => {
      const existing = runs.get(runId);
      if (!existing || (existing.state !== "queued" && existing.state !== "running")) {
        throw new Error("not claimable");
      }
      const run: AuditShopifyRun = {
        ...existing,
        state: "running",
        attempt_count: existing.attempt_count + 1,
        lease_token: leaseToken,
        lease_generation: existing.lease_generation + 1,
        lease_acquired_at: "2026-08-12T21:45:30.000Z",
        lease_renewed_at: "2026-08-12T21:45:30.000Z",
        lease_expires_at: "2026-08-12T21:50:30.000Z",
        next_attempt_at: null,
        started_at: existing.started_at ?? "2026-08-12T21:45:30.000Z",
      };
      runs.set(runId, run);
      return run;
    },
  );
  mocks.renew.mockImplementation(
    async ({ run, checkpoint }: { run: AuditShopifyRun; checkpoint: Record<string, unknown> }) => {
      const renewed = { ...run, checkpoint };
      runs.set(run.id, renewed);
      return renewed;
    },
  );
  mocks.complete.mockImplementation(
    async ({ run, checkpoint, artifact }: {
      run: AuditShopifyRun;
      checkpoint: Record<string, unknown>;
      artifact: Record<string, unknown>;
    }) => {
      order.push(`complete:${run.id}`);
      const completed: AuditShopifyRun = {
        ...run,
        state: "completed",
        checkpoint,
        artifact,
        completed_at:
          typeof artifact.completedAt === "string"
            ? artifact.completedAt
            : typeof artifact.persistedAt === "string"
              ? artifact.persistedAt
              : AT,
        next_attempt_at: null,
        lease_token: null,
        lease_acquired_at: null,
        lease_renewed_at: null,
        lease_expires_at: null,
      };
      runs.set(run.id, completed);
      return completed;
    },
  );
  mocks.fail.mockImplementation(
    async ({ run, checkpoint, errorCode, retryable }: {
      run: AuditShopifyRun;
      checkpoint: Record<string, unknown>;
      errorCode: string;
      retryable: boolean;
    }) => {
      const failed: AuditShopifyRun = {
        ...run,
        state: retryable ? "queued" : "failed",
        checkpoint,
        error_code: errorCode,
        next_attempt_at: retryable ? "2026-08-12T21:49:30.000Z" : null,
        lease_token: null,
        lease_acquired_at: null,
        lease_renewed_at: null,
        lease_expires_at: null,
        failed_at: retryable ? null : "2026-08-12T21:49:00.000Z",
      };
      runs.set(run.id, failed);
      return failed;
    },
  );
  mocks.serviceRpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    const run = runs.get(String(args.p_run_id))!;
    const yielded: AuditShopifyRun = {
      ...run,
      state: "queued",
      checkpoint: args.p_checkpoint as Record<string, unknown>,
      next_attempt_at: "2026-08-12T21:49:10.000Z",
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    };
    runs.set(run.id, yielded);
    return { data: [yielded], error: null };
  });
});

describe("the durable Lara theme one-shot", () => {
  it("returns a server-generated zero-write dry run with Kaching structural evidence", async () => {
    const state = sourceState();
    const submit = vi.fn();
    const dryRun = await buildLaraThemeUrgencyDryRun({
      runtime: liveRuntime(state, submit),
      now: () => new Date(AT),
    });
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      writesAttempted: 0,
      operationCount: 3,
      vendorMutationIncluded: false,
      kaching: {
        separateBooleanPlanEligible: true,
        urgencyBatchWriteIncluded: false,
        handling: { status: "deferred_no_write" },
      },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("completes and verifies the immutable full backup before one synchronous write", async () => {
    const state = sourceState();
    const submit = vi.fn(async (material: LaraThemeUrgencyLiveMaterial) => {
      order.push("submit-theme-copy");
      applyMaterial(state, material);
      return {
        status: "completed" as const,
        filenames: material.payload.plan.payload.operations.map(
          (operation) => operation.target.filename,
        ),
        jobId: null,
        exemptionConfirmedByShopify: true as const,
      };
    });
    const result = await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime: liveRuntime(state, submit),
      now: () => new Date(AT),
      leaseToken: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toMatchObject({
      state: "completed",
      status: "verified",
      backupRunId: LARA_THEME_URGENCY_BACKUP_RUN_ID,
      verifiedFiles: 3,
      kachingStatus: "deferred_no_write",
    });
    expect(order).toEqual([
      `complete:${LARA_THEME_URGENCY_BACKUP_RUN_ID}`,
      "submit-theme-copy",
      `complete:${LARA_THEME_URGENCY_REPAIR_RUN_ID}`,
    ]);
    const backup = runs.get(LARA_THEME_URGENCY_BACKUP_RUN_ID)!;
    const backupJson = JSON.stringify(backup.artifact);
    expect(new TextEncoder().encode(backupJson).byteLength).toBeLessThan(8_388_608);
    expect(backup.artifact).toMatchObject({
      kind: "full_theme_source_and_inverse",
      status: "persisted_before_write",
      material: {
        payload: {
          sourceSnapshot: { files: expect.arrayContaining([]) },
          vendorPolicy: { mutationsAllowed: false },
          kachingEvidence: { urgencyBatchWriteIncluded: false },
        },
      },
    });
    const material = (backup.artifact as { material: LaraThemeUrgencyLiveMaterial })
      .material;
    expect(material.payload.sourceSnapshot.files).toHaveLength(8);
    expect(
      material.payload.plan.payload.operations.every(
        (operation) => typeof operation.inverse.content === "string",
      ),
    ).toBe(true);
  });

  it("revalidates every completed-run field and the fresh Admin state on replay", async () => {
    const state = sourceState();
    const submit = vi.fn(async (material: LaraThemeUrgencyLiveMaterial) => {
      applyMaterial(state, material);
      return {
        status: "completed" as const,
        filenames: material.payload.plan.payload.operations.map(
          (operation) => operation.target.filename,
        ),
        jobId: null,
        exemptionConfirmedByShopify: true as const,
      };
    });
    const runtime = liveRuntime(state, submit);
    await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime,
      now: () => new Date(AT),
      leaseToken: "10111111-1111-4111-8111-111111111111",
    });

    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "terminal run"),
    );
    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date(AT),
        leaseToken: "10222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toMatchObject({ state: "completed", status: "verified" });
    expect(submit).toHaveBeenCalledOnce();

    const completed = runs.get(LARA_THEME_URGENCY_REPAIR_RUN_ID)!;
    runs.set(LARA_THEME_URGENCY_REPAIR_RUN_ID, {
      ...completed,
      lease_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "terminal run"),
    );
    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date(AT),
        leaseToken: "10222222-2222-4222-8222-222222222223",
      }),
    ).rejects.toMatchObject({ code: "repair_evidence_mismatch" });

    runs.set(LARA_THEME_URGENCY_REPAIR_RUN_ID, {
      ...completed,
      artifact: {
        ...completed.artifact!,
        verifiedFiles: 999,
      },
    });
    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "terminal run"),
    );
    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date(AT),
        leaseToken: "10333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toMatchObject({ code: "repair_evidence_mismatch" });
  });

  it("never reports a stale completed repair after a later theme edit", async () => {
    const state = sourceState();
    const submit = vi.fn(async (material: LaraThemeUrgencyLiveMaterial) => {
      applyMaterial(state, material);
      return {
        status: "completed" as const,
        filenames: material.payload.plan.payload.operations.map(
          (operation) => operation.target.filename,
        ),
        jobId: null,
        exemptionConfirmedByShopify: true as const,
      };
    });
    const runtime = liveRuntime(state, submit);
    await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime,
      now: () => new Date(AT),
      leaseToken: "10444444-4444-4444-8444-444444444444",
    });
    state.set("sections/featured-product.liquid", {
      content: "later merchant edit",
      updatedAt: "2026-08-12T22:00:00.000Z",
      checksumMd5: AFTER_MD5,
    });
    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "terminal run"),
    );
    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date("2026-08-12T22:00:00.000Z"),
        leaseToken: "10555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toMatchObject({ code: "theme_state_drift" });
  });

  it("persists an async job, yields, resumes without resubmitting, then verifies", async () => {
    const state = sourceState();
    let savedMaterial: Parameters<typeof applyMaterial>[1] | null = null;
    let jobDone = false;
    const submit = vi.fn(async (material: LaraThemeUrgencyLiveMaterial) => {
      savedMaterial = material;
      return {
        status: "pending" as const,
        filenames: material.payload.plan.payload.operations.map(
          (operation) => operation.target.filename,
        ),
        jobId: JOB_ID,
        exemptionConfirmedByShopify: true as const,
      };
    });
    const readJob = vi.fn(async () => ({ id: JOB_ID, done: jobDone }));
    const runtime = liveRuntime(state, submit, readJob);

    const first = await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime,
      now: () => new Date(AT),
      leaseToken: "22222222-2222-4222-8222-222222222222",
    });
    expect(first).toMatchObject({ state: "in_progress", stage: "repair" });
    expect(runs.get(LARA_THEME_URGENCY_REPAIR_RUN_ID)?.state).toBe("queued");
    expect(
      runs.get(LARA_THEME_URGENCY_REPAIR_RUN_ID)?.checkpoint.jobId,
    ).toBe(JOB_ID);

    applyMaterial(state, savedMaterial!);
    jobDone = true;
    const second = await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime,
      now: () => new Date("2026-08-12T21:49:00.000Z"),
      leaseToken: "33333333-3333-4333-8333-333333333333",
    });
    expect(second).toMatchObject({ state: "completed", status: "verified" });
    expect(submit).toHaveBeenCalledOnce();
    expect(readJob).toHaveBeenCalledOnce();
  });

  it("ends a stuck asynchronous job after the finite elapsed window", async () => {
    const state = sourceState();
    const submit = vi.fn(async (material: LaraThemeUrgencyLiveMaterial) => ({
      status: "pending" as const,
      filenames: material.payload.plan.payload.operations.map(
        (operation) => operation.target.filename,
      ),
      jobId: JOB_ID,
      exemptionConfirmedByShopify: true as const,
    }));
    const readJob = vi.fn(async () => ({ id: JOB_ID, done: false }));
    const runtime = liveRuntime(state, submit, readJob);
    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date(AT),
        leaseToken: "20111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toMatchObject({ state: "in_progress" });

    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date("2026-08-12T22:16:00.000Z"),
        leaseToken: "20222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toMatchObject({
      state: "failed",
      status: "manual_intervention_required",
      errorCode: "theme_write_unresolved",
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(readJob).not.toHaveBeenCalled();
  });

  it("also ends a stuck asynchronous job after the finite poll count", async () => {
    const state = sourceState();
    const submit = vi.fn(async (material: LaraThemeUrgencyLiveMaterial) => ({
      status: "pending" as const,
      filenames: material.payload.plan.payload.operations.map(
        (operation) => operation.target.filename,
      ),
      jobId: JOB_ID,
      exemptionConfirmedByShopify: true as const,
    }));
    const readJob = vi.fn(async () => ({ id: JOB_ID, done: false }));
    const runtime = liveRuntime(state, submit, readJob);
    await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime,
      now: () => new Date(AT),
      leaseToken: "30111111-1111-4111-8111-111111111111",
    });
    for (let poll = 1; poll <= 12; poll += 1) {
      const polledAt = new Date(Date.parse(AT) + poll * 60_000);
      await expect(
        runLaraThemeUrgencyRepairOneShot({
          requestedBy: REQUESTED_BY,
          runtime,
          now: () => polledAt,
          leaseToken: `30${String(poll).padStart(2, "0")}1111-1111-4111-8111-111111111111`,
        }),
      ).resolves.toMatchObject({ state: "in_progress" });
    }
    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date(Date.parse(AT) + 13 * 60_000),
        leaseToken: "31444444-4444-4444-8444-444444444444",
      }),
    ).resolves.toMatchObject({
      state: "failed",
      errorCode: "theme_write_unresolved",
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(readJob).toHaveBeenCalledTimes(12);
  });

  it("reconciles only an ambiguous mutation by exact Admin state", async () => {
    const state = sourceState();
    const submit = vi.fn(async (material) => {
      applyMaterial(state, material);
      throw new LaraThemeUrgencyLiveRuntimeError(
        "mutation_ambiguous",
        "lost response",
      );
    });
    const result = await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime: liveRuntime(state, submit),
      now: () => new Date(AT),
      leaseToken: "44444444-4444-4444-8444-444444444444",
    });
    expect(result).toMatchObject({ state: "completed", status: "verified" });
    const repair = runs.get(LARA_THEME_URGENCY_REPAIR_RUN_ID)!;
    expect(JSON.stringify(repair.artifact)).toContain("mutation.reconciled");
  });

  it("never resubmits after a persisted intent with an unresolved ambiguous response", async () => {
    const state = sourceState();
    const submit = vi.fn(async () => {
      throw new LaraThemeUrgencyLiveRuntimeError(
        "mutation_ambiguous",
        "lost response before a state change could be proven",
      );
    });
    const runtime = liveRuntime(state, submit);

    const first = await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime,
      now: () => new Date(AT),
      leaseToken: "66666666-6666-4666-8666-666666666666",
    });
    expect(first).toMatchObject({ state: "in_progress", stage: "repair" });
    expect(
      runs.get(LARA_THEME_URGENCY_REPAIR_RUN_ID)?.checkpoint.phase,
    ).toBe("mutation_intent");

    const second = await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime,
      now: () => new Date("2026-08-12T21:49:00.000Z"),
      leaseToken: "77777777-7777-4777-8777-777777777777",
    });
    expect(second).toMatchObject({ state: "in_progress", stage: "repair" });
    expect(submit).toHaveBeenCalledOnce();
    expect(
      runs.get(LARA_THEME_URGENCY_REPAIR_RUN_ID)?.checkpoint.reconciliationCount,
    ).toBe(2);
  });

  it("reports a database-terminal lease expiry with fresh Admin state and no resubmit", async () => {
    const state = sourceState();
    const submit = vi.fn(async () => {
      throw new LaraThemeUrgencyLiveRuntimeError(
        "mutation_ambiguous",
        "lost response before a state change could be proven",
      );
    });
    const runtime = liveRuntime(state, submit);
    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date(AT),
        leaseToken: "88111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toMatchObject({ state: "in_progress" });

    const active = runs.get(LARA_THEME_URGENCY_REPAIR_RUN_ID)!;
    runs.set(LARA_THEME_URGENCY_REPAIR_RUN_ID, {
      ...active,
      state: "failed",
      attempt_count: active.max_retries + 1,
      retry_count: active.max_retries,
      lease_generation: active.max_retries + 1,
      error_code: "lease_expired",
      failed_at: "2026-08-12T22:00:00.000Z",
      next_attempt_at: null,
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
    });
    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "terminal run"),
    );

    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime,
        now: () => new Date("2026-08-12T22:00:00.000Z"),
        leaseToken: "88222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toMatchObject({
      state: "failed",
      status: "manual_intervention_required",
      errorCode: "lease_expired",
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("does not reconcile a definitive exemption failure and preserves the backup", async () => {
    const state = sourceState();
    const submit = vi.fn(async () => {
      throw new LaraThemeUrgencyLiveRuntimeError(
        "theme_write_exemption_unavailable",
        "exemption unavailable",
      );
    });
    const result = await runLaraThemeUrgencyRepairOneShot({
      requestedBy: REQUESTED_BY,
      runtime: liveRuntime(state, submit),
      now: () => new Date(AT),
      leaseToken: "55555555-5555-4555-8555-555555555555",
    });
    expect(result).toMatchObject({
      state: "failed",
      status: "manual_intervention_required",
      errorCode: "theme_write_exemption_unavailable",
    });
    expect(runs.get(LARA_THEME_URGENCY_BACKUP_RUN_ID)?.state).toBe("completed");
    expect(submit).toHaveBeenCalledOnce();
    expect(
      runs.get(LARA_THEME_URGENCY_REPAIR_RUN_ID)?.checkpoint.reconciliationCount,
    ).toBe(0);

    mocks.claim.mockRejectedValueOnce(
      new AuditShopifyRunError("run_not_found", "terminal run"),
    );
    await expect(
      runLaraThemeUrgencyRepairOneShot({
        requestedBy: REQUESTED_BY,
        runtime: liveRuntime(state, submit),
        now: () => new Date(AT),
        leaseToken: "55666666-6666-4666-8666-666666666666",
      }),
    ).resolves.toMatchObject({
      state: "failed",
      errorCode: "theme_write_exemption_unavailable",
    });
    expect(submit).toHaveBeenCalledOnce();
  });
});
