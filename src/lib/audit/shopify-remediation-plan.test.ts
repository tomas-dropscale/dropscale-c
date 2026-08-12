import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  LARA_ROVINJ_REMEDIATION_SHOP,
  SHOPIFY_REMEDIATION_OPERATION_ALLOWLIST,
  ShopifyRemediationPlanError,
  buildShopifyRemediationCas,
  remediationSha256,
  sealShopifyRemediationPlan,
  verifyShopifyRemediationPlan,
  type PageBeforeSnapshot,
  type PageRemediationCas,
  type ShopifyRemediationOperation,
  type ThemeBeforeSnapshot,
  type ThemeRemediationCas,
} from "./shopify-remediation-plan";

const AT = "2026-08-12T12:00:00.000Z";

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
      bodyHtml: "<p>Old returns body.</p>",
      templateSuffix: null,
      isPublished: true,
      publishedAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T11:00:00.000Z",
      ...overrides,
    },
  };
}

function themeSnapshot(): ThemeBeforeSnapshot {
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
    },
  };
}

async function pageOperation(
  snapshot = pageSnapshot(),
  bodyHtml = "<p>Approved returns body.</p>",
): Promise<ShopifyRemediationOperation> {
  return {
    operationId: "returns-page-body",
    kind: "page.replace_body",
    reason: "Align the public returns page with the approved policy.",
    evidenceRefs: ["operator:returns-v1"],
    target: snapshot.target,
    cas: (await buildShopifyRemediationCas(snapshot)) as PageRemediationCas,
    change: { bodyHtml },
  };
}

async function themeOperation(
  snapshot = themeSnapshot(),
): Promise<ShopifyRemediationOperation> {
  return {
    operationId: "remove-cart-urgency",
    kind: "theme.replace_exact_text",
    reason: "Remove the exact cart-expiry message without a broad theme rewrite.",
    evidenceRefs: ["audit:F-02"],
    target: snapshot.target,
    cas: (await buildShopifyRemediationCas(snapshot)) as ThemeRemediationCas,
    change: {
      needle: "Košarica istječe za {{ timer }}",
      replacement: "Vaša košarica",
      expectedOccurrences: 1,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("immutable Lara Shopify remediation plans", () => {
  it("pins Lara exactly, defaults to dry-run, seals the digest and deep-freezes the plan", async () => {
    const operation = await pageOperation();
    const plan = await sealShopifyRemediationPlan({
      planId: "lara-returns-001",
      shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
      createdAt: AT,
      purpose: "Dry-run the first approved Lara returns correction.",
      operations: [operation],
    });

    expect(plan.payload.executionMode).toBe("dry-run");
    expect(plan.payload.shop).toEqual(LARA_ROVINJ_REMEDIATION_SHOP);
    expect(plan.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.payload)).toBe(true);
    expect(Object.isFrozen(plan.payload.operations)).toBe(true);
    expect(Object.isFrozen(plan.payload.operations[0]?.cas.protectedFields)).toBe(true);
    await expect(verifyShopifyRemediationPlan(plan)).resolves.toEqual(plan);
  });

  it("produces a deterministic digest and binds changes and operation order", async () => {
    const page = await pageOperation();
    const theme = await themeOperation();
    const common = {
      planId: "lara-deterministic-001",
      shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
      createdAt: AT,
      purpose: "Prove canonical immutable plan hashing for Lara repairs.",
    } as const;
    const first = await sealShopifyRemediationPlan({
      ...common,
      operations: [page, theme],
    });
    const same = await sealShopifyRemediationPlan({
      purpose: common.purpose,
      createdAt: common.createdAt,
      shop: { shopId: common.shop.shopId, domain: common.shop.domain },
      planId: common.planId,
      operations: [page, theme],
    });
    const reordered = await sealShopifyRemediationPlan({
      ...common,
      operations: [theme, page],
    });

    expect(same.digestSha256).toBe(first.digestSha256);
    expect(reordered.digestSha256).not.toBe(first.digestSha256);
  });

  it("rejects a payload changed after sealing", async () => {
    const plan = await sealShopifyRemediationPlan({
      planId: "lara-tamper-001",
      shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
      createdAt: AT,
      purpose: "Prove that post-seal changes are rejected.",
      operations: [await pageOperation()],
    });
    const tampered = structuredClone(plan) as {
      payload: { purpose: string };
      digestSha256: string;
    };
    tampered.payload.purpose = "A different and unauthorised purpose.";

    await expect(verifyShopifyRemediationPlan(tampered)).rejects.toMatchObject({
      code: "plan_digest_mismatch",
    });
  });

  it("rejects every store identity except the exact Lara domain and shop GID", async () => {
    const operation = await pageOperation();
    const invalid = {
      planId: "wrong-shop-001",
      shop: {
        domain: "another-shop.myshopify.com",
        shopId: LARA_ROVINJ_REMEDIATION_SHOP.shopId,
      },
      createdAt: AT,
      purpose: "This must never be accepted for a different shop.",
      operations: [operation],
    };

    await expect(
      sealShopifyRemediationPlan(invalid as never),
    ).rejects.toBeInstanceOf(ShopifyRemediationPlanError);
  });

  it("has no product, publication, price, inventory, customer or order operation", () => {
    expect(SHOPIFY_REMEDIATION_OPERATION_ALLOWLIST).toEqual([
      "page.replace_body",
      "policy.replace_body",
      "theme.replace_exact_text",
    ]);
  });

  it("rejects unknown operations and duplicate targets", async () => {
    const operation = await pageOperation();
    const base = {
      planId: "lara-invalid-ops-001",
      shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
      createdAt: AT,
      purpose: "Reject operations outside the narrow allowlist.",
    };

    await expect(
      sealShopifyRemediationPlan({
        ...base,
        operations: [
          {
            ...operation,
            kind: "product.update",
          } as never,
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_plan" });

    await expect(
      sealShopifyRemediationPlan({
        ...base,
        operations: [
          operation,
          { ...operation, operationId: "returns-page-body-again" },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("rejects active page HTML and theme replacements that add executable tokens", async () => {
    await expect(
      sealShopifyRemediationPlan({
        planId: "lara-active-html-001",
        shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
        createdAt: AT,
        purpose: "Reject active content in low-risk page repairs.",
        operations: [
          await pageOperation(
            pageSnapshot(),
            '<p>Policy</p><script src="https://example.test/x.js"></script>',
          ),
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_plan" });

    const theme = await themeOperation();
    if (theme.kind !== "theme.replace_exact_text") {
      throw new TypeError("Missing theme fixture operation.");
    }
    await expect(
      sealShopifyRemediationPlan({
        planId: "lara-active-theme-001",
        shop: { ...LARA_ROVINJ_REMEDIATION_SHOP },
        createdAt: AT,
        purpose: "Reject new executable tokens in a theme text repair.",
        operations: [
          {
            ...theme,
            change: {
              ...theme.change,
              replacement: "<script>alert(1)</script>",
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("builds a CAS digest over the target and protected state, not capturedAt", async () => {
    const first = pageSnapshot();
    const recaptured = { ...first, capturedAt: "2026-08-12T13:00:00.000Z" };
    const changed = pageSnapshot({ title: "Changed title" });

    const firstCas = await buildShopifyRemediationCas(first);
    const recapturedCas = await buildShopifyRemediationCas(recaptured);
    const changedCas = await buildShopifyRemediationCas(changed);

    expect(recapturedCas).toEqual(firstCas);
    expect(changedCas.beforeStateSha256).not.toBe(firstCas.beforeStateSha256);
    expect(await remediationSha256(firstCas)).toMatch(/^[a-f0-9]{64}$/);
  });
});
