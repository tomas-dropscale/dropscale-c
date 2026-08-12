import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SHOPIFY_REMEDIATION_LIVE_WRITES_IMPLEMENTED,
  prepareLaraShopifyRemediationRun,
} from "./shopify-remediation-executor";
import {
  LARA_ROVINJ_REMEDIATION_SHOP,
  buildShopifyRemediationCas,
  remediationSha256,
  sealShopifyRemediationPlan,
  type PageBeforeSnapshot,
  type PageRemediationCas,
  type PolicyBeforeSnapshot,
  type PolicyRemediationCas,
  type ShopifyRemediationBeforeSnapshot,
  type ShopifyRemediationOperation,
  type ThemeBeforeSnapshot,
  type ThemeRemediationCas,
} from "./shopify-remediation-plan";

const AT = "2026-08-12T12:00:00.000Z";
const RUN_ID = "50000000-0000-4000-8000-000000000005";

function pageSnapshot(overrides: Partial<PageBeforeSnapshot["state"]> = {}): PageBeforeSnapshot {
  return {
    kind: "page",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    capturedAt: AT,
    target: {
      resourceId: "gid://shopify/Page/1001",
      handle: "politika-povrata-novca",
    },
    state: {
      title: "Politika povrata novca",
      bodyHtml: "<p>Old returns body that must be restorable.</p>",
      templateSuffix: null,
      isPublished: true,
      publishedAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T11:00:00.000Z",
      ...overrides,
    },
  };
}

function policySnapshot(
  overrides: Partial<PolicyBeforeSnapshot["state"]> = {},
): PolicyBeforeSnapshot {
  return {
    kind: "policy",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    capturedAt: AT,
    target: {
      resourceId: "gid://shopify/ShopPolicy/3001",
      policyType: "REFUND_POLICY",
    },
    state: {
      title: "Pravila refundacije",
      url: "https://www.lararovinj.com/policies/refund-policy",
      body: "<p>Old native refund policy that must be restorable.</p>",
      updatedAt: "2026-08-11T11:00:00.000Z",
      ...overrides,
    },
  };
}

function themeSnapshot(
  overrides: Partial<ThemeBeforeSnapshot["state"]> = {},
): ThemeBeforeSnapshot {
  return {
    kind: "theme_asset",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    capturedAt: AT,
    target: {
      themeId: "gid://shopify/OnlineStoreTheme/2001",
      assetKey: "sections/main-product.liquid",
    },
    state: {
      themeName: "Main theme",
      themeRole: "MAIN",
      contentType: "text/x-liquid",
      content: "<p>Košarica istječe za {{ timer }}</p>",
      checksumMd5: "0123456789abcdef0123456789abcdef",
      updatedAt: "2026-08-11T11:00:00.000Z",
      ...overrides,
    },
  };
}

async function operations(snapshots: {
  page: PageBeforeSnapshot;
  policy: PolicyBeforeSnapshot;
  theme: ThemeBeforeSnapshot;
}): Promise<ShopifyRemediationOperation[]> {
  return [
    {
      operationId: "returns-page-body",
      kind: "page.replace_body",
      reason: "Align the public returns page with the approved policy.",
      evidenceRefs: ["operator:returns-v1"],
      target: snapshots.page.target,
      cas: (await buildShopifyRemediationCas(snapshots.page)) as PageRemediationCas,
      change: { bodyHtml: "<p>Approved public returns policy.</p>" },
    },
    {
      operationId: "native-refund-policy",
      kind: "policy.replace_body",
      reason: "Populate the native Shopify refund policy with approved text.",
      evidenceRefs: ["operator:returns-v1"],
      target: snapshots.policy.target,
      cas: (await buildShopifyRemediationCas(snapshots.policy)) as PolicyRemediationCas,
      change: { body: "<p>Approved native refund policy.</p>" },
    },
    {
      operationId: "remove-cart-urgency",
      kind: "theme.replace_exact_text",
      reason: "Remove the exact cart-expiry message without a broad rewrite.",
      evidenceRefs: ["audit:F-02"],
      target: snapshots.theme.target,
      cas: (await buildShopifyRemediationCas(snapshots.theme)) as ThemeRemediationCas,
      change: {
        needle: "Košarica istječe za {{ timer }}",
        replacement: "Vaša košarica",
        expectedOccurrences: 1,
      },
    },
  ];
}

async function sealedPlan({
  snapshots,
  executionMode,
  customOperations,
}: {
  snapshots: {
    page: PageBeforeSnapshot;
    policy: PolicyBeforeSnapshot;
    theme: ThemeBeforeSnapshot;
  };
  executionMode?: "dry-run" | "apply";
  customOperations?: ShopifyRemediationOperation[];
}) {
  return sealShopifyRemediationPlan({
    planId: "lara-safe-skeleton-001",
    shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
    createdAt: AT,
    purpose: "Prepare the bounded Lara low-risk repair plan without live writes.",
    executionMode,
    operations: customOperations ?? (await operations(snapshots)),
  });
}

function fixtures() {
  return {
    page: pageSnapshot(),
    policy: policySnapshot(),
    theme: themeSnapshot(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("non-writing Lara remediation executor skeleton", () => {
  it("has no connected runtime, network call or live-write adapter in its module boundary", () => {
    const source = readFileSync(
      new URL("./shopify-remediation-executor.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain('from "./shopify-runtime"');
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/\bwriter\s*:/u);
    expect(source).not.toMatch(/\bexecuteMutation\b/u);
  });

  it("prepares all allowlisted changes, inverse material and an append-only safe journal", async () => {
    const current = fixtures();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const plan = await sealedPlan({ snapshots: current });

    const run = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [current.page, current.policy, current.theme],
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(SHOPIFY_REMEDIATION_LIVE_WRITES_IMPLEMENTED).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run).toMatchObject({
      status: "dry_run_complete",
      executionMode: "dry-run",
      writesAttempted: 0,
      liveWriterAttached: false,
    });
    expect(run.operationResults).toHaveLength(3);
    expect(run.operationResults.every((result) => result.status === "would_apply")).toBe(
      true,
    );
    expect(run.inverseManifest?.payload.operations).toEqual([
      expect.objectContaining({
        originalOperationId: "returns-page-body",
        kind: "page.restore_body",
        restore: { bodyHtml: current.page.state.bodyHtml },
      }),
      expect.objectContaining({
        originalOperationId: "native-refund-policy",
        kind: "policy.restore_body",
        restore: { body: current.policy.state.body },
      }),
      expect.objectContaining({
        originalOperationId: "remove-cart-urgency",
        kind: "theme.restore_asset_content",
        restore: { content: current.theme.state.content },
      }),
    ]);
    expect(run.inverseManifest?.digestSha256).toBe(
      await remediationSha256(run.inverseManifest?.payload),
    );
    expect(run.journal.map((entry) => entry.sequence)).toEqual(
      run.journal.map((_, index) => index + 1),
    );
    expect(JSON.stringify(run.journal)).not.toContain(current.page.state.bodyHtml);
    expect(JSON.stringify(run.journal)).not.toContain(current.theme.state.content);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.journal)).toBe(true);
    expect(Object.isFrozen(run.journal[0]?.details)).toBe(true);
  });

  it("fail-closes apply before evaluating snapshots and still performs zero writes", async () => {
    const current = fixtures();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const plan = await sealedPlan({ snapshots: current, executionMode: "apply" });

    const run = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [],
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(run.status).toBe("blocked_apply_disabled");
    expect(run.operationResults.every((result) => result.blockCode === "APPLY_DISABLED")).toBe(
      true,
    );
    expect(run.inverseManifest).toBeNull();
    expect(run.beforeSnapshots).toEqual([]);
    expect(run.writesAttempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks protected-field drift before the full-state CAS", async () => {
    const current = fixtures();
    const plan = await sealedPlan({ snapshots: current });
    const drifted = pageSnapshot({ title: "A title changed after approval" });

    const run = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [drifted, current.policy, current.theme],
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(run.status).toBe("blocked_precondition");
    expect(run.operationResults[0]).toMatchObject({
      status: "blocked",
      blockCode: "PROTECTED_FIELD_MISMATCH",
    });
    expect(run.inverseManifest).toBeNull();
  });

  it("blocks body drift through content CAS even when protected fields and timestamp match", async () => {
    const current = fixtures();
    const plan = await sealedPlan({ snapshots: current });
    const drifted = pageSnapshot({ bodyHtml: "<p>Concurrent body change.</p>" });

    const run = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [drifted, current.policy, current.theme],
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(run.operationResults[0]?.blockCode).toBe("STATE_CAS_MISMATCH");
    expect(run.inverseManifest).toBeNull();
  });

  it("blocks updatedAt and theme checksum races with distinct codes", async () => {
    const current = fixtures();
    const plan = await sealedPlan({ snapshots: current });
    const updatedPage = pageSnapshot({ updatedAt: "2026-08-12T11:00:00.000Z" });
    const changedTheme = themeSnapshot({
      checksumMd5: "fedcba9876543210fedcba9876543210",
    });

    const run = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [updatedPage, current.policy, changedTheme],
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(run.operationResults[0]?.blockCode).toBe("EXPECTED_UPDATED_AT_MISMATCH");
    expect(run.operationResults[2]?.blockCode).toBe("EXPECTED_CHECKSUM_MISMATCH");
  });

  it("requires the exact number of theme occurrences approved in the plan", async () => {
    const current = fixtures();
    const plan = await sealedPlan({ snapshots: current });
    const duplicateTheme = themeSnapshot({
      content:
        "Košarica istječe za {{ timer }} | Košarica istječe za {{ timer }}",
      // Keep the full-state CAS aligned so the occurrence guard itself is exercised.
    });
    const custom = await operations({ ...current, theme: duplicateTheme });
    const themeOperation = custom[2];
    if (!themeOperation || themeOperation.kind !== "theme.replace_exact_text") {
      throw new TypeError("Missing theme fixture operation.");
    }
    themeOperation.change.expectedOccurrences = 1;
    const occurrencePlan = await sealedPlan({
      snapshots: { ...current, theme: duplicateTheme },
      customOperations: custom,
    });

    const run = await prepareLaraShopifyRemediationRun({
      sealedPlan: occurrencePlan,
      snapshots: [current.page, current.policy, duplicateTheme],
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(plan.digestSha256).not.toBe(occurrencePlan.digestSha256);
    expect(run.operationResults[2]?.blockCode).toBe("EXPECTED_OCCURRENCES_MISMATCH");
  });

  it("blocks missing, extra and duplicate before snapshots without creating rollback material", async () => {
    const current = fixtures();
    const plan = await sealedPlan({ snapshots: current });

    const missing = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [current.page, current.policy],
      runId: RUN_ID,
      occurredAt: AT,
    });
    expect(missing.operationResults[2]?.blockCode).toBe("MISSING_SNAPSHOT");
    expect(missing.inverseManifest).toBeNull();

    const extra: ShopifyRemediationBeforeSnapshot = {
      ...current.page,
      target: {
        resourceId: "gid://shopify/Page/9999",
        handle: "extra-page",
      },
    };
    const withExtra = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [current.page, current.policy, current.theme, extra],
      runId: RUN_ID,
      occurredAt: AT,
    });
    expect(withExtra.status).toBe("blocked_precondition");
    expect(withExtra.journal.at(-1)?.details.code).toBe("EXTRA_SNAPSHOT");
    expect(withExtra.inverseManifest).toBeNull();

    const duplicate = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [current.page, current.page, current.policy, current.theme],
      runId: RUN_ID,
      occurredAt: AT,
    });
    expect(duplicate.operationResults[0]?.blockCode).toBe("DUPLICATE_SNAPSHOT");
    expect(duplicate.inverseManifest).toBeNull();
  });

  it("blocks no-op writes instead of producing a misleading successful dry run", async () => {
    const current = fixtures();
    const allOperations = await operations(current);
    const page = allOperations[0];
    if (!page || page.kind !== "page.replace_body") {
      throw new TypeError("Missing page fixture operation.");
    }
    page.change.bodyHtml = current.page.state.bodyHtml;
    const plan = await sealedPlan({ snapshots: current, customOperations: allOperations });

    const run = await prepareLaraShopifyRemediationRun({
      sealedPlan: plan,
      snapshots: [current.page, current.policy, current.theme],
      runId: RUN_ID,
      occurredAt: AT,
    });

    expect(run.operationResults[0]?.blockCode).toBe("NO_EFFECT");
    expect(run.status).toBe("blocked_precondition");
  });

  it("verifies the plan digest before preparing any operation", async () => {
    const current = fixtures();
    const plan = await sealedPlan({ snapshots: current });
    const tampered = structuredClone(plan) as {
      payload: { purpose: string };
      digestSha256: string;
    };
    tampered.payload.purpose = "An unsealed replacement purpose.";

    await expect(
      prepareLaraShopifyRemediationRun({
        sealedPlan: tampered,
        snapshots: [current.page, current.policy, current.theme],
        runId: RUN_ID,
        occurredAt: AT,
      }),
    ).rejects.toMatchObject({ code: "plan_digest_mismatch" });
  });
});
