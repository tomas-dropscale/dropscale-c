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

export type ShopifyGraphqlExecutor = <T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

/**
 * Prices an order placed in a currency other than the shop's CURRENT one
 * into the shop's currency, at the rate of the order's own day.
 *
 * A merchant can change the store currency, and Shopify keeps every earlier
 * order in the currency it was placed in. Summing those as if they were in
 * the new currency would be wrong by the whole exchange rate, so without a
 * normalizer such an order is refused; the reporting adapter supplies one
 * backed by the day's ECB rate.
 */
export type DailySalesNormalizer = (
  foreignCurrency: string,
  shopCurrency: string,
  from: string,
  to: string,
) => Promise<(day: string, amount: number) => number>;

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
   *  orders. Not netted against refunds: a refunded item was still sold. A
   *  unit an edit took off the order before the customer paid for it (an
   *  upsell whose charge failed) was not, and is not counted. */
  units: number;
  /**
   * Orders NOT referred by Instagram or Facebook — the store's conversions
   * figure. It sits beside Google ad spend, so orders Meta sent are subtracted:
   * Google spend had nothing to do with them. See lib/shopify/referrer.ts for
   * how a visit is classified, and why an unknown referrer stays counted.
   */
  attributedOrders: number;
  /**
   * Revenue of exactly those orders — the conversion VALUE that pairs with the
   * count above, so "N conversions worth €X" is one consistent statement.
   *
   * Gross order totals, like `revenue`: an order counted as a conversion has its
   * value counted too, refunded or not - only what the customer never paid
   * for is left out, as in `revenue`.
   */
  attributedRevenue: number;
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
  /**
   * What the customer was charged for the line after discounts and before
   * refunds (Shopify's discountedTotalSet), store base currency. A discount
   * code or an automatic discount makes this less than unitPrice x quantity,
   * which is why a sheet that reads a collection's sales the way the client
   * does needs it. For a line partly taken off the order unpaid, it is the
   * share of the units that were actually sold.
   */
  lineTotal: number;
  /**
   * Money refunded on this line so far - the subtotals of the refund line
   * items booked against it, store base currency. A removal the customer
   * never paid for (see fetchDailySales) is not a refund and is left out.
   */
  refundedAmount: number;
  /** Units refunded on this line so far, the same unpaid removals left out. */
  refundedQuantity: number;
};

export type SyncedOrder = {
  /** ISO day the order was created. */
  date: string;
  /** Gross order total (after discounts, incl. shipping, BEFORE refunds, without
   *  any line the customer never paid for), store base currency. */
  total: number;
  /** Whether the customer actually paid — the revenue-share base uses only these. */
  paid: boolean;
  /** Path the customer FIRST landed on (rev-share landing rule), or null. */
  landingPath: string | null;
  firstVisit?: { source: string | null; medium: string | null; campaign: string | null } | null;
  /** What has been refunded on this order so far, store base currency. */
  refunded: number;
  lines: SyncedOrderLine[];
  /**
   * Shopify's numeric order id — the number a supplier reports back as the
   * platform order (HST's platformOrderId), so a per-order charge can be
   * matched to the order it bills for. Absent only on fixtures built by hand.
   */
  platformOrderId?: string;
};

// Each temporal chunk reads at most 10 × 250 orders. A saturated multi-day
// chunk is split deterministically; a saturated single reporting day fails
// closed instead of returning a truncated financial rollup.
const PAGE_SIZE = 250;
const MAX_PAGES = 10;
const MAX_REPORTING_DAYS = 366;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Which financial statuses count as "the customer paid". This does NOT gate the
// dashboard's revenue (that is the TOTAL of all real orders, to match Shopify) —
// it only tags each order so the agency REVENUE SHARE is billed on paid revenue.
const PAID_FINANCIAL_STATUSES = new Set([
  "PAID",
  "PARTIALLY_PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

function validIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftedDay(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function reportingDayCount(from: string, to: string): number {
  if (!validIsoDay(from) || !validIsoDay(to) || from > to) {
    throw new ShopifyError("The Shopify reporting range is invalid.");
  }
  const days = Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  ) + 1;
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_REPORTING_DAYS) {
    throw new ShopifyError("The Shopify reporting range is too large.");
  }
  return days;
}

function reportingFormatter(timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new ShopifyError("Shopify returned an invalid reporting time zone.");
  }
}

function formatterParts(formatter: Intl.DateTimeFormat, instant: Date) {
  const parts = formatter.formatToParts(instant);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? Number.NaN);
  const result = {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
    second: number("second"),
  };
  if (Object.values(result).some((value) => !Number.isFinite(value))) {
    throw new ShopifyError("Shopify returned an invalid reporting time zone.");
  }
  return result;
}

function reportingMidnight(day: string, formatter: Intl.DateTimeFormat): string {
  const [year, month, date] = day.split("-").map(Number);
  const target = Date.UTC(year, month - 1, date);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = formatterParts(formatter, new Date(instant));
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    const difference = representedAsUtc - target;
    if (difference === 0) return new Date(instant).toISOString();
    instant -= difference;
  }
  throw new ShopifyError("Shopify reporting midnight could not be resolved exactly.");
}

function reportingDay(timestamp: string, formatter: Intl.DateTimeFormat): string {
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) {
    throw new ShopifyError("Shopify returned an invalid order timestamp.");
  }
  const parts = formatterParts(formatter, instant);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function finiteAmount(value: unknown, label: string): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new ShopifyError(`Shopify returned a missing ${label}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ShopifyError(`Shopify returned an invalid ${label}.`);
  }
  return parsed === 0 ? 0 : parsed;
}

function finiteNonNegative(value: unknown, label: string): number {
  const parsed = finiteAmount(value, label);
  if (parsed < 0) {
    throw new ShopifyError(`Shopify returned an invalid ${label}.`);
  }
  return parsed;
}

function moneyCurrency(value: unknown, label: string): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new ShopifyError(`Shopify returned a missing ${label} currency.`);
  }
  return code;
}

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
 *
 * An order counts AS THE CUSTOMER PAID FOR IT. A post-purchase upsell
 * (AfterSell) is added to the order after checkout and, when its charge
 * fails, taken off again by an edit. Shopify writes that removal as a refund
 * that moves no money and keeps the item's price in `totalPriceSet` - money
 * the customer never paid and Shopify's own sales do not count. What was
 * never paid is the gap `totalPriceSet - totalReceivedSet -
 * totalOutstandingSet`: an unpaid order is all outstanding, a paid one all
 * received, a refunded one still received (refunds are their own field), so
 * the gap is what an edit took off the order before it was paid for. Gross
 * revenue is the total without it; refunds come off once, from the money
 * that moved, as before. An item taken off a PAID order and settled outside
 * Shopify opens no gap and keeps counting, as it always did.
 *
 * Units follow the same money. A refund line item is an unpaid removal only
 * while its value fits in that gap - the lines of refunds that moved no
 * money first (how Shopify records the edit), then any other. Beyond the
 * gap the item was paid for, and however it left the order - refunded for
 * money, returned, taken off and refunded as a custom amount - it keeps its
 * unit and its cost.
 *
 * Every amount comes back in `currency`, the shop's current currency. An
 * order placed before the merchant changed that currency is priced into it
 * through `options.normalize`; with no normalizer such an order is refused.
 */
export async function fetchDailySales(
  shopDomain: string,
  accessToken: string,
  from: string,
  to: string,
  graphql: ShopifyGraphqlExecutor = shopifyGraphql,
  options: { normalize?: DailySalesNormalizer } = {},
): Promise<{
  currency: string | null;
  timeZone: string;
  days: DailySales[];
  orders: SyncedOrder[];
}> {
  type OrderNode = {
    id: string;
    createdAt: string;
    test: boolean;
    cancelledAt: string | null;
    displayFinancialStatus: string | null;
    customerJourneySummary: {
      firstVisit: {
        landingPage: string | null;
        source: string | null;
        referrerUrl: string | null;
        utmParameters: { source: string | null; medium: string | null; campaign: string | null } | null;
      } | null;
    } | null;
    taxesIncluded: boolean;
    totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
    totalReceivedSet: { shopMoney: { amount: string; currencyCode: string } } | null;
    totalOutstandingSet: { shopMoney: { amount: string; currencyCode: string } } | null;
    totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } } | null;
    refunds: RefundNode[];
    lineItems: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{
        id: string;
        title: string;
        sku: string | null;
        quantity: number;
        originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
        discountedTotalSet: { shopMoney: { amount: string; currencyCode: string } } | null;
      }>;
    };
  };
  type RefundNode = {
    totalRefundedSet: { shopMoney: { amount: string } } | null;
    refundLineItems: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{
        quantity: number;
        subtotalSet: { shopMoney: { amount: string } } | null;
        totalTaxSet: { shopMoney: { amount: string } } | null;
        lineItem: { id: string } | null;
      }>;
    };
  };
  type OrdersResponse = {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: OrderNode[];
    };
  };

  reportingDayCount(from, to);
  const metadata = await graphql<{
    shop: { currencyCode: string; ianaTimezone: string };
  }>(
    shopDomain,
    accessToken,
    `query DropscaleDailySalesShop {
      shop { currencyCode ianaTimezone }
    }`,
  );
  const currency = metadata.shop?.currencyCode?.trim().toUpperCase() ?? "";
  const timeZone = metadata.shop?.ianaTimezone?.trim() ?? "";
  if (!/^[A-Z]{3}$/.test(currency) || !timeZone) {
    throw new ShopifyError("Shopify returned invalid reporting metadata.");
  }
  const formatter = reportingFormatter(timeZone);

  const fetchChunk = async (
    chunkFrom: string,
    chunkTo: string,
  ): Promise<OrderNode[]> => {
    const fromInclusive = reportingMidnight(chunkFrom, formatter);
    const toExclusive = reportingMidnight(shiftedDay(chunkTo, 1), formatter);
    const nodes: OrderNode[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data: OrdersResponse = await graphql<OrdersResponse>(
        shopDomain,
        accessToken,
        `query DropscaleDailySalesOrders($q: String!, $cursor: String) {
          orders(first: ${PAGE_SIZE}, after: $cursor, query: $q, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              createdAt
              test
              cancelledAt
              displayFinancialStatus
              customerJourneySummary {
                firstVisit {
                  landingPage
                  source
                  referrerUrl
                  utmParameters { source medium campaign }
                }
              }
              taxesIncluded
              totalPriceSet { shopMoney { amount currencyCode } }
              totalReceivedSet { shopMoney { amount currencyCode } }
              totalOutstandingSet { shopMoney { amount currencyCode } }
              totalRefundedSet { shopMoney { amount currencyCode } }
              refunds {
                totalRefundedSet { shopMoney { amount } }
                refundLineItems(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    quantity
                    subtotalSet { shopMoney { amount } }
                    totalTaxSet { shopMoney { amount } }
                    lineItem { id }
                  }
                }
              }
              lineItems(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  id
                  title
                  sku
                  quantity
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  discountedTotalSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }`,
        {
          q: `created_at:>='${fromInclusive}' AND created_at:<'${toExclusive}'`,
          cursor,
        },
      );
      if (
        !data.orders ||
        !Array.isArray(data.orders.nodes) ||
        data.orders.nodes.length > PAGE_SIZE
      ) {
        throw new ShopifyError("Shopify returned invalid order pagination.");
      }
      nodes.push(...data.orders.nodes);
      if (!data.orders.pageInfo.hasNextPage) return nodes;
      const next: string | null = data.orders.pageInfo.endCursor;
      if (!next || cursors.has(next)) {
        throw new ShopifyError("Shopify returned invalid order pagination.");
      }
      cursors.add(next);
      cursor = next;
    }

    if (chunkFrom === chunkTo) {
      throw new ShopifyError(
        "A single Shopify reporting day has too many orders for an exact report.",
      );
    }
    const days = reportingDayCount(chunkFrom, chunkTo);
    const leftTo = shiftedDay(chunkFrom, Math.ceil(days / 2) - 1);
    const rightFrom = shiftedDay(leftTo, 1);
    const left = await fetchChunk(chunkFrom, leftTo);
    const right = await fetchChunk(rightFrom, chunkTo);
    return [...left, ...right];
  };

  const orderNodes = await fetchChunk(from, to);
  const byDay = new Map<
    string,
    {
      revenue: number;
      orders: number;
      refunds: number;
      units: number;
      attributedOrders: number;
      attributedRevenue: number;
    }
  >();
  const syncedOrders: SyncedOrder[] = [];
  const seenOrders = new Set<string>();

  // One converter per currency seen, resolved once; the shop's own needs none.
  const converters = new Map<string, (day: string, amount: number) => number>();
  const converterFor = async (orderCurrency: string) => {
    if (orderCurrency === currency) return (_day: string, amount: number) => amount;
    let convert = converters.get(orderCurrency);
    if (!convert) {
      if (!options.normalize) {
        throw new ShopifyError(
          `Shopify returned an order in ${orderCurrency}, but the store now reports in ${currency}.`,
        );
      }
      convert = await options.normalize(orderCurrency, currency, from, to);
      converters.set(orderCurrency, convert);
    }
    return convert;
  };
  for (const order of orderNodes) {
    if (!/^gid:\/\/shopify\/Order\/\d+$/.test(order.id) || seenOrders.has(order.id)) {
      throw new ShopifyError("Shopify returned invalid order identity.");
    }
    seenOrders.add(order.id);
    const day = reportingDay(order.createdAt, formatter);
    if (day < from || day > to) {
      throw new ShopifyError("Shopify returned an order outside its reporting range.");
    }
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

    // GROSS order total (before refunds): what the customer paid or still
    // owes. totalPriceSet also carries an upsell an edit took off the order
    // before its charge went through - that unpaid gap comes off (never
    // below zero: an over-receipt is not a reason to count less). Refunds
    // are subtracted ONCE via totalRefundedSet below — using
    // currentTotalPriceSet here (already net of returns) would double-count
    // them and understate net revenue.
    const rawListed = finiteNonNegative(order.totalPriceSet?.shopMoney.amount, "order total");
    const rawReceived = finiteNonNegative(order.totalReceivedSet?.shopMoney.amount, "order balance");
    // A balance the merchant owes back shows as zero outstanding, not a
    // negative one; should it ever go negative, that is not unpaid revenue.
    const rawOutstanding = Math.max(0, finiteAmount(order.totalOutstandingSet?.shopMoney.amount, "order balance"));
    const rawUnpaid = Math.max(0, Number((rawListed - rawReceived - rawOutstanding).toFixed(6)));
    const rawTotal = Number((rawListed - rawUnpaid).toFixed(6));
    const rawRefunded = order.totalRefundedSet === null
      ? 0
      : finiteNonNegative(order.totalRefundedSet?.shopMoney.amount, "order refund");
    // The currency the order was placed in - the shop's current one, or the
    // one it had back then. Every money field of one order must agree.
    const orderCurrency = moneyCurrency(order.totalPriceSet?.shopMoney.currencyCode, "order total");
    if (
      moneyCurrency(order.totalReceivedSet?.shopMoney.currencyCode, "order balance") !== orderCurrency ||
      moneyCurrency(order.totalOutstandingSet?.shopMoney.currencyCode, "order balance") !== orderCurrency
    ) {
      throw new ShopifyError("Shopify returned an order balance in another currency.");
    }
    if (
      order.totalRefundedSet !== null &&
      moneyCurrency(order.totalRefundedSet?.shopMoney.currencyCode, "order refund") !== orderCurrency
    ) {
      throw new ShopifyError("Shopify returned an order refund in another currency.");
    }
    const convert = await converterFor(orderCurrency);
    const total = convert(day, rawTotal);
    const refunded = convert(day, rawRefunded);
    if (order.lineItems.pageInfo.hasNextPage) {
      throw new ShopifyError("A Shopify order has too many lines for an exact report.");
    }
    // Units the customer never paid for, per line. A refund line item is an
    // unpaid removal only while its value fits in the unpaid gap, first come
    // first matched: the lines of refunds that moved no money first - that is
    // how Shopify records the edit - then, only while a gap is left, lines of
    // refunds that also moved money (shipping refunded along with the
    // removal). One beyond the gap was paid for and settled some other way:
    // it stays sold, like a refund for money.
    const removed: Array<{
      id: string;
      quantity: number;
      subtotal: number;
      value: number;
      moved: boolean;
      unpaid: boolean;
    }> = [];
    for (const refund of order.refunds) {
      if (refund.refundLineItems.pageInfo.hasNextPage) {
        throw new ShopifyError("A Shopify refund has too many lines for an exact report.");
      }
      const moved = finiteNonNegative(refund.totalRefundedSet?.shopMoney.amount, "refund total") > 0;
      for (const item of refund.refundLineItems.nodes) {
        if (!item.lineItem?.id || !Number.isSafeInteger(item.quantity) || item.quantity < 0) {
          throw new ShopifyError("Shopify returned an invalid refund line.");
        }
        // A line's subtotal already holds the tax where the store's prices
        // include it; elsewhere the tax sits on top.
        const subtotal = finiteNonNegative(item.subtotalSet?.shopMoney.amount, "refund line subtotal");
        const value =
          subtotal +
          (order.taxesIncluded ? 0 : finiteNonNegative(item.totalTaxSet?.shopMoney.amount, "refund line tax"));
        removed.push({ id: item.lineItem.id, quantity: item.quantity, subtotal, value, moved, unpaid: false });
      }
    }
    const unpaidUnits = new Map<string, number>();
    let unpaidLeft = rawUnpaid;
    for (const pass of [false, true]) {
      for (const item of removed) {
        // A cent of tolerance: the gap comes from rounded money fields.
        if (item.moved !== pass || unpaidLeft <= 0 || item.value <= 0 || item.value > unpaidLeft + 0.011) {
          continue;
        }
        unpaidLeft = Math.max(0, Number((unpaidLeft - item.value).toFixed(6)));
        unpaidUnits.set(item.id, (unpaidUnits.get(item.id) ?? 0) + item.quantity);
        item.unpaid = true;
      }
    }
    // What was refunded on each line, the unpaid removals aside: those were
    // never sold, so they are not refunds either. The subtotal is booked as
    // the line's own total is (tax inside where prices include it), so the
    // two subtract cleanly.
    const refundedByLine = new Map<string, { quantity: number; subtotal: number }>();
    for (const item of removed) {
      if (item.unpaid) continue;
      const current = refundedByLine.get(item.id) ?? { quantity: 0, subtotal: 0 };
      current.quantity += item.quantity;
      current.subtotal += item.subtotal;
      refundedByLine.set(item.id, current);
    }
    const lines = order.lineItems.nodes.flatMap((line) => {
      const title = typeof line.title === "string" ? line.title.trim() : "";
      if (!title || !Number.isSafeInteger(line.quantity) || line.quantity < 0) {
        throw new ShopifyError("Shopify returned an invalid order line.");
      }
      const unpaid = unpaidUnits.get(line.id) ?? 0;
      if (unpaid > line.quantity) {
        throw new ShopifyError("Shopify returned an invalid refund line.");
      }
      const sold = line.quantity - unpaid;
      if (sold === 0) return [];
      const unitPrice = finiteNonNegative(
        line.originalUnitPriceSet?.shopMoney.amount,
        "order line price",
      );
      const discountedTotal = finiteNonNegative(
        line.discountedTotalSet?.shopMoney.amount,
        "order line total",
      );
      if (
        moneyCurrency(line.originalUnitPriceSet?.shopMoney.currencyCode, "order line price") !==
          orderCurrency ||
        moneyCurrency(line.discountedTotalSet?.shopMoney.currencyCode, "order line total") !==
          orderCurrency
      ) {
        throw new ShopifyError("Shopify returned an order line in another currency.");
      }
      // The discounted total covers the whole line as Shopify lists it,
      // unpaid units included; only the sold share was charged.
      const soldTotal = sold === line.quantity ? discountedTotal : (discountedTotal * sold) / line.quantity;
      const refunded = refundedByLine.get(line.id) ?? { quantity: 0, subtotal: 0 };
      return [{
        productKey: line.sku?.trim() || title,
        title,
        quantity: sold,
        unitPrice: convert(day, unitPrice),
        lineTotal: convert(day, soldTotal),
        refundedAmount: convert(day, refunded.subtotal),
        refundedQuantity: refunded.quantity,
      }];
    });

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
      byDay.get(day) ??
      {
        revenue: 0,
        orders: 0,
        refunds: 0,
        units: 0,
        attributedOrders: 0,
        attributedRevenue: 0,
      };
    entry.revenue += total;
    entry.refunds += refunded;
    entry.orders += 1;
    if (!fromMeta) {
      entry.attributedOrders += 1;
      entry.attributedRevenue += total;
    }
    entry.units += lines.reduce((sum, line) => sum + line.quantity, 0);
    byDay.set(day, entry);

    syncedOrders.push({
      date: day,
      total,
      paid,
      landingPath: visit?.landingPage ?? null,
      firstVisit: visit ? {
        source: visit.utmParameters?.source ?? visit.source ?? null,
        medium: visit.utmParameters?.medium ?? null,
        campaign: visit.utmParameters?.campaign ?? null,
      } : null,
      refunded,
      lines,
      // Validated above as gid://shopify/Order/<digits>; the digits are the id.
      platformOrderId: order.id.slice("gid://shopify/Order/".length),
    });
  }

  return {
    currency,
    // The shop's own zone — the one order days were bucketed in. Returned so the
    // rollup can align other per-order facts (HST costs) to the same days.
    timeZone,
    days: [...byDay.entries()]
      .map(([date, sums]) => ({ date, ...sums }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    orders: syncedOrders,
  };
}

type CollectionProductsPage = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { title: string; variants: { nodes: { sku: string | null }[] } }[];
};

/** One page of a collection's products, or null when the store has no collection by that handle. */
async function fetchCollectionProductsPage(
  shopDomain: string,
  accessToken: string,
  handle: string,
  cursor: string | null,
  graphql: ShopifyGraphqlExecutor,
): Promise<CollectionProductsPage | null> {
  const data = await graphql<{ collectionByHandle: { products: CollectionProductsPage } | null }>(
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
  return data.collectionByHandle?.products ?? null;
}

function addCollectionProductKeys(keys: Set<string>, page: CollectionProductsPage): void {
  for (const product of page.nodes) {
    // Add both: SKU-keyed lines and (for SKU-less products) title-keyed lines.
    if (product.title) keys.add(product.title);
    for (const variant of product.variants.nodes) {
      const sku = variant.sku?.trim();
      if (sku) keys.add(sku);
    }
  }
}

/**
 * Product keys (variant SKU, else product title, how order line items are
 * keyed) for every product in a collection, by handle, or null when the store
 * has no collection by that handle. A page that cannot be read throws. The
 * admin sheet reads this because it must tell a renamed collection (its
 * campaign has no basis) from a throttle or a timeout (the last good sheet is
 * kept), and because a set cut short by a failed later page would pass for
 * the whole membership and silently drop the sales of every product it never
 * reached.
 */
export async function readCollectionProductKeys(
  shopDomain: string,
  accessToken: string,
  handle: string,
  graphql: ShopifyGraphqlExecutor = shopifyGraphql,
): Promise<Set<string> | null> {
  const keys = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const products = await fetchCollectionProductsPage(shopDomain, accessToken, handle, cursor, graphql);
    if (!products) return null;
    addCollectionProductKeys(keys, products);
    if (!products.pageInfo.hasNextPage) break;
    cursor = products.pageInfo.endCursor;
  }

  return keys;
}

/**
 * The same keys for the revenue-share ledger, which reads on a best-effort
 * basis: an empty set when the collection is missing or read_products isn't
 * granted, and the keys read so far when a later page fails, so the
 * rev-share simply falls back to its landing-page rule. Kept exactly so
 * because the ledger bills on it.
 */
export async function fetchCollectionProductKeys(
  shopDomain: string,
  accessToken: string,
  handle: string,
  graphql: ShopifyGraphqlExecutor = shopifyGraphql,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let products: CollectionProductsPage | null;
    try {
      products = await fetchCollectionProductsPage(shopDomain, accessToken, handle, cursor, graphql);
    } catch {
      // Missing scope, removed field, or unknown handle: degrade to what was read.
      return keys;
    }
    if (!products) return keys;
    addCollectionProductKeys(keys, products);
    if (!products.pageInfo.hasNextPage) break;
    cursor = products.pageInfo.endCursor;
  }

  return keys;
}
