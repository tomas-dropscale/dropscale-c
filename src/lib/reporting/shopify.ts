import "server-only";

import {
  exchangeReportingClientCredentials,
  normalizeReportingShopDomain,
  reportingShopifyGraphql,
  verifyReportingShop,
} from "../client-onboarding/shopify";
import { decryptToken } from "../google-ads/crypto";
import { fxDailyRates, rateOn } from "../shopify/fx";
import type { CanonicalReportingSource } from "./sources";
import {
  fetchCollectionProductKeys,
  fetchDailySales,
  resolveAdminToken,
  type ShopifyGraphqlExecutor,
} from "../shopify/client";

export type ShopifyReportingAdapterErrorCode =
  | "invalid_source"
  | "credential_decrypt_failed"
  | "identity_mismatch"
  | "currency_mismatch"
  | "missing_scope"
  | "invalid_response";

export class ShopifyReportingAdapterError extends Error {
  constructor(
    readonly code: ShopifyReportingAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ShopifyReportingAdapterError";
  }
}

export type ShopifyReportingAdapter = {
  fetchDailySales: (
    from: string,
    to: string,
  ) => ReturnType<typeof fetchDailySales>;
  fetchCollectionProductKeys: (
    handle: string,
  ) => ReturnType<typeof fetchCollectionProductKeys>;
  fetchFunnel: (
    from: string,
    to: string,
  ) => Promise<ShopifyFunnelDay[]>;
  fetchFunnelSeries: (
    from: string,
    to: string,
  ) => Promise<ShopifyFunnelSeries>;
  fetchCampaignAttribution: (
    from: string,
    to: string,
    targetCurrency?: string,
  ) => Promise<ShopifyCampaignAttribution[]>;
  fetchCampaignAttributionSeries: (
    from: string,
    to: string,
    targetCurrency?: string,
  ) => Promise<ShopifyCampaignAttributionSeriesRow[]>;
  fetchCampaignProducts: (
    from: string,
    to: string,
  ) => Promise<ShopifyCampaignProductAttribution[]>;
  fetchCampaignProductSeries: (
    from: string,
    to: string,
  ) => Promise<ShopifyCampaignProductSeriesRow[]>;
  fetchCollectionSales: (
    from: string,
    to: string,
    targetCurrency?: string,
  ) => Promise<ShopifyCollectionSales[]>;
  fetchCollectionSalesSeries: (
    from: string,
    to: string,
    targetCurrency?: string,
  ) => Promise<ShopifyCollectionSalesSeriesRow[]>;
};

export type LegacyShopifyReportingSource = {
  clientId: string;
  adAccountId: string;
  shopDomain: string;
  currency: string;
  shopifyClientId: string | null;
  credentialCiphertext: string;
};

export type ShopifyFunnelDay = {
  day: string;
  sessions: number;
  addedToCart: number;
  reachedCheckout: number;
  completedCheckout: number;
};

export type ShopifyGranularity = "hour" | "day";

export type ShopifyFunnelPoint = ShopifyFunnelDay & { bucket: string };

export type ShopifyFunnelSeries = {
  granularity: ShopifyGranularity;
  points: ShopifyFunnelPoint[];
};

export type ShopifyCampaignAttribution = {
  /** Exact numeric utm_campaign value, not Shopify's unrelated campaign_id. */
  campaignId: string;
  attributionModel: "last_non_direct_click";
  sessions: number | null;
  orders: number | null;
  revenue: number | null;
};

export type ShopifyCampaignAttributionPoint = {
  bucket: string;
  sessions: number | null;
  orders: number | null;
  revenue: number | null;
};

export type ShopifyCampaignAttributionSeriesRow = ShopifyCampaignAttribution & {
  timeline: ShopifyCampaignAttributionPoint[];
};

export type ShopifyCampaignProductAttribution = {
  /** Exact numeric utm_campaign value paired with Google's referring platform. */
  campaignId: string;
  productId: string;
  title: string;
  attributionModel: "last_non_direct_click";
  /** Net units after returns, so this may legitimately be negative. */
  units: number;
};

export type ShopifyCampaignProductSeriesRow = ShopifyCampaignProductAttribution & {
  timeline: Array<{ bucket: string; units: number }>;
};

export type ShopifyCollectionProductSales = {
  productId: string;
  title: string;
  revenue: number;
  units: number;
};

export type ShopifyCollectionProductSalesSeriesRow = ShopifyCollectionProductSales & {
  timeline: Array<{ bucket: string; revenue: number; units: number }>;
};

export type ShopifyCollectionSales = {
  collectionId: string;
  title: string;
  revenue: number;
  units: number;
  products: ShopifyCollectionProductSales[];
};

export type ShopifyCollectionSalesSeriesRow = Omit<ShopifyCollectionSales, "products"> & {
  handle: string | null;
  timeline: Array<{ bucket: string; revenue: number; units: number }>;
  products: ShopifyCollectionProductSalesSeriesRow[];
};

type ShopifyQlColumn = {
  name: string;
  dataType?: string | null;
  displayName?: string | null;
};

type ShopifyQlResponse = {
  shopifyqlQuery: {
    tableData: {
      columns: ShopifyQlColumn[];
      rows: unknown[];
    } | null;
    parseErrors: unknown;
  } | null;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHOPIFYQL_ROW_LIMIT = 1000;
const PRODUCT_NODE_PAGE_SIZE = 250;
const SHOPIFYQL_QUERY = `#graphql
  query DropscaleStoreAnalytics($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData {
        columns { name dataType displayName }
        rows
      }
      parseErrors
    }
  }
`;

function invalidResponse(message: string): never {
  throw new ShopifyReportingAdapterError("invalid_response", message);
}

function validDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateRange(from: string, to: string) {
  if (!validDay(from) || !validDay(to) || from > to) {
    throw new ShopifyReportingAdapterError(
      "invalid_source",
      "The Shopify reporting range is invalid.",
    );
  }
}

function inclusiveDays(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const last = Date.parse(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function requireScopes(granted: ReadonlySet<string>, required: string[]) {
  if (required.some((scope) => !granted.has(scope))) {
    throw new ShopifyReportingAdapterError(
      "missing_scope",
      `Shopify has not granted ${required.join(" and ")}.`,
    );
  }
}

function tableRows(response: ShopifyQlResponse): Array<Record<string, unknown>> {
  const report = response.shopifyqlQuery;
  if (!report) invalidResponse("Shopify returned no analytics report.");
  const parseErrors = report.parseErrors;
  if (
    (Array.isArray(parseErrors) && parseErrors.length > 0) ||
    (!Array.isArray(parseErrors) && parseErrors != null)
  ) {
    invalidResponse("Shopify rejected the analytics query.");
  }
  const table = report.tableData;
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    invalidResponse("Shopify returned an invalid analytics table.");
  }
  const names = table.columns.map((column) => column?.name);
  if (names.some((name) => typeof name !== "string" || !name.trim())) {
    invalidResponse("Shopify returned invalid analytics columns.");
  }
  return table.rows.map((row) => {
    if (Array.isArray(row)) {
      if (row.length !== names.length) {
        invalidResponse("Shopify returned an invalid analytics row.");
      }
      return Object.fromEntries(names.map((name, index) => [name, row[index]]));
    }
    if (!row || typeof row !== "object") {
      invalidResponse("Shopify returned an invalid analytics row.");
    }
    return row as Record<string, unknown>;
  });
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalidResponse(`Shopify returned an invalid ${field}.`);
  }
  return parsed;
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isSafeInteger(parsed)) {
    invalidResponse(`Shopify returned an invalid ${field}.`);
  }
  return parsed;
}

function exactGoogleCampaign(row: Record<string, unknown>): string | null {
  const platform = typeof row.referring_platform === "string"
    ? row.referring_platform.trim().toLowerCase()
    : "";
  // UTM values are strings by contract. Coercing a JSON number could silently
  // lose precision before identity validation.
  const utmCampaign = typeof row.utm_campaign === "string"
    ? row.utm_campaign.trim()
    : "";
  return platform === "google" && /^\d{1,30}$/.test(utmCampaign)
    ? utmCampaign
    : null;
}

function finiteMoney(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) {
    invalidResponse(`Shopify returned an invalid ${field}.`);
  }
  return parsed;
}

function rowDay(value: unknown, from: string, to: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  const day = text.slice(0, 10);
  if (!validDay(day) || day < from || day > to) {
    invalidResponse("Shopify returned a reporting day outside the selected range.");
  }
  return day;
}

function reportingGranularity(from: string, to: string): ShopifyGranularity {
  return from === to ? "hour" : "day";
}

function reportingBucket(
  row: Record<string, unknown>,
  from: string,
  to: string,
  timeZone: string,
): { bucket: string; day: string } {
  if (from !== to) {
    const day = rowDay(row.day, from, to);
    return { bucket: day, day };
  }
  const value = typeof row.hour === "string" ? row.hour.trim() : "";
  const timestamp = Date.parse(value);
  if (!value || !Number.isFinite(timestamp)) {
    invalidResponse("Shopify returned an invalid reporting hour.");
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(timestamp);
  } catch {
    invalidResponse("Shopify returned an invalid reporting time zone.");
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  const hour = part("hour");
  if (day !== from || !/^\d{2}$/.test(hour)) {
    invalidResponse("Shopify returned a reporting hour outside the selected range.");
  }
  return { bucket: `${day}T${hour}:00:00`, day };
}

function timelineClause(from: string, to: string): string {
  return from === to ? "GROUP BY hour" : "TIMESERIES day";
}

function timelineOrder(from: string, to: string): string {
  return from === to ? "hour" : "day";
}

function productGid(value: unknown): string | null {
  if (value == null || value === "") return null;
  const text = typeof value === "number"
    ? Number.isSafeInteger(value) && value > 0
      ? String(value)
      : ""
    : typeof value === "string"
      ? value.trim()
      : "";
  const match = /^(?:gid:\/\/shopify\/Product\/)?(\d{1,30})$/.exec(text);
  return match ? `gid://shopify/Product/${match[1]}` : null;
}

function invalidSource(): never {
  throw new ShopifyReportingAdapterError(
    "invalid_source",
    "The reporting source is not a canonical Shopify anchor.",
  );
}

function validatedShopifyAnchor(source: CanonicalReportingSource) {
  const shopify = source.shopify;
  const credential = shopify?.credential;
  if (
    !shopify ||
    !credential ||
    source.kind === "google_ads" ||
    source.group.id !== source.bindingId ||
    source.group.shopifyAnchorBindingId !== source.bindingId ||
    source.group.shopifyAnchorAdAccountId !== source.adAccountId ||
    ![
      source.bindingId,
      source.clientId,
      source.adAccountId,
      shopify.connectionId,
      shopify.shopId,
      shopify.shopifyName,
      shopify.domain,
      shopify.currency,
      credential.shopifyClientId,
      credential.clientSecretCiphertext,
    ].every((value) => value.length > 0 && value === value.trim()) ||
    !/^gid:\/\/shopify\/Shop\/\d+$/.test(shopify.shopId)
  ) {
    invalidSource();
  }

  try {
    if (normalizeReportingShopDomain(shopify.domain) !== shopify.domain) {
      invalidSource();
    }
  } catch {
    invalidSource();
  }
  return { shopify, credential };
}

function currency(value: string | null): string {
  if (!value || !/^[A-Z]{3}$/.test(value)) {
    throw new ShopifyReportingAdapterError(
      "currency_mismatch",
      "Shopify returned an invalid store currency.",
    );
  }
  return value;
}

async function fetchShopifyQlRows(
  shopDomain: string,
  accessToken: string,
  query: string,
  graphql: ShopifyGraphqlExecutor,
): Promise<Array<Record<string, unknown>>> {
  const response = await graphql<ShopifyQlResponse>(
    shopDomain,
    accessToken,
    SHOPIFYQL_QUERY,
    { query },
  );
  return tableRows(response);
}

function splitRange(from: string, to: string): { leftTo: string; rightFrom: string } {
  const dayMs = 86_400_000;
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  const dayCount = Math.round((toMs - fromMs) / dayMs) + 1;
  const leftDayCount = Math.ceil(dayCount / 2);
  return {
    leftTo: new Date(fromMs + (leftDayCount - 1) * dayMs).toISOString().slice(0, 10),
    rightFrom: new Date(fromMs + leftDayCount * dayMs).toISOString().slice(0, 10),
  };
}

async function fetchBoundedShopifyQlRows(
  shopDomain: string,
  accessToken: string,
  from: string,
  to: string,
  queryForRange: (chunkFrom: string, chunkTo: string) => string,
  overflowMessage: string,
  graphql: ShopifyGraphqlExecutor,
): Promise<Array<Record<string, unknown>>> {
  const rows = await fetchShopifyQlRows(
    shopDomain,
    accessToken,
    queryForRange(from, to),
    graphql,
  );
  if (rows.length < SHOPIFYQL_ROW_LIMIT) return rows;
  if (from === to) invalidResponse(overflowMessage);

  const { leftTo, rightFrom } = splitRange(from, to);
  const left = await fetchBoundedShopifyQlRows(
    shopDomain,
    accessToken,
    from,
    leftTo,
    queryForRange,
    overflowMessage,
    graphql,
  );
  const right = await fetchBoundedShopifyQlRows(
    shopDomain,
    accessToken,
    rightFrom,
    to,
    queryForRange,
    overflowMessage,
    graphql,
  );
  return [...left, ...right];
}

async function fetchCollectionSalesSeries(
  shopDomain: string,
  accessToken: string,
  expectedCurrency: string,
  targetCurrency: string,
  from: string,
  to: string,
  graphql: ShopifyGraphqlExecutor,
): Promise<ShopifyCollectionSalesSeriesRow[]> {
  type CollectionProductsResponse = {
    nodes: Array<
      | {
          __typename: "Product";
          id: string;
          title: string;
          collections: {
            pageInfo: { hasNextPage: boolean };
            nodes: Array<{ id: string; title: string; handle?: string }>;
          };
        }
      | { __typename: string }
      | null
    >;
  };

  // Collection sales always report on Shopify's daily grain, including
  // single-day ranges. Unlike the funnel and campaign families, this family
  // has no hourly mode: membership is joined onto whole reporting days.
  const rows = await fetchBoundedShopifyQlRows(
    shopDomain,
    accessToken,
    from,
    to,
    (chunkFrom, chunkTo) => `FROM sales
SHOW net_sales, net_items_sold
GROUP BY product_id
TIMESERIES day
SINCE ${chunkFrom}
UNTIL ${chunkTo}
ORDER BY day ASC
LIMIT ${SHOPIFYQL_ROW_LIMIT}`,
    "A single reporting day has too many product sales rows for an exact report.",
    graphql,
  );

  const rates = expectedCurrency === targetCurrency || rows.length === 0
    ? null
    : await fxDailyRates(expectedCurrency, targetCurrency, from, to);
  const productSales = new Map<
    string,
    {
      revenue: number;
      units: number;
      timeline: Map<string, { bucket: string; revenue: number; units: number }>;
    }
  >();
  for (const row of rows) {
    const day = rowDay(row.day, from, to);
    const bucket = day;
    const productId = productGid(row.product_id);
    if (row.product_id != null && row.product_id !== "" && !productId) {
      invalidResponse("Shopify returned an invalid product identity in its sales report.");
    }
    // Sales without a Product identity cannot belong to an official Product
    // collection, but their reporting day and identity shape are still checked.
    if (!productId) continue;
    const nativeRevenue = finiteMoney(row.net_sales, "product net sales");
    const units = integer(row.net_items_sold, "product net items sold");
    const revenue = nativeRevenue * (rates ? rateOn(rates, day) : 1);
    const current = productSales.get(productId) ?? {
      revenue: 0,
      units: 0,
      timeline: new Map(),
    };
    current.revenue += revenue;
    current.units += units;
    const point = current.timeline.get(bucket) ?? { bucket, revenue: 0, units: 0 };
    point.revenue += revenue;
    point.units += units;
    current.timeline.set(bucket, point);
    if (!Number.isFinite(current.revenue) || !Number.isSafeInteger(current.units)) {
      invalidResponse("Shopify returned invalid product sales totals.");
    }
    productSales.set(productId, current);
  }

  const productMembership = new Map<
    string,
    {
      title: string;
      collections: Array<{ id: string; title: string; handle: string | null }>;
    }
  >();
  // Products that sold inside the range but were deleted from the store
  // afterwards resolve to null nodes. That is routine catalog churn, not a
  // malformed response: the store's current official collection membership no
  // longer contains them, so their sales silently leave the by-collection
  // attribution instead of failing the whole report.
  const deletedProductIds = new Set<string>();
  const productIds = [...productSales.keys()];
  for (let start = 0; start < productIds.length; start += PRODUCT_NODE_PAGE_SIZE) {
    const ids = productIds.slice(start, start + PRODUCT_NODE_PAGE_SIZE);
    const data = await graphql<CollectionProductsResponse>(
      shopDomain,
      accessToken,
      `#graphql
        query DropscaleCollectionProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            __typename
            ... on Product {
              id
              title
              collections(first: 100) {
                pageInfo { hasNextPage }
                nodes { id title handle }
              }
            }
          }
        }
      `,
      { ids },
    );
    if (!Array.isArray(data.nodes) || data.nodes.length !== ids.length) {
      invalidResponse("Shopify returned incomplete product collection membership.");
    }
    for (let index = 0; index < data.nodes.length; index += 1) {
      const node = data.nodes[index];
      if (node === null) {
        // nodes() preserves request order, so a null at this position names
        // exactly the requested product that no longer exists.
        deletedProductIds.add(ids[index]);
        continue;
      }
      if (
        !node ||
        node.__typename !== "Product" ||
        !("id" in node) ||
        !ids.includes(node.id) ||
        !/^gid:\/\/shopify\/Product\/\d+$/.test(node.id) ||
        !node.title.trim() ||
        node.title.length > 500 ||
        node.collections.pageInfo.hasNextPage ||
        productMembership.has(node.id)
      ) {
        invalidResponse("Shopify returned incomplete product collection membership.");
      }
      const seenCollections = new Set<string>();
      const memberships = node.collections.nodes.map((collection) => {
        const title = collection.title.trim();
        const handle = typeof collection.handle === "string"
          ? collection.handle.trim().toLowerCase()
          : null;
        if (
          !/^gid:\/\/shopify\/Collection\/\d+$/.test(collection.id) ||
          !title ||
          title.length > 500 ||
          (handle !== null && !/^[a-z0-9][a-z0-9-]*$/.test(handle)) ||
          seenCollections.has(collection.id)
        ) {
          invalidResponse("Shopify returned invalid collection identity.");
        }
        seenCollections.add(collection.id);
        return { id: collection.id, title, handle };
      });
      productMembership.set(node.id, {
        title: node.title.trim(),
        collections: memberships,
      });
    }
    if (ids.some((id) => !productMembership.has(id) && !deletedProductIds.has(id))) {
      invalidResponse("Shopify returned incomplete product collection membership.");
    }
  }

  const collections = new Map<
    string,
    {
      title: string;
      handle: string | null;
      revenue: number;
      units: number;
      timeline: Map<string, { bucket: string; revenue: number; units: number }>;
      products: Map<string, ShopifyCollectionProductSalesSeriesRow>;
    }
  >();
  for (const [productId, sales] of productSales) {
    const product = productMembership.get(productId);
    if (!product) {
      if (deletedProductIds.has(productId)) continue;
      invalidResponse("Shopify returned incomplete product collection membership.");
    }
    for (const collection of product.collections) {
      const current = collections.get(collection.id) ?? {
        title: collection.title,
        handle: collection.handle,
        revenue: 0,
        units: 0,
        timeline: new Map(),
        products: new Map<string, ShopifyCollectionProductSalesSeriesRow>(),
      };
      if (current.title !== collection.title || current.handle !== collection.handle) {
        invalidResponse("Shopify returned conflicting collection identity.");
      }
      current.products.set(productId, {
        productId,
        title: product.title,
        revenue: sales.revenue,
        units: sales.units,
        timeline: [...sales.timeline.values()].sort((left, right) =>
          left.bucket.localeCompare(right.bucket)),
      });
      current.revenue += sales.revenue;
      current.units += sales.units;
      for (const productPoint of sales.timeline.values()) {
        const point = current.timeline.get(productPoint.bucket) ?? {
          bucket: productPoint.bucket,
          revenue: 0,
          units: 0,
        };
        point.revenue += productPoint.revenue;
        point.units += productPoint.units;
        current.timeline.set(point.bucket, point);
      }
      if (!Number.isFinite(current.revenue) || !Number.isSafeInteger(current.units)) {
        invalidResponse("Shopify returned invalid collection sales totals.");
      }
      collections.set(collection.id, current);
    }
  }

  return [...collections.entries()]
    .map(([collectionId, value]) => ({
      collectionId,
      title: value.title,
      handle: value.handle,
      revenue: value.revenue,
      units: value.units,
      timeline: [...value.timeline.values()].sort((left, right) =>
        left.bucket.localeCompare(right.bucket)),
      products: [...value.products.values()].sort(
        (left, right) => right.revenue - left.revenue || left.title.localeCompare(right.title),
      ),
    }))
    .sort((left, right) => right.revenue - left.revenue || left.title.localeCompare(right.title));
}

function boundAdapter({
  shopDomain,
  accessToken,
  verifiedCurrency,
  verifiedTimeZone,
  grantedScopes,
}: {
  shopDomain: string;
  accessToken: string;
  verifiedCurrency: string;
  verifiedTimeZone: string;
  grantedScopes: string[];
}): ShopifyReportingAdapter {
  const granted = new Set(grantedScopes);
  const graphql: ShopifyGraphqlExecutor = (domain, token, query, variables) => {
    if (domain !== shopDomain || token !== accessToken) invalidSource();
    return reportingShopifyGraphql({
      shopDomain: domain,
      accessToken: token,
      query,
      variables,
    });
  };

  return {
    async fetchDailySales(from, to) {
      validateRange(from, to);
      requireScopes(granted, ["read_orders"]);
      const result = await fetchDailySales(
        shopDomain,
        accessToken,
        from,
        to,
        graphql,
      );
      if (currency(result.currency) !== verifiedCurrency) {
        throw new ShopifyReportingAdapterError(
          "currency_mismatch",
          "Shopify changed the reporting currency for this store.",
        );
      }
      return result;
    },
    fetchCollectionProductKeys(handle) {
      return fetchCollectionProductKeys(
        shopDomain,
        accessToken,
        handle,
        graphql,
      );
    },
    async fetchFunnel(from, to) {
      validateRange(from, to);
      requireScopes(granted, ["read_reports"]);
      const rows = await fetchBoundedShopifyQlRows(
        shopDomain,
        accessToken,
        from,
        to,
        (chunkFrom, chunkTo) => `FROM sessions
SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout
WHERE human_or_bot_session = 'human'
TIMESERIES day
SINCE ${chunkFrom}
UNTIL ${chunkTo}
ORDER BY day ASC
LIMIT ${SHOPIFYQL_ROW_LIMIT}`,
        "A single reporting day has too many funnel rows for an exact report.",
        graphql,
      );
      const byDay = new Map<string, ShopifyFunnelDay>();
      for (const row of rows) {
        const day = rowDay(row.day, from, to);
        if (byDay.has(day)) invalidResponse("Shopify returned duplicate funnel days.");
        byDay.set(day, {
          day,
          sessions: nonNegativeInteger(row.sessions, "sessions"),
          addedToCart: nonNegativeInteger(
            row.sessions_with_cart_additions,
            "sessions with cart additions",
          ),
          reachedCheckout: nonNegativeInteger(
            row.sessions_that_reached_checkout,
            "sessions that reached checkout",
          ),
          completedCheckout: nonNegativeInteger(
            row.sessions_that_completed_checkout,
            "sessions that completed checkout",
          ),
        });
      }
      return inclusiveDays(from, to).map((day) => byDay.get(day) ?? {
        day,
        sessions: 0,
        addedToCart: 0,
        reachedCheckout: 0,
        completedCheckout: 0,
      });
    },
    async fetchFunnelSeries(from, to) {
      validateRange(from, to);
      requireScopes(granted, ["read_reports"]);
      const granularity = reportingGranularity(from, to);
      const rows = await fetchBoundedShopifyQlRows(
        shopDomain,
        accessToken,
        from,
        to,
        (chunkFrom, chunkTo) => `FROM sessions
SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout
WHERE human_or_bot_session = 'human'
${timelineClause(from, to)}
SINCE ${chunkFrom}
UNTIL ${chunkTo}
ORDER BY ${timelineOrder(from, to)} ASC
LIMIT ${SHOPIFYQL_ROW_LIMIT}`,
        "A single reporting day has too many funnel rows for an exact report.",
        graphql,
      );
      const byBucket = new Map<string, ShopifyFunnelPoint>();
      for (const row of rows) {
        const { bucket, day } = reportingBucket(row, from, to, verifiedTimeZone);
        if (byBucket.has(bucket)) invalidResponse("Shopify returned duplicate funnel buckets.");
        byBucket.set(bucket, {
          bucket,
          day,
          sessions: nonNegativeInteger(row.sessions, "sessions"),
          addedToCart: nonNegativeInteger(row.sessions_with_cart_additions, "sessions with cart additions"),
          reachedCheckout: nonNegativeInteger(row.sessions_that_reached_checkout, "sessions that reached checkout"),
          completedCheckout: nonNegativeInteger(row.sessions_that_completed_checkout, "sessions that completed checkout"),
        });
      }
      const buckets = granularity === "hour"
        ? Array.from({ length: 24 }, (_, hour) => `${from}T${String(hour).padStart(2, "0")}:00:00`)
        : inclusiveDays(from, to);
      return {
        granularity,
        points: buckets.map((bucket) => byBucket.get(bucket) ?? {
          bucket,
          day: bucket.slice(0, 10),
          sessions: 0,
          addedToCart: 0,
          reachedCheckout: 0,
          completedCheckout: 0,
        }),
      };
    },
    async fetchCampaignAttribution(from, to, targetCurrency = verifiedCurrency) {
      validateRange(from, to);
      requireScopes(granted, ["read_reports"]);
      const reportingCurrency = currency(targetCurrency);
      const [salesRows, sessionRows] = await Promise.all([
        fetchBoundedShopifyQlRows(
          shopDomain,
          accessToken,
          from,
          to,
          (chunkFrom, chunkTo) => `FROM campaign_sales
SHOW campaign_last_non_direct_click_total_sales, campaign_last_non_direct_click_order_count
GROUP BY utm_campaign, referring_platform
TIMESERIES day
SINCE ${chunkFrom}
UNTIL ${chunkTo}
ORDER BY day ASC
LIMIT ${SHOPIFYQL_ROW_LIMIT}`,
          "A single reporting day has too many campaign sales rows for an exact report.",
          graphql,
        ),
        fetchBoundedShopifyQlRows(
          shopDomain,
          accessToken,
          from,
          to,
          (chunkFrom, chunkTo) => `FROM campaign_sessions
SHOW campaign_sessions
GROUP BY utm_campaign, referring_platform
TIMESERIES day
SINCE ${chunkFrom}
UNTIL ${chunkTo}
ORDER BY day ASC
LIMIT ${SHOPIFYQL_ROW_LIMIT}`,
          "A single reporting day has too many campaign session rows for an exact report.",
          graphql,
        ),
      ]);
      const rates = verifiedCurrency === reportingCurrency || salesRows.length === 0
        ? null
        : await fxDailyRates(verifiedCurrency, reportingCurrency, from, to);
      const byCampaign = new Map<string, ShopifyCampaignAttribution>();
      for (const row of salesRows) {
        const day = rowDay(row.day, from, to);
        const campaignId = exactGoogleCampaign(row);
        if (!campaignId) continue;
        const current = byCampaign.get(campaignId) ?? {
          campaignId,
          attributionModel: "last_non_direct_click",
          sessions: null,
          orders: null,
          revenue: null,
        };
        const nativeRevenue = finiteMoney(
          row.campaign_last_non_direct_click_total_sales,
          "campaign revenue",
        );
        current.revenue = (current.revenue ?? 0) +
          nativeRevenue * (rates ? rateOn(rates, day) : 1);
        current.orders = (current.orders ?? 0) + nonNegativeInteger(
          row.campaign_last_non_direct_click_order_count,
          "campaign orders",
        );
        byCampaign.set(campaignId, current);
      }
      for (const row of sessionRows) {
        rowDay(row.day, from, to);
        const campaignId = exactGoogleCampaign(row);
        if (!campaignId) continue;
        const current = byCampaign.get(campaignId) ?? {
          campaignId,
          attributionModel: "last_non_direct_click",
          sessions: null,
          orders: null,
          revenue: null,
        };
        current.sessions = (current.sessions ?? 0) + nonNegativeInteger(
          row.campaign_sessions,
          "campaign sessions",
        );
        byCampaign.set(campaignId, current);
      }
      return [...byCampaign.values()].sort((left, right) =>
        (right.revenue ?? -Infinity) - (left.revenue ?? -Infinity) ||
        left.campaignId.localeCompare(right.campaignId));
    },
    async fetchCampaignAttributionSeries(from, to, targetCurrency = verifiedCurrency) {
      validateRange(from, to);
      requireScopes(granted, ["read_reports"]);
      const q = (dataset: string, fields: string, a: string, b: string) => `FROM ${dataset}
SHOW ${fields}
GROUP BY utm_campaign, referring_platform${from === to ? ", hour" : ""}
${from === to ? "" : "TIMESERIES day"}
SINCE ${a}
UNTIL ${b}
ORDER BY ${timelineOrder(from, to)} ASC
LIMIT ${SHOPIFYQL_ROW_LIMIT}`;
      const [salesRows, sessionRows] = await Promise.all([
        fetchBoundedShopifyQlRows(
          shopDomain, accessToken, from, to,
          (a, b) => q("campaign_sales", "campaign_last_non_direct_click_total_sales, campaign_last_non_direct_click_order_count", a, b),
          "A single reporting day has too many campaign sales rows for an exact report.", graphql,
        ),
        fetchBoundedShopifyQlRows(
          shopDomain, accessToken, from, to,
          (a, b) => q("campaign_sessions", "campaign_sessions", a, b),
          "A single reporting day has too many campaign session rows for an exact report.", graphql,
        ),
      ]);
      const reportingCurrency = currency(targetCurrency);
      const rates = verifiedCurrency === reportingCurrency || salesRows.length === 0
        ? null
        : await fxDailyRates(verifiedCurrency, reportingCurrency, from, to);
      type Mutable = ShopifyCampaignAttributionSeriesRow & {
        pointByBucket: Map<string, ShopifyCampaignAttributionPoint>;
      };
      const campaigns = new Map<string, Mutable>();
      const currentFor = (campaignId: string) => {
        const current = campaigns.get(campaignId) ?? {
          campaignId,
          attributionModel: "last_non_direct_click" as const,
          sessions: null,
          orders: null,
          revenue: null,
          timeline: [],
          pointByBucket: new Map(),
        };
        campaigns.set(campaignId, current);
        return current;
      };
      const pointFor = (current: Mutable, bucket: string) => {
        const point = current.pointByBucket.get(bucket) ?? {
          bucket,
          sessions: null,
          orders: null,
          revenue: null,
        };
        current.pointByBucket.set(bucket, point);
        return point;
      };
      for (const row of salesRows) {
        const campaignId = exactGoogleCampaign(row);
        if (!campaignId) continue;
        const { bucket, day } = reportingBucket(row, from, to, verifiedTimeZone);
        const current = currentFor(campaignId);
        const point = pointFor(current, bucket);
        const revenue = finiteMoney(row.campaign_last_non_direct_click_total_sales, "campaign revenue") *
          (rates ? rateOn(rates, day) : 1);
        const orders = nonNegativeInteger(row.campaign_last_non_direct_click_order_count, "campaign orders");
        current.revenue = (current.revenue ?? 0) + revenue;
        current.orders = (current.orders ?? 0) + orders;
        point.revenue = (point.revenue ?? 0) + revenue;
        point.orders = (point.orders ?? 0) + orders;
      }
      for (const row of sessionRows) {
        const campaignId = exactGoogleCampaign(row);
        if (!campaignId) continue;
        const { bucket } = reportingBucket(row, from, to, verifiedTimeZone);
        const current = currentFor(campaignId);
        const point = pointFor(current, bucket);
        const sessions = nonNegativeInteger(row.campaign_sessions, "campaign sessions");
        current.sessions = (current.sessions ?? 0) + sessions;
        point.sessions = (point.sessions ?? 0) + sessions;
      }
      return [...campaigns.values()].map(({ pointByBucket, ...row }) => ({
        ...row,
        timeline: [...pointByBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
      })).sort((a, b) =>
        (b.revenue ?? -Infinity) - (a.revenue ?? -Infinity) ||
        a.campaignId.localeCompare(b.campaignId));
    },
    async fetchCampaignProducts(from, to) {
      validateRange(from, to);
      requireScopes(granted, ["read_reports"]);
      const rows = await fetchBoundedShopifyQlRows(
        shopDomain,
        accessToken,
        from,
        to,
        (chunkFrom, chunkTo) => `FROM campaign_products
SHOW campaign_last_non_direct_click_net_items_sold
GROUP BY utm_campaign, referring_platform, product_id, product_title
TIMESERIES day
SINCE ${chunkFrom}
UNTIL ${chunkTo}
ORDER BY day ASC
LIMIT ${SHOPIFYQL_ROW_LIMIT}`,
        "A single reporting day has too many campaign product rows for an exact report.",
        graphql,
      );

      const products = new Map<string, ShopifyCampaignProductAttribution>();
      for (const row of rows) {
        rowDay(row.day, from, to);
        const campaignId = exactGoogleCampaign(row);
        if (!campaignId) continue;
        const productId = typeof row.product_id === "string"
          ? row.product_id.trim()
          : "";
        const title = typeof row.product_title === "string"
          ? row.product_title.trim()
          : "";
        if (
          !/^(?:gid:\/\/shopify\/Product\/)?\d{1,30}$/.test(productId) ||
          !title ||
          title.length > 500
        ) {
          invalidResponse("Shopify returned an invalid attributed product identity.");
        }
        const key = `${campaignId}\u0000${productId}`;
        const current = products.get(key) ?? {
          campaignId,
          productId,
          title,
          attributionModel: "last_non_direct_click" as const,
          units: 0,
        };
        if (current.title !== title) {
          invalidResponse("Shopify returned conflicting attributed product identity.");
        }
        current.units += integer(
          row.campaign_last_non_direct_click_net_items_sold,
          "campaign product units",
        );
        if (!Number.isSafeInteger(current.units)) {
          invalidResponse("Shopify returned invalid campaign product totals.");
        }
        products.set(key, current);
      }
      return [...products.values()].sort(
        (left, right) =>
          left.campaignId.localeCompare(right.campaignId) ||
          right.units - left.units ||
          left.title.localeCompare(right.title),
      );
    },
    async fetchCampaignProductSeries(from, to) {
      validateRange(from, to);
      requireScopes(granted, ["read_reports"]);
      const rows = await fetchBoundedShopifyQlRows(
        shopDomain, accessToken, from, to,
        (a, b) => `FROM campaign_products
SHOW campaign_last_non_direct_click_net_items_sold
GROUP BY utm_campaign, referring_platform, product_id, product_title${from === to ? ", hour" : ""}
${from === to ? "" : "TIMESERIES day"}
SINCE ${a}
UNTIL ${b}
ORDER BY ${timelineOrder(from, to)} ASC
LIMIT ${SHOPIFYQL_ROW_LIMIT}`,
        "A single reporting day has too many campaign product rows for an exact report.",
        graphql,
      );
      const products = new Map<string, ShopifyCampaignProductSeriesRow>();
      for (const row of rows) {
        const campaignId = exactGoogleCampaign(row);
        if (!campaignId) continue;
        const productId = productGid(row.product_id);
        const title = typeof row.product_title === "string" ? row.product_title.trim() : "";
        if (!productId || !title || title.length > 500) {
          invalidResponse("Shopify returned an invalid attributed product identity.");
        }
        const { bucket } = reportingBucket(row, from, to, verifiedTimeZone);
        const key = `${campaignId}\u0000${productId}`;
        const current = products.get(key) ?? {
          campaignId,
          productId,
          title,
          attributionModel: "last_non_direct_click" as const,
          units: 0,
          timeline: [],
        };
        if (current.title !== title) invalidResponse("Shopify returned conflicting attributed product identity.");
        const units = integer(row.campaign_last_non_direct_click_net_items_sold, "campaign product units");
        current.units += units;
        const point = current.timeline.find((entry) => entry.bucket === bucket);
        if (point) point.units += units;
        else current.timeline.push({ bucket, units });
        if (!Number.isSafeInteger(current.units)) invalidResponse("Shopify returned invalid campaign product totals.");
        products.set(key, current);
      }
      return [...products.values()].map((row) => ({
        ...row,
        timeline: row.timeline.sort((a, b) => a.bucket.localeCompare(b.bucket)),
      })).sort((a, b) =>
        a.campaignId.localeCompare(b.campaignId) || b.units - a.units || a.title.localeCompare(b.title));
    },
    async fetchCollectionSales(from, to, targetCurrency = verifiedCurrency) {
      validateRange(from, to);
      requireScopes(granted, ["read_reports", "read_products"]);
      const reportingCurrency = currency(targetCurrency);
      const rows = await fetchCollectionSalesSeries(
        shopDomain,
        accessToken,
        verifiedCurrency,
        reportingCurrency,
        from,
        to,
        graphql,
      );
      return rows.map(({ handle: _handle, timeline: _timeline, products, ...row }) => ({
        ...row,
        products: products.map(({ timeline: _productTimeline, ...product }) => product),
      }));
    },
    async fetchCollectionSalesSeries(from, to, targetCurrency = verifiedCurrency) {
      validateRange(from, to);
      requireScopes(granted, ["read_reports", "read_products"]);
      return fetchCollectionSalesSeries(
        shopDomain,
        accessToken,
        verifiedCurrency,
        currency(targetCurrency),
        from,
        to,
        graphql,
      );
    },
  };
}

/**
 * Opens one purpose-bound V2 Shopify source. The access token remains inside
 * the returned method closures and is never included in their results.
 */
export async function createShopifyReportingAdapter(
  source: CanonicalReportingSource,
): Promise<ShopifyReportingAdapter> {
  const { shopify, credential } = validatedShopifyAnchor(source);
  const sourceCurrency = currency(shopify.currency);

  let clientSecret: string;
  try {
    clientSecret = (await decryptToken(credential.clientSecretCiphertext)).trim();
  } catch {
    throw new ShopifyReportingAdapterError(
      "credential_decrypt_failed",
      "The stored Shopify reporting credential could not be read.",
    );
  }

  const accessToken = await exchangeReportingClientCredentials({
    shopDomain: shopify.domain,
    clientId: credential.shopifyClientId,
    clientSecret,
  });
  const verified = await verifyReportingShop({
    shopDomain: shopify.domain,
    accessToken,
  });
  if (
    verified.shopId !== shopify.shopId ||
    verified.myshopifyDomain !== shopify.domain
  ) {
    throw new ShopifyReportingAdapterError(
      "identity_mismatch",
      "The Shopify credential no longer matches its reporting source.",
    );
  }
  const verifiedCurrency = currency(verified.currencyCode);
  if (verifiedCurrency !== sourceCurrency) {
    throw new ShopifyReportingAdapterError(
      "currency_mismatch",
      "The Shopify credential no longer matches the store currency.",
    );
  }

  return boundAdapter({
    shopDomain: shopify.domain,
    accessToken,
    verifiedCurrency,
    verifiedTimeZone: verified.ianaTimezone ?? "UTC",
    grantedScopes: verified.scopes.granted,
  });
}

/**
 * Opens one exact pre-cutover Shopify account. The service-layer caller must
 * first prove that the account belongs to the selected admin client; this
 * adapter then proves that the decrypted credential belongs to that domain.
 */
export async function createLegacyShopifyReportingAdapter(
  source: LegacyShopifyReportingSource,
): Promise<ShopifyReportingAdapter> {
  if (
    !source.clientId.trim() ||
    !source.adAccountId.trim() ||
    !source.credentialCiphertext.trim() ||
    (source.shopifyClientId !== null &&
      source.shopifyClientId.trim() !== source.shopifyClientId)
  ) {
    invalidSource();
  }
  let shopDomain: string;
  try {
    shopDomain = normalizeReportingShopDomain(source.shopDomain);
  } catch {
    invalidSource();
  }
  if (shopDomain !== source.shopDomain) invalidSource();
  // Legacy ad_account.currency is the reporting/target currency. Shopify's
  // verified currency is the native money base and may legitimately differ.
  currency(source.currency);

  let credential: string;
  try {
    credential = (await decryptToken(source.credentialCiphertext)).trim();
  } catch {
    throw new ShopifyReportingAdapterError(
      "credential_decrypt_failed",
      "The stored Shopify reporting credential could not be read.",
    );
  }
  if (!credential) {
    throw new ShopifyReportingAdapterError(
      "credential_decrypt_failed",
      "The stored Shopify reporting credential could not be read.",
    );
  }

  const accessToken = await resolveAdminToken(
    shopDomain,
    credential,
    source.shopifyClientId,
  );
  const verified = await verifyReportingShop({ shopDomain, accessToken });
  if (verified.myshopifyDomain !== shopDomain) {
    throw new ShopifyReportingAdapterError(
      "identity_mismatch",
      "The Shopify credential no longer matches its reporting source.",
    );
  }
  const verifiedCurrency = currency(verified.currencyCode);

  return boundAdapter({
    shopDomain,
    accessToken,
    verifiedCurrency,
    verifiedTimeZone: verified.ianaTimezone ?? "UTC",
    grantedScopes: verified.scopes.granted,
  });
}
