import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_THEME,
  readLaraThemeUrgencySnapshot,
  type LaraThemeUrgencyFilename,
  type LaraThemeUrgencyReadRuntime,
} from "./lara-theme-urgency-plan";
import {
  LARA_THEME_URGENCY_KACHING_FILE,
  LARA_THEME_URGENCY_TERMINAL_PUBLIC_MARKERS,
  classifyLaraThemeUrgencyLiveState,
  prepareLaraThemeUrgencyLiveMaterial,
  verifyLaraThemeUrgencyLiveMaterial,
} from "./lara-theme-urgency-live-contract";
import { LARA_ROVINJ_REMEDIATION_SHOP } from "./shopify-remediation-plan";

const AT = "2026-08-12T21:45:00.000Z";
const BEFORE_MD5 = "0123456789abcdef0123456789abcdef";
const AFTER_MD5 = "abcdef0123456789abcdef0123456789";
const SHOPIFY_GENERATED_JSON_BANNER = `/*
 * ------------------------------------------------------------
 * IMPORTANT: The contents of this file are auto-generated.
 *
 * This file may be updated by the Shopify admin theme editor
 * or related systems. Please exercise caution as any changes
 * made to this file may be overwritten.
 * ------------------------------------------------------------
 */
`;

type FileState = { content: string; updatedAt: string; checksumMd5: string };

function sourceState(kachingType = "shopify://apps/kaching-cart/blocks/embed/abc123") {
  const state = new Map<LaraThemeUrgencyFilename, FileState>();
  for (const filename of LARA_THEME_URGENCY_FILES) {
    state.set(filename, {
      content: filename.endsWith(".json")
        ? "{}"
        : `{% comment %}${filename}{% endcomment %}`,
      updatedAt: AT,
      checksumMd5: BEFORE_MD5,
    });
  }
  state.set("blocks/ai_gen_block_a974a97.liquid", {
    content:
      "<h2>Lara Rovinj zatvara svoja vrata</h2><p>Veliko rasprodavanje cijele trgovine</p><p>Posljednji dani, posljednje veličine</p>",
    updatedAt: AT,
    checksumMd5: BEFORE_MD5,
  });
  state.set("sections/main-product.liquid", {
    content:
      '<span class="stock-urgency__text">Posljednji komadi</span><p>Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane.</p>',
    updatedAt: AT,
    checksumMd5: BEFORE_MD5,
  });
  state.set("templates/product.json", {
    content: '{"claim":"Hrvatski brend od 2015."}',
    updatedAt: AT,
    checksumMd5: BEFORE_MD5,
  });
  state.set(LARA_THEME_URGENCY_KACHING_FILE, {
    content: JSON.stringify({
      current: {
        blocks: {
          one: {
            type: kachingType,
            disabled: false,
            settings: { clearCartOnTimerEnd: false, label: "Košarica istječe za" },
          },
        },
      },
    }),
    updatedAt: AT,
    checksumMd5: BEFORE_MD5,
  });
  return state;
}

function runtime(
  state: Map<LaraThemeUrgencyFilename, FileState>,
  crlfNormalizedFilenames: readonly LaraThemeUrgencyFilename[] = [],
  generatedJsonFilenames: readonly LaraThemeUrgencyFilename[] = [],
) {
  const query = vi.fn(
    async (_document: string, variables?: Record<string, unknown>): Promise<unknown> => {
      const filename = (variables?.filenames as LaraThemeUrgencyFilename[])[0]!;
      const file = state.get(filename)!;
      const bodyContent = generatedJsonFilenames.includes(filename)
        ? `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(
            JSON.parse(file.content),
            null,
            2,
          )}`
        : crlfNormalizedFilenames.includes(filename)
          ? file.content.replace(/\r\n/g, "\n")
          : file.content;
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
                  content: bodyContent,
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
    query,
  } as LaraThemeUrgencyReadRuntime;
}

describe("Lara live theme material contract", () => {
  it("seals all eight full sources/inverses and keeps Kaching out of the copy write", async () => {
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: runtime(sourceState()),
      capturedAt: AT,
    });

    expect(material.payload.sourceSnapshot.files).toHaveLength(
      LARA_THEME_URGENCY_FILES.length,
    );
    expect(material.payload.plan.payload.operations.length).toBeGreaterThan(0);
    expect(
      material.payload.plan.payload.operations.some(
        (operation) => operation.target.filename === LARA_THEME_URGENCY_KACHING_FILE,
      ),
    ).toBe(false);
    expect(material.payload.kachingEvidence).toMatchObject({
      kachingTypedBlockCount: 1,
      exactEmbedTypeCount: 1,
      exactActiveEmbedCount: 1,
      separateBooleanPlanEligible: true,
      urgencyBatchWriteIncluded: false,
    });
    expect(material.payload.vendorPolicy).toMatchObject({
      decision: "merchant_accepted_non_issue",
      mutationsAllowed: false,
    });
    for (const operation of material.payload.plan.payload.operations) {
      const source = material.payload.sourceSnapshot.files.find(
        (file) => file.filename === operation.target.filename,
      );
      expect(operation.inverse.content).toBe(source?.content);
      expect(operation.after.content).not.toContain("Hrvatski brend od 2015");
      expect(operation.after.content).not.toContain("Posljednji komadi");
      expect(operation.after.content).not.toContain("Lara Rovinj zatvara svoja vrata");
      for (const marker of LARA_THEME_URGENCY_TERMINAL_PUBLIC_MARKERS) {
        expect(operation.after.content).not.toContain(marker);
      }
    }
    await expect(verifyLaraThemeUrgencyLiveMaterial(material)).resolves.toEqual(
      material,
    );
  });

  it("requires one exact embed type and an own explicit disabled:false for Kaching eligibility", async () => {
    const wrongType = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: runtime(
        sourceState("shopify://apps/kaching-cart/blocks/app-embed/abc123"),
      ),
      capturedAt: AT,
    });
    expect(wrongType.payload.kachingEvidence).toMatchObject({
      rawTokenOccurrences: 1,
      exactEmbedTypeCount: 0,
      separateBooleanPlanEligible: false,
    });

    const duplicate = sourceState();
    duplicate.set(LARA_THEME_URGENCY_KACHING_FILE, {
      ...duplicate.get(LARA_THEME_URGENCY_KACHING_FILE)!,
      content: JSON.stringify({
        current: {
          blocks: {
            one: {
              type: "shopify://apps/kaching-cart/blocks/embed/abc123",
              disabled: false,
            },
            two: {
              type: "shopify://apps/kaching-cart/blocks/embed/def456",
              disabled: false,
            },
          },
        },
      }),
    });
    const duplicateMaterial = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: runtime(duplicate),
      capturedAt: AT,
    });
    expect(duplicateMaterial.payload.kachingEvidence).toMatchObject({
      exactEmbedTypeCount: 2,
      separateBooleanPlanEligible: false,
    });
  });

  it("rejects complete source material that cannot fit the bounded durable artifact", async () => {
    const state = sourceState();
    const padding = "x".repeat(650_000);
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

    await expect(
      prepareLaraThemeUrgencyLiveMaterial({
        runtime: runtime(state),
        capturedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  });

  it("keeps reconstructed CRLF bytes in the live inverse and terminal state proof", async () => {
    const state = sourceState();
    const filename = "templates/index.json" as const;
    const rawSource = [
      "{",
      '  \"sections\": {',
      '    \"farewell\": { \"heading\": \"Zbogom...\" }',
      "  }",
      "}",
    ].join("\r\n");
    state.set(filename, {
      content: rawSource,
      updatedAt: AT,
      checksumMd5: createHash("md5").update(rawSource, "utf8").digest("hex"),
    });
    const client = runtime(state, [filename]);
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: client,
      capturedAt: AT,
    });
    const operation = material.payload.plan.payload.operations.find(
      (candidate) => candidate.target.filename === filename,
    )!;

    expect(operation.inverse.content).toBe(rawSource);
    expect(operation.after.content).toContain("\r\n");
    expect(operation.after.content).not.toContain("Zbogom...");

    for (const candidate of material.payload.plan.payload.operations) {
      state.set(candidate.target.filename, {
        content: candidate.after.content,
        updatedAt: "2026-08-12T21:46:00.000Z",
        checksumMd5: createHash("md5")
          .update(candidate.after.content, "utf8")
          .digest("hex"),
      });
    }
    const current = await readLaraThemeUrgencySnapshot({
      runtime: client,
      capturedAt: AT,
    });
    await expect(
      classifyLaraThemeUrgencyLiveState({ material, current }),
    ).resolves.toBe("after_exact");
  });

  it("keeps checksum-proven generated JSON bytes through terminal Admin verification", async () => {
    const state = sourceState();
    const filename = "templates/index.json" as const;
    const rawSource = JSON.stringify({
      sections: {
        farewell: {
          settings: {
            heading: "Zbogom...",
            body: "Lara Rovinj zatvara svoja vrata. Hvala vam što ste bili dio ove priče.",
          },
        },
      },
    });
    state.set(filename, {
      content: rawSource,
      updatedAt: AT,
      checksumMd5: createHash("md5").update(rawSource, "utf8").digest("hex"),
    });
    const client = runtime(state, [], [filename]);
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: client,
      capturedAt: AT,
    });
    const operation = material.payload.plan.payload.operations.find(
      (candidate) => candidate.target.filename === filename,
    )!;

    expect(operation.inverse.content).toBe(rawSource);
    expect(operation.after.content).not.toContain("Zbogom...");
    expect(operation.after.content).not.toContain(
      "Lara Rovinj zatvara svoja vrata",
    );

    for (const candidate of material.payload.plan.payload.operations) {
      state.set(candidate.target.filename, {
        content: candidate.after.content,
        updatedAt: "2026-08-12T21:46:00.000Z",
        checksumMd5: createHash("md5")
          .update(candidate.after.content, "utf8")
          .digest("hex"),
      });
    }
    const current = await readLaraThemeUrgencySnapshot({
      runtime: client,
      capturedAt: AT,
    });
    await expect(
      classifyLaraThemeUrgencyLiveState({ material, current }),
    ).resolves.toBe("after_exact");
  });

  it("classifies only exact before, exact after or attributable mixed states", async () => {
    const state = sourceState();
    const client = runtime(state);
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: client,
      capturedAt: AT,
    });
    const before = await readLaraThemeUrgencySnapshot({ runtime: client, capturedAt: AT });
    await expect(
      classifyLaraThemeUrgencyLiveState({ material, current: before }),
    ).resolves.toBe("before_exact");

    for (const [index, operation] of material.payload.plan.payload.operations.entries()) {
      if (index > 0) break;
      state.set(operation.target.filename, {
        content: operation.after.content,
        updatedAt: "2026-08-12T21:46:00.000Z",
        checksumMd5: AFTER_MD5,
      });
    }
    const mixed = await readLaraThemeUrgencySnapshot({ runtime: client, capturedAt: AT });
    await expect(
      classifyLaraThemeUrgencyLiveState({ material, current: mixed }),
    ).resolves.toBe("mixed_transition");

    for (const operation of material.payload.plan.payload.operations) {
      state.set(operation.target.filename, {
        content: operation.after.content,
        updatedAt: "2026-08-12T21:46:00.000Z",
        checksumMd5: AFTER_MD5,
      });
    }
    const after = await readLaraThemeUrgencySnapshot({ runtime: client, capturedAt: AT });
    await expect(
      classifyLaraThemeUrgencyLiveState({ material, current: after }),
    ).resolves.toBe("after_exact");

    state.set("sections/main-product.liquid", {
      content: "merchant concurrent edit",
      updatedAt: "2026-08-12T21:47:00.000Z",
      checksumMd5: AFTER_MD5,
    });
    const drift = await readLaraThemeUrgencySnapshot({ runtime: client, capturedAt: AT });
    await expect(
      classifyLaraThemeUrgencyLiveState({ material, current: drift }),
    ).resolves.toBe("drift");
  });
});
