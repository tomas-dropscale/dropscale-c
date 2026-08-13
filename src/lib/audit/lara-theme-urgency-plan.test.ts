import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_REST_THEME_ID,
  LARA_THEME_URGENCY_SOURCE_QUERY,
  LARA_THEME_URGENCY_THEME,
  LARA_THEME_VENDOR_POLICY,
  LaraThemeUrgencyPlanError,
  buildLaraThemeUrgencyPlan,
  readLaraThemeUrgencySnapshot,
  verifyLaraThemeUrgencyPlan,
  type LaraThemeUrgencyFilename,
  type LaraThemeUrgencyReadRuntime,
} from "./lara-theme-urgency-plan";
import { LARA_ROVINJ_REMEDIATION_SHOP } from "./shopify-remediation-plan";

const AT = "2026-08-12T18:00:00.000Z";
const MD5 = "0123456789abcdef0123456789abcdef";
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

const sources = new Map<string, string>(
  LARA_THEME_URGENCY_FILES.map((filename) => [
    filename,
    filename.endsWith(".json") ? "{}" : `{% comment %}${filename}{% endcomment %}`,
  ]),
);
sources.set(
  "blocks/ai_gen_block_a974a97.liquid",
  '<p>Zbogom...</p><h2>Veliko rasprodavanje cijele trgovine</h2><div class="a974a97_NWNyPc"><p>Lara Rovinj zatvara svoja vrata. Hvala vam što ste bili dio ove priče.</p><p>Posljednji dani, posljednje veličine!</p><p>Zauvijek,<br/>Lara.</p></div>',
);
sources.set(
  "templates/index.json",
  '{\n  "sections": {\n    "farewell": {\n      "settings": {\n        "kicker": "Zbogom...",\n        "heading": "Veliko rasprodavanje cijele trgovine",\n        "body": "<p>Lara Rovinj zatvara svoja vrata. Hvala vam što ste bili dio ove priče.</p><p>Posljednji dani, posljednje veličine!</p><p>Zauvijek,<br/>Lara.</p>"\n      }\n    }\n  }\n}',
);
sources.set(
  "sections/main-product.liquid",
  '<span class="stock-urgency__text">Posljednji komadi</span><span class="cc-conv__sale-text">Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane. Međutim, ako kliknete na gumb &quot;DODAJ U KOŠARICU&quot;, proizvod je još uvijek dostupan.</span><script>updateStockUrgency(document.querySelector("[data-stock-urgency-variants]"))</script>',
);
sources.set(
  "templates/product.json",
  '{\n  "sections": {\n    "main": {\n      "settings": {\n        "message": "Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane. Međutim, ako kliknete na gumb \\\"DODAJ U KOŠARICU\\\", proizvod je još uvijek dostupan.",\n        "claim": "Hrvatski brend od 2015."\n      }\n    }\n  }\n}',
);
sources.set(
  "config/settings_data.json",
  '{\n  "current": {\n    "blocks": {\n      "timer": {\n        "type": "shopify://apps/kaching-cart/blocks/app-embed/1",\n        "settings": { "label": "Košarica istječe za", "clearCartOnTimerEnd": false }\n      }\n    }\n  }\n}',
);

function runtime(
  overrides: Partial<LaraThemeUrgencyReadRuntime> = {},
  textNormalization?: {
    filename: LaraThemeUrgencyFilename;
    checksumMd5?: string | null;
    decodedContent?: string;
    storedContent?: string;
  },
) {
  const query = vi.fn(
    async (_document: string, variables?: Record<string, unknown>): Promise<unknown> => {
      const filenames = variables?.filenames as string[];
      const filename = filenames[0];
      const sourceContent = sources.get(filename) ?? "";
      const decodedContent =
        textNormalization?.filename === filename &&
        textNormalization.decodedContent !== undefined
          ? textNormalization.decodedContent
          : sourceContent;
      const reconstructedContent =
        textNormalization?.filename === filename
          ? textNormalization.storedContent ??
            decodedContent.replace(/\r?\n/g, "\r\n")
          : decodedContent;
      return {
        theme: {
          id: LARA_THEME_URGENCY_THEME.id,
          name: "symmetry",
          role: "MAIN",
          files: {
            nodes: [
              {
                filename,
                checksumMd5:
                  textNormalization?.filename === filename
                    ? textNormalization.checksumMd5 === undefined
                      ? createHash("md5")
                          .update(reconstructedContent, "utf8")
                          .digest("hex")
                      : textNormalization.checksumMd5
                    : createHash("md5")
                        .update(decodedContent, "utf8")
                        .digest("hex"),
                contentType: filename.endsWith(".json")
                  ? "application/json"
                  : "text/x-liquid",
                size: new TextEncoder().encode(reconstructedContent).byteLength,
                updatedAt: AT,
                body: {
                  __typename: "OnlineStoreThemeFileBodyText",
                  content: decodedContent,
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
    ...overrides,
  } as LaraThemeUrgencyReadRuntime & { query: typeof query };
}

describe("Lara exact theme urgency source collection", () => {
  it("reads all eight fixed files separately and binds the protected main theme", async () => {
    const client = runtime();
    const snapshot = await readLaraThemeUrgencySnapshot({
      runtime: client,
      capturedAt: AT,
    });

    expect(client.query).toHaveBeenCalledTimes(LARA_THEME_URGENCY_FILES.length);
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      LARA_THEME_URGENCY_SOURCE_QUERY,
      {
        themeId: LARA_THEME_URGENCY_THEME.id,
        filenames: [LARA_THEME_URGENCY_FILES[0]],
      },
    );
    expect(snapshot.theme).toMatchObject({
      id: LARA_THEME_URGENCY_THEME.id,
      name: "symmetry",
      role: "MAIN",
    });
    expect(snapshot.files.map((file) => file.filename)).toEqual(
      LARA_THEME_URGENCY_FILES,
    );
    expect(snapshot.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
  });

  it("fails before reading when the runtime is not exact or lacks read_themes", async () => {
    const client = runtime({ grantedScopes: ["write_themes"] });
    await expect(
      readLaraThemeUrgencySnapshot({ runtime: client, capturedAt: AT }),
    ).rejects.toMatchObject({ code: "INVALID_RUNTIME" });
    expect(client.query).not.toHaveBeenCalled();

    const wrongConnection = runtime({
      connectionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    await expect(
      readLaraThemeUrgencySnapshot({ runtime: wrongConnection, capturedAt: AT }),
    ).rejects.toMatchObject({ code: "INVALID_RUNTIME" });
    expect(wrongConnection.query).not.toHaveBeenCalled();
  });

  it("rejects URL/base64 bodies instead of claiming to have a full source backup", async () => {
    const client = runtime();
    client.query.mockResolvedValueOnce({
      theme: {
        id: LARA_THEME_URGENCY_THEME.id,
        name: "symmetry",
        role: "MAIN",
        files: {
          nodes: [
            {
              filename: LARA_THEME_URGENCY_FILES[0],
              checksumMd5: MD5,
              contentType: "text/x-liquid",
              size: 10,
              updatedAt: AT,
              body: {
                __typename: "OnlineStoreThemeFileBodyUrl",
                url: "https://cdn.shopify.com/file",
              },
            },
          ],
          userErrors: [],
        },
      },
    });

    await expect(
      readLaraThemeUrgencySnapshot({ runtime: client, capturedAt: AT }),
    ).rejects.toMatchObject({
      name: LaraThemeUrgencyPlanError.name,
      code: "BODY_NOT_TEXT",
    });
  });

  it("rejects a truncated multibyte body even when Shopify returned text", async () => {
    const client = runtime();
    client.query.mockResolvedValueOnce({
      theme: {
        id: LARA_THEME_URGENCY_THEME.id,
        name: "symmetry",
        role: "MAIN",
        files: {
          nodes: [
            {
              filename: LARA_THEME_URGENCY_FILES[0],
              checksumMd5: MD5,
              contentType: "text/x-liquid",
              size: 1,
              updatedAt: AT,
              body: {
                __typename: "OnlineStoreThemeFileBodyText",
                content: "č",
              },
            },
          ],
          userErrors: [],
        },
      },
    });
    await expect(
      readLaraThemeUrgencySnapshot({ runtime: client, capturedAt: AT }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects literal-size text when an available Shopify MD5 does not match", async () => {
    const client = runtime();
    const filename = LARA_THEME_URGENCY_FILES[0];
    const content = sources.get(filename)!;
    client.query.mockResolvedValueOnce({
      theme: {
        id: LARA_THEME_URGENCY_THEME.id,
        name: "symmetry",
        role: "MAIN",
        files: {
          nodes: [
            {
              filename,
              checksumMd5: "0".repeat(32),
              contentType: "text/x-liquid",
              size: Buffer.byteLength(content, "utf8"),
              updatedAt: AT,
              body: {
                __typename: "OnlineStoreThemeFileBodyText",
                content,
              },
            },
          ],
          userErrors: [],
        },
      },
    });

    await expect(
      readLaraThemeUrgencySnapshot({ runtime: client, capturedAt: AT }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reconstructs stored CRLF only when Shopify size and MD5 prove every byte", async () => {
    const filename = "templates/index.json" as const;
    const decoded = sources.get(filename)!;
    const reconstructed = decoded.replace(/\r?\n/g, "\r\n");
    const client = runtime({}, { filename });
    const snapshot = await readLaraThemeUrgencySnapshot({
      runtime: client,
      capturedAt: AT,
    });
    const source = snapshot.files.find((file) => file.filename === filename)!;

    expect(source.content).toBe(reconstructed);
    expect(source.size).toBe(new TextEncoder().encode(reconstructed).byteLength);
    expect(source.checksumMd5).toBe(
      createHash("md5").update(reconstructed, "utf8").digest("hex"),
    );
    const plan = await buildLaraThemeUrgencyPlan({
      snapshot,
      planId: "lara-theme-crlf-proof",
      createdAt: AT,
    });
    const operation = plan.payload.operations.find(
      (candidate) => candidate.target.filename === filename,
    )!;
    expect(operation.inverse.content).toBe(reconstructed);
    expect(operation.after.content).toContain("\r\n");
  });

  it("rejects CRLF inference without the exact reconstructed checksum", async () => {
    const filename = "templates/index.json" as const;
    for (const checksumMd5 of [null, "0".repeat(32)]) {
      await expect(
        readLaraThemeUrgencySnapshot({
          runtime: runtime({}, { filename, checksumMd5 }),
          capturedAt: AT,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("strips only the exact anchored Shopify JSON banner when size and MD5 prove the stored bytes", async () => {
    const filename = "templates/index.json" as const;
    const storedContent = sources.get(filename)!;
    const decodedContent = `${SHOPIFY_GENERATED_JSON_BANNER}${storedContent}`;
    const snapshot = await readLaraThemeUrgencySnapshot({
      runtime: runtime(
        {},
        { filename, decodedContent, storedContent },
      ),
      capturedAt: AT,
    });

    const source = snapshot.files.find((file) => file.filename === filename)!;
    expect(source.content).toBe(storedContent);
    expect(source.size).toBe(Buffer.byteLength(storedContent, "utf8"));
    expect(source.checksumMd5).toBe(
      createHash("md5").update(storedContent, "utf8").digest("hex"),
    );
  });

  it("reconstructs compact generated JSON including a proven terminal newline", async () => {
    const filename = "templates/index.json" as const;
    const parsed = JSON.parse(sources.get(filename)!);
    const storedContent = `${JSON.stringify(parsed)}\n`;
    const decodedContent = `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(parsed, null, 2)}`;
    const snapshot = await readLaraThemeUrgencySnapshot({
      runtime: runtime(
        {},
        { filename, decodedContent, storedContent },
      ),
      capturedAt: AT,
    });
    const source = snapshot.files.find((file) => file.filename === filename)!;

    expect(source.content).toBe(storedContent);
    const plan = await buildLaraThemeUrgencyPlan({
      snapshot,
      planId: "lara-theme-generated-json-proof",
      createdAt: AT,
    });
    const operation = plan.payload.operations.find(
      (candidate) => candidate.target.filename === filename,
    )!;
    expect(operation.inverse.content).toBe(storedContent);
    expect(operation.after.content.endsWith("\n")).toBe(true);
    expect(operation.after.content).not.toContain("Zbogom...");
  });

  it("rejects projected JSON on a wrong checksum or a near-match banner", async () => {
    const filename = "templates/index.json" as const;
    const parsed = JSON.parse(sources.get(filename)!);
    const storedContent = JSON.stringify(parsed);
    const projectedJson = JSON.stringify(parsed, null, 2);

    await expect(
      readLaraThemeUrgencySnapshot({
        runtime: runtime(
          {},
          {
            filename,
            decodedContent: `${SHOPIFY_GENERATED_JSON_BANNER}${projectedJson}`,
            storedContent,
            checksumMd5: "0".repeat(32),
          },
        ),
        capturedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      readLaraThemeUrgencySnapshot({
        runtime: runtime(
          {},
          {
            filename,
            decodedContent: `${SHOPIFY_GENERATED_JSON_BANNER.replace(
              "IMPORTANT:",
              "IMPORTANT!",
            )}${projectedJson}`,
            storedContent,
          },
        ),
        capturedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("uses the fixed REST asset only when GraphQL projection cannot prove the stored JSON", async () => {
    const filename = "templates/index.json" as const;
    const parsed = JSON.parse(sources.get(filename)!);
    const storedContent = `${JSON.stringify(parsed, null, 4)}\n`;
    const decodedContent = `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(parsed, null, 2)}`;
    const checksumMd5 = createHash("md5")
      .update(storedContent, "utf8")
      .digest("hex");
    const readExactThemeAsset = vi.fn(async () => ({
      filename,
      themeId: LARA_THEME_URGENCY_REST_THEME_ID,
      checksumMd5,
      contentType: "application/json",
      size: Buffer.byteLength(storedContent, "utf8"),
      updatedAt: AT,
      projectedContent: decodedContent,
      content: storedContent,
    }));
    const snapshot = await readLaraThemeUrgencySnapshot({
      runtime: runtime(
        { readExactThemeAsset },
        { filename, decodedContent, storedContent },
      ),
      capturedAt: AT,
    });

    expect(readExactThemeAsset).toHaveBeenCalledOnce();
    expect(readExactThemeAsset).toHaveBeenCalledWith(filename);
    expect(
      snapshot.files.find((file) => file.filename === filename)?.content,
    ).toBe(storedContent);
  });

  it("rejects REST bytes unless all preceding GraphQL source metadata still matches", async () => {
    const filename = "templates/index.json" as const;
    const parsed = JSON.parse(sources.get(filename)!);
    const storedContent = `${JSON.stringify(parsed, null, 4)}\n`;
    const decodedContent = `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(parsed, null, 2)}`;
    const checksumMd5 = createHash("md5")
      .update(storedContent, "utf8")
      .digest("hex");

    await expect(
      readLaraThemeUrgencySnapshot({
        runtime: runtime(
          {
            readExactThemeAsset: vi.fn(async () => ({
              filename,
              themeId: LARA_THEME_URGENCY_REST_THEME_ID,
              checksumMd5,
              contentType: "application/json",
              size: Buffer.byteLength(storedContent, "utf8"),
              updatedAt: "2026-08-12T18:00:01.000Z",
              projectedContent: decodedContent,
              content: storedContent,
            })),
          },
          { filename, decodedContent, storedContent },
        ),
        capturedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a REST reconstruction that is not independently derivable from the GraphQL JSON projection", async () => {
    const filename = "templates/index.json" as const;
    const graphqlParsed = { sections: { main: { type: "featured" } } };
    const restParsed = { sections: { main: { type: "different" } } };
    const graphqlProjection = `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(
      graphqlParsed,
      null,
      2,
    )}`;
    const restProjection = `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(
      restParsed,
      null,
      2,
    )}`;
    const storedContent = `${JSON.stringify(restParsed, null, 4)}\n`;
    const checksumMd5 = createHash("md5")
      .update(storedContent, "utf8")
      .digest("hex");

    await expect(
      readLaraThemeUrgencySnapshot({
        runtime: runtime(
          {
            readExactThemeAsset: vi.fn(async () => ({
              filename,
              themeId: LARA_THEME_URGENCY_REST_THEME_ID,
              checksumMd5,
              contentType: "application/json",
              size: Buffer.byteLength(storedContent, "utf8"),
              updatedAt: AT,
              projectedContent: restProjection,
              content: storedContent,
            })),
          },
          {
            filename,
            decodedContent: graphqlProjection,
            storedContent,
          },
        ),
        capturedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("immutable Lara theme urgency plan", () => {
  it("proposes only exact copy changes, retains inverse bodies and blocks Kaching", async () => {
    const snapshot = await readLaraThemeUrgencySnapshot({
      runtime: runtime(),
      capturedAt: AT,
    });
    const plan = await buildLaraThemeUrgencyPlan({
      snapshot,
      planId: "lara-theme-urgency-001",
      createdAt: AT,
    });

    expect(plan.payload.executionMode).toBe("dry-run");
    expect(plan.payload.vendorPolicy).toEqual(LARA_THEME_VENDOR_POLICY);
    expect(plan.payload.vendorPolicy.mutationsAllowed).toBe(false);
    expect(plan.payload.operations.map((operation) => operation.target.filename)).toEqual([
      "blocks/ai_gen_block_a974a97.liquid",
      "templates/index.json",
      "sections/main-product.liquid",
      "templates/product.json",
    ]);
    const home = plan.payload.operations[0];
    expect(home?.after.content).toContain("Dobrodošli");
    expect(home?.after.content).toContain("Dobrodošli u Lara Rovinj");
    expect(home?.after.content).toContain("Otkrijte kolekciju Lara Rovinj");
    expect(home?.after.content).not.toContain("Srdačno,");
    expect(home?.after.content).not.toContain("<br/>Lara.</p>");
    expect(home?.inverse.content).toBe(sources.get(home.target.filename));
    expect(home?.before.contentSha256).toBe(home?.inverse.contentSha256);

    const productJson = plan.payload.operations.find(
      (operation) => operation.target.filename === "templates/product.json",
    );
    expect(productJson?.after.content).toContain(
      '"claim": "Lara Rovinj"',
    );
    expect(productJson?.after.content).toContain(
      '"message": "Dostupnost proizvoda redovito se ažurira."',
    );
    expect(productJson?.after.content.split("\n")).toHaveLength(
      sources.get("templates/product.json")!.split("\n").length,
    );

    expect(
      plan.payload.operations.some(
        (operation) => operation.target.filename === "config/settings_data.json",
      ),
    ).toBe(false);
    expect(plan.payload.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "KACHING_TIMER_UNSAFE_TO_DISABLE",
          filename: "config/settings_data.json",
          marker: "Košarica istječe za",
        }),
        expect.objectContaining({
          code: "KACHING_TIMER_UNSAFE_TO_DISABLE",
          filename: "config/settings_data.json",
          marker: "clearCartOnTimerEnd",
        }),
      ]),
    );
    expect(
      plan.payload.findings
        .filter((finding) => finding.category === "high_demand")
        .every((finding) => finding.disposition === "changed_exactly"),
    ).toBe(true);
    for (const operation of plan.payload.operations) {
      for (const residual of [
        "Zbogom...",
        "Lara Rovinj zatvara svoja vrata",
        "Hvala vam što ste bili dio ove priče",
        "Veliko rasprodavanje cijele trgovine",
        "Posljednji dani, posljednje veličine",
        "Zauvijek,",
        "Posljednji komadi",
        "Zbog velike potražnje tijekom rasprodaje",
        "ako kliknete na gumb",
        "proizvod je još uvijek dostupan",
        "Hrvatski brend od 2015",
      ]) {
        expect(operation.after.content).not.toContain(residual);
      }
      expect(operation.inverse.content).toBe(
        sources.get(operation.target.filename),
      );
    }
    expect(
      plan.payload.blockers.filter(
        (blocker) => blocker.code === "AMBIGUOUS_ACTIVE_COPY",
      ),
    ).toEqual([]);
    expect(plan.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan.payload.operations)).toBe(true);
    await expect(verifyLaraThemeUrgencyPlan(plan)).resolves.toEqual(plan);
  });

  it("detects a modified sealed payload even when the object was copied", async () => {
    const snapshot = await readLaraThemeUrgencySnapshot({
      runtime: runtime(),
      capturedAt: AT,
    });
    const plan = await buildLaraThemeUrgencyPlan({
      snapshot,
      planId: "lara-theme-urgency-002",
      createdAt: AT,
    });
    const tampered = structuredClone(plan);
    Reflect.set(tampered.payload, "purpose", "Tampered after sealing");

    await expect(verifyLaraThemeUrgencyPlan(tampered)).rejects.toMatchObject({
      code: "PLAN_DIGEST_MISMATCH",
    });
  });
});
