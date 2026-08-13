import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  decryptToken: vi.fn(),
  createServiceClient: vi.fn(),
  exchange: vi.fn(),
  normalize: vi.fn((value: string) => value),
  verify: vi.fn(),
}));

vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: mocks.decryptToken }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("./shopify", async (importOriginal) => {
  const original = await importOriginal<typeof import("./shopify")>();
  return {
    ...original,
    exchangeAuditClientCredentials: mocks.exchange,
    normalizeAuditShopDomain: mocks.normalize,
    verifyAuditShop: mocks.verify,
  };
});

import {
  LARA_THEME_URGENCY_FILES,
  LARA_THEME_URGENCY_REST_THEME_ID,
  LARA_THEME_URGENCY_SOURCE_QUERY,
  LARA_THEME_URGENCY_THEME,
  type LaraThemeUrgencyFilename,
  type LaraThemeUrgencyReadRuntime,
} from "./lara-theme-urgency-plan";
import { LARA_THEME_FILES_UPSERT_MUTATION, LARA_THEME_JOB_QUERY } from "./lara-theme-urgency-executor";
import { prepareLaraThemeUrgencyLiveMaterial } from "./lara-theme-urgency-live-contract";
import {
  createLaraThemeUrgencyLiveRuntime,
  LARA_THEME_URGENCY_GRAPHQL_MANIFEST,
  LARA_THEME_URGENCY_REST_ASSET_MANIFEST,
} from "./lara-theme-urgency-live-runtime";
import { LARA_ROVINJ_REMEDIATION_SHOP } from "./shopify-remediation-plan";

const AT = "2026-08-12T21:45:00.000Z";
const JOB_ID = "gid://shopify/Job/ae8d210d-90e0-4912-96d0-96d45c5e8fbb";
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

function sourceMap() {
  const sources = new Map<LaraThemeUrgencyFilename, string>();
  for (const filename of LARA_THEME_URGENCY_FILES) {
    sources.set(
      filename,
      filename.endsWith(".json")
        ? "{}"
        : `{% comment %}${filename}{% endcomment %}`,
    );
  }
  sources.set(
    "blocks/ai_gen_block_a974a97.liquid",
    "Lara Rovinj zatvara svoja vrata — Veliko rasprodavanje cijele trgovine",
  );
  sources.set(
    "sections/main-product.liquid",
    "Posljednji komadi. Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane.",
  );
  sources.set("templates/product.json", '{"claim":"Hrvatski brend od 2015."}');
  sources.set(
    "config/settings_data.json",
    '{"current":{"blocks":{"timer":{"type":"shopify://apps/kaching-cart/blocks/embed/abc123","disabled":false}}}}',
  );
  return sources;
}

function themeData(filename: LaraThemeUrgencyFilename, content: string) {
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
              .update(content, "utf8")
              .digest("hex"),
            contentType: filename.endsWith(".json")
              ? "application/json"
              : "text/x-liquid",
            size: new TextEncoder().encode(content).byteLength,
            updatedAt: AT,
            body: { __typename: "OnlineStoreThemeFileBodyText", content },
          },
        ],
        userErrors: [],
      },
    },
  };
}

function localRuntime(sources: Map<LaraThemeUrgencyFilename, string>) {
  return {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: LARA_ROVINJ_REMEDIATION_SHOP.domain,
    shopId: LARA_ROVINJ_REMEDIATION_SHOP.shopId,
    grantedScopes: ["read_themes", "write_themes"],
    query: vi.fn(async (_document: string, variables?: Record<string, unknown>) => {
      const filename = (variables?.filenames as LaraThemeUrgencyFilename[])[0]!;
      return themeData(filename, sources.get(filename)!);
    }),
  } as LaraThemeUrgencyReadRuntime;
}

function connection(scopes = ["read_themes", "write_themes"]) {
  return {
    id: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    status: "connected",
    shopify_shop_id: "gid://shopify/Shop/95462097276",
    shopify_domain: "jwmtjg-fm.myshopify.com",
    shopify_client_id: "client-id-long-enough",
    granted_scopes: scopes,
    audit_shopify_credentials: { client_secret_ciphertext: "encrypted" },
  };
}

function serviceReturning(row: ReturnType<typeof connection>) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  mocks.createServiceClient.mockReturnValue({ from });
}

function shopifyResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "x-shopify-api-version": "2026-07" },
  });
}

function restAssetResponse(
  filename: LaraThemeUrgencyFilename,
  content: string,
  overrides: Record<string, unknown> = {},
  responseHeaders: Record<string, string> = {},
) {
  return new Response(
    JSON.stringify({
      asset: {
        key: filename,
        value: content,
        updated_at: AT,
        content_type: filename.endsWith(".json")
          ? "application/json"
          : "application/x-liquid",
        size: Buffer.byteLength(content, "utf8"),
        checksum: createHash("md5").update(content, "utf8").digest("hex"),
        theme_id: LARA_THEME_URGENCY_REST_THEME_ID,
        ...overrides,
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-shopify-api-version": "2026-07",
        ...responseHeaders,
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  serviceReturning(connection());
  mocks.decryptToken.mockResolvedValue("decrypted-secret-long-enough");
  mocks.exchange.mockResolvedValue("temporary-access-token-long-enough");
  mocks.verify.mockResolvedValue({
    shopId: "gid://shopify/Shop/95462097276",
    myshopifyDomain: "jwmtjg-fm.myshopify.com",
    scopes: { granted: ["read_themes", "write_themes"] },
  });
});

describe("the dedicated Lara live theme runtime", () => {
  it("exposes only the fixed source, approved write and async-job boundaries", async () => {
    const runtime = await createLaraThemeUrgencyLiveRuntime();
    expect(Object.keys(runtime).sort()).toEqual([
      "apiVersion",
      "connectionId",
      "grantedScopes",
      "query",
      "readAsyncJob",
      "readExactThemeAsset",
      "shopDomain",
      "shopId",
      "submitApprovedPlan",
      "themeFileWriteRequirement",
      "themeId",
    ]);
    expect(LARA_THEME_URGENCY_GRAPHQL_MANIFEST).toEqual({
      source: LARA_THEME_URGENCY_SOURCE_QUERY,
      upsert: LARA_THEME_FILES_UPSERT_MUTATION,
      job: LARA_THEME_JOB_QUERY,
    });
    expect(LARA_THEME_URGENCY_REST_ASSET_MANIFEST).toMatchObject({
      method: "GET",
      apiVersion: "2026-07",
      themeId: LARA_THEME_URGENCY_REST_THEME_ID,
      redirects: "manual",
      writesAllowed: false,
      filenames: LARA_THEME_URGENCY_FILES,
    });
  });

  it("rejects arbitrary query documents and filenames before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraThemeUrgencyLiveRuntime();

    await expect(runtime.query("query Arbitrary { shop { id } }")).rejects.toMatchObject({
      code: "invalid_source_query",
    });
    await expect(
      runtime.query(LARA_THEME_URGENCY_SOURCE_QUERY, {
        themeId: LARA_THEME_URGENCY_THEME.id,
        filenames: ["layout/theme.liquid"],
      }),
    ).rejects.toMatchObject({ code: "invalid_source_query" });
    await expect(
      (
        runtime.readExactThemeAsset as (filename: string) => Promise<unknown>
      )("layout/theme.liquid"),
    ).rejects.toMatchObject({ code: "invalid_source_query" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads one allowlisted raw REST asset with the same token and strict fixed request", async () => {
    const filename = "templates/index.json" as const;
    const content = '{\n    "sections": {"main": {"settings": {}}}\n}\n';
    const fetchMock = vi.fn(
      async (request: string | URL | Request, init?: RequestInit) => {
        void request;
        void init;
        return restAssetResponse(filename, content);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraThemeUrgencyLiveRuntime();

    await expect(runtime.readExactThemeAsset(filename)).resolves.toMatchObject({
      filename,
      themeId: LARA_THEME_URGENCY_REST_THEME_ID,
      content,
      size: Buffer.byteLength(content, "utf8"),
      checksumMd5: createHash("md5").update(content, "utf8").digest("hex"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://jwmtjg-fm.myshopify.com/admin/api/2026-07/themes/${LARA_THEME_URGENCY_REST_THEME_ID}/assets.json`,
    );
    expect([...url.searchParams.entries()]).toEqual([
      ["asset[key]", filename],
      [
        "fields",
        "key,value,updated_at,content_type,size,checksum,theme_id",
      ],
    ]);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-shopify-access-token": "temporary-access-token-long-enough",
      },
    });
    expect(init?.body).toBeUndefined();
  });

  it("proves REST-normalized line endings against Shopify's exact stored size and MD5", async () => {
    const filename = "templates/index.json" as const;
    const parsed = { sections: { main: { settings: { enabled: true } } } };
    const storedContent = `${JSON.stringify(parsed, null, 4)}\n`.replaceAll(
      "\n",
      "\r\n",
    );
    const projectedContent = `${JSON.stringify(parsed, null, 4)}\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        restAssetResponse(filename, projectedContent, {
          size: Buffer.byteLength(storedContent, "utf8"),
          checksum: createHash("md5").update(storedContent, "utf8").digest("hex"),
        }),
      ),
    );
    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.readExactThemeAsset(filename)).resolves.toMatchObject({
      content: storedContent,
      size: Buffer.byteLength(storedContent, "utf8"),
      checksumMd5: createHash("md5").update(storedContent, "utf8").digest("hex"),
    });
  });

  it("reconstructs only a bounded standard JSON indentation selected by exact size and MD5", async () => {
    const filename = "templates/index.json" as const;
    const parsed = {
      sections: { main: { settings: { title: "Lara Rovinj", enabled: true } } },
    };
    const projectedContent = `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(
      parsed,
      null,
      2,
    )}`;
    const storedContent = `${JSON.stringify(parsed, null, 4)}\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        restAssetResponse(filename, projectedContent, {
          size: Buffer.byteLength(storedContent, "utf8"),
          checksum: createHash("md5").update(storedContent, "utf8").digest("hex"),
        }),
      ),
    );

    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.readExactThemeAsset(filename)).resolves.toMatchObject({
      projectedContent,
      content: storedContent,
      size: Buffer.byteLength(storedContent, "utf8"),
      checksumMd5: createHash("md5").update(storedContent, "utf8").digest("hex"),
    });
  });

  it("reconstructs Shopify's documented settings_data minification without rewriting JSON tokens", async () => {
    const filename = "config/settings_data.json" as const;
    const projectedJson = `{
  "current": {
    "escaped_url": "https:\\/\\/example.com\\/café",
    "escaped_unicode": "\\u006c\\u0061\\u0072\\u0061"
  }
}`;
    const projectedContent = `${SHOPIFY_GENERATED_JSON_BANNER}${projectedJson}`;
    const storedContent =
      '{"current":{"escaped_url":"https:\\/\\/example.com\\/café","escaped_unicode":"\\u006c\\u0061\\u0072\\u0061"}}';
    expect(JSON.stringify(JSON.parse(projectedJson))).not.toBe(storedContent);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        restAssetResponse(filename, projectedContent, {
          size: Buffer.byteLength(storedContent, "utf8"),
          checksum: createHash("md5").update(storedContent, "utf8").digest("hex"),
        }),
      ),
    );

    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.readExactThemeAsset(filename)).resolves.toMatchObject({
      projectedContent,
      content: storedContent,
    });
  });

  it("rejects valid JSON whose stored indentation is outside the fixed REST candidate set", async () => {
    const filename = "templates/index.json" as const;
    const parsed = { sections: { main: { settings: { enabled: true } } } };
    const projectedContent = `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(
      parsed,
      null,
      2,
    )}`;
    const storedContent = JSON.stringify(parsed, null, 10).replace(
      /^( +)/gm,
      (indent) => `${indent}  `,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        restAssetResponse(filename, projectedContent, {
          size: Buffer.byteLength(storedContent, "utf8"),
          checksum: createHash("md5").update(storedContent, "utf8").digest("hex"),
        }),
      ),
    );

    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.readExactThemeAsset(filename)).rejects.toMatchObject({
      code: "invalid_rest_asset_integrity",
    });
  });

  it("does not apply JSON reconstruction candidates to a Liquid filename", async () => {
    const filename = "sections/main-product.liquid" as const;
    const parsed = { message: "Posljednji komadi" };
    const projectedContent = JSON.stringify(parsed, null, 2);
    const storedContent = JSON.stringify(parsed, null, 4);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        restAssetResponse(filename, projectedContent, {
          content_type: "application/x-liquid",
          size: Buffer.byteLength(storedContent, "utf8"),
          checksum: createHash("md5").update(storedContent, "utf8").digest("hex"),
        }),
      ),
    );

    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.readExactThemeAsset(filename)).rejects.toMatchObject({
      code: "invalid_rest_asset_integrity",
    });
  });

  it.each([
    ["wrong key", { key: "layout/theme.liquid" }, {}, "invalid_rest_asset_fields"],
    ["wrong theme", { theme_id: 999 }, {}, "invalid_rest_asset_fields"],
    ["wrong size", { size: 999 }, {}, "invalid_rest_asset_integrity"],
    ["wrong checksum", { checksum: "0".repeat(32) }, {}, "invalid_rest_asset_integrity"],
    ["wrong content type", { content_type: "text/plain" }, {}, "invalid_rest_asset_fields"],
    ["invalid timestamp", { updated_at: "not-a-time" }, {}, "invalid_rest_asset_fields"],
    ["an extra field", { attachment: "e30=" }, {}, "invalid_rest_asset_fields"],
    [
      "an oversized declared envelope",
      {},
      { "content-length": "12500001" },
      "invalid_rest_asset_response",
    ],
    [
      "a non-JSON response type",
      {},
      { "content-type": "text/html" },
      "invalid_rest_asset_response",
    ],
    [
      "wrong API version",
      {},
      { "x-shopify-api-version": "2026-04" },
      "invalid_rest_asset_response",
    ],
  ] as const)(
    "rejects a REST asset with %s",
    async (_label, overrides, headers, code) => {
      const filename = "templates/index.json" as const;
      const content = "{}";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          restAssetResponse(filename, content, { ...overrides }, { ...headers }),
        ),
      );
      const runtime = await createLaraThemeUrgencyLiveRuntime();
      await expect(runtime.readExactThemeAsset(filename)).rejects.toMatchObject({
        code,
      });
    },
  );

  it("falls back to REST only for a GraphQL JSON projection that cannot prove raw bytes", async () => {
    const sources = sourceMap();
    const filename = "templates/product.json" as const;
    const parsed = { claim: "Hrvatski brend od 2015.", nested: { enabled: true } };
    const storedContent = `${JSON.stringify(parsed, null, 4)}\n`;
    const projectedContent = `${SHOPIFY_GENERATED_JSON_BANNER}${JSON.stringify(
      parsed,
      null,
      2,
    )}`;
    sources.set(filename, storedContent);
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "GET") {
          return restAssetResponse(filename, storedContent);
        }
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query !== LARA_THEME_URGENCY_SOURCE_QUERY) {
          throw new Error("unexpected document");
        }
        const requested = (body.variables.filenames as LaraThemeUrgencyFilename[])[0]!;
        if (requested !== filename) {
          return shopifyResponse({
            data: themeData(requested, sources.get(requested)!),
          });
        }
        return shopifyResponse({
          data: {
            theme: {
              id: LARA_THEME_URGENCY_THEME.id,
              name: "symmetry",
              role: "MAIN",
              files: {
                nodes: [
                  {
                    filename,
                    checksumMd5: createHash("md5")
                      .update(storedContent, "utf8")
                      .digest("hex"),
                    contentType: "application/json",
                    size: Buffer.byteLength(storedContent, "utf8"),
                    updatedAt: AT,
                    body: {
                      __typename: "OnlineStoreThemeFileBodyText",
                      content: projectedContent,
                    },
                  },
                ],
                userErrors: [],
              },
            },
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraThemeUrgencyLiveRuntime();
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime,
      capturedAt: AT,
    });
    const operation = material.payload.plan.payload.operations.find(
      (candidate) => candidate.target.filename === filename,
    )!;

    expect(operation.inverse.content).toBe(storedContent);
    expect(operation.after.content).not.toContain("Hrvatski brend od 2015.");
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "GET"),
    ).toHaveLength(1);
  });

  it("submits only plan-owned exact bodies, excludes Kaching, and resumes the returned job", async () => {
    const sources = sourceMap();
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: localRuntime(sources),
      capturedAt: AT,
    });
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      requests.push(body);
      if (body.query === LARA_THEME_URGENCY_SOURCE_QUERY) {
        const filename = (body.variables.filenames as LaraThemeUrgencyFilename[])[0]!;
        return shopifyResponse({ data: themeData(filename, sources.get(filename)!) });
      }
      if (body.query === LARA_THEME_FILES_UPSERT_MUTATION) {
        return shopifyResponse({
          data: {
            themeFilesUpsert: {
              upsertedThemeFiles: material.payload.plan.payload.operations.map(
                (operation) => ({ filename: operation.target.filename }),
              ),
              job: { id: JOB_ID },
              userErrors: [],
            },
          },
        });
      }
      if (body.query === LARA_THEME_JOB_QUERY) {
        return shopifyResponse({ data: { job: { id: JOB_ID, done: false } } });
      }
      throw new Error("unexpected document");
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createLaraThemeUrgencyLiveRuntime();

    await expect(runtime.submitApprovedPlan(material)).resolves.toMatchObject({
      status: "pending",
      jobId: JOB_ID,
      exemptionConfirmedByShopify: true,
    });
    await expect(runtime.readAsyncJob(JOB_ID)).resolves.toEqual({
      id: JOB_ID,
      done: false,
    });

    const mutation = requests.find(
      (request) => request.query === LARA_THEME_FILES_UPSERT_MUTATION,
    )!;
    expect(mutation.variables.themeId).toBe(LARA_THEME_URGENCY_THEME.id);
    const files = mutation.variables.files as Array<Record<string, unknown>>;
    expect(files.map((file) => file.filename)).toEqual(
      material.payload.plan.payload.operations.map(
        (operation) => operation.target.filename,
      ),
    );
    expect(files.some((file) => file.filename === "config/settings_data.json")).toBe(
      false,
    );
    expect(
      files.every(
        (file) =>
          Object.keys(file).sort().join(",") === "body,filename" &&
          Object.keys(file.body as Record<string, unknown>).sort().join(",") ===
            "type,value",
      ),
    ).toBe(true);
  });

  it("persists a valid async job even when Shopify defers the file result list", async () => {
    const sources = sourceMap();
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: localRuntime(sources),
      capturedAt: AT,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query === LARA_THEME_URGENCY_SOURCE_QUERY) {
          const filename = (body.variables.filenames as LaraThemeUrgencyFilename[])[0]!;
          return shopifyResponse({ data: themeData(filename, sources.get(filename)!) });
        }
        return shopifyResponse({
          data: {
            themeFilesUpsert: {
              upsertedThemeFiles: null,
              job: { id: JOB_ID },
              userErrors: [],
            },
          },
        });
      }),
    );
    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.submitApprovedPlan(material)).resolves.toEqual({
      status: "pending",
      filenames: [],
      jobId: JOB_ID,
      exemptionConfirmedByShopify: true,
    });
  });

  it("fails closed with a distinct exemption code when Shopify denies theme writes", async () => {
    const sources = sourceMap();
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: localRuntime(sources),
      capturedAt: AT,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query === LARA_THEME_URGENCY_SOURCE_QUERY) {
          const filename = (body.variables.filenames as LaraThemeUrgencyFilename[])[0]!;
          return shopifyResponse({ data: themeData(filename, sources.get(filename)!) });
        }
        return shopifyResponse({
          errors: [{ message: "protected scope", extensions: { code: "ACCESS_DENIED" } }],
        });
      }),
    );
    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.submitApprovedPlan(material)).rejects.toMatchObject({
      code: "theme_write_exemption_unavailable",
      retryable: false,
    });
  });

  it("also classifies a definitive ACCESS_DENIED userError as a missing exemption", async () => {
    const sources = sourceMap();
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: localRuntime(sources),
      capturedAt: AT,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query === LARA_THEME_URGENCY_SOURCE_QUERY) {
          const filename = (body.variables.filenames as LaraThemeUrgencyFilename[])[0]!;
          return shopifyResponse({ data: themeData(filename, sources.get(filename)!) });
        }
        return shopifyResponse({
          data: {
            themeFilesUpsert: {
              upsertedThemeFiles: null,
              job: null,
              userErrors: [
                {
                  code: "ACCESS_DENIED",
                  field: ["files"],
                  filename: null,
                  message: "protected scope",
                },
              ],
            },
          },
        });
      }),
    );
    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.submitApprovedPlan(material)).rejects.toMatchObject({
      code: "theme_write_exemption_unavailable",
      retryable: false,
    });
  });

  it("treats malformed top-level error fields as unsafe instead of success", async () => {
    const sources = sourceMap();
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: localRuntime(sources),
      capturedAt: AT,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query === LARA_THEME_URGENCY_SOURCE_QUERY) {
          const filename = (body.variables.filenames as LaraThemeUrgencyFilename[])[0]!;
          return shopifyResponse({ data: themeData(filename, sources.get(filename)!) });
        }
        return shopifyResponse({ errors: { code: "ACCESS_DENIED" } });
      }),
    );
    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.submitApprovedPlan(material)).rejects.toMatchObject({
      code: "mutation_ambiguous",
    });
  });

  it("treats malformed nested user errors as ambiguous, not a definitive rejection", async () => {
    const sources = sourceMap();
    const material = await prepareLaraThemeUrgencyLiveMaterial({
      runtime: localRuntime(sources),
      capturedAt: AT,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query === LARA_THEME_URGENCY_SOURCE_QUERY) {
          const filename = (body.variables.filenames as LaraThemeUrgencyFilename[])[0]!;
          return shopifyResponse({ data: themeData(filename, sources.get(filename)!) });
        }
        return shopifyResponse({
          data: {
            themeFilesUpsert: {
              upsertedThemeFiles: null,
              job: null,
              userErrors: [null],
            },
          },
        });
      }),
    );
    const runtime = await createLaraThemeUrgencyLiveRuntime();
    await expect(runtime.submitApprovedPlan(material)).rejects.toMatchObject({
      code: "mutation_ambiguous",
    });
  });

  it.each([
    [["write_themes"], "missing_read_themes"],
    [["read_themes"], "missing_write_themes"],
  ] as const)("requires both verified theme scopes", async (scopes, code) => {
    serviceReturning(connection([...scopes]));
    mocks.verify.mockResolvedValue({
      shopId: "gid://shopify/Shop/95462097276",
      myshopifyDomain: "jwmtjg-fm.myshopify.com",
      scopes: { granted: [...scopes] },
    });
    await expect(createLaraThemeUrgencyLiveRuntime()).rejects.toMatchObject({ code });
    expect(mocks.decryptToken).not.toHaveBeenCalled();
  });
});
