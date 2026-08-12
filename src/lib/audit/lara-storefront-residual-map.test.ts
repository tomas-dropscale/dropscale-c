import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectLaraStorefrontResidualMap,
  LARA_STOREFRONT_APP_INSTALLATIONS_QUERY,
  LARA_STOREFRONT_MAIN_THEME_QUERY,
  LARA_STOREFRONT_MENUS_QUERY,
  LARA_STOREFRONT_RESIDUAL_QUERY_MANIFEST,
  LARA_STOREFRONT_THEME_BODIES_QUERY,
  LARA_STOREFRONT_THEME_FILES_QUERY,
  laraStorefrontResidualManifestSha256,
  summariseLaraStorefrontResidualArtifact,
} from "./lara-storefront-residual-map";

const THEME = {
  id: "gid://shopify/OnlineStoreTheme/186665468284",
  name: "symmetry",
  prefix: "t/2",
  role: "MAIN",
  themeStoreId: 999,
  processing: false,
  processingFailed: false,
  updatedAt: "2026-08-12T20:00:00Z",
};

const SETTINGS_SOURCE = JSON.stringify({
  current: {
    blocks: {
      "embed-1": {
        type: "shopify://apps/kaching-cart/blocks/embed/12345678",
        disabled: false,
        settings: {
          clearCartOnTimerEnd: false,
          apiKey: "must-not-persist",
        },
      },
    },
  },
});
const SHIPPING_SOURCE = JSON.stringify({
  blocks: [
    {
      image: "hrvatska-posta.svg",
      className: "usp-icon-hp",
      copy: "Brza i sigurna dostava Hrvatskom poštom, ravno do vaših vrata.",
    },
  ],
});
const SALE_SOURCE = JSON.stringify({
  promo: { heading: "Sniženja", subheading: "Do 50% popusta" },
});
const NEUTRAL_SOURCE = "<main>{{ content_for_layout }}</main>";

function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function metadata(filename: string, content: string, contentType = "application/json") {
  return {
    filename,
    checksumMd5: "a".repeat(32),
    contentType,
    size: bytes(content),
    updatedAt: "2026-08-12T20:00:00Z",
  };
}

const SETTINGS_FILE = metadata("config/settings_data.json", SETTINGS_SOURCE);
const SHIPPING_FILE = metadata("sections/footer-group.json", SHIPPING_SOURCE);
const SALE_FILE = metadata("sections/header-group.json", SALE_SOURCE);
const NEUTRAL_FILE = metadata(
  "layout/theme.liquid",
  NEUTRAL_SOURCE,
  "application/x-liquid",
);
const LOGO_FILE = {
  filename: "assets/hrvatska-posta.svg",
  checksumMd5: "b".repeat(32),
  contentType: "image/svg+xml",
  size: 320,
  updatedAt: "2026-08-12T20:00:00Z",
};

type TestMenuItem = {
  id: string;
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  tags: string[];
  items: TestMenuItem[];
};

function menuItem(
  id: number,
  title: string,
  input: Partial<{
    type: string;
    url: string | null;
    resourceId: string | null;
    tags: string[];
    items: TestMenuItem[];
  }> = {},
): TestMenuItem {
  return {
    id: `gid://shopify/MenuItem/${id}`,
    title,
    type: input.type ?? "HTTP",
    url: input.url ?? null,
    resourceId: input.resourceId ?? null,
    tags: input.tags ?? [],
    items: input.items ?? [],
  };
}

function menus() {
  return {
    main: {
      id: "gid://shopify/Menu/347574075772",
      handle: "main-menu",
      title: "Main menu",
      isDefault: true,
      items: [
        menuItem(1, "Početna", {
          url: "/?tracking=remove#fragment",
          items: [
            menuItem(6, "Kategorija", {
              items: [menuItem(7, "Model", { url: "/collections/model" })],
            }),
          ],
        }),
        menuItem(2, "LJETNA AKCIJA ’26", {
          type: "COLLECTION",
          url: "/collections/sales?campaign=summer",
        }),
        menuItem(3, "Kontakt", {
          type: "PAGE",
          url: "/pages/kontakt?source=menu",
          resourceId: "gid://shopify/Page/697904923004",
        }),
      ],
    },
    footer: {
      id: "gid://shopify/Menu/347574108540",
      handle: "footer",
      title: "Footer",
      isDefault: true,
      items: [
        menuItem(4, "Kontakt", {
          type: "PAGE",
          url: "/pages/kontakt",
          resourceId: "gid://shopify/Page/697904923004",
        }),
        menuItem(5, "O nama", {
          type: "PAGE",
          url: "/pages/o-nama",
          resourceId: "gid://shopify/Page/697974849916",
        }),
      ],
    },
  };
}

function runtime(options: { wrongTheme?: boolean; duplicateMenu?: boolean } = {}) {
  const queryMock = vi.fn(async (
    document: string,
    variables: Record<string, unknown> = {},
  ): Promise<unknown> => {
    if (document === LARA_STOREFRONT_MAIN_THEME_QUERY) {
      return {
        themes: {
          nodes: [
            options.wrongTheme
              ? { ...THEME, id: "gid://shopify/OnlineStoreTheme/999" }
              : THEME,
          ],
        },
      };
    }
    if (document === LARA_STOREFRONT_THEME_FILES_QUERY) {
      const after = variables.after;
      return {
        theme: {
          ...THEME,
          files:
            after === null
              ? {
                  nodes: [SETTINGS_FILE, SHIPPING_FILE, LOGO_FILE],
                  pageInfo: { hasNextPage: true, endCursor: "page-2" },
                  userErrors: [],
                }
              : {
                  nodes: [SALE_FILE, NEUTRAL_FILE],
                  pageInfo: { hasNextPage: false, endCursor: null },
                  userErrors: [],
                },
        },
      };
    }
    if (document === LARA_STOREFRONT_THEME_BODIES_QUERY) {
      const requested = variables.filenames as string[];
      const all = new Map([
        [
          SETTINGS_FILE.filename,
          {
            ...SETTINGS_FILE,
            body: {
              __typename: "OnlineStoreThemeFileBodyText",
              content: SETTINGS_SOURCE,
            },
          },
        ],
        [
          SHIPPING_FILE.filename,
          {
            ...SHIPPING_FILE,
            body: {
              __typename: "OnlineStoreThemeFileBodyText",
              content: SHIPPING_SOURCE,
            },
          },
        ],
        [
          SALE_FILE.filename,
          {
            ...SALE_FILE,
            body: {
              __typename: "OnlineStoreThemeFileBodyUrl",
              url: "https://cdn.shopify.com/s/files/header-source",
            },
          },
        ],
        [
          NEUTRAL_FILE.filename,
          {
            ...NEUTRAL_FILE,
            body: {
              __typename: "OnlineStoreThemeFileBodyBase64",
              contentBase64: Buffer.from(NEUTRAL_SOURCE).toString("base64"),
            },
          },
        ],
      ]);
      return {
        theme: {
          ...THEME,
          files: {
            nodes: requested.flatMap((filename) => {
              const node = all.get(filename);
              return node ? [node] : [];
            }),
            userErrors: [],
          },
        },
      };
    }
    if (document === LARA_STOREFRONT_MENUS_QUERY) {
      const result = menus();
      if (options.duplicateMenu) result.footer.items[0].id = result.main.items[0].id;
      return result;
    }
    if (document === LARA_STOREFRONT_APP_INSTALLATIONS_QUERY) {
      return {
        appInstallations: {
          nodes: [
            {
              app: {
                title: "Shopify Flow",
                handle: "shopify-flow",
                shopifyDeveloped: true,
              },
            },
            {
              app: {
                title: "Shopify Forms",
                handle: "forms",
                shopifyDeveloped: true,
              },
            },
            {
              app: {
                title: "Unrelated private integration",
                handle: "unrelated-private",
                shopifyDeveloped: false,
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    throw new Error("Unexpected query");
  });
  return {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: "jwmtjg-fm.myshopify.com",
    shopId: "gid://shopify/Shop/95462097276",
    grantedScopes: [
      "read_themes",
      "read_online_store_navigation",
      "read_apps",
    ],
    query: queryMock as unknown as <TData>(
      document: string,
      variables?: Record<string, unknown>,
    ) => Promise<TData>,
    queryMock,
  };
}

describe("the fixed read-only Lara storefront residual mapper", () => {
  it("contains only named read queries and hashes the fixed pins into its manifest", async () => {
    for (const document of Object.values(LARA_STOREFRONT_RESIDUAL_QUERY_MANIFEST)) {
      const words = document.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      expect(words).toContain("query");
      expect(words).not.toContain("mutation");
      expect(words).not.toContain("subscription");
    }
    await expect(laraStorefrontResidualManifestSha256()).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("maps every filename page, hashed marker evidence, Kaching structure and ordered menus", async () => {
    const sourceRuntime = runtime();
    const artifact = await collectLaraStorefrontResidualMap({
      runtime: sourceRuntime,
      readShortLivedBody: vi.fn(async ({ url }) => {
        expect(url).toBe("https://cdn.shopify.com/s/files/header-source");
        return SALE_SOURCE;
      }),
      now: () => new Date("2026-08-12T21:00:00Z"),
    });

    expect(artifact.auditStatus).toBe("complete");
    expect(artifact.theme).toMatchObject({
      id: THEME.id,
      name: "symmetry",
      role: "MAIN",
      fileCount: 5,
    });
    expect(artifact.theme.files.map((file) => file.filename)).toEqual([
      "config/settings_data.json",
      "sections/footer-group.json",
      "assets/hrvatska-posta.svg",
      "sections/header-group.json",
      "layout/theme.liquid",
    ]);
    expect(artifact.sourceScan).toMatchObject({
      candidateCount: 4,
      scannedCount: 4,
      matchedFileCount: 3,
      skipped: [],
    });
    expect(artifact.kachingEmbed).toMatchObject({
      jsonValid: true,
      structuralEvidenceComplete: true,
      exactOneEmbed: true,
      embedCount: 1,
      activeEmbedCount: 1,
      embeds: [
        {
          blockPointerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          type: "shopify://apps/kaching-cart/blocks/embed/12345678",
          disabled: false,
        },
      ],
    });
    expect(artifact.findings).toEqual({
      kaching: {
        matchedFiles: ["config/settings_data.json"],
        embedCount: 1,
        activeEmbedCount: 1,
      },
      croatianPost: {
        matchedFiles: ["sections/footer-group.json"],
        markerOccurrences: 4,
        logoAssetPresent: true,
      },
      saleNarrative: {
        matchedFiles: ["sections/header-group.json"],
        markerOccurrences: 2,
      },
      summerSaleMenuItemCount: 1,
      contactLinks: { main: 1, footer: 1 },
      aboutLinks: { main: 0, footer: 1 },
    });
    expect(artifact.appInstallations).toEqual({
      status: "complete",
      scannedCount: 3,
      pagesRead: 1,
      matches: [
        {
          product: "shopify_flow",
          title: "Shopify Flow",
          handle: "shopify-flow",
          shopifyDeveloped: true,
        },
        {
          product: "shopify_forms",
          title: "Shopify Forms",
          handle: "forms",
          shopifyDeveloped: true,
        },
      ],
    });
    expect(artifact.menus.map((menu) => [menu.label, menu.itemCount])).toEqual([
      ["main", 5],
      ["footer", 2],
    ]);
    expect(artifact.menus[0].items[0].items[0].items[0].positionPath).toEqual([
      1, 1, 1,
    ]);
    expect(artifact.linkCoverage.summerSaleMain).toEqual([
      {
        id: "gid://shopify/MenuItem/2",
        positionPath: [2],
        url: "/collections/sales",
      },
    ]);
    expect(artifact.sourceScan.evidence[0]).not.toHaveProperty("content");
    expect(JSON.stringify(artifact)).not.toContain("must-not-persist");
    expect(JSON.stringify(artifact)).not.toContain("clearCartOnTimerEnd");
    expect(sourceRuntime.queryMock).toHaveBeenCalledTimes(6);

    expect(summariseLaraStorefrontResidualArtifact(artifact)).toEqual({
      auditStatus: "complete",
      completionIssues: [],
      themeFileCount: 5,
      scannedSourceCount: 4,
      matchedSourceCount: 3,
      kachingEmbedCount: 1,
      activeKachingEmbedCount: 1,
      croatianPostMatchedFileCount: 1,
      saleNarrativeMatchedFileCount: 1,
      summerSaleMenuItemCount: 1,
      contactLinks: { main: 1, footer: 1 },
      aboutLinks: { main: 0, footer: 1 },
      appInstallations: {
        status: "complete",
        scannedCount: 3,
        pagesRead: 1,
        matches: [
          {
            product: "shopify_flow",
            title: "Shopify Flow",
            handle: "shopify-flow",
            shopifyDeveloped: true,
          },
          {
            product: "shopify_forms",
            title: "Shopify Forms",
            handle: "forms",
            shopifyDeveloped: true,
          },
        ],
      },
    });
  });

  it("persists a partial artifact instead of following an unavailable body URL", async () => {
    const artifact = await collectLaraStorefrontResidualMap({
      runtime: runtime(),
      now: () => new Date("2026-08-12T21:00:00Z"),
    });

    expect(artifact.auditStatus).toBe("partial");
    expect(artifact.completionIssues).toContain("theme:source_scan_incomplete");
    expect(artifact.sourceScan.skipped).toContainEqual({
      filename: "sections/header-group.json",
      reason: "short_lived_body_unavailable",
    });
    expect(artifact.findings.saleNarrative.markerOccurrences).toBe(0);
  });

  it("explicitly skips the app-presence module when read_apps is not granted", async () => {
    const sourceRuntime = runtime();
    sourceRuntime.grantedScopes = ["read_themes", "read_online_store_navigation"];
    const artifact = await collectLaraStorefrontResidualMap({
      runtime: sourceRuntime,
      readShortLivedBody: vi.fn(async () => SALE_SOURCE),
      now: () => new Date("2026-08-12T21:00:00Z"),
    });

    expect(artifact.auditStatus).toBe("complete");
    expect(artifact.appInstallations).toEqual({
      status: "skipped_missing_scope",
      scannedCount: 0,
      pagesRead: 0,
      matches: [],
    });
    expect(artifact.completeness.appInstallations).toBe(false);
    expect(sourceRuntime.queryMock).not.toHaveBeenCalledWith(
      LARA_STOREFRONT_APP_INSTALLATIONS_QUERY,
      expect.anything(),
    );
  });

  it("rejects a runtime without both read scopes before querying Shopify", async () => {
    const sourceRuntime = runtime();
    sourceRuntime.grantedScopes = ["read_themes"];
    await expect(
      collectLaraStorefrontResidualMap({ runtime: sourceRuntime }),
    ).rejects.toMatchObject({
      code: "invalid_runtime",
    });
    expect(sourceRuntime.queryMock).not.toHaveBeenCalled();
  });

  it("fails closed when the published MAIN theme does not match the fixed theme pin", async () => {
    const sourceRuntime = runtime({ wrongTheme: true });
    await expect(
      collectLaraStorefrontResidualMap({ runtime: sourceRuntime }),
    ).rejects.toMatchObject({
      code: "main_theme_mismatch",
    });
    expect(sourceRuntime.queryMock).toHaveBeenCalledOnce();
  });

  it("does not accept a completed artifact with changed shop or theme evidence", async () => {
    expect(
      summariseLaraStorefrontResidualArtifact({
        schemaVersion: "lara-storefront-residual-map.v1",
        auditStatus: "complete",
        completionIssues: [],
        apiVersion: "2026-07",
        shop: {
          connectionId: "attacker-selected",
          shopDomain: "jwmtjg-fm.myshopify.com",
          shopId: "gid://shopify/Shop/95462097276",
        },
      }),
    ).toBeNull();
  });
});
