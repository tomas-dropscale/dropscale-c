import "server-only";

import { createHash } from "node:crypto";

import {
  LARA_ROVINJ_REMEDIATION_SHOP,
  canonicalRemediationJson,
  freezeRemediationValue,
  remediationSha256,
  type DeepReadonly,
} from "./shopify-remediation-plan";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import type { AuditShopifyRuntime } from "./shopify-runtime";

export const LARA_THEME_URGENCY_SCHEMA_VERSION =
  "lara-theme-urgency-repair.v1" as const;

export const LARA_THEME_URGENCY_THEME = Object.freeze({
  id: "gid://shopify/OnlineStoreTheme/186665468284",
  name: "symmetry",
  role: "MAIN",
} as const);

export const LARA_THEME_URGENCY_REST_THEME_ID = 186665468284 as const;

export const LARA_THEME_URGENCY_FILES = Object.freeze([
  "blocks/ai_gen_block_a974a97.liquid",
  "templates/index.json",
  "sections/main-product.liquid",
  "templates/product.json",
  "sections/collection-list.liquid",
  "sections/featured-collection.liquid",
  "sections/featured-product.liquid",
  "config/settings_data.json",
] as const);

export type LaraThemeUrgencyFilename =
  (typeof LARA_THEME_URGENCY_FILES)[number];

/**
 * Every non-literal text representation must reconstruct the stored bytes and
 * prove them against both independent Shopify metadata fields. Keep this value
 * in the live repair schema hash so a resumed fixed run cannot silently change
 * its source-integrity rules.
 */
export const LARA_THEME_URGENCY_TEXT_BODY_INTEGRITY_POLICY = Object.freeze([
  "literal_text_requires_exact_reported_size_and_available_md5",
  "crlf_reconstruction_requires_exact_size_and_md5",
  "exact_shopify_generated_json_banner_then_bounded_candidates_require_exact_size_and_md5",
  "fixed_rest_asset_fallback_requires_matching_graphql_metadata_and_exact_size_and_md5",
] as const);

/** The merchant explicitly accepted Lara Rovinj as the structured brand/vendor. */
export const LARA_THEME_VENDOR_POLICY = Object.freeze({
  decision: "merchant_accepted_non_issue",
  mutationsAllowed: false,
  protectedFields: ["product.vendor", "structured_data.brand"],
  note: "This theme batch must not infer, plan or execute brand/vendor changes.",
} as const);

export const LARA_THEME_URGENCY_SOURCE_QUERY = `#graphql
  query LaraThemeUrgencySource($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      id
      name
      role
      files(first: 1, filenames: $filenames) {
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

type ThemeSourceData = {
  theme: {
    id: string;
    name: string;
    role: string;
    files: {
      nodes: Array<{
        filename: string;
        checksumMd5: string | null;
        contentType: string;
        size: number | string;
        updatedAt: string;
        body:
          | { __typename: "OnlineStoreThemeFileBodyText"; content: string }
          | { __typename: "OnlineStoreThemeFileBodyBase64"; contentBase64: string }
          | { __typename: "OnlineStoreThemeFileBodyUrl"; url: string };
      }>;
      userErrors: Array<{ code: string; filename: string | null }>;
    };
  } | null;
};

export type LaraThemeUrgencyRestAsset = DeepReadonly<{
  filename: LaraThemeUrgencyFilename;
  themeId: typeof LARA_THEME_URGENCY_REST_THEME_ID;
  checksumMd5: string;
  contentType: string;
  size: number;
  updatedAt: string;
  content: string;
}>;

export type LaraThemeUrgencyReadRuntime = Pick<
  AuditShopifyRuntime,
  "connectionId" | "shopDomain" | "shopId" | "grantedScopes" | "query"
> &
  Readonly<{
    /** Optional fixed-path fallback implemented only by the dedicated live runtime. */
    readExactThemeAsset?: (
      filename: LaraThemeUrgencyFilename,
    ) => Promise<LaraThemeUrgencyRestAsset>;
  }>;

export type LaraThemeUrgencySourceFile = DeepReadonly<{
  filename: LaraThemeUrgencyFilename;
  checksumMd5: string | null;
  contentType: string;
  size: number;
  updatedAt: string;
  content: string;
  contentSha256: string;
}>;

export type LaraThemeUrgencySnapshot = DeepReadonly<{
  shop: typeof LARA_ROVINJ_REMEDIATION_SHOP;
  capturedAt: string;
  theme: {
    id: typeof LARA_THEME_URGENCY_THEME.id;
    name: string;
    role: typeof LARA_THEME_URGENCY_THEME.role;
    nameSha256: string;
    roleSha256: string;
  };
  files: LaraThemeUrgencySourceFile[];
  digestSha256: string;
}>;

type FindingCategory =
  | "cart_timer"
  | "closing_sale"
  | "high_demand"
  | "longevity_claim"
  | "scarcity"
  | "urgency_implementation";

export type LaraThemeUrgencyFinding = DeepReadonly<{
  findingId: string;
  filename: LaraThemeUrgencyFilename;
  category: FindingCategory;
  marker: string;
  occurrencesBefore: number;
  occurrencesAfter: number;
  disposition: "changed_exactly" | "blocked_ambiguous" | "detected_non_copy";
  ruleId: string | null;
}>;

export type LaraThemeUrgencyExactChange = DeepReadonly<{
  ruleId: string;
  category: Exclude<FindingCategory, "cart_timer" | "urgency_implementation">;
  needle: string;
  replacement: string;
  expectedOccurrences: number;
}>;

export type LaraThemeUrgencyOperation = DeepReadonly<{
  operationId: string;
  kind: "theme_file.replace_content";
  target: {
    themeId: typeof LARA_THEME_URGENCY_THEME.id;
    filename: LaraThemeUrgencyFilename;
  };
  protectedTheme: {
    name: string;
    nameSha256: string;
    role: typeof LARA_THEME_URGENCY_THEME.role;
    roleSha256: string;
  };
  before: {
    updatedAt: string;
    checksumMd5: string | null;
    contentType: string;
    size: number;
    contentSha256: string;
  };
  after: {
    content: string;
    contentSha256: string;
  };
  inverse: {
    content: string;
    contentSha256: string;
  };
  exactChanges: LaraThemeUrgencyExactChange[];
}>;

export type LaraThemeUrgencyBlocker = DeepReadonly<{
  code: "AMBIGUOUS_ACTIVE_COPY" | "KACHING_TIMER_UNSAFE_TO_DISABLE";
  filename: LaraThemeUrgencyFilename;
  marker: string;
  occurrences: number;
  detail: string;
}>;

export type LaraThemeUrgencyPlanPayload = DeepReadonly<{
  schemaVersion: typeof LARA_THEME_URGENCY_SCHEMA_VERSION;
  planId: string;
  createdAt: string;
  executionMode: "dry-run" | "apply";
  purpose: string;
  shop: typeof LARA_ROVINJ_REMEDIATION_SHOP;
  theme: LaraThemeUrgencySnapshot["theme"];
  sourceCapturedAt: string;
  sourceSnapshotDigestSha256: string;
  sourceFiles: Array<{
    filename: LaraThemeUrgencyFilename;
    updatedAt: string;
    checksumMd5: string | null;
    contentType: string;
    size: number;
    contentSha256: string;
  }>;
  vendorPolicy: typeof LARA_THEME_VENDOR_POLICY;
  findings: LaraThemeUrgencyFinding[];
  blockers: LaraThemeUrgencyBlocker[];
  operations: LaraThemeUrgencyOperation[];
}>;

export type SealedLaraThemeUrgencyPlan = DeepReadonly<{
  payload: LaraThemeUrgencyPlanPayload;
  digestSha256: string;
}>;

export class LaraThemeUrgencyPlanError extends Error {
  constructor(
    public readonly code:
      | "BODY_NOT_TEXT"
      | "DUPLICATE_FILE"
      | "INVALID_INPUT"
      | "INVALID_PLAN"
      | "INVALID_RUNTIME"
      | "MISSING_FILE"
      | "PLAN_DIGEST_MISMATCH"
      | "SHOPIFY_FILE_ERROR"
      | "THEME_IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "LaraThemeUrgencyPlanError";
  }
}

type ExactRule = Readonly<{
  id: string;
  category: LaraThemeUrgencyExactChange["category"];
  needle: string;
  replacement: string;
}>;

const EXACT_RULES: readonly ExactRule[] = Object.freeze([
  {
    id: "closing.full-body-html",
    category: "closing_sale",
    needle:
      "<p>Lara Rovinj zatvara svoja vrata. Hvala vam što ste bili dio ove priče.</p><p>Posljednji dani, posljednje veličine!</p><p>Zauvijek,<br/>Lara.</p>",
    replacement:
      "<p>Dobrodošli u Lara Rovinj.</p><p>Otkrijte našu aktualnu kolekciju.</p>",
  },
  {
    id: "closing.full-farewell-body",
    category: "closing_sale",
    needle:
      "Lara Rovinj zatvara svoja vrata. Hvala vam što ste bili dio ove priče.",
    replacement: "Dobrodošli u Lara Rovinj. Otkrijte našu aktualnu kolekciju.",
  },
  {
    id: "closing.goodbye-kicker",
    category: "closing_sale",
    needle: "Zbogom...",
    replacement: "Dobrodošli",
  },
  {
    id: "closing.store-doors",
    category: "closing_sale",
    needle: "Lara Rovinj zatvara svoja vrata",
    replacement: "Dobrodošli u Lara Rovinj",
  },
  {
    id: "closing.thank-you-farewell",
    category: "closing_sale",
    needle: "Hvala vam što ste bili dio ove priče.",
    replacement: "Otkrijte našu aktualnu kolekciju.",
  },
  {
    id: "closing.storewide-clearance",
    category: "closing_sale",
    needle: "Veliko rasprodavanje cijele trgovine",
    replacement: "Otkrijte kolekciju Lara Rovinj",
  },
  {
    id: "closing.last-days-sizes",
    category: "closing_sale",
    needle: "Posljednji dani, posljednje veličine",
    replacement: "Odabrani modeli i veličine",
  },
  {
    id: "closing.forever-signoff",
    category: "closing_sale",
    needle: "Zauvijek,",
    replacement: "Srdačno,",
  },
  {
    id: "scarcity.last-pieces",
    category: "scarcity",
    needle: "Posljednji komadi",
    replacement: "Dostupno",
  },
  {
    id: "demand.complete-button-message",
    category: "high_demand",
    needle:
      'Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane. Međutim, ako kliknete na gumb "DODAJ U KOŠARICU", proizvod je još uvijek dostupan.',
    replacement: "Dostupnost proizvoda redovito se ažurira.",
  },
  {
    id: "demand.complete-button-message-html-escaped",
    category: "high_demand",
    needle:
      "Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane. Međutim, ako kliknete na gumb &quot;DODAJ U KOŠARICU&quot;, proizvod je još uvijek dostupan.",
    replacement: "Dostupnost proizvoda redovito se ažurira.",
  },
  {
    id: "demand.full-copy-period",
    category: "high_demand",
    needle:
      "Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane.",
    replacement: "Dostupnost proizvoda redovito se ažurira.",
  },
  {
    id: "demand.full-copy",
    category: "high_demand",
    needle:
      "Zbog velike potražnje tijekom rasprodaje, naše zalihe su gotovo rasprodane",
    replacement: "Dostupnost proizvoda redovito se ažurira",
  },
  {
    id: "demand.button-availability-cue",
    category: "high_demand",
    needle:
      'Međutim, ako kliknete na gumb "DODAJ U KOŠARICU", proizvod je još uvijek dostupan.',
    replacement: "Podaci o dostupnosti prikazani su na stranici proizvoda.",
  },
  {
    id: "demand.button-availability-cue-html-escaped",
    category: "high_demand",
    needle:
      "Međutim, ako kliknete na gumb &quot;DODAJ U KOŠARICU&quot;, proizvod je još uvijek dostupan.",
    replacement: "Podaci o dostupnosti prikazani su na stranici proizvoda.",
  },
  {
    id: "longevity.title-period",
    category: "longevity_claim",
    needle: "Hrvatski brend od 2015.",
    replacement: "Lara Rovinj",
  },
  {
    id: "longevity.title",
    category: "longevity_claim",
    needle: "Hrvatski brend od 2015",
    replacement: "Lara Rovinj",
  },
  {
    id: "longevity.lower-period",
    category: "longevity_claim",
    needle: "hrvatski brend od 2015.",
    replacement: "Lara Rovinj",
  },
  {
    id: "longevity.lower",
    category: "longevity_claim",
    needle: "hrvatski brend od 2015",
    replacement: "Lara Rovinj",
  },
]);

const MARKERS: ReadonlyArray<
  Readonly<{ category: FindingCategory; marker: string; ruleId?: string }>
> = Object.freeze([
  ...EXACT_RULES.map((rule) => ({
    category: rule.category,
    marker: rule.needle,
    ruleId: rule.id,
  })),
  { category: "high_demand", marker: "Zbog velike potražnje tijekom rasprodaje" },
  { category: "high_demand", marker: "naše zalihe su gotovo rasprodane" },
  { category: "high_demand", marker: "ako kliknete na gumb" },
  { category: "high_demand", marker: "proizvod je još uvijek dostupan" },
  { category: "closing_sale", marker: "Hvala vam što ste bili dio ove priče" },
  { category: "closing_sale", marker: "Zauvijek, Lara" },
  { category: "cart_timer", marker: "Košarica istječe za" },
  { category: "cart_timer", marker: "clearCartOnTimerEnd" },
  { category: "cart_timer", marker: "kaching-cart" },
  { category: "urgency_implementation", marker: "stock-urgency__text" },
  { category: "urgency_implementation", marker: "data-stock-urgency-variants" },
  { category: "urgency_implementation", marker: "updateStockUrgency" },
  { category: "urgency_implementation", marker: "cc-conv__sale-text" },
  {
    category: "urgency_implementation",
    marker: "ai-bmt-attgxn3vjb1lhzepraaigenblocka974a97nwnypc",
  },
  { category: "urgency_implementation", marker: "a974a97_NWNyPc" },
]);

const PLAN_ID = /^[a-z0-9][a-z0-9._-]{2,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;
const MAX_FILE_BYTES = 2_000_000;
const SHOPIFY_GENERATED_JSON_BANNER_LF = `/*
 * ------------------------------------------------------------
 * IMPORTANT: The contents of this file are auto-generated.
 *
 * This file may be updated by the Shopify admin theme editor
 * or related systems. Please exercise caution as any changes
 * made to this file may be overwritten.
 * ------------------------------------------------------------
 */
`;
const SHOPIFY_GENERATED_JSON_BANNER_CRLF =
  SHOPIFY_GENERATED_JSON_BANNER_LF.replaceAll("\n", "\r\n");

function exactCount(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const index = value.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function replaceEveryExact(value: string, needle: string, replacement: string): string {
  return value.split(needle).join(replacement);
}

function assertTimestamp(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new LaraThemeUrgencyPlanError("INVALID_INPUT", "A Shopify timestamp is invalid.");
  }
}

function assertReadRuntime(runtime: LaraThemeUrgencyReadRuntime): void {
  if (
    runtime.shopDomain !== LARA_ROVINJ_REMEDIATION_SHOP.domain ||
    runtime.shopId !== LARA_ROVINJ_REMEDIATION_SHOP.shopId ||
    runtime.connectionId !== LARA_AUDIT_CONNECTION.connectionId ||
    !runtime.grantedScopes.includes("read_themes") ||
    typeof runtime.query !== "function" ||
    (runtime.readExactThemeAsset !== undefined &&
      typeof runtime.readExactThemeAsset !== "function")
  ) {
    throw new LaraThemeUrgencyPlanError(
      "INVALID_RUNTIME",
      "The read runtime is not the scope-bound Lara Shopify connection.",
    );
  }
}

function numericSize(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_FILE_BYTES) {
    throw new LaraThemeUrgencyPlanError(
      "INVALID_INPUT",
      "A selected Shopify theme file exceeds the bounded text-file limit.",
    );
  }
  return parsed;
}

function md5Hex(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function withoutOneTerminalLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function addTerminalLineEndingCandidates(candidates: Set<string>, value: string): void {
  candidates.add(value);
  const withoutTerminalLineEnding = withoutOneTerminalLineEnding(value);
  candidates.add(withoutTerminalLineEnding);
  candidates.add(`${withoutTerminalLineEnding}\n`);
  candidates.add(`${withoutTerminalLineEnding}\r\n`);
}

/**
 * Shopify's GraphQL Text body can project generated JSON as the exact standard
 * Theme Editor banner followed by formatted JSON, while size/checksum still
 * describe the underlying stored file. Only the two exact anchored banner
 * encodings are recognised. The bounded candidates intentionally do not try to
 * infer arbitrary formatting: banner-stripped bytes, their CRLF representation,
 * and JSON.stringify's deterministic compact representation, each with the
 * common zero/LF/CRLF terminal line-ending variants.
 */
function shopifyGeneratedJsonStoredCandidates(content: string): Set<string> {
  let jsonText: string;
  if (content.startsWith(SHOPIFY_GENERATED_JSON_BANNER_LF)) {
    jsonText = content.slice(SHOPIFY_GENERATED_JSON_BANNER_LF.length);
  } else if (content.startsWith(SHOPIFY_GENERATED_JSON_BANNER_CRLF)) {
    jsonText = content.slice(SHOPIFY_GENERATED_JSON_BANNER_CRLF.length);
  } else {
    return new Set();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return new Set();
  }
  const compact = JSON.stringify(parsed);
  if (compact === undefined) return new Set();

  const candidates = new Set<string>();
  addTerminalLineEndingCandidates(candidates, jsonText);
  addTerminalLineEndingCandidates(
    candidates,
    jsonText.replace(/\r?\n/g, "\r\n"),
  );
  addTerminalLineEndingCandidates(candidates, compact);
  return candidates;
}

/**
 * Shopify can expose a projected Text body while `size` and `checksumMd5`
 * continue to describe the stored bytes. Literal-size bodies remain literal;
 * every reconstructed representation is selected from a fixed candidate set
 * and requires an exact size plus MD5 proof. The snapshot, inverse and backup
 * therefore retain the proven stored bytes rather than the API projection.
 */
function completeStoredTextBody({
  filename,
  content,
  size,
  checksumMd5,
}: {
  filename: LaraThemeUrgencyFilename;
  content: string;
  size: number;
  checksumMd5: string | null;
}): string | null {
  if (
    utf8ByteLength(content) === size &&
    (checksumMd5 === null || md5Hex(content) === checksumMd5)
  ) {
    return content;
  }
  if (checksumMd5 === null) return null;

  const candidates = new Set<string>();
  if (content.includes("\n")) {
    candidates.add(content.replace(/\r?\n/g, "\r\n"));
  }
  if (filename.endsWith(".json")) {
    for (const candidate of shopifyGeneratedJsonStoredCandidates(content)) {
      candidates.add(candidate);
    }
  }
  const matches = [...candidates].filter(
    (candidate) =>
      utf8ByteLength(candidate) === size && md5Hex(candidate) === checksumMd5,
  );
  if (matches.length !== 1) {
    return null;
  }
  return matches[0];
}

function verifyRestFallbackAgainstGraphql({
  filename,
  graphql,
  rest,
}: {
  filename: LaraThemeUrgencyFilename;
  graphql: {
    checksumMd5: string | null;
    size: number;
    updatedAt: string;
  };
  rest: LaraThemeUrgencyRestAsset;
}): string {
  if (
    graphql.checksumMd5 === null ||
    rest.filename !== filename ||
    rest.themeId !== LARA_THEME_URGENCY_REST_THEME_ID ||
    rest.checksumMd5 !== graphql.checksumMd5 ||
    rest.size !== graphql.size ||
    Date.parse(rest.updatedAt) !== Date.parse(graphql.updatedAt) ||
    !rest.contentType ||
    utf8ByteLength(rest.content) !== rest.size ||
    md5Hex(rest.content) !== rest.checksumMd5
  ) {
    throw new LaraThemeUrgencyPlanError(
      "INVALID_INPUT",
      "The fixed REST theme asset did not match the preceding GraphQL source metadata.",
    );
  }
  return rest.content;
}

/** Read the eight fixed files one-by-one so Shopify cannot truncate a large batch payload. */
export async function readLaraThemeUrgencySnapshot({
  runtime,
  capturedAt,
}: {
  runtime: LaraThemeUrgencyReadRuntime;
  capturedAt: string;
}): Promise<LaraThemeUrgencySnapshot> {
  assertReadRuntime(runtime);
  assertTimestamp(capturedAt);

  let protectedTheme: { id: string; name: string; role: string } | null = null;
  const files: LaraThemeUrgencySourceFile[] = [];

  for (const filename of LARA_THEME_URGENCY_FILES) {
    const data = await runtime.query<ThemeSourceData>(LARA_THEME_URGENCY_SOURCE_QUERY, {
      themeId: LARA_THEME_URGENCY_THEME.id,
      filenames: [filename],
    });
    if (
      !data.theme ||
      data.theme.id !== LARA_THEME_URGENCY_THEME.id ||
      data.theme.role !== LARA_THEME_URGENCY_THEME.role ||
      data.theme.name !== LARA_THEME_URGENCY_THEME.name ||
      (protectedTheme !== null &&
        (data.theme.id !== protectedTheme.id ||
          data.theme.name !== protectedTheme.name ||
          data.theme.role !== protectedTheme.role))
    ) {
      throw new LaraThemeUrgencyPlanError(
        "THEME_IDENTITY_MISMATCH",
        "The exact Lara main theme identity changed during collection.",
      );
    }
    protectedTheme ??= {
      id: data.theme.id,
      name: data.theme.name,
      role: data.theme.role,
    };
    if (data.theme.files.userErrors.length > 0) {
      throw new LaraThemeUrgencyPlanError(
        "SHOPIFY_FILE_ERROR",
        "Shopify reported an error while reading a fixed Lara theme file.",
      );
    }
    if (data.theme.files.nodes.length !== 1) {
      throw new LaraThemeUrgencyPlanError(
        "MISSING_FILE",
        "Shopify did not return exactly one requested Lara theme file.",
      );
    }
    const file = data.theme.files.nodes[0];
    if (file.filename !== filename) {
      throw new LaraThemeUrgencyPlanError(
        "MISSING_FILE",
        "Shopify returned a different theme filename than requested.",
      );
    }
    if (files.some((candidate) => candidate.filename === filename)) {
      throw new LaraThemeUrgencyPlanError(
        "DUPLICATE_FILE",
        "Shopify returned a duplicate Lara theme file.",
      );
    }
    if (file.body.__typename !== "OnlineStoreThemeFileBodyText") {
      throw new LaraThemeUrgencyPlanError(
        "BODY_NOT_TEXT",
        "A fixed Lara source file did not return its complete text body.",
      );
    }
    if (file.body.content.length > MAX_FILE_BYTES) {
      throw new LaraThemeUrgencyPlanError(
        "INVALID_INPUT",
        "A selected Lara theme source body exceeds the bounded file limit.",
      );
    }
    if (file.checksumMd5 !== null && !MD5.test(file.checksumMd5)) {
      throw new LaraThemeUrgencyPlanError(
        "INVALID_INPUT",
        "A selected Lara theme checksum is invalid.",
      );
    }
    assertTimestamp(file.updatedAt);
    const size = numericSize(file.size);
    const projectedContent = completeStoredTextBody({
      filename,
      content: file.body.content,
      size,
      checksumMd5: file.checksumMd5,
    });
    let content = projectedContent;
    if (content === null && runtime.readExactThemeAsset) {
      const rest = await runtime.readExactThemeAsset(filename);
      content = verifyRestFallbackAgainstGraphql({
        filename,
        graphql: {
          checksumMd5: file.checksumMd5,
          size,
          updatedAt: file.updatedAt,
        },
        rest,
      });
    }
    if (content === null) {
      throw new LaraThemeUrgencyPlanError(
        "INVALID_INPUT",
        "A selected Lara theme body failed every bounded stored-byte size and checksum proof.",
      );
    }
    files.push({
      filename,
      checksumMd5: file.checksumMd5,
      contentType: file.contentType,
      size,
      updatedAt: file.updatedAt,
      content,
      contentSha256: await remediationSha256(content),
    });
  }

  if (!protectedTheme) {
    throw new LaraThemeUrgencyPlanError("MISSING_FILE", "No Lara theme files were read.");
  }
  const theme = {
    id: LARA_THEME_URGENCY_THEME.id,
    name: protectedTheme.name,
    role: LARA_THEME_URGENCY_THEME.role,
    nameSha256: await remediationSha256(protectedTheme.name),
    roleSha256: await remediationSha256(LARA_THEME_URGENCY_THEME.role),
  } as const;
  const stable = {
    shop: LARA_ROVINJ_REMEDIATION_SHOP,
    capturedAt,
    theme,
    files,
  };
  return freezeRemediationValue({
    ...stable,
    digestSha256: await remediationSha256(stable),
  });
}

function applyRulesToString(value: string): {
  content: string;
  changes: LaraThemeUrgencyExactChange[];
} {
  let content = value;
  const changes: LaraThemeUrgencyExactChange[] = [];
  for (const rule of EXACT_RULES) {
    const expectedOccurrences = exactCount(content, rule.needle);
    if (expectedOccurrences === 0) continue;
    content = replaceEveryExact(content, rule.needle, rule.replacement);
    changes.push({
      ruleId: rule.id,
      category: rule.category,
      needle: rule.needle,
      replacement: rule.replacement,
      expectedOccurrences,
    });
  }
  return { content, changes };
}

/** Replace decoded JSON string values while preserving all unrelated bytes/formatting. */
function transformJsonStringValues(value: string): {
  content: string;
  changes: LaraThemeUrgencyExactChange[];
} {
  try {
    JSON.parse(value);
  } catch {
    throw new LaraThemeUrgencyPlanError(
      "INVALID_INPUT",
      "A selected Shopify JSON theme file is not valid JSON.",
    );
  }
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const aggregate = new Map<string, LaraThemeUrgencyExactChange>();
  let index = 0;

  while (index < value.length) {
    if (value[index] !== '"') {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < value.length) {
      if (value[index] === "\\") {
        index += 2;
        continue;
      }
      if (value[index] === '"') break;
      index += 1;
    }
    if (index >= value.length) {
      throw new LaraThemeUrgencyPlanError(
        "INVALID_INPUT",
        "A selected JSON theme file has an unterminated string.",
      );
    }
    const end = index + 1;
    let cursor = end;
    while (cursor < value.length && /\s/u.test(value[cursor])) cursor += 1;
    const isObjectKey = value[cursor] === ":";
    if (!isObjectKey) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(value.slice(start, end));
      } catch {
        throw new LaraThemeUrgencyPlanError(
          "INVALID_INPUT",
          "A selected JSON theme file contains an invalid string token.",
        );
      }
      if (typeof decoded === "string") {
        const transformed = applyRulesToString(decoded);
        if (transformed.content !== decoded) {
          edits.push({ start, end, replacement: JSON.stringify(transformed.content) });
          for (const change of transformed.changes) {
            const previous = aggregate.get(change.ruleId);
            aggregate.set(change.ruleId, {
              ...change,
              expectedOccurrences:
                (previous?.expectedOccurrences ?? 0) + change.expectedOccurrences,
            });
          }
        }
      }
    }
    index = end;
  }

  let content = value;
  for (const edit of edits.reverse()) {
    content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end);
  }
  try {
    JSON.parse(content);
  } catch {
    throw new LaraThemeUrgencyPlanError(
      "INVALID_INPUT",
      "An exact Lara JSON copy replacement would produce invalid JSON.",
    );
  }
  return { content, changes: [...aggregate.values()] };
}

function transformFile(file: LaraThemeUrgencySourceFile) {
  // This file contains the Kaching app embed. It is captured in full for
  // structural evidence, but this copy batch must never rewrite it wholesale.
  if (file.filename === "config/settings_data.json") {
    return { content: file.content, changes: [] };
  }
  return file.filename.endsWith(".json")
    ? transformJsonStringValues(file.content)
    : applyRulesToString(file.content);
}

function uniqueMarkerKey(category: FindingCategory, marker: string) {
  return `${category}\u0000${marker}`;
}

export async function buildLaraThemeUrgencyPlan({
  snapshot,
  planId,
  createdAt,
  executionMode = "dry-run",
  purpose = "Remove unsupported urgency and longevity claims from the exact Lara main theme.",
}: {
  snapshot: LaraThemeUrgencySnapshot;
  planId: string;
  createdAt: string;
  executionMode?: "dry-run" | "apply";
  purpose?: string;
}): Promise<SealedLaraThemeUrgencyPlan> {
  if (
    !PLAN_ID.test(planId) ||
    !purpose.trim() ||
    purpose.length > 1_000 ||
    !["dry-run", "apply"].includes(executionMode)
  ) {
    throw new LaraThemeUrgencyPlanError("INVALID_INPUT", "The Lara repair plan input is invalid.");
  }
  assertTimestamp(createdAt);
  await verifyLaraThemeUrgencySnapshot(snapshot);

  const findings: LaraThemeUrgencyFinding[] = [];
  const blockers: LaraThemeUrgencyBlocker[] = [];
  const operations: LaraThemeUrgencyOperation[] = [];

  for (const file of snapshot.files) {
    const transformed = transformFile(file);
    const changesByRule = new Map(
      transformed.changes.map((change) => [change.ruleId, change]),
    );
    const seen = new Set<string>();
    for (const candidate of MARKERS) {
      const markerKey = uniqueMarkerKey(candidate.category, candidate.marker);
      if (seen.has(markerKey)) continue;
      seen.add(markerKey);
      const occurrencesBefore = exactCount(file.content, candidate.marker);
      if (occurrencesBefore === 0) continue;
      const occurrencesAfter = exactCount(transformed.content, candidate.marker);
      const directChange = candidate.ruleId
        ? changesByRule.get(candidate.ruleId)
        : undefined;
      const change =
        directChange ??
        transformed.changes.find(
          (exactChange) =>
            exactChange.category === candidate.category &&
            exactChange.needle.includes(candidate.marker) &&
            occurrencesAfter === 0,
        );
      let disposition: LaraThemeUrgencyFinding["disposition"];
      if (change && occurrencesAfter === 0) disposition = "changed_exactly";
      else if (candidate.category === "urgency_implementation") {
        disposition = "detected_non_copy";
      } else disposition = "blocked_ambiguous";
      findings.push({
        findingId: `theme.${file.filename}.${findings.length + 1}`,
        filename: file.filename,
        category: candidate.category,
        marker: candidate.marker,
        occurrencesBefore,
        occurrencesAfter,
        disposition,
        ruleId: change?.ruleId ?? null,
      });
      if (disposition === "blocked_ambiguous" && occurrencesAfter > 0) {
        const isKaching =
          candidate.category === "cart_timer" ||
          candidate.marker.toLocaleLowerCase().includes("kaching");
        blockers.push({
          code: isKaching
            ? "KACHING_TIMER_UNSAFE_TO_DISABLE"
            : "AMBIGUOUS_ACTIVE_COPY",
          filename: file.filename,
          marker: candidate.marker,
          occurrences: occurrencesAfter,
          detail: isKaching
            ? "No unequivocal timer-only boolean setting was proven; the app/embed is not rewritten."
            : "The remaining copy does not match an approved exact full-string replacement.",
        });
      }
    }

    if (transformed.content === file.content) continue;
    operations.push({
      operationId: `theme-urgency-${String(operations.length + 1).padStart(2, "0")}`,
      kind: "theme_file.replace_content",
      target: { themeId: LARA_THEME_URGENCY_THEME.id, filename: file.filename },
      protectedTheme: {
        name: snapshot.theme.name,
        nameSha256: snapshot.theme.nameSha256,
        role: snapshot.theme.role,
        roleSha256: snapshot.theme.roleSha256,
      },
      before: {
        updatedAt: file.updatedAt,
        checksumMd5: file.checksumMd5,
        contentType: file.contentType,
        size: file.size,
        contentSha256: file.contentSha256,
      },
      after: {
        content: transformed.content,
        contentSha256: await remediationSha256(transformed.content),
      },
      inverse: {
        content: file.content,
        contentSha256: file.contentSha256,
      },
      exactChanges: transformed.changes,
    });
  }

  const payload: LaraThemeUrgencyPlanPayload = {
    schemaVersion: LARA_THEME_URGENCY_SCHEMA_VERSION,
    planId,
    createdAt,
    executionMode,
    purpose,
    shop: LARA_ROVINJ_REMEDIATION_SHOP,
    theme: snapshot.theme,
    sourceCapturedAt: snapshot.capturedAt,
    sourceSnapshotDigestSha256: snapshot.digestSha256,
    sourceFiles: snapshot.files.map((file) => ({
      filename: file.filename,
      updatedAt: file.updatedAt,
      checksumMd5: file.checksumMd5,
      contentType: file.contentType,
      size: file.size,
      contentSha256: file.contentSha256,
    })),
    vendorPolicy: LARA_THEME_VENDOR_POLICY,
    findings,
    blockers,
    operations,
  };
  return freezeRemediationValue({
    payload,
    digestSha256: await remediationSha256(payload),
  });
}

export async function verifyLaraThemeUrgencySnapshot(
  snapshot: LaraThemeUrgencySnapshot,
): Promise<LaraThemeUrgencySnapshot> {
  assertTimestamp(snapshot.capturedAt);
  if (
    snapshot.shop.domain !== LARA_ROVINJ_REMEDIATION_SHOP.domain ||
    snapshot.shop.shopId !== LARA_ROVINJ_REMEDIATION_SHOP.shopId ||
    snapshot.theme.id !== LARA_THEME_URGENCY_THEME.id ||
    snapshot.theme.role !== LARA_THEME_URGENCY_THEME.role ||
    snapshot.files.length !== LARA_THEME_URGENCY_FILES.length ||
    snapshot.theme.name !== LARA_THEME_URGENCY_THEME.name ||
    snapshot.theme.nameSha256 !== (await remediationSha256(snapshot.theme.name)) ||
    snapshot.theme.roleSha256 !== (await remediationSha256(snapshot.theme.role))
  ) {
    throw new LaraThemeUrgencyPlanError("INVALID_PLAN", "The Lara source snapshot is invalid.");
  }
  const names = snapshot.files.map((file) => file.filename);
  if (
    new Set(names).size !== LARA_THEME_URGENCY_FILES.length ||
    LARA_THEME_URGENCY_FILES.some((filename) => !names.includes(filename))
  ) {
    throw new LaraThemeUrgencyPlanError(
      "INVALID_PLAN",
      "The Lara source snapshot does not contain the exact file manifest.",
    );
  }
  for (const file of snapshot.files) {
    if (
      !SHA256.test(file.contentSha256) ||
      file.contentSha256 !== (await remediationSha256(file.content)) ||
      (file.checksumMd5 !== null && !MD5.test(file.checksumMd5)) ||
      !file.contentType ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE_BYTES ||
      new TextEncoder().encode(file.content).byteLength !== file.size ||
      !validThemeTimestamp(file.updatedAt)
    ) {
      throw new LaraThemeUrgencyPlanError("INVALID_PLAN", "A Lara source file digest is invalid.");
    }
  }
  const stable = {
    shop: snapshot.shop,
    capturedAt: snapshot.capturedAt,
    theme: snapshot.theme,
    files: snapshot.files,
  };
  if (snapshot.digestSha256 !== (await remediationSha256(stable))) {
    throw new LaraThemeUrgencyPlanError(
      "PLAN_DIGEST_MISMATCH",
      "The Lara source snapshot digest does not match its content.",
    );
  }
  return snapshot;
}

function validThemeTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

export async function verifyLaraThemeUrgencyPlan(
  sealed: SealedLaraThemeUrgencyPlan,
): Promise<SealedLaraThemeUrgencyPlan> {
  if (
    !sealed ||
    sealed.payload?.schemaVersion !== LARA_THEME_URGENCY_SCHEMA_VERSION ||
    sealed.payload.shop?.domain !== LARA_ROVINJ_REMEDIATION_SHOP.domain ||
    sealed.payload.shop?.shopId !== LARA_ROVINJ_REMEDIATION_SHOP.shopId ||
    sealed.payload.theme?.id !== LARA_THEME_URGENCY_THEME.id ||
    sealed.payload.theme?.role !== LARA_THEME_URGENCY_THEME.role ||
    sealed.payload.vendorPolicy?.mutationsAllowed !== false ||
    !SHA256.test(sealed.digestSha256)
  ) {
    throw new LaraThemeUrgencyPlanError("INVALID_PLAN", "The sealed Lara theme plan is invalid.");
  }
  if (sealed.digestSha256 !== (await remediationSha256(sealed.payload))) {
    throw new LaraThemeUrgencyPlanError(
      "PLAN_DIGEST_MISMATCH",
      "The sealed Lara theme plan digest does not match its payload.",
    );
  }
  // Ensure the value is serialisable before a writer or artifact adapter sees it.
  canonicalRemediationJson(sealed);
  return freezeRemediationValue(sealed);
}
