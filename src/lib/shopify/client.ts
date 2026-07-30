/**
 * Minimal Shopify Admin GraphQL client — fetch only, Workers-safe, same
 * philosophy as lib/google-ads/client.ts.
 *
 * Auth model: each store's own custom app. The client creates it in their
 * Shopify admin (Settings → Apps and sales channels → Develop apps) and
 * pastes the Admin API access token into Connections. We store it AES-GCM
 * encrypted (lib/google-ads/crypto — one server-held key encrypts all
 * third-party secrets) and it never reaches the browser after saving.
 */

import { isMetaReferral } from "@/lib/shopify/referrer";

const API_VERSION = "2025-01";

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

/**
 * Which kind of credential the client pasted. The two look alike but play
 * opposite roles: the secret goes ONLY in the token-exchange body, the access
 * token goes ONLY in the X-Shopify-Access-Token header. Mixing them up is the
 * classic 401.
 */
export function isClientSecret(credential: string): boolean {
  return credential.startsWith("shpss_");
}

// Exchanged tokens live ~24h; cache per isolate so recompute bursts don't
// re-exchange. Keyed by shop+clientId, same pattern as the Google Ads cache.
const exchangeCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * client_credentials grant: Client ID (API key) + API secret key → shpat_
 * access token. Shopify's docs claim this grant doesn't work for admin custom
 * apps; empirically it returns 200 and a working token — trust the wire, not
 * the docs. A fresh token per ~day is cheap.
 */
export async function exchangeClientCredentials(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const cacheKey = `${shopDomain}:${clientId}`;
  const cached = exchangeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;

  if (!res.ok || !body?.access_token) {
    const code = body?.error ?? "";
    if (code === "invalid_client") {
      throw new ShopifyError(
        "Shopify does not recognise this Client ID for this store. API key = Client ID; the shpss_ value is the secret.",
        res.status,
      );
    }
    if (code === "invalid_request") {
      throw new ShopifyError(
        "Client ID and secret are not a pair. Re-copy BOTH together from the same “API credentials” tab (a regenerated secret invalidates the old one).",
        res.status,
      );
    }
    throw new ShopifyError(
      body?.error_description ?? `Token exchange failed (${res.status}).`,
      res.status,
    );
  }

  const ttlMs = (body.expires_in ?? 23 * 3600) * 1000;
  exchangeCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + ttlMs });
  return body.access_token;
}

/**
 * Stored credential → header-ready access token. Direct shpat_ tokens pass
 * through; shpss_ secrets go through the exchange (which needs the app's
 * Client ID). Every Shopify call sits behind this.
 */
export async function resolveAdminToken(
  shopDomain: string,
  credential: string,
  clientId: string | null,
): Promise<string> {
  if (!isClientSecret(credential)) return credential;
  if (!clientId) {
    throw new ShopifyError(
      "An API secret key needs the app's Client ID for the token exchange.",
    );
  }
  return exchangeClientCredentials(shopDomain, clientId, credential);
}

/** "my-store.myshopify.com", with protocol/paths/whitespace stripped. */
export function normalizeShopDomain(input: string): string | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(cleaned)) return null;
  return cleaned;
}

export async function shopifyGraphql<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new ShopifyError("Shopify rejected the credentials.", res.status);
  }
  if (!res.ok) {
    throw new ShopifyError(`Shopify API error (${res.status}).`, res.status);
  }

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new ShopifyError(body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data) throw new ShopifyError("Empty Shopify response.");
  return body.data;
}

export type ShopInfo = {
  name: string;
  currencyCode: string;
  myshopifyDomain: string;
  accessScopes: string[];
};

/** Proves the credentials work and returns what we store alongside them. */
export async function validateShopifyCredentials(
  shopDomain: string,
  accessToken: string,
): Promise<ShopInfo> {
  const data = await shopifyGraphql<{
    shop: { name: string; currencyCode: string; myshopifyDomain: string };
    currentAppInstallation: { accessScopes: { handle: string }[] } | null;
  }>(
    shopDomain,
    accessToken,
    `{
      shop { name currencyCode myshopifyDomain }
      currentAppInstallation { accessScopes { handle } }
    }`,
  );

  return {
    name: data.shop.name,
    currencyCode: data.shop.currencyCode,
    myshopifyDomain: data.shop.myshopifyDomain,
    accessScopes: (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle),
  };
}

export type DailySales = {
  /** ISO day, in the shop's timezone as reported by createdAt. */
  date: string;
  revenue: number;
  orders: number;
  refunds: number;
  /** Line-item quantities summed — how many things were sold, not how many
   *  orders. Not netted against refunds: that needs per-line refund
   *  quantities, which this query does not ask for. */
  units: number;
  /**
   * Orders NOT referred by Instagram or Facebook — the store's conversions
   * figure. It sits beside Google ad spend, so orders Meta sent are subtracted:
   * Google spend had nothing to do with them. See lib/shopify/referrer.ts for
   * how a visit is classified, and why an unknown referrer stays counted.
   */
  attributedOrders: number;
};

/** One synced order line, ready for the COGS engine. */
export type SyncedOrderLine = {
  /** SKU when the store sets them, else the line title — the product key.
   *  Product/variant ids would be stronger but require read_products. */
  productKey: string;
  title: string;
  quantity: number;
  /** Unit selling price in the store's base currency. */
  unitPrice: number;
};

export type SyncedOrder = {
  /** ISO day the order was created. */
  date: string;
  /** Gross order total (after discounts, incl. shipping, BEFORE refunds), store base currency. */
  total: number;
  /** Whether the customer actually paid — the revenue-share base uses only these. */
  paid: boolean;
  /** Path the customer FIRST landed on (rev-share landing rule), or null. */
  landingPath: string | null;
  lines: SyncedOrderLine[];
};

// Orders per page × page cap. 2 500 orders per recompute window is plenty for
// the 7-day incremental sync; a bigger backfill just runs again next window.
const PAGE_SIZE = 250;
const MAX_PAGES = 10;

// Which financial statuses count as "the customer paid". This does NOT gate the
// dashboard's revenue (that is the TOTAL of all real orders, to match Shopify) —
// it only tags each order so the agency REVENUE SHARE is billed on paid revenue.
const PAID_FINANCIAL_STATUSES = new Set([
  "PAID",
  "PARTIALLY_PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

/**
 * Per-day sales for [from, to] (ISO dates, inclusive), plus the currency the
 * amounts are denominated in — the store's BASE currency, which is what
 * shopMoney reports and is NOT necessarily what Shopify Analytics displays.
 * Revenue books on the order's creation day; refunds book on the order's
 * creation day too — a simplification (Shopify refunds carry their own dates)
 * that keeps one query and matches how the P&L will read it.
 *
 * Revenue is the TOTAL of every real order (test/cancelled aside), so it lines
 * up with Shopify's own sales. Payment status doesn't gate it — it's only
 * carried per order (`paid`) so the agency revenue share bills paid revenue.
 */
export async function fetchDailySales(
  shopDomain: string,
  accessToken: string,
  from: string,
  to: string,
): Promise<{ currency: string | null; days: DailySales[]; orders: SyncedOrder[] }> {
  const byDay = new Map<
    string,
    { revenue: number; orders: number; refunds: number; units: number; attributedOrders: number }
  >();
  const syncedOrders: SyncedOrder[] = [];
  let currency: string | null = null;

  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: {
      shop: { currencyCode: string };
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          createdAt: string;
          test: boolean;
          cancelledAt: string | null;
          displayFinancialStatus: string | null;
          customerJourneySummary: {
            firstVisit: {
              landingPage: string | null;
              source: string | null;
              referrerUrl: string | null;
              utmParameters: { source: string | null } | null;
            } | null;
          } | null;
          totalPriceSet: { shopMoney: { amount: string } } | null;
          totalRefundedSet: { shopMoney: { amount: string } } | null;
          lineItems: {
            nodes: {
              title: string;
              sku: string | null;
              quantity: number;
              originalUnitPriceSet: { shopMoney: { amount: string } } | null;
            }[];
          };
        }[];
      };
    } = await shopifyGraphql(
      shopDomain,
      accessToken,
      `query ($q: String!, $cursor: String) {
        shop { currencyCode }
        orders(first: ${PAGE_SIZE}, after: $cursor, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes {
            createdAt
            test
            cancelledAt
            displayFinancialStatus
            customerJourneySummary {
              firstVisit {
                landingPage
                source
                referrerUrl
                utmParameters { source }
              }
            }
            totalPriceSet { shopMoney { amount } }
            totalRefundedSet { shopMoney { amount } }
            lineItems(first: 100) {
              nodes {
                title
                sku
                quantity
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
        }
      }`,
      { q: `created_at:>='${from}' AND created_at:<='${to}T23:59:59Z'`, cursor },
    );

    currency = data.shop.currencyCode;

    for (const order of data.orders.nodes) {
      // Shopify Analytics excludes test-gateway and cancelled orders from its
      // sales reports; include them and our numbers drift from the report the
      // client trusts. Filtered here, in code — the search-query syntax for
      // these is less reliable than the fields themselves.
      if (order.test || order.cancelledAt) continue;

      // Every real order counts toward revenue (matching Shopify). Payment
      // status is kept per order, not used to exclude — only the revenue share
      // narrows to paid orders.
      const paid =
        !!order.displayFinancialStatus &&
        PAID_FINANCIAL_STATUSES.has(order.displayFinancialStatus);

      const day = order.createdAt.slice(0, 10);
      // GROSS order total (before refunds). Refunds are subtracted ONCE via
      // totalRefundedSet below — using currentTotalPriceSet here (already net of
      // refunds) would double-count them and understate net revenue.
      const total = Number(order.totalPriceSet?.shopMoney.amount ?? 0);
      const lines = order.lineItems.nodes.map((line) => ({
        productKey: line.sku?.trim() || line.title,
        title: line.title,
        quantity: line.quantity,
        unitPrice: Number(line.originalUnitPriceSet?.shopMoney.amount ?? 0),
      }));

      // The store's conversions: every real order except the ones Instagram or
      // Facebook referred. An order whose journey Shopify does not report at all
      // stays counted — see referrer.ts on why unknown is not Meta.
      const visit = order.customerJourneySummary?.firstVisit;
      const fromMeta = isMetaReferral({
        source: visit?.source,
        referrerUrl: visit?.referrerUrl,
        utmSource: visit?.utmParameters?.source,
      });

      const entry =
        byDay.get(day) ?? { revenue: 0, orders: 0, refunds: 0, units: 0, attributedOrders: 0 };
      entry.revenue += total;
      entry.refunds += Number(order.totalRefundedSet?.shopMoney.amount ?? 0);
      entry.orders += 1;
      if (!fromMeta) entry.attributedOrders += 1;
      entry.units += lines.reduce((sum, line) => sum + line.quantity, 0);
      byDay.set(day, entry);

      syncedOrders.push({
        date: day,
        total,
        paid,
        landingPath: visit?.landingPage ?? null,
        lines,
      });
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }

  return {
    currency,
    days: [...byDay.entries()]
      .map(([date, sums]) => ({ date, ...sums }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    orders: syncedOrders,
  };
}

/**
 * Product keys (variant SKU, else product title — how order line items are
 * keyed) for every product in a collection, by handle. Returns an empty set
 * when the collection is missing or read_products isn't granted, so the
 * rev-share simply falls back to its landing-page rule.
 */
export async function fetchCollectionProductKeys(
  shopDomain: string,
  accessToken: string,
  handle: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let data: {
      collectionByHandle: {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { title: string; variants: { nodes: { sku: string | null }[] } }[];
        };
      } | null;
    };
    try {
      data = await shopifyGraphql(
        shopDomain,
        accessToken,
        `query ($handle: String!, $cursor: String) {
          collectionByHandle(handle: $handle) {
            products(first: ${PAGE_SIZE}, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                title
                variants(first: 100) { nodes { sku } }
              }
            }
          }
        }`,
        { handle, cursor },
      );
    } catch {
      // Missing scope, removed field, or unknown handle — degrade to empty.
      return keys;
    }

    const collection = data.collectionByHandle;
    if (!collection) return keys;

    for (const product of collection.products.nodes) {
      // Add both: SKU-keyed lines and (for SKU-less products) title-keyed lines.
      if (product.title) keys.add(product.title);
      for (const variant of product.variants.nodes) {
        const sku = variant.sku?.trim();
        if (sku) keys.add(sku);
      }
    }

    if (!collection.products.pageInfo.hasNextPage) break;
    cursor = collection.products.pageInfo.endCursor;
  }

  return keys;
}
