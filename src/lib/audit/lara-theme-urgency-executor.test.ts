import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));

import {
  LARA_THEME_FILES_UPSERT_MUTATION,
  LARA_THEME_JOB_QUERY,
  LaraThemeUrgencyExecutionError,
  executeLaraThemeUrgencyPlan,
  type LaraThemeUrgencyBackupArtifact,
  type LaraThemeUrgencyBackupStore,
  type LaraThemeUrgencyWriteRequest,
  type LaraThemeUrgencyWriter,
} from "./lara-theme-urgency-executor";
import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_THEME,
  buildLaraThemeUrgencyPlan,
  readLaraThemeUrgencySnapshot,
  type LaraThemeUrgencyFilename,
  type LaraThemeUrgencyReadRuntime,
} from "./lara-theme-urgency-plan";
import { LARA_ROVINJ_REMEDIATION_SHOP } from "./shopify-remediation-plan";

const AT = "2026-08-12T18:00:00.000Z";
const RUN_ID = "40000000-0000-4000-8000-000000000099";
const MD5 = "0123456789abcdef0123456789abcdef";
const NEW_MD5 = "abcdef0123456789abcdef0123456789";

type FileState = {
  content: string;
  updatedAt: string;
  checksumMd5: string;
};

function initialSources(): Map<LaraThemeUrgencyFilename, FileState> {
  const values = new Map<LaraThemeUrgencyFilename, FileState>();
  for (const filename of LARA_THEME_URGENCY_FILES) {
    values.set(filename, {
      content: filename.endsWith(".json")
        ? "{}"
        : `{% comment %}${filename}{% endcomment %}`,
      updatedAt: AT,
      checksumMd5: MD5,
    });
  }
  values.set("blocks/ai_gen_block_a974a97.liquid", {
    content:
      "<h2>Lara Rovinj zatvara svoja vrata</h2><p>Veliko rasprodavanje cijele trgovine</p>",
    updatedAt: AT,
    checksumMd5: MD5,
  });
  values.set("sections/main-product.liquid", {
    content: '<span class="stock-urgency__text">Posljednji komadi</span>',
    updatedAt: AT,
    checksumMd5: MD5,
  });
  values.set("config/settings_data.json", {
    content:
      '{"type":"shopify://apps/kaching-cart/blocks/app","label":"Košarica istječe za","clearCartOnTimerEnd":false}',
    updatedAt: AT,
    checksumMd5: MD5,
  });
  return values;
}

function readRuntime(state: Map<LaraThemeUrgencyFilename, FileState>) {
  const query = vi.fn(
    async (_document: string, variables?: Record<string, unknown>): Promise<unknown> => {
      const filename = (variables?.filenames as LaraThemeUrgencyFilename[])[0];
      const file = state.get(filename);
      return {
        theme: {
          id: LARA_THEME_URGENCY_THEME.id,
          name: "symmetry",
          role: "MAIN",
          files: {
            nodes: file
              ? [
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
                ]
              : [],
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
    query,
  } as LaraThemeUrgencyReadRuntime & { query: typeof query };
}

function mutateState(
  state: Map<LaraThemeUrgencyFilename, FileState>,
  request: LaraThemeUrgencyWriteRequest,
) {
  for (const file of request.files) {
    state.set(file.filename, {
      content: file.body.value,
      updatedAt: "2026-08-12T18:01:00.000Z",
      checksumMd5: NEW_MD5,
    });
  }
}

function writer(
  state: Map<LaraThemeUrgencyFilename, FileState>,
  implementation?: (
    request: LaraThemeUrgencyWriteRequest,
  ) => Promise<ReturnTypeShape>,
) {
  const upsertThemeFiles = vi.fn(
    implementation ??
      (async (request: LaraThemeUrgencyWriteRequest) => {
        mutateState(state, request);
        return {
          filenames: request.files.map((file) => file.filename),
          jobId: "gid://shopify/Job/one",
          completed: true as const,
        };
      }),
  );
  return {
    shopDomain: LARA_ROVINJ_REMEDIATION_SHOP.domain,
    shopId: LARA_ROVINJ_REMEDIATION_SHOP.shopId,
    themeId: LARA_THEME_URGENCY_THEME.id,
    apiVersion: "2026-07",
    grantedScopes: ["write_themes"],
    upsertThemeFiles,
  } as LaraThemeUrgencyWriter & { upsertThemeFiles: typeof upsertThemeFiles };
}

type ReturnTypeShape = {
  filenames: readonly LaraThemeUrgencyFilename[];
  jobId: string | null;
  completed: true;
};

function backupStore(order: string[] = []) {
  let saved: LaraThemeUrgencyBackupArtifact | null = null;
  const persist = vi.fn(async (artifact: LaraThemeUrgencyBackupArtifact) => {
    order.push("backup");
    saved = artifact;
    return { artifactId: "artifact/lara-theme/one", digestSha256: artifact.digestSha256 };
  });
  return {
    persist,
    get saved() {
      return saved;
    },
  } as LaraThemeUrgencyBackupStore & {
    persist: typeof persist;
    readonly saved: LaraThemeUrgencyBackupArtifact | null;
  };
}

async function sealedPlan(
  state: Map<LaraThemeUrgencyFilename, FileState>,
  executionMode: "dry-run" | "apply",
) {
  const runtime = readRuntime(state);
  const snapshot = await readLaraThemeUrgencySnapshot({ runtime, capturedAt: AT });
  return buildLaraThemeUrgencyPlan({
    snapshot,
    planId: `lara-theme-${executionMode}`,
    createdAt: AT,
    executionMode,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Lara theme urgency exact executor", () => {
  it("exports only the fixed official theme upsert and job documents", () => {
    expect(LARA_THEME_FILES_UPSERT_MUTATION).toContain(
      "mutation LaraThemeUrgencyFilesUpsert",
    );
    expect(LARA_THEME_FILES_UPSERT_MUTATION).toContain("themeFilesUpsert");
    expect(LARA_THEME_FILES_UPSERT_MUTATION).not.toContain("productUpdate");
    expect(LARA_THEME_JOB_QUERY).toContain("job(id: $jobId)");
  });

  it("performs a current-state dry run without accepting any writer", async () => {
    const state = initialSources();
    const plan = await sealedPlan(state, "dry-run");
    const result = await executeLaraThemeUrgencyPlan({
      sealedPlan: plan,
      readRuntime: readRuntime(state),
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(result).toMatchObject({
      status: "dry_run_complete",
      writesAttempted: 0,
      backupArtifactId: null,
    });
  });

  it("persists the full inverse before one exact apply and verifies the bodies", async () => {
    const state = initialSources();
    const plan = await sealedPlan(state, "apply");
    const order: string[] = [];
    const store = backupStore(order);
    const liveWriter = writer(state, async (request) => {
      order.push(`write:${request.reason}`);
      mutateState(state, request);
      return {
        filenames: request.files.map((file) => file.filename),
        jobId: null,
        completed: true,
      };
    });

    const result = await executeLaraThemeUrgencyPlan({
      sealedPlan: plan,
      readRuntime: readRuntime(state),
      writer: liveWriter,
      backupStore: store,
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(result.status).toBe("applied");
    expect(result.writesAttempted).toBe(1);
    expect(order).toEqual(["backup", "write:apply"]);
    expect(store.saved?.payload.vendorPolicy.mutationsAllowed).toBe(false);
    expect(store.saved?.payload.files).toHaveLength(LARA_THEME_URGENCY_FILES.length);
    expect(store.saved?.payload.files.map((file) => file.filename)).toEqual(
      LARA_THEME_URGENCY_FILES,
    );
    expect(
      store.saved?.payload.files.find(
        (file) => file.filename === "config/settings_data.json",
      )?.beforeContent,
    ).toBe(state.get("config/settings_data.json")?.content);
    expect(liveWriter.upsertThemeFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        themeId: LARA_THEME_URGENCY_THEME.id,
        reason: "apply",
        files: expect.arrayContaining([
          expect.objectContaining({ body: expect.objectContaining({ type: "TEXT" }) }),
        ]),
      }),
    );
    expect(state.get("sections/main-product.liquid")?.content).toContain("Dostupno");
  });

  it("blocks a stale source file before backup or mutation", async () => {
    const state = initialSources();
    const plan = await sealedPlan(state, "apply");
    state.set("sections/main-product.liquid", {
      content: "merchant changed this file",
      updatedAt: "2026-08-12T18:02:00.000Z",
      checksumMd5: NEW_MD5,
    });
    const store = backupStore();
    const liveWriter = writer(state);

    await expect(
      executeLaraThemeUrgencyPlan({
        sealedPlan: plan,
        readRuntime: readRuntime(state),
        writer: liveWriter,
        backupStore: store,
        runId: RUN_ID,
        occurredAt: AT,
      }),
    ).rejects.toMatchObject({ code: "PREFLIGHT_CAS_MISMATCH" });
    expect(store.persist).not.toHaveBeenCalled();
    expect(liveWriter.upsertThemeFiles).not.toHaveBeenCalled();
  });

  it("requires an exact durable backup acknowledgement before writing", async () => {
    const state = initialSources();
    const plan = await sealedPlan(state, "apply");
    const liveWriter = writer(state);
    const store = {
      persist: vi.fn(async () => ({
        artifactId: "artifact/wrong",
        digestSha256: "0".repeat(64),
      })),
    };

    await expect(
      executeLaraThemeUrgencyPlan({
        sealedPlan: plan,
        readRuntime: readRuntime(state),
        writer: liveWriter,
        backupStore: store,
        runId: RUN_ID,
        occurredAt: AT,
      }),
    ).rejects.toBeInstanceOf(LaraThemeUrgencyExecutionError);
    expect(liveWriter.upsertThemeFiles).not.toHaveBeenCalled();
  });

  it("refuses an apply when the complete raw backup exceeds eight megabytes", async () => {
    const state = initialSources();
    const padding = "x".repeat(1_010_000);
    for (const filename of LARA_THEME_URGENCY_FILES) {
      const current = state.get(filename)!;
      state.set(filename, {
        ...current,
        content: filename.endsWith(".json")
          ? JSON.stringify({
              ...(JSON.parse(current.content) as Record<string, unknown>),
              _padding: padding,
            })
          : `${current.content}${padding}`,
      });
    }
    const plan = await sealedPlan(state, "apply");
    const store = backupStore();
    const liveWriter = writer(state);

    await expect(
      executeLaraThemeUrgencyPlan({
        sealedPlan: plan,
        readRuntime: readRuntime(state),
        writer: liveWriter,
        backupStore: store,
        runId: RUN_ID,
        occurredAt: AT,
      }),
    ).rejects.toMatchObject({ code: "BACKUP_TOO_LARGE" });
    expect(store.persist).not.toHaveBeenCalled();
    expect(liveWriter.upsertThemeFiles).not.toHaveBeenCalled();
  });

  it("never rolls back automatically and exposes only manual recovery evidence", async () => {
    const state = initialSources();
    const plan = await sealedPlan(state, "apply");
    const liveWriter = writer(state, async (request) => {
      mutateState(state, {
        ...request,
        files: request.files.slice(0, 1),
      });
      throw new Error("transport lost after partial mutation");
    });

    const result = await executeLaraThemeUrgencyPlan({
      sealedPlan: plan,
      readRuntime: readRuntime(state),
      writer: liveWriter,
      backupStore: backupStore(),
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(result).toMatchObject({
      status: "manual_intervention_required",
      writesAttempted: 1,
      manualRecoveryFiles: [plan.payload.operations[0]?.target.filename],
    });
    expect(liveWriter.upsertThemeFiles).toHaveBeenCalledOnce();
    expect(liveWriter.upsertThemeFiles).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "apply" }),
    );
    expect(state.get(plan.payload.operations[0]!.target.filename)?.content).toBe(
      plan.payload.operations[0]!.after.content,
    );
    expect(
      state.get(plan.payload.operations[1]!.target.filename)?.content,
    ).toBe(plan.payload.operations[1]!.inverse.content);
  });

  it("does not report success when an evidence-only source changes during the write", async () => {
    const state = initialSources();
    const plan = await sealedPlan(state, "apply");
    const liveWriter = writer(state, async (request) => {
      mutateState(state, request);
      state.set("config/settings_data.json", {
        content: '{"merchant":"concurrent settings edit"}',
        updatedAt: "2026-08-12T18:01:00.000Z",
        checksumMd5: NEW_MD5,
      });
      return {
        filenames: request.files.map((file) => file.filename),
        jobId: null,
        completed: true,
      };
    });

    const result = await executeLaraThemeUrgencyPlan({
      sealedPlan: plan,
      readRuntime: readRuntime(state),
      writer: liveWriter,
      backupStore: backupStore(),
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(result).toMatchObject({
      status: "manual_intervention_required",
      writesAttempted: 1,
      manualRecoveryFiles: plan.payload.operations.map(
        (operation) => operation.target.filename,
      ),
    });
    expect(liveWriter.upsertThemeFiles).toHaveBeenCalledOnce();
  });
});
