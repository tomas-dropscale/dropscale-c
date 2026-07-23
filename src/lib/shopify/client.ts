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
  /** Current total (after discounts, incl. shipping), store base currency. */
  total: number;
  lines: SyncedOrderLine[];
};

// Orders per page × page cap. 2 500 orders per recompute window is plenty for
// the 7-day incremental sync; a bigger backfill just runs again next window.
const PAGE_SIZE = 250;
const MAX_PAGES = 10;

/**
 * Per-day sales for [from, to] (ISO dates, inclusive), plus the currency the
 * amounts are denominated in — the store's BASE currency, which is what
 * shopMoney reports and is NOT necessarily what Shopify Analytics displays.
 * Revenue books on the order's creation day; refunds book on the order's
 * creation day too — a simplification (Shopify refunds carry their own dates)
 * that keeps one query and matches how the P&L will read it.
 */
export async function fetchDailySales(
  shopDomain: string,
  accessToken: string,
  from: string,
  to: string,
): Promise<{ currency: string | null; days: DailySales[]; orders: SyncedOrder[] }> {
  const byDay = new Map<string, { revenue: number; orders: number; refunds: number }>();
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
          currentTotalPriceSet: { shopMoney: { amount: string } } | null;
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
            currentTotalPriceSet { shopMoney { amount } }
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

      const day = order.createdAt.slice(0, 10);
      const total = Number(order.currentTotalPriceSet?.shopMoney.amount ?? 0);
      const entry = byDay.get(day) ?? { revenue: 0, orders: 0, refunds: 0 };
      entry.revenue += total;
      entry.refunds += Number(order.totalRefundedSet?.shopMoney.amount ?? 0);
      entry.orders += 1;
      byDay.set(day, entry);

      syncedOrders.push({
        date: day,
        total,
        lines: order.lineItems.nodes.map((line) => ({
          productKey: line.sku?.trim() || line.title,
          title: line.title,
          quantity: line.quantity,
          unitPrice: Number(line.originalUnitPriceSet?.shopMoney.amount ?? 0),
        })),
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
