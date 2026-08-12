import "server-only";

import { createHash } from "node:crypto";

import { AUDIT_SHOPIFY_API_VERSION } from "./shopify";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import type { AuditShopifyRuntime } from "./shopify-runtime";

export const LARA_STOREFRONT_RESIDUAL_SCHEMA_VERSION =
  "lara-storefront-residual-map.v2" as const;

export const LARA_STOREFRONT_RESIDUAL_TARGETS = Object.freeze({
  theme: Object.freeze({
    id: "gid://shopify/OnlineStoreTheme/186665468284",
    name: "symmetry",
    role: "MAIN",
  }),
  menus: Object.freeze({
    main: Object.freeze({
      id: "gid://shopify/Menu/347574075772",
      label: "main" as const,
    }),
    footer: Object.freeze({
      id: "gid://shopify/Menu/347574108540",
      label: "footer" as const,
    }),
  }),
  pages: Object.freeze({
    contact: Object.freeze({
      id: "gid://shopify/Page/697904923004",
      path: "/pages/kontakt",
    }),
    about: Object.freeze({
      id: "gid://shopify/Page/697974849916",
      path: "/pages/o-nama",
    }),
  }),
} as const);

export const LARA_STOREFRONT_MAIN_THEME_QUERY = `#graphql
  query LaraStorefrontResidualMainTheme {
    themes(first: 2, roles: [MAIN]) {
      nodes {
        id
        name
        prefix
        role
        themeStoreId
        processing
        processingFailed
        updatedAt
      }
    }
  }
`;

export const LARA_STOREFRONT_THEME_FILES_QUERY = `#graphql
  query LaraStorefrontResidualThemeFiles($themeId: ID!, $after: String) {
    theme(id: $themeId) {
      id
      name
      role
      files(first: 250, after: $after) {
        nodes { filename checksumMd5 contentType size updatedAt }
        pageInfo { hasNextPage endCursor }
        userErrors { code filename }
      }
    }
  }
`;

export const LARA_STOREFRONT_THEME_BODIES_QUERY = `#graphql
  query LaraStorefrontResidualThemeBodies($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      id
      name
      role
      files(first: 25, filenames: $filenames) {
        nodes {
          filename
          checksumMd5
          contentType
          size
          updatedAt
          body {
            __typename
            ... on OnlineStoreThemeFileBodyText { content }
            ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
            ... on OnlineStoreThemeFileBodyUrl { url }
          }
        }
        userErrors { code filename }
      }
    }
  }
`;

export const LARA_STOREFRONT_MENUS_QUERY = `#graphql
  query LaraStorefrontResidualMenus($mainId: ID!, $footerId: ID!) {
    main: menu(id: $mainId) {
      id handle title isDefault
      items(limit: 10000) {
        id title type url resourceId tags
        items {
          id title type url resourceId tags
          items { id title type url resourceId tags }
        }
      }
    }
    footer: menu(id: $footerId) {
      id handle title isDefault
      items(limit: 10000) {
        id title type url resourceId tags
        items {
          id title type url resourceId tags
          items { id title type url resourceId tags }
        }
      }
    }
  }
`;

export const LARA_STOREFRONT_APP_INSTALLATIONS_QUERY = `#graphql
  query LaraStorefrontResidualAppInstallations($after: String) {
    appInstallations(first: 100, after: $after) {
      nodes { app { title handle shopifyDeveloped } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const LARA_STOREFRONT_RESIDUAL_QUERY_MANIFEST = Object.freeze({
  mainTheme: LARA_STOREFRONT_MAIN_THEME_QUERY,
  themeFiles: LARA_STOREFRONT_THEME_FILES_QUERY,
  themeBodies: LARA_STOREFRONT_THEME_BODIES_QUERY,
  menus: LARA_STOREFRONT_MENUS_QUERY,
  appInstallations: LARA_STOREFRONT_APP_INSTALLATIONS_QUERY,
});

const SOURCE_MARKERS = Object.freeze([
  Object.freeze({
    id: "kaching.app_embed_reference",
    category: "kaching" as const,
    text: "shopify://apps/kaching",
  }),
  Object.freeze({
    id: "kaching.cart_reference",
    category: "kaching" as const,
    text: "kaching-cart",
  }),
  Object.freeze({
    id: "kaching.public_timer_copy",
    category: "kaching" as const,
    text: "Košarica istječe za",
  }),
  Object.freeze({
    id: "shipping.croatian_post_copy",
    category: "croatian_post" as const,
    text: "Brza i sigurna dostava Hrvatskom poštom, ravno do vaših vrata.",
  }),
  Object.freeze({
    id: "shipping.croatian_post_inflection",
    category: "croatian_post" as const,
    text: "Hrvatskom poštom",
  }),
  Object.freeze({
    id: "shipping.product_free_croatian_post_copy",
    category: "croatian_post" as const,
    text: "Besplatna dostava Hrvatskom poštom",
  }),
  Object.freeze({
    id: "shipping.croatian_post_logo",
    category: "croatian_post" as const,
    text: "hrvatska-posta.svg",
  }),
  Object.freeze({
    id: "shipping.croatian_post_badge_class",
    category: "croatian_post" as const,
    text: "usp-icon-hp",
  }),
  Object.freeze({
    id: "sale.discount_heading",
    category: "sale_narrative" as const,
    text: "Sniženja",
  }),
  Object.freeze({
    id: "sale.fifty_percent_copy",
    category: "sale_narrative" as const,
    text: "Do 50% popusta",
  }),
] as const);

const SUMMER_SALE_MENU_TITLE = "LJETNA AKCIJA ’26";
const TEXT_SOURCE_SUFFIXES = Object.freeze([
  ".liquid",
  ".json",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".txt",
]);
const TEXT_SOURCE_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/typescript",
  "application/x-javascript",
  "application/x-liquid",
  "text/css",
  "text/html",
  "text/javascript",
  "text/less",
  "text/plain",
  "text/typescript",
  "text/x-liquid",
  "text/x-sass",
  "text/x-scss",
]);
const MAX_THEME_FILE_PAGES = 12;
const MAX_THEME_FILES = 2_500;
const MAX_TEXT_SOURCE_FILES = 1_000;
const MAX_SOURCE_FILE_BYTES = 2_000_000;
const MAX_TOTAL_SOURCE_BYTES = 24_000_000;
const SOURCE_BATCH_SIZE = 25;
const MAX_EVIDENCE_PER_MARKER = 20;
const MAX_JSON_POINTERS_PER_MARKER = 50;
const MAX_APP_INSTALLATION_PAGES = 10;
const MAX_MENU_ITEMS = 10_000;
const MENU_ITEM_GID = /^gid:\/\/shopify\/MenuItem\/[1-9][0-9]*$/;
const MD5 = /^[a-f0-9]{32}$/;

type SourceCategory = (typeof SOURCE_MARKERS)[number]["category"];
type QueryRuntime = Pick<
  AuditShopifyRuntime,
  "connectionId" | "shopDomain" | "shopId" | "grantedScopes" | "query"
>;

type ThemeFileMetadata = {
  filename: string;
  checksumMd5: string | null;
  contentType: string;
  size: number | string;
  updatedAt: string;
};

type MainThemeData = {
  themes: {
    nodes: Array<{
      id: string;
      name: string;
      prefix: string;
      role: string;
      themeStoreId: number | null;
      processing: boolean;
      processingFailed: boolean;
      updatedAt: string;
    }>;
  };
};

type ThemeFilesData = {
  theme: {
    id: string;
    name: string;
    role: string;
    files: {
      nodes: ThemeFileMetadata[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      userErrors: Array<{ code: string; filename: string | null }>;
    };
  } | null;
};

type ThemeBody =
  | { __typename: "OnlineStoreThemeFileBodyText"; content: string }
  | { __typename: "OnlineStoreThemeFileBodyBase64"; contentBase64: string }
  | { __typename: "OnlineStoreThemeFileBodyUrl"; url: string };

type ThemeBodyNode = ThemeFileMetadata & { body: ThemeBody };

type ThemeBodiesData = {
  theme: {
    id: string;
    name: string;
    role: string;
    files: {
      nodes: ThemeBodyNode[];
      userErrors: Array<{ code: string; filename: string | null }>;
    };
  } | null;
};

type MenuItemNode = {
  id: string;
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  tags: string[];
  items: MenuItemNode[];
};

type MenuNode = {
  id: string;
  handle: string;
  title: string;
  isDefault: boolean;
  items: MenuItemNode[];
};

type MenusData = { main: MenuNode | null; footer: MenuNode | null };

type AppInstallationsData = {
  appInstallations: {
    nodes: Array<{
      app: { title: string; handle: string | null; shopifyDeveloped: boolean };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type BodyReader = (input: {
  url: string;
  expectedBytes: number;
  filename: string;
}) => Promise<string>;

type BodyMode = "text" | "base64" | "short_lived_url";

export type LaraStorefrontResidualSourceEvidence = {
  filename: string;
  checksumMd5: string | null;
  updatedAt: string;
  size: number;
  decodedByteLength: number;
  integrityMode: "exact" | "text_crlf_normalized";
  bodyMode: BodyMode;
  sourceSha256: string;
  matches: Array<{
    markerId: string;
    category: SourceCategory;
    marker: string;
    occurrences: number;
    evidenceTruncated: boolean;
    locations: Array<{
      offset: number;
      line: number;
      column: number;
      contextSha256: string;
    }>;
    jsonPointerSha256s: string[];
    jsonPointerEvidenceTruncated: boolean;
  }>;
};

export type LaraStorefrontMenuItemSnapshot = {
  id: string;
  position: number;
  positionPath: number[];
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  tags: string[];
  items: LaraStorefrontMenuItemSnapshot[];
};

export type LaraStorefrontMenuSnapshot = {
  label: "main" | "footer";
  id: string;
  handle: string;
  title: string;
  isDefault: boolean;
  itemCount: number;
  digestSha256: string;
  items: LaraStorefrontMenuItemSnapshot[];
};

export type LaraStorefrontResidualArtifact = {
  schemaVersion: typeof LARA_STOREFRONT_RESIDUAL_SCHEMA_VERSION;
  auditStatus: "complete" | "partial";
  completionIssues: string[];
  generatedAt: string;
  apiVersion: typeof AUDIT_SHOPIFY_API_VERSION;
  queryManifestSha256: string;
  shop: typeof LARA_AUDIT_CONNECTION;
  theme: {
    id: typeof LARA_STOREFRONT_RESIDUAL_TARGETS.theme.id;
    name: typeof LARA_STOREFRONT_RESIDUAL_TARGETS.theme.name;
    prefix: string;
    role: typeof LARA_STOREFRONT_RESIDUAL_TARGETS.theme.role;
    themeStoreId: number | null;
    updatedAt: string;
    processing: boolean;
    processingFailed: boolean;
    fileCount: number;
    files: Array<ThemeFileMetadata & { size: number; textSource: boolean }>;
  };
  sourceScan: {
    candidateCount: number;
    scannedCount: number;
    scannedBytes: number;
    matchedFileCount: number;
    skipped: Array<{ filename: string; reason: string }>;
    textSizeReconciliations: Array<{
      filename: string;
      reportedSize: number;
      decodedByteLength: number;
      integrityMode: "text_crlf_normalized";
    }>;
    evidence: LaraStorefrontResidualSourceEvidence[];
  };
  kachingEmbed: {
    settingsFilename: "config/settings_data.json";
    settingsSourceSha256: string | null;
    jsonValid: boolean;
    structuralEvidenceComplete: boolean;
    exactOneEmbed: boolean;
    embedCount: number;
    activeEmbedCount: number;
    embeds: Array<{
      blockPointerSha256: string;
      type: string;
      disabled: boolean | null;
      blockSha256: string;
    }>;
  };
  menus: [LaraStorefrontMenuSnapshot, LaraStorefrontMenuSnapshot];
  linkCoverage: {
    summerSaleMain: Array<{ id: string; positionPath: number[]; url: string | null }>;
    contact: {
      main: Array<{ id: string; positionPath: number[]; title: string }>;
      footer: Array<{ id: string; positionPath: number[]; title: string }>;
    };
    about: {
      main: Array<{ id: string; positionPath: number[]; title: string }>;
      footer: Array<{ id: string; positionPath: number[]; title: string }>;
    };
  };
  findings: {
    kaching: { matchedFiles: string[]; embedCount: number; activeEmbedCount: number };
    croatianPost: {
      matchedFiles: string[];
      markerOccurrences: number;
      logoAssetPresent: boolean;
    };
    saleNarrative: { matchedFiles: string[]; markerOccurrences: number };
    summerSaleMenuItemCount: number;
    contactLinks: { main: number; footer: number };
    aboutLinks: { main: number; footer: number };
  };
  appInstallations: {
    status: "complete" | "skipped_missing_scope";
    scannedCount: number;
    pagesRead: number;
    matches: Array<{
      product: "shopify_flow" | "shopify_forms";
      title: string;
      handle: string;
      shopifyDeveloped: true;
    }>;
  };
  completeness: {
    mainThemeIdentity: true;
    themeFileEnumeration: true;
    themeSourceScan: boolean;
    kachingStructure: boolean;
    mainMenuSnapshot: true;
    footerMenuSnapshot: true;
    appInstallations: boolean;
  };
};

export class LaraStorefrontResidualMapError extends Error {
  constructor(
    public readonly code:
      | "invalid_runtime"
      | "main_theme_mismatch"
      | "theme_file_error"
      | "theme_file_invalid"
      | "theme_file_page_cap"
      | "theme_file_cap"
      | "theme_cursor_invalid"
      | "theme_body_error"
      | "theme_body_invalid"
      | "menu_mismatch"
      | "menu_invalid",
    message: string,
  ) {
    super(message);
    this.name = "LaraStorefrontResidualMapError";
  }
}

function mapError(
  code: LaraStorefrontResidualMapError["code"],
  message: string,
): LaraStorefrontResidualMapError {
  return new LaraStorefrontResidualMapError(code, message);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function md5Hex(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function restoreCrlf(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

function verifyTextIntegrity(input: {
  content: string;
  reportedSize: number;
  checksumMd5: string | null;
}): {
  decodedByteLength: number;
  integrityMode: "exact" | "text_crlf_normalized";
} | null {
  const decodedByteLength = new TextEncoder().encode(input.content).byteLength;
  const exactChecksum =
    input.checksumMd5 === null || md5Hex(input.content) === input.checksumMd5;
  if (decodedByteLength === input.reportedSize && exactChecksum) {
    return { decodedByteLength, integrityMode: "exact" };
  }

  // Shopify can return a text body with CRLF line endings normalised to LF
  // while `size` and checksum still describe the stored bytes. Accept only
  // that one deterministic transformation, and only when both the documented
  // byte count and MD5 prove the reconstruction.
  if (input.checksumMd5 === null || !input.content.includes("\n")) return null;
  const restored = restoreCrlf(input.content);
  const restoredByteLength = new TextEncoder().encode(restored).byteLength;
  if (
    restoredByteLength !== input.reportedSize ||
    md5Hex(restored) !== input.checksumMd5
  ) {
    return null;
  }
  return { decodedByteLength, integrityMode: "text_crlf_normalized" };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export async function laraStorefrontResidualManifestSha256(): Promise<string> {
  const queryText = Object.entries(LARA_STOREFRONT_RESIDUAL_QUERY_MANIFEST)
    .map(([name, document]) => `${name}\n${document.trim()}`)
    .join("\n---\n");
  const pins = canonicalJson({
    apiVersion: AUDIT_SHOPIFY_API_VERSION,
    connection: LARA_AUDIT_CONNECTION,
    targets: LARA_STOREFRONT_RESIDUAL_TARGETS,
    markers: SOURCE_MARKERS,
    summerSaleMenuTitle: SUMMER_SALE_MENU_TITLE,
  });
  return sha256Hex(`${queryText}\n---\n${pins}`);
}

export async function laraStorefrontResidualSchemaSha256(): Promise<string> {
  return sha256Hex(LARA_STOREFRONT_RESIDUAL_SCHEMA_VERSION);
}

function assertRuntime(runtime: QueryRuntime): void {
  if (
    runtime.connectionId !== LARA_AUDIT_CONNECTION.connectionId ||
    runtime.shopDomain !== LARA_AUDIT_CONNECTION.shopDomain ||
    runtime.shopId !== LARA_AUDIT_CONNECTION.shopId ||
    !runtime.grantedScopes.includes("read_themes") ||
    !runtime.grantedScopes.includes("read_online_store_navigation") ||
    typeof runtime.query !== "function"
  ) {
    throw mapError(
      "invalid_runtime",
      "The mapper is not bound to the exact read-only Lara connection.",
    );
  }
}

function numericSize(value: number | string): number {
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw mapError("theme_file_invalid", "Shopify returned an invalid theme file size.");
  }
  return size;
}

function assertTimestamp(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw mapError("theme_file_invalid", "Shopify returned an invalid theme timestamp.");
  }
}

function assertThemeIdentity(
  theme: { id: string; name: string; role: string } | null,
): asserts theme is {
  id: typeof LARA_STOREFRONT_RESIDUAL_TARGETS.theme.id;
  name: typeof LARA_STOREFRONT_RESIDUAL_TARGETS.theme.name;
  role: typeof LARA_STOREFRONT_RESIDUAL_TARGETS.theme.role;
} {
  if (
    !theme ||
    theme.id !== LARA_STOREFRONT_RESIDUAL_TARGETS.theme.id ||
    theme.name !== LARA_STOREFRONT_RESIDUAL_TARGETS.theme.name ||
    theme.role !== LARA_STOREFRONT_RESIDUAL_TARGETS.theme.role
  ) {
    throw mapError(
      "main_theme_mismatch",
      "Shopify returned a different Lara main theme identity.",
    );
  }
}

function isTextSource(file: ThemeFileMetadata): boolean {
  const filename = file.filename.toLocaleLowerCase();
  const contentType = file.contentType.split(";", 1)[0].trim().toLocaleLowerCase();
  return (
    TEXT_SOURCE_SUFFIXES.some((suffix) => filename.endsWith(suffix)) ||
    TEXT_SOURCE_CONTENT_TYPES.has(contentType)
  );
}

function decodeBase64Text(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function countExact(value: string, needle: string): { count: number; offsets: number[] } {
  const offsets: number[] = [];
  let count = 0;
  let cursor = 0;
  while (cursor <= value.length - needle.length) {
    const offset = value.indexOf(needle, cursor);
    if (offset < 0) break;
    count += 1;
    if (offsets.length < MAX_EVIDENCE_PER_MARKER) offsets.push(offset);
    cursor = offset + needle.length;
  }
  return { count, offsets };
}

function lineStarts(value: string): number[] {
  const starts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineColumn(starts: number[], offset: number): { line: number; column: number } {
  let lower = 0;
  let upper = starts.length;
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (starts[middle] <= offset) lower = middle;
    else upper = middle;
  }
  return { line: lower + 1, column: offset - starts[lower] + 1 };
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function jsonStringPointers(
  value: unknown,
): Map<string, { pointers: string[]; truncated: boolean }> {
  const results = new Map<string, { pointers: string[]; truncated: boolean }>();
  for (const marker of SOURCE_MARKERS) {
    results.set(marker.id, { pointers: [], truncated: false });
  }

  const visit = (item: unknown, pointer: string): void => {
    if (typeof item === "string") {
      for (const marker of SOURCE_MARKERS) {
        if (!item.includes(marker.text)) continue;
        const result = results.get(marker.id)!;
        if (result.pointers.length < MAX_JSON_POINTERS_PER_MARKER) {
          result.pointers.push(pointer || "/");
        } else {
          result.truncated = true;
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${pointer}/${index}`));
      return;
    }
    const record = objectRecord(item);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      visit(child, `${pointer}/${escapeJsonPointer(key)}`);
    }
  };
  visit(value, "");
  return results;
}

async function sourceEvidence(
  file: ThemeFileMetadata & { size: number },
  content: string,
  bodyMode: BodyMode,
  integrity: {
    decodedByteLength: number;
    integrityMode: "exact" | "text_crlf_normalized";
  },
): Promise<LaraStorefrontResidualSourceEvidence | null> {
  const starts = lineStarts(content);
  let jsonPointers = new Map<
    string,
    { pointers: string[]; truncated: boolean }
  >();
  if (file.filename.endsWith(".json")) {
    try {
      jsonPointers = jsonStringPointers(JSON.parse(content));
    } catch {
      // A malformed JSON theme file can still be safely located by exact raw
      // marker and source hash; JSON pointer evidence is simply unavailable.
    }
  }
  const matches: LaraStorefrontResidualSourceEvidence["matches"] = [];
  for (const marker of SOURCE_MARKERS) {
    const occurrence = countExact(content, marker.text);
    if (occurrence.count === 0) continue;
    const locations = [];
    for (const offset of occurrence.offsets) {
      const position = lineColumn(starts, offset);
      const windowStart = Math.max(0, offset - 96);
      const windowEnd = Math.min(content.length, offset + marker.text.length + 96);
      locations.push({
        offset,
        ...position,
        contextSha256: await sha256Hex(content.slice(windowStart, windowEnd)),
      });
    }
    const pointerEvidence = jsonPointers.get(marker.id);
    matches.push({
      markerId: marker.id,
      category: marker.category,
      marker: marker.text,
      occurrences: occurrence.count,
      evidenceTruncated: occurrence.count > occurrence.offsets.length,
      locations,
      jsonPointerSha256s: await Promise.all(
        (pointerEvidence?.pointers ?? []).map((pointer) => sha256Hex(pointer)),
      ),
      jsonPointerEvidenceTruncated: pointerEvidence?.truncated ?? false,
    });
  }
  if (matches.length === 0) return null;
  return {
    filename: file.filename,
    checksumMd5: file.checksumMd5,
    updatedAt: file.updatedAt,
    size: file.size,
    decodedByteLength: integrity.decodedByteLength,
    integrityMode: integrity.integrityMode,
    bodyMode,
    sourceSha256: await sha256Hex(content),
    matches,
  };
}

async function inspectKachingEmbed(
  settingsSource: { content: string; sha256: string } | null,
): Promise<LaraStorefrontResidualArtifact["kachingEmbed"]> {
  const empty: LaraStorefrontResidualArtifact["kachingEmbed"] = {
    settingsFilename: "config/settings_data.json",
    settingsSourceSha256: settingsSource?.sha256 ?? null,
    jsonValid: false,
    structuralEvidenceComplete: false,
    exactOneEmbed: false,
    embedCount: 0,
    activeEmbedCount: 0,
    embeds: [],
  };
  if (!settingsSource) return empty;

  let document: unknown;
  try {
    document = JSON.parse(settingsSource.content);
  } catch {
    return empty;
  }
  const root = objectRecord(document);
  const current = objectRecord(root?.current);
  const blocks = objectRecord(current?.blocks);
  if (!root || !current || !blocks) return { ...empty, jsonValid: true };

  const embeds: LaraStorefrontResidualArtifact["kachingEmbed"]["embeds"] = [];
  for (const [blockId, value] of Object.entries(blocks)) {
    const block = objectRecord(value);
    if (
      !block ||
      typeof block.type !== "string" ||
      !block.type.startsWith("shopify://apps/") ||
      !block.type.toLocaleLowerCase().includes("kaching") ||
      !block.type.includes("/blocks/")
    ) {
      continue;
    }
    embeds.push({
      blockPointerSha256: await sha256Hex(
        `/current/blocks/${escapeJsonPointer(blockId)}`,
      ),
      type: block.type.slice(0, 1_000),
      disabled: typeof block.disabled === "boolean" ? block.disabled : null,
      blockSha256: await sha256Hex(canonicalJson(block)),
    });
  }
  const structuralEvidenceComplete = embeds.every(
    (embed) => typeof embed.disabled === "boolean",
  );
  return {
    settingsFilename: "config/settings_data.json",
    settingsSourceSha256: settingsSource.sha256,
    jsonValid: true,
    structuralEvidenceComplete,
    exactOneEmbed: structuralEvidenceComplete && embeds.length === 1,
    embedCount: embeds.length,
    activeEmbedCount: embeds.filter((embed) => embed.disabled === false).length,
    embeds,
  };
}

function sanitizeMenuUrl(value: string | null): string | null {
  if (!value || value.length > 8_192) return null;
  try {
    const url = new URL(value, "https://www.lararovinj.com");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === "https://www.lararovinj.com"
      ? url.pathname
      : `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function sanitizeMenuItems(
  items: MenuItemNode[],
  path: number[] = [],
  seen = new Set<string>(),
): LaraStorefrontMenuItemSnapshot[] {
  if (
    !Array.isArray(items) ||
    items.length > MAX_MENU_ITEMS ||
    (path.length >= 3 && items.length > 0)
  ) {
    throw mapError("menu_invalid", "Shopify returned an invalid Lara menu tree.");
  }
  return items.map((item, index) => {
    const position = index + 1;
    const positionPath = [...path, position];
    if (
      !item ||
      !MENU_ITEM_GID.test(item.id) ||
      seen.has(item.id) ||
      seen.size >= MAX_MENU_ITEMS ||
      typeof item.title !== "string" ||
      !item.title ||
      item.title.length > 500 ||
      typeof item.type !== "string" ||
      !Array.isArray(item.tags) ||
      item.tags.some((tag) => typeof tag !== "string" || tag.length > 500) ||
      !Array.isArray(item.items)
    ) {
      throw mapError("menu_invalid", "Shopify returned an invalid Lara menu item.");
    }
    seen.add(item.id);
    return {
      id: item.id,
      position,
      positionPath,
      title: item.title,
      type: item.type,
      url: sanitizeMenuUrl(item.url),
      resourceId: typeof item.resourceId === "string" ? item.resourceId : null,
      tags: [...item.tags],
      items: sanitizeMenuItems(item.items, positionPath, seen),
    };
  });
}

function flattenMenuItems(
  items: LaraStorefrontMenuItemSnapshot[],
): LaraStorefrontMenuItemSnapshot[] {
  return items.flatMap((item) => [item, ...flattenMenuItems(item.items)]);
}

async function menuSnapshot(
  label: "main" | "footer",
  menu: MenuNode | null,
): Promise<LaraStorefrontMenuSnapshot> {
  const expected = LARA_STOREFRONT_RESIDUAL_TARGETS.menus[label];
  if (
    !menu ||
    menu.id !== expected.id ||
    typeof menu.handle !== "string" ||
    !menu.handle ||
    typeof menu.title !== "string" ||
    !menu.title ||
    typeof menu.isDefault !== "boolean" ||
    !Array.isArray(menu.items)
  ) {
    throw mapError("menu_mismatch", `Shopify returned a different Lara ${label} menu.`);
  }
  const items = sanitizeMenuItems(menu.items);
  const stable = {
    label,
    id: menu.id,
    handle: menu.handle,
    title: menu.title,
    isDefault: menu.isDefault,
    itemCount: flattenMenuItems(items).length,
    items,
  };
  return { ...stable, digestSha256: await sha256Hex(canonicalJson(stable)) };
}

function pageLinks(
  menu: LaraStorefrontMenuSnapshot,
  target: { id: string; path: string },
): Array<{ id: string; positionPath: number[]; title: string }> {
  return flattenMenuItems(menu.items)
    .filter(
      (item) => item.resourceId === target.id || item.url === target.path,
    )
    .map((item) => ({ id: item.id, positionPath: item.positionPath, title: item.title }));
}

function matchedFilesForCategory(
  evidence: LaraStorefrontResidualSourceEvidence[],
  category: SourceCategory,
): string[] {
  return evidence
    .filter((file) => file.matches.some((match) => match.category === category))
    .map((file) => file.filename)
    .sort();
}

function markerOccurrences(
  evidence: LaraStorefrontResidualSourceEvidence[],
  category: SourceCategory,
): number {
  return evidence.reduce(
    (total, file) =>
      total +
      file.matches
        .filter((match) => match.category === category)
        .reduce((subtotal, match) => subtotal + match.occurrences, 0),
    0,
  );
}

function recognizedShopifyProduct(
  title: string,
  handle: string,
): "shopify_flow" | "shopify_forms" | null {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  const normalizedHandle = handle.trim().toLocaleLowerCase();
  if (
    normalizedTitle === "shopify flow" ||
    normalizedHandle === "flow" ||
    normalizedHandle === "shopify-flow"
  ) {
    return "shopify_flow";
  }
  if (
    normalizedTitle === "shopify forms" ||
    normalizedTitle === "forms" ||
    normalizedHandle === "forms" ||
    normalizedHandle === "shopify-forms"
  ) {
    return "shopify_forms";
  }
  return null;
}

async function collectRelevantAppInstallations(
  runtime: QueryRuntime,
): Promise<LaraStorefrontResidualArtifact["appInstallations"]> {
  if (!runtime.grantedScopes.includes("read_apps")) {
    return {
      status: "skipped_missing_scope",
      scannedCount: 0,
      pagesRead: 0,
      matches: [],
    };
  }
  let after: string | null = null;
  let scannedCount = 0;
  let pagesRead = 0;
  const matches: LaraStorefrontResidualArtifact["appInstallations"]["matches"] = [];
  for (;;) {
    if (pagesRead >= MAX_APP_INSTALLATION_PAGES) {
      throw mapError("theme_file_page_cap", "The app-installation page cap was reached.");
    }
    const data: AppInstallationsData = await runtime.query<AppInstallationsData>(
      LARA_STOREFRONT_APP_INSTALLATIONS_QUERY,
      { after },
    );
    pagesRead += 1;
    if (!data || !data.appInstallations || !Array.isArray(data.appInstallations.nodes)) {
      throw mapError("theme_file_invalid", "Shopify returned invalid app installation data.");
    }
    for (const node of data.appInstallations.nodes) {
      const app = node?.app;
      if (
        !app ||
        typeof app.title !== "string" ||
        typeof app.shopifyDeveloped !== "boolean" ||
        (app.handle !== null && typeof app.handle !== "string")
      ) {
        throw mapError("theme_file_invalid", "Shopify returned invalid app metadata.");
      }
      scannedCount += 1;
      if (!app.shopifyDeveloped || !app.handle) continue;
      const product = recognizedShopifyProduct(app.title, app.handle);
      if (!product) continue;
      matches.push({
        product,
        title: app.title.slice(0, 200),
        handle: app.handle.slice(0, 200),
        shopifyDeveloped: true,
      });
    }
    if (!data.appInstallations.pageInfo.hasNextPage) break;
    const next: string | null = data.appInstallations.pageInfo.endCursor;
    if (!next || next === after) {
      throw mapError("theme_cursor_invalid", "Shopify returned an invalid app cursor.");
    }
    after = next;
  }
  matches.sort(
    (left, right) =>
      left.product.localeCompare(right.product) || left.handle.localeCompare(right.handle),
  );
  return { status: "complete", scannedCount, pagesRead, matches };
}

export async function collectLaraStorefrontResidualMap({
  runtime,
  readShortLivedBody,
  now = () => new Date(),
}: {
  runtime: QueryRuntime;
  readShortLivedBody?: BodyReader;
  now?: () => Date;
}): Promise<LaraStorefrontResidualArtifact> {
  assertRuntime(runtime);

  const mainThemeData = await runtime.query<MainThemeData>(
    LARA_STOREFRONT_MAIN_THEME_QUERY,
  );
  if (mainThemeData.themes.nodes.length !== 1) {
    throw mapError("main_theme_mismatch", "Shopify did not return one Lara main theme.");
  }
  const mainTheme = mainThemeData.themes.nodes[0];
  assertThemeIdentity(mainTheme);
  assertTimestamp(mainTheme.updatedAt);
  if (
    typeof mainTheme.prefix !== "string" ||
    typeof mainTheme.processing !== "boolean" ||
    typeof mainTheme.processingFailed !== "boolean" ||
    (mainTheme.themeStoreId !== null && !Number.isSafeInteger(mainTheme.themeStoreId))
  ) {
    throw mapError("main_theme_mismatch", "Shopify returned invalid Lara theme metadata.");
  }

  const files: Array<ThemeFileMetadata & { size: number; textSource: boolean }> = [];
  const seenFilenames = new Set<string>();
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_THEME_FILE_PAGES) {
      throw mapError("theme_file_page_cap", "The Lara theme file page cap was reached.");
    }
    const data: ThemeFilesData = await runtime.query<ThemeFilesData>(
      LARA_STOREFRONT_THEME_FILES_QUERY,
      { themeId: LARA_STOREFRONT_RESIDUAL_TARGETS.theme.id, after },
    );
    assertThemeIdentity(data.theme);
    if (data.theme.files.userErrors.length > 0) {
      throw mapError("theme_file_error", "Shopify could not enumerate Lara theme files.");
    }
    for (const file of data.theme.files.nodes) {
      if (
        !file ||
        typeof file.filename !== "string" ||
        !file.filename ||
        file.filename.length > 1_000 ||
        seenFilenames.has(file.filename) ||
        typeof file.contentType !== "string" ||
        (file.checksumMd5 !== null && !MD5.test(file.checksumMd5))
      ) {
        throw mapError("theme_file_invalid", "Shopify returned invalid Lara file metadata.");
      }
      assertTimestamp(file.updatedAt);
      seenFilenames.add(file.filename);
      files.push({
        ...file,
        size: numericSize(file.size),
        textSource: isTextSource(file),
      });
      if (files.length > MAX_THEME_FILES) {
        throw mapError("theme_file_cap", "The Lara theme file cap was reached.");
      }
    }
    if (!data.theme.files.pageInfo.hasNextPage) break;
    const next = data.theme.files.pageInfo.endCursor;
    if (!next || next === after) {
      throw mapError("theme_cursor_invalid", "Shopify returned an invalid theme cursor.");
    }
    after = next;
  }

  const allCandidates = files.filter((file) => file.textSource);
  const candidates = allCandidates.slice(0, MAX_TEXT_SOURCE_FILES);
  const skipped: LaraStorefrontResidualArtifact["sourceScan"]["skipped"] = [];
  if (allCandidates.length > candidates.length) {
    for (const file of allCandidates.slice(MAX_TEXT_SOURCE_FILES)) {
      skipped.push({ filename: file.filename, reason: "source_file_count_cap" });
    }
  }

  const evidence: LaraStorefrontResidualSourceEvidence[] = [];
  const textSizeReconciliations: LaraStorefrontResidualArtifact["sourceScan"]["textSizeReconciliations"] = [];
  let scannedCount = 0;
  let scannedBytes = 0;
  let settingsSource: { content: string; sha256: string } | null = null;
  for (let offset = 0; offset < candidates.length; offset += SOURCE_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + SOURCE_BATCH_SIZE);
    const data = await runtime.query<ThemeBodiesData>(
      LARA_STOREFRONT_THEME_BODIES_QUERY,
      {
        themeId: LARA_STOREFRONT_RESIDUAL_TARGETS.theme.id,
        filenames: batch.map((file) => file.filename),
      },
    );
    assertThemeIdentity(data.theme);
    const errorFilenames = new Set(
      data.theme.files.userErrors.flatMap((error) =>
        typeof error.filename === "string" ? [error.filename] : [],
      ),
    );
    if (data.theme.files.userErrors.some((error) => !error.filename)) {
      throw mapError("theme_body_error", "Shopify rejected a Lara source batch.");
    }
    const returned = new Map<string, ThemeBodyNode>();
    for (const node of data.theme.files.nodes) {
      if (returned.has(node.filename)) {
        throw mapError("theme_body_invalid", "Shopify returned a duplicate Lara source body.");
      }
      returned.set(node.filename, node);
    }

    for (const expected of batch) {
      if (errorFilenames.has(expected.filename)) {
        skipped.push({ filename: expected.filename, reason: "shopify_file_error" });
        continue;
      }
      const node = returned.get(expected.filename);
      if (!node || node.filename !== expected.filename) {
        skipped.push({ filename: expected.filename, reason: "source_body_omitted" });
        continue;
      }
      const nodeSize = numericSize(node.size);
      if (
        nodeSize !== expected.size ||
        node.checksumMd5 !== expected.checksumMd5 ||
        node.updatedAt !== expected.updatedAt ||
        node.contentType !== expected.contentType
      ) {
        throw mapError("theme_body_invalid", "A Lara source changed during its bounded read.");
      }
      if (nodeSize > MAX_SOURCE_FILE_BYTES) {
        skipped.push({ filename: expected.filename, reason: "source_file_byte_cap" });
        continue;
      }
      let content: string | null = null;
      let bodyMode: BodyMode = "text";
      if (node.body.__typename === "OnlineStoreThemeFileBodyText") {
        content = node.body.content;
      } else if (node.body.__typename === "OnlineStoreThemeFileBodyBase64") {
        bodyMode = "base64";
        content = decodeBase64Text(node.body.contentBase64);
      } else if (node.body.__typename === "OnlineStoreThemeFileBodyUrl") {
        bodyMode = "short_lived_url";
        if (readShortLivedBody) {
          try {
            content = await readShortLivedBody({
              url: node.body.url,
              expectedBytes: nodeSize,
              filename: expected.filename,
            });
          } catch {
            content = null;
          }
        }
      }
      if (content === null) {
        skipped.push({
          filename: expected.filename,
          reason:
            node.body.__typename === "OnlineStoreThemeFileBodyUrl"
              ? "short_lived_body_unavailable"
              : "source_body_not_utf8",
        });
        continue;
      }
      const integrity =
        node.body.__typename === "OnlineStoreThemeFileBodyText"
          ? verifyTextIntegrity({
              content,
              reportedSize: nodeSize,
              checksumMd5: node.checksumMd5,
            })
          : new TextEncoder().encode(content).byteLength === nodeSize
            ? {
                decodedByteLength: nodeSize,
                integrityMode: "exact" as const,
              }
            : null;
      if (!integrity) {
        skipped.push({ filename: expected.filename, reason: "source_integrity_mismatch" });
        continue;
      }
      if (integrity.decodedByteLength > MAX_SOURCE_FILE_BYTES) {
        skipped.push({ filename: expected.filename, reason: "source_file_byte_cap" });
        continue;
      }
      if (scannedBytes + integrity.decodedByteLength > MAX_TOTAL_SOURCE_BYTES) {
        skipped.push({ filename: expected.filename, reason: "source_total_byte_cap" });
        continue;
      }
      scannedCount += 1;
      scannedBytes += integrity.decodedByteLength;
      if (integrity.integrityMode === "text_crlf_normalized") {
        textSizeReconciliations.push({
          filename: expected.filename,
          reportedSize: nodeSize,
          decodedByteLength: integrity.decodedByteLength,
          integrityMode: integrity.integrityMode,
        });
      }
      const contentSha256 = await sha256Hex(content);
      if (expected.filename === "config/settings_data.json") {
        settingsSource = { content, sha256: contentSha256 };
      }
      const match = await sourceEvidence(expected, content, bodyMode, integrity);
      if (match) evidence.push(match);
    }
  }

  const kachingEmbed = await inspectKachingEmbed(settingsSource);
  const menuData = await runtime.query<MenusData>(LARA_STOREFRONT_MENUS_QUERY, {
    mainId: LARA_STOREFRONT_RESIDUAL_TARGETS.menus.main.id,
    footerId: LARA_STOREFRONT_RESIDUAL_TARGETS.menus.footer.id,
  });
  const mainMenu = await menuSnapshot("main", menuData.main);
  const footerMenu = await menuSnapshot("footer", menuData.footer);
  const mainFlat = flattenMenuItems(mainMenu.items);
  const summerSaleMain = mainFlat
    .filter((item) => item.title === SUMMER_SALE_MENU_TITLE)
    .map((item) => ({
      id: item.id,
      positionPath: item.positionPath,
      url: item.url,
    }));
  const contactMain = pageLinks(
    mainMenu,
    LARA_STOREFRONT_RESIDUAL_TARGETS.pages.contact,
  );
  const contactFooter = pageLinks(
    footerMenu,
    LARA_STOREFRONT_RESIDUAL_TARGETS.pages.contact,
  );
  const aboutMain = pageLinks(
    mainMenu,
    LARA_STOREFRONT_RESIDUAL_TARGETS.pages.about,
  );
  const aboutFooter = pageLinks(
    footerMenu,
    LARA_STOREFRONT_RESIDUAL_TARGETS.pages.about,
  );
  const appInstallations = await collectRelevantAppInstallations(runtime);

  const themeSourceScan =
    allCandidates.length === candidates.length &&
    skipped.length === 0 &&
    scannedCount === candidates.length;
  const completeness = {
    mainThemeIdentity: true as const,
    themeFileEnumeration: true as const,
    themeSourceScan,
    kachingStructure: kachingEmbed.structuralEvidenceComplete,
    mainMenuSnapshot: true as const,
    footerMenuSnapshot: true as const,
    appInstallations: appInstallations.status === "complete",
  };
  const completionIssues = [
    ...(themeSourceScan ? [] : ["theme:source_scan_incomplete"]),
    ...(kachingEmbed.structuralEvidenceComplete
      ? []
      : ["kaching:structural_evidence_incomplete"]),
  ];
  const kachingFiles = matchedFilesForCategory(evidence, "kaching");
  const croatianPostFiles = matchedFilesForCategory(evidence, "croatian_post");
  const saleNarrativeFiles = matchedFilesForCategory(evidence, "sale_narrative");
  const logoAssetPresent = files.some(
    (file) => file.filename.toLocaleLowerCase() === "assets/hrvatska-posta.svg",
  );

  return {
    schemaVersion: LARA_STOREFRONT_RESIDUAL_SCHEMA_VERSION,
    auditStatus: completionIssues.length === 0 ? "complete" : "partial",
    completionIssues,
    generatedAt: now().toISOString(),
    apiVersion: AUDIT_SHOPIFY_API_VERSION,
    queryManifestSha256: await laraStorefrontResidualManifestSha256(),
    shop: LARA_AUDIT_CONNECTION,
    theme: {
      id: mainTheme.id,
      name: mainTheme.name,
      prefix: mainTheme.prefix,
      role: mainTheme.role,
      themeStoreId: mainTheme.themeStoreId,
      updatedAt: mainTheme.updatedAt,
      processing: mainTheme.processing,
      processingFailed: mainTheme.processingFailed,
      fileCount: files.length,
      files,
    },
    sourceScan: {
      candidateCount: allCandidates.length,
      scannedCount,
      scannedBytes,
      matchedFileCount: evidence.length,
      skipped,
      textSizeReconciliations,
      evidence: evidence.sort((left, right) =>
        left.filename.localeCompare(right.filename),
      ),
    },
    kachingEmbed,
    menus: [mainMenu, footerMenu],
    linkCoverage: {
      summerSaleMain,
      contact: { main: contactMain, footer: contactFooter },
      about: { main: aboutMain, footer: aboutFooter },
    },
    findings: {
      kaching: {
        matchedFiles: kachingFiles,
        embedCount: kachingEmbed.embedCount,
        activeEmbedCount: kachingEmbed.activeEmbedCount,
      },
      croatianPost: {
        matchedFiles: croatianPostFiles,
        markerOccurrences: markerOccurrences(evidence, "croatian_post"),
        logoAssetPresent,
      },
      saleNarrative: {
        matchedFiles: saleNarrativeFiles,
        markerOccurrences: markerOccurrences(evidence, "sale_narrative"),
      },
      summerSaleMenuItemCount: summerSaleMain.length,
      contactLinks: { main: contactMain.length, footer: contactFooter.length },
      aboutLinks: { main: aboutMain.length, footer: aboutFooter.length },
    },
    appInstallations,
    completeness,
  };
}

export type LaraStorefrontResidualSummary = {
  auditStatus: "complete" | "partial";
  completionIssues: string[];
  themeFileCount: number;
  scannedSourceCount: number;
  matchedSourceCount: number;
  textSizeReconciliationCount: number;
  kachingEmbedCount: number;
  activeKachingEmbedCount: number;
  croatianPostMatchedFileCount: number;
  saleNarrativeMatchedFileCount: number;
  summerSaleMenuItemCount: number;
  contactLinks: { main: number; footer: number };
  aboutLinks: { main: number; footer: number };
  appInstallations: LaraStorefrontResidualArtifact["appInstallations"];
};

/** Validate a durable artifact and reduce it to the only fields an HTTP route may return. */
export function summariseLaraStorefrontResidualArtifact(
  value: unknown,
): LaraStorefrontResidualSummary | null {
  const artifact = objectRecord(value);
  const shop = objectRecord(artifact?.shop);
  const theme = objectRecord(artifact?.theme);
  const sourceScan = objectRecord(artifact?.sourceScan);
  const kaching = objectRecord(artifact?.kachingEmbed);
  const findings = objectRecord(artifact?.findings);
  const croatianPost = objectRecord(findings?.croatianPost);
  const saleNarrative = objectRecord(findings?.saleNarrative);
  const contactLinks = objectRecord(findings?.contactLinks);
  const aboutLinks = objectRecord(findings?.aboutLinks);
  const appInstallations = objectRecord(artifact?.appInstallations);
  if (
    artifact?.schemaVersion !== LARA_STOREFRONT_RESIDUAL_SCHEMA_VERSION ||
    !["complete", "partial"].includes(String(artifact.auditStatus)) ||
    !Array.isArray(artifact.completionIssues) ||
    artifact.completionIssues.some((issue) => typeof issue !== "string") ||
    artifact.apiVersion !== AUDIT_SHOPIFY_API_VERSION ||
    shop?.connectionId !== LARA_AUDIT_CONNECTION.connectionId ||
    shop?.shopDomain !== LARA_AUDIT_CONNECTION.shopDomain ||
    shop?.shopId !== LARA_AUDIT_CONNECTION.shopId ||
    theme?.id !== LARA_STOREFRONT_RESIDUAL_TARGETS.theme.id ||
    theme?.name !== LARA_STOREFRONT_RESIDUAL_TARGETS.theme.name ||
    theme?.role !== LARA_STOREFRONT_RESIDUAL_TARGETS.theme.role ||
    typeof theme.fileCount !== "number" ||
    typeof sourceScan?.scannedCount !== "number" ||
    typeof sourceScan?.matchedFileCount !== "number" ||
    !Array.isArray(sourceScan?.textSizeReconciliations) ||
    sourceScan.textSizeReconciliations.some((entry) => {
      const record = objectRecord(entry);
      return (
        !record ||
        typeof record.filename !== "string" ||
        typeof record.reportedSize !== "number" ||
        typeof record.decodedByteLength !== "number" ||
        record.integrityMode !== "text_crlf_normalized"
      );
    }) ||
    typeof kaching?.embedCount !== "number" ||
    typeof kaching?.activeEmbedCount !== "number" ||
    !Array.isArray(croatianPost?.matchedFiles) ||
    !Array.isArray(saleNarrative?.matchedFiles) ||
    typeof findings?.summerSaleMenuItemCount !== "number" ||
    typeof contactLinks?.main !== "number" ||
    typeof contactLinks?.footer !== "number" ||
    typeof aboutLinks?.main !== "number" ||
    typeof aboutLinks?.footer !== "number" ||
    !["complete", "skipped_missing_scope"].includes(
      String(appInstallations?.status),
    ) ||
    typeof appInstallations?.scannedCount !== "number" ||
    typeof appInstallations?.pagesRead !== "number" ||
    (appInstallations?.status === "skipped_missing_scope" &&
      (appInstallations.scannedCount !== 0 || appInstallations.pagesRead !== 0)) ||
    !Array.isArray(appInstallations?.matches) ||
    (appInstallations?.status === "skipped_missing_scope" &&
      appInstallations.matches.length !== 0) ||
    appInstallations.matches.some((match) => {
      const entry = objectRecord(match);
      return (
        !entry ||
        !["shopify_flow", "shopify_forms"].includes(String(entry.product)) ||
        typeof entry.title !== "string" ||
        typeof entry.handle !== "string" ||
        entry.shopifyDeveloped !== true
      );
    })
  ) {
    return null;
  }
  return {
    auditStatus: artifact.auditStatus as "complete" | "partial",
    completionIssues: [...(artifact.completionIssues as string[])],
    themeFileCount: theme.fileCount,
    scannedSourceCount: sourceScan.scannedCount,
    matchedSourceCount: sourceScan.matchedFileCount,
    textSizeReconciliationCount: sourceScan.textSizeReconciliations.length,
    kachingEmbedCount: kaching.embedCount,
    activeKachingEmbedCount: kaching.activeEmbedCount,
    croatianPostMatchedFileCount: croatianPost.matchedFiles.length,
    saleNarrativeMatchedFileCount: saleNarrative.matchedFiles.length,
    summerSaleMenuItemCount: findings.summerSaleMenuItemCount,
    contactLinks: { main: contactLinks.main, footer: contactLinks.footer },
    aboutLinks: { main: aboutLinks.main, footer: aboutLinks.footer },
    appInstallations:
      appInstallations as LaraStorefrontResidualArtifact["appInstallations"],
  };
}
