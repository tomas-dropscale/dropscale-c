import "server-only";

/**
 * A bounded, fixed-query baseline for merchant-authorised store audits.
 *
 * This module deliberately knows nothing about credentials or HTTP. The
 * server-only runtime supplies a verified GraphQL executor after it has bound
 * the temporary token to the stored shop id and myshopify domain. Keeping the
 * query manifest here static prevents an API route from becoming an arbitrary
 * Shopify GraphQL proxy.
 */

export type AuditGraphqlExecutor = <TData>(
  document: string,
  variables?: Record<string, unknown>,
) => Promise<TData>;

export type AuditModuleStatus =
  | { status: "complete"; requests: number }
  | { status: "blocked_missing_scope"; missingScopes: string[]; requests: 0 }
  | { status: "failed"; requests: number; errorCode: string; retryable: boolean };

type Count = { count: number; precision?: string };

type ShopIdentityData = {
  shop: {
    id: string;
    name: string;
    myshopifyDomain: string;
    primaryDomain: { host: string; url: string };
    contactEmail: string;
    currencyCode: string;
    ianaTimezone: string;
    shopOwnerName: string;
    shopAddress: {
      company: string | null;
      address1: string | null;
      address2: string | null;
      city: string | null;
      province: string | null;
      country: string | null;
      countryCodeV2: string | null;
      zip: string | null;
      phone: string | null;
    };
    countriesInShippingZones: {
      countryCodes: string[];
      includeRestOfWorld: boolean;
    };
  };
};

type CountsData = {
  productsCount: Count;
  productVariantsCount: Count;
  collectionsCount: Count;
};

type PoliciesData = {
  shop: {
    shopPolicies: Array<{
      id: string;
      type: string;
      title: string;
      url: string;
      body: string;
      updatedAt: string;
    }>;
  };
};

type PageNode = {
  id: string;
  handle: string;
  title: string;
  body: string;
  isPublished: boolean;
  publishedAt: string | null;
  templateSuffix: string | null;
  updatedAt: string;
};

type PagesData = {
  pages: {
    nodes: PageNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type MenuItemNode = {
  id: string;
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  items: MenuItemNode[];
};

type MenusData = {
  menus: {
    nodes: Array<{
      id: string;
      handle: string;
      title: string;
      items: MenuItemNode[];
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type ProductImage = {
  id: string;
  altText: string | null;
  url: string;
  width: number | null;
  height: number | null;
};

type PriorityProductNode = {
  id: string;
  handle: string;
  title: string;
  status: string;
  vendor: string;
  productType: string;
  descriptionHtml: string;
  updatedAt: string;
  publishedAt: string | null;
  category: { id: string; name: string; fullName: string } | null;
  seo: { title: string | null; description: string | null };
  options: Array<{
    id: string;
    name: string;
    position: number;
    optionValues: Array<{ id: string; name: string; hasVariants: boolean }>;
  }>;
  variantsCount: Count;
  variants: {
    nodes: Array<{
      id: string;
      title: string;
      sku: string | null;
      barcode: string | null;
      price: string;
      compareAtPrice: string | null;
      availableForSale: boolean;
      inventoryQuantity: number | null;
      inventoryPolicy: string;
      taxable: boolean;
      selectedOptions: Array<{ name: string; value: string }>;
      inventoryItem: {
        id: string;
        tracked: boolean;
        requiresShipping: boolean;
        measurement: {
          weight: { value: number; unit: string } | null;
        };
      };
      image: ProductImage | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  media: {
    nodes: Array<{
      id: string;
      alt: string;
      status: string;
      image: ProductImage | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type PriorityProductData = { product: PriorityProductNode | null };

type ThemeFileMetadata = {
  filename: string;
  checksumMd5: string | null;
  contentType: string;
  size: string | number;
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
      updatedAt: string;
    }>;
  };
};

type ThemeFilesData = {
  theme: {
    files: {
      nodes: ThemeFileMetadata[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      userErrors: Array<{ code: string; filename: string | null }>;
    };
  } | null;
};

type ThemeFileBodyNode = ThemeFileMetadata & {
  body:
    | { __typename: "OnlineStoreThemeFileBodyText"; content: string }
    | { __typename: "OnlineStoreThemeFileBodyBase64"; contentBase64: string }
    | { __typename: "OnlineStoreThemeFileBodyUrl"; url: string };
};

type ThemeBodiesData = {
  theme: {
    files: {
      nodes: ThemeFileBodyNode[];
      userErrors: Array<{ code: string; filename: string | null }>;
    };
  } | null;
};

export const LARA_PRIORITY_PRODUCT_HANDLES = [
  "tila-marije-prirodni-caj-za-opustanje",
  "marija-mesna-delicija",
  "marija-humir-ocaravajuca-njega-za-vasu-kozu",
  "rog-marija-tradicionalni-hrvatski-suvenir",
  "marija-i-milo-savrsen-spoj-za-svaki-dom",
  "tommy-suncane-naocale",
  "bozica-ortopedske-cipele",
  "renske-elegantna-madinga-torba-za-pecnicu",
  "lizzy-osvjezite-svoj-dom-s-prato-setom",
  "clara-vodootporne-kozne-cizme-s-vunenom-podstavom",
] as const;

export const AUDIT_THEME_SOURCE_TOKENS = [
  "Lara Rovinj zatvara svoja vrata",
  "Veliko rasprodavanje cijele trgovine",
  "Posljednji dani, posljednje veličine",
  "ai-bmt-attgxn3vjb1lhzepraaigenblocka974a97nwnypc",
  "a974a97_NWNyPc",
  "Posljednji komadi",
  "stock-urgency__text",
  "data-stock-urgency-variants",
  "updateStockUrgency",
  "Zbog velike potražnje tijekom rasprodaje",
  "naše zalihe su gotovo rasprodane",
  "cc-conv__sale-text",
  "Svaki artikl ima detaljnu tablicu veličina",
  "izrađen je od vrhunskih tkanina",
  "product-faq__answer",
  "Rok za povrat i reklamaciju je 14 dana",
  '"@type": "FAQPage"',
  "kaching-cart",
  "Košarica istječe za",
] as const;

const SHOP_IDENTITY_QUERY = `#graphql
  query AuditShopIdentity {
    shop {
      id
      name
      myshopifyDomain
      primaryDomain { host url }
      contactEmail
      currencyCode
      ianaTimezone
      shopOwnerName
      shopAddress {
        company
        address1
        address2
        city
        province
        country
        countryCodeV2
        zip
        phone
      }
      countriesInShippingZones { countryCodes includeRestOfWorld }
    }
  }
`;

const COUNTS_QUERY = `#graphql
  query AuditStoreCounts {
    productsCount(limit: null) { count precision }
    productVariantsCount(limit: null) { count precision }
    collectionsCount(limit: null) { count precision }
  }
`;

const POLICIES_QUERY = `#graphql
  query AuditLegalPolicies {
    shop {
      shopPolicies { id type title url body updatedAt }
    }
  }
`;

const PAGES_QUERY = `#graphql
  query AuditOnlineStorePages($after: String) {
    pages(first: 100, after: $after) {
      nodes {
        id
        handle
        title
        body
        isPublished
        publishedAt
        templateSuffix
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const MENUS_QUERY = `#graphql
  query AuditOnlineStoreMenus($after: String) {
    menus(first: 100, after: $after) {
      nodes {
        id
        handle
        title
        items {
          id title type url resourceId
          items {
            id title type url resourceId
            items { id title type url resourceId }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRIORITY_PRODUCT_QUERY = `#graphql
  query AuditPriorityProduct($handle: String!) {
    product: productByIdentifier(identifier: { handle: $handle }) { ...PriorityProduct }
  }

  fragment PriorityProduct on Product {
    id
    handle
    title
    status
    vendor
    productType
    descriptionHtml
    updatedAt
    publishedAt
    category { id name fullName }
    seo { title description }
    options {
      id name position
      optionValues { id name hasVariants }
    }
    variantsCount { count precision }
    variants(first: 100) {
      nodes {
        id title sku barcode price compareAtPrice availableForSale
        inventoryQuantity inventoryPolicy taxable
        selectedOptions { name value }
        inventoryItem {
          id tracked requiresShipping
          measurement { weight { value unit } }
        }
        image { id altText url width height }
      }
      pageInfo { hasNextPage endCursor }
    }
    media(first: 50) {
      nodes {
        id alt status
        ... on MediaImage { image { id altText url width height } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const MAIN_THEME_QUERY = `#graphql
  query AuditMainTheme {
    themes(first: 20, roles: [MAIN]) {
      nodes { id name prefix role themeStoreId updatedAt }
    }
  }
`;

const THEME_FILES_QUERY = `#graphql
  query AuditThemeFiles($themeId: ID!, $after: String) {
    theme(id: $themeId) {
      files(first: 500, after: $after) {
        nodes { filename checksumMd5 contentType size updatedAt }
        pageInfo { hasNextPage endCursor }
        userErrors { code filename }
      }
    }
  }
`;

const THEME_BODIES_QUERY = `#graphql
  query AuditThemeFileBodies($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      files(first: 25, filenames: $filenames) {
        nodes {
          filename checksumMd5 contentType size updatedAt
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

export const AUDIT_BASELINE_QUERY_MANIFEST = Object.freeze({
  shopIdentity: SHOP_IDENTITY_QUERY,
  counts: COUNTS_QUERY,
  policies: POLICIES_QUERY,
  pages: PAGES_QUERY,
  menus: MENUS_QUERY,
  priorityProduct: PRIORITY_PRODUCT_QUERY,
  mainTheme: MAIN_THEME_QUERY,
  themeFiles: THEME_FILES_QUERY,
  themeBodies: THEME_BODIES_QUERY,
});

const MAX_PAGE_REQUESTS = 20;
const MAX_THEME_FILES = 2_500;
const MAX_THEME_SOURCE_FILES = 1_000;
const MAX_THEME_REQUESTS = 60;
const SOURCE_BATCH_SIZE = 25;
const TEXT_THEME_SOURCE_SUFFIXES = [
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
] as const;
const TEXT_THEME_SOURCE_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/typescript",
  "application/x-javascript",
  "application/x-liquid",
  "text/css",
  "text/javascript",
  "text/less",
  "text/typescript",
  "text/x-liquid",
  "text/x-sass",
  "text/x-scss",
]);

function missingScopes(granted: ReadonlySet<string>, required: readonly string[]) {
  return required.filter((scope) => !granted.has(scope));
}

function missingAlternativeScopes(
  granted: ReadonlySet<string>,
  alternatives: readonly string[],
) {
  return alternatives.some((scope) => granted.has(scope)) ? [] : [...alternatives];
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  }
  return "module_failed";
}

function errorRetryable(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "retryable" in error &&
      (error as { retryable?: unknown }).retryable === true,
  );
}

function failedModule(error: unknown, requests: number): AuditModuleStatus {
  return {
    status: "failed",
    requests,
    errorCode: errorCode(error),
    retryable: errorRetryable(error),
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function auditBaselineManifestSha256(): Promise<string> {
  const manifestText = Object.entries(AUDIT_BASELINE_QUERY_MANIFEST)
    .map(([name, document]) => `${name}\n${document.trim()}`)
    .join("\n---\n");
  return sha256Hex(manifestText);
}

export async function auditBaselineSchemaSha256(): Promise<string> {
  return sha256Hex("shopify-audit-baseline-v2");
}

function redactContext(value: string): string {
  return value
    .replace(
      /\bauthorization\b\s*[:=]\s*(?:bearer\s+)?[A-Za-z0-9._~+\/-]{8,}/gi,
      "authorization=[REDACTED]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]{4,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:shpat|shpca|shppa|shpss|shpua)_[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|credential|password|authorization|private[_-]?key)["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|credential|password|authorization|private[_-]?key)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/([?&](?:key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deeplySanitize<T>(value: T): T {
  if (typeof value === "string") return redactContext(value) as T;
  if (Array.isArray(value)) return value.map(deeplySanitize) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        deeplySanitize(item),
      ]),
    ) as T;
  }
  return value;
}

function sanitizeUrl(value: string | null): string | null {
  if (!value) return value;
  try {
    const url = new URL(value, "https://audit.invalid");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (url.origin === "https://audit.invalid") return url.pathname;
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return redactContext(value).split(/[?#]/, 1)[0].slice(0, 2_048);
  }
}

function sanitizeImage(image: ProductImage | null): ProductImage | null {
  return image ? { ...image, url: sanitizeUrl(image.url) ?? "" } : null;
}

function sanitizeMenuItem(item: MenuItemNode): MenuItemNode {
  return {
    ...item,
    url: sanitizeUrl(item.url),
    items: item.items.map(sanitizeMenuItem),
  };
}

function sourceContainsMarker(source: string, marker: string): boolean {
  return source.toLocaleLowerCase().includes(marker.toLocaleLowerCase());
}

function bodyText(body: ThemeFileBodyNode["body"]): string | null {
  // URL bodies are intentionally not fetched here: following a body URL would
  // expand the runtime's network boundary. A later fixed-purpose module can do
  // that with an explicit Shopify CDN allowlist if a required source is large.
  if (body.__typename === "OnlineStoreThemeFileBodyText") return body.content;
  if (body.__typename === "OnlineStoreThemeFileBodyBase64") {
    try {
      return atob(body.contentBase64);
    } catch {
      return null;
    }
  }
  return null;
}

function sourcePriority(file: ThemeFileMetadata): number {
  const lower = file.filename.toLocaleLowerCase();
  const contentType = file.contentType.split(";", 1)[0].trim().toLocaleLowerCase();
  const isExplicitTextSource =
    TEXT_THEME_SOURCE_SUFFIXES.some((suffix) => lower.endsWith(suffix)) ||
    TEXT_THEME_SOURCE_CONTENT_TYPES.has(contentType);
  if (!isExplicitTextSource) return 99;

  if (
    [
      "templates/index.json",
      "templates/product.json",
      "config/settings_data.json",
    ].includes(lower)
  ) {
    return 0;
  }
  if (/a974a97|ai_gen|main-product|faq-pdp|product-faq/.test(lower)) return 1;
  if (lower.startsWith("assets/")) return 2;
  if (lower.startsWith("blocks/")) return 3;
  if (lower.startsWith("sections/")) return 4;
  if (lower.startsWith("config/")) return 5;
  if (lower.startsWith("templates/")) return 6;
  if (lower.startsWith("snippets/")) return 7;
  if (lower.startsWith("layout/")) return 8;
  if (lower.startsWith("locales/")) return 9;
  return 10;
}

function themeSourceCandidates(files: ThemeFileMetadata[]): ThemeFileMetadata[] {
  return files
    .filter((file) => sourcePriority(file) < 99)
    .sort(
      (left, right) =>
        sourcePriority(left) - sourcePriority(right) ||
        left.filename.localeCompare(right.filename),
    )
    .slice(0, MAX_THEME_SOURCE_FILES);
}

function publicPageSummary(page: PageNode) {
  const text = redactContext(stripHtml(page.body));
  return {
    id: page.id,
    handle: page.handle,
    title: page.title,
    isPublished: page.isPublished,
    publishedAt: page.publishedAt,
    templateSuffix: page.templateSuffix,
    updatedAt: page.updatedAt,
    bodyLength: page.body.length,
    bodyEmpty: text.length === 0,
  };
}

async function policySummary(policy: PoliciesData["shop"]["shopPolicies"][number]) {
  const text = redactContext(stripHtml(policy.body));
  const dayMentions = [...text.matchAll(/\b(?:14|30)\s+(?:dana|days?|dias?)\b/gi)].map(
    (match) => match[0],
  );
  return {
    id: policy.id,
    type: policy.type,
    title: policy.title,
    url: policy.url,
    updatedAt: policy.updatedAt,
    bodyLength: policy.body.length,
    bodySha256: await sha256Hex(policy.body),
    empty: text.length === 0,
    dayMentions: [...new Set(dayMentions)],
  };
}

async function priorityProductSummary(product: PriorityProductNode) {
  const descriptionText = redactContext(stripHtml(product.descriptionHtml));
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    updatedAt: product.updatedAt,
    publishedAt: product.publishedAt,
    category: product.category,
    seo: product.seo,
    descriptionLength: product.descriptionHtml.length,
    descriptionSha256: await sha256Hex(product.descriptionHtml),
    descriptionEmpty: descriptionText.length === 0,
    options: product.options,
    variantsCount: product.variantsCount,
    variantsComplete: !product.variants.pageInfo.hasNextPage,
    variants: product.variants.nodes.map((variant) => ({
      ...variant,
      image: sanitizeImage(variant.image),
    })),
    mediaComplete: !product.media.pageInfo.hasNextPage,
    media: product.media.nodes.map((media) => ({
      ...media,
      image: sanitizeImage(media.image),
    })),
  };
}

async function collectPaginated<TData, TNode>({
  execute,
  document,
  connection,
}: {
  execute: AuditGraphqlExecutor;
  document: string;
  connection: (data: TData) => {
    nodes: TNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}): Promise<{ nodes: TNode[]; requests: number }> {
  const nodes: TNode[] = [];
  let after: string | null = null;
  let requests = 0;
  for (;;) {
    if (requests >= MAX_PAGE_REQUESTS) throw Object.assign(new Error("Page cap reached."), { code: "page_cap" });
    const data = await execute<TData>(document, { after });
    requests += 1;
    const page = connection(data);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return { nodes, requests };
    if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) {
      throw Object.assign(new Error("Invalid pagination cursor."), { code: "invalid_cursor" });
    }
    after = page.pageInfo.endCursor;
  }
}

export type ShopifyAuditBaseline = {
  schemaVersion: "shopify-audit-baseline-v2";
  auditStatus: "complete" | "partial";
  completionIssues: string[];
  generatedAt: string;
  queryManifestSha256: string;
  modules: Record<string, AuditModuleStatus>;
  shopIdentity: ShopIdentityData["shop"] | null;
  counts: CountsData | null;
  policies: Awaited<ReturnType<typeof policySummary>>[];
  pages: ReturnType<typeof publicPageSummary>[];
  menus: MenusData["menus"]["nodes"];
  priorityProducts: Array<
    | ({ requestedHandle: string; found: false })
    | ({ requestedHandle: string; found: true } & Awaited<ReturnType<typeof priorityProductSummary>>)
  >;
  theme: null | {
    id: string;
    name: string;
    prefix: string;
    role: string;
    themeStoreId: number | null;
    updatedAt: string;
    fileCount: number;
    filesComplete: boolean;
    files: ThemeFileMetadata[];
    sourceScan: {
      candidateCount: number;
      scannedCount: number;
      scanComplete: boolean;
      urlBodiesSkipped: string[];
      matches: Array<{
        filename: string;
        checksumMd5: string | null;
        updatedAt: string;
        markers: Array<{ marker: string }>;
      }>;
    };
  };
};

export async function collectShopifyAuditBaseline({
  execute,
  grantedScopes,
  now = () => new Date(),
}: {
  execute: AuditGraphqlExecutor;
  grantedScopes: readonly string[];
  now?: () => Date;
}): Promise<ShopifyAuditBaseline> {
  const scopes = new Set(grantedScopes);
  const modules: Record<string, AuditModuleStatus> = {};

  let shopIdentity: ShopIdentityData["shop"] | null = null;
  let counts: CountsData | null = null;
  const policies: Awaited<ReturnType<typeof policySummary>>[] = [];
  const pages: ReturnType<typeof publicPageSummary>[] = [];
  const menus: MenusData["menus"]["nodes"] = [];
  const priorityProducts: ShopifyAuditBaseline["priorityProducts"] = [];
  let theme: ShopifyAuditBaseline["theme"] = null;

  try {
    const data = await execute<ShopIdentityData>(SHOP_IDENTITY_QUERY);
    shopIdentity = data.shop;
    modules.shopIdentity = { status: "complete", requests: 1 };
  } catch (error) {
    modules.shopIdentity = failedModule(error, 1);
  }

  const productScopeMissing = missingScopes(scopes, ["read_products"]);
  if (productScopeMissing.length) {
    modules.counts = { status: "blocked_missing_scope", missingScopes: productScopeMissing, requests: 0 };
    modules.priorityProducts = {
      status: "blocked_missing_scope",
      missingScopes: productScopeMissing,
      requests: 0,
    };
  } else {
    try {
      counts = await execute<CountsData>(COUNTS_QUERY);
      modules.counts = { status: "complete", requests: 1 };
    } catch (error) {
      modules.counts = failedModule(error, 1);
    }

    let priorityRequests = 0;
    try {
      for (const requestedHandle of LARA_PRIORITY_PRODUCT_HANDLES) {
        const data = await execute<PriorityProductData>(PRIORITY_PRODUCT_QUERY, {
          handle: requestedHandle,
        });
        priorityRequests += 1;
        const product = data.product;
        if (!product) {
          priorityProducts.push({ requestedHandle, found: false });
          continue;
        }
        const summary = await priorityProductSummary(product);
        priorityProducts.push({
          requestedHandle,
          found: true,
          ...summary,
        });
        if (!summary.variantsComplete || !summary.mediaComplete) {
          throw Object.assign(new Error("A priority product exceeded a collection cap."), {
            code: "priority_product_cap",
          });
        }
      }
      modules.priorityProducts = { status: "complete", requests: priorityRequests };
    } catch (error) {
      modules.priorityProducts = failedModule(error, Math.max(priorityRequests, 1));
    }
  }

  const policyScopeMissing = missingScopes(scopes, ["read_legal_policies"]);
  if (policyScopeMissing.length) {
    modules.policies = { status: "blocked_missing_scope", missingScopes: policyScopeMissing, requests: 0 };
  } else {
    try {
      const data = await execute<PoliciesData>(POLICIES_QUERY);
      for (const policy of data.shop.shopPolicies) policies.push(await policySummary(policy));
      modules.policies = { status: "complete", requests: 1 };
    } catch (error) {
      modules.policies = failedModule(error, 1);
    }
  }

  // Shopify allows Page reads through either the broad content grant or the
  // page-specific grant. Requiring one fixed handle would incorrectly mark a
  // fully authorised module as blocked.
  const pageScopeMissing = missingAlternativeScopes(scopes, [
    "read_content",
    "read_online_store_pages",
  ]);
  if (pageScopeMissing.length) {
    modules.pages = { status: "blocked_missing_scope", missingScopes: pageScopeMissing, requests: 0 };
  } else {
    try {
      const result = await collectPaginated<PagesData, PageNode>({
        execute,
        document: PAGES_QUERY,
        connection: (data) => data.pages,
      });
      pages.push(...result.nodes.map(publicPageSummary));
      modules.pages = { status: "complete", requests: result.requests };
    } catch (error) {
      modules.pages = failedModule(error, 1);
    }
  }

  const menuScopeMissing = missingScopes(scopes, ["read_online_store_navigation"]);
  if (menuScopeMissing.length) {
    modules.menus = { status: "blocked_missing_scope", missingScopes: menuScopeMissing, requests: 0 };
  } else {
    try {
      const result = await collectPaginated<MenusData, MenusData["menus"]["nodes"][number]>({
        execute,
        document: MENUS_QUERY,
        connection: (data) => data.menus,
      });
      menus.push(
        ...result.nodes.map((menu) => ({
          ...menu,
          items: menu.items.map(sanitizeMenuItem),
        })),
      );
      modules.menus = { status: "complete", requests: result.requests };
    } catch (error) {
      modules.menus = failedModule(error, 1);
    }
  }

  const themeScopeMissing = missingScopes(scopes, ["read_themes"]);
  if (themeScopeMissing.length) {
    modules.theme = { status: "blocked_missing_scope", missingScopes: themeScopeMissing, requests: 0 };
  } else {
    let themeRequests = 0;
    try {
      const themeData = await execute<MainThemeData>(MAIN_THEME_QUERY);
      themeRequests += 1;
      if (themeData.themes.nodes.length !== 1) {
        throw Object.assign(new Error("Expected exactly one main theme."), { code: "main_theme_count" });
      }
      const main = themeData.themes.nodes[0];
      const files: ThemeFileMetadata[] = [];
      let after: string | null = null;
      let filesComplete = false;
      for (;;) {
        if (themeRequests >= MAX_THEME_REQUESTS) {
          throw Object.assign(new Error("Theme page cap reached."), { code: "theme_page_cap" });
        }
        const data: ThemeFilesData = await execute<ThemeFilesData>(THEME_FILES_QUERY, {
          themeId: main.id,
          after,
        });
        themeRequests += 1;
        if (!data.theme) throw Object.assign(new Error("Main theme disappeared."), { code: "theme_missing" });
        if (data.theme.files.userErrors.length > 0) {
          throw Object.assign(new Error("Shopify could not enumerate every theme file."), {
            code: "theme_file_user_errors",
          });
        }
        files.push(...data.theme.files.nodes);
        if (files.length > MAX_THEME_FILES) {
          throw Object.assign(new Error("Theme file cap reached."), { code: "theme_file_cap" });
        }
        if (!data.theme.files.pageInfo.hasNextPage) {
          filesComplete = true;
          break;
        }
        const next: string | null = data.theme.files.pageInfo.endCursor;
        if (!next || next === after) {
          throw Object.assign(new Error("Invalid theme cursor."), { code: "invalid_theme_cursor" });
        }
        after = next;
      }

      const candidates = themeSourceCandidates(files);
      const matches: NonNullable<ShopifyAuditBaseline["theme"]>["sourceScan"]["matches"] = [];
      const urlBodiesSkipped: string[] = [];
      let scannedCount = 0;
      for (let offset = 0; offset < candidates.length; offset += SOURCE_BATCH_SIZE) {
        if (themeRequests >= MAX_THEME_REQUESTS) {
          throw Object.assign(new Error("Theme request cap reached."), {
            code: "theme_request_cap",
          });
        }
        const batch = candidates.slice(offset, offset + SOURCE_BATCH_SIZE);
        const data = await execute<ThemeBodiesData>(THEME_BODIES_QUERY, {
          themeId: main.id,
          filenames: batch.map((file) => file.filename),
        });
        themeRequests += 1;
        if (!data.theme) throw Object.assign(new Error("Main theme disappeared."), { code: "theme_missing" });
        if (data.theme.files.userErrors.length > 0) {
          throw Object.assign(new Error("Shopify could not read every selected theme file."), {
            code: "theme_body_user_errors",
          });
        }
        const requestedFilenames = new Set(batch.map((file) => file.filename));
        const returnedFilenames = data.theme.files.nodes.map((file) => file.filename);
        if (
          new Set(returnedFilenames).size !== requestedFilenames.size ||
          returnedFilenames.some((filename) => !requestedFilenames.has(filename))
        ) {
          throw Object.assign(new Error("Shopify omitted a selected theme file body."), {
            code: "theme_body_incomplete",
          });
        }
        for (const file of data.theme.files.nodes) {
          const source = bodyText(file.body);
          if (source === null) {
            if (file.body.__typename === "OnlineStoreThemeFileBodyUrl") {
              urlBodiesSkipped.push(file.filename);
            }
            continue;
          }
          scannedCount += 1;
          const markers = AUDIT_THEME_SOURCE_TOKENS.flatMap((marker) => {
            return sourceContainsMarker(source, marker) ? [{ marker }] : [];
          });
          if (markers.length) {
            matches.push({
              filename: file.filename,
              checksumMd5: file.checksumMd5,
              updatedAt: file.updatedAt,
              markers,
            });
          }
        }
      }

      theme = {
        ...main,
        fileCount: files.length,
        filesComplete,
        files,
        sourceScan: {
          candidateCount: candidates.length,
          scannedCount,
          scanComplete:
            filesComplete &&
            candidates.length < MAX_THEME_SOURCE_FILES &&
            scannedCount + urlBodiesSkipped.length === candidates.length &&
            urlBodiesSkipped.length === 0,
          urlBodiesSkipped,
          matches,
        },
      };
      modules.theme = { status: "complete", requests: themeRequests };
    } catch (error) {
      modules.theme = failedModule(error, Math.max(themeRequests, 1));
    }
  }

  const completionIssues = Object.entries(modules).flatMap(([name, module]) =>
    module.status === "complete" ? [] : [`module:${name}:${module.status}`],
  );
  if (theme && !theme.sourceScan.scanComplete) {
    completionIssues.push("theme:source_scan_incomplete");
  }
  if (
    priorityProducts.length !== LARA_PRIORITY_PRODUCT_HANDLES.length ||
    priorityProducts.some((product) => !product.found)
  ) {
    completionIssues.push("priority_products:missing_or_incomplete");
  }

  if (
    counts &&
    [counts.productsCount, counts.productVariantsCount, counts.collectionsCount].some(
      (count) => count.precision !== "EXACT",
    )
  ) {
    completionIssues.push("counts:non_exact");
  }

  return deeplySanitize({
    schemaVersion: "shopify-audit-baseline-v2",
    auditStatus: completionIssues.length === 0 ? "complete" : "partial",
    completionIssues: [...new Set(completionIssues)].sort(),
    generatedAt: now().toISOString(),
    queryManifestSha256: await auditBaselineManifestSha256(),
    modules,
    shopIdentity,
    counts,
    policies,
    pages,
    menus,
    priorityProducts,
    theme,
  });
}
