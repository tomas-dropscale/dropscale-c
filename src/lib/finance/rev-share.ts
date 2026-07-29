/**
 * Agency revenue share, collection-based.
 *
 * The deal is encoded in the Google Ads CAMPAIGN NAME: a campaign that bills a
 * revenue share on the collection it advertises is named so it contains the
 * collection URL and ends with the rate, e.g.
 *
 *   "Summer Velas https://shop.myshopify.com/collections/velas 5%"
 *
 * From that we read the collection handle (`velas`) and the rate (`5`). The
 * revenue that rate applies to is decided by the attribution engine (which
 * orders/lines belong to the advertised collection or landed on its URL).
 *
 * This module is the PURE parsing/attribution core — no I/O — so it is fully
 * unit-tested (rev-share.test.ts).
 */

export type RevShareDeal = {
  /** Shopify collection handle, e.g. "velas". */
  handle: string;
  /** The advertised collection path, "/collections/<handle>", for landing match. */
  path: string;
  /** Percentage to bill on the attributed revenue, e.g. 5. */
  rate: number;
};

// The handle is the segment right after /collections/, up to the next
// slash / query / hash / whitespace.
const COLLECTION_RE = /\/collections\/([^/?#\s]+)/i;
// The rate is the LAST "N%" in the name — deals are named with it at the end.
const TRAILING_RATE_RE = /(\d+(?:[.,]\d+)?)\s*%\s*$/;

/**
 * Parse one campaign name into a rev-share deal, or null when it isn't one
 * (no /collections/ URL, or no trailing rate). Errs toward null — a campaign
 * that doesn't clearly encode a deal bills nothing.
 */
export function parseRevShareCampaign(name: string | null | undefined): RevShareDeal | null {
  if (!name) return null;

  const collection = COLLECTION_RE.exec(name);
  if (!collection) return null;

  const rateMatch = TRAILING_RATE_RE.exec(name.trim());
  if (!rateMatch) return null;

  const rate = Number(rateMatch[1].replace(",", "."));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) return null;

  // Normalise the handle: strip a trailing slash and lower-case (Shopify
  // handles are lower-case), and decode any %-escapes.
  let handle = collection[1].replace(/\/+$/, "").toLowerCase();
  try {
    handle = decodeURIComponent(handle);
  } catch {
    // Leave the raw handle if it isn't valid percent-encoding.
  }
  if (!handle) return null;

  return { handle, path: `/collections/${handle}`, rate };
}

/**
 * The collection handle in a bare URL — no rate involved.
 *
 * Same regex the campaign-name parser uses, so a collection link a client typed
 * into a creative submission (migration 0018) is read exactly the way it will be
 * read later out of the campaign name. Null when there is no /collections/
 * segment, which is what lets the admin inbox flag a link that would attribute
 * nothing.
 */
export function collectionHandleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  const match = COLLECTION_RE.exec(url);
  if (!match) return null;

  let handle = match[1].replace(/\/+$/, "").toLowerCase();
  try {
    handle = decodeURIComponent(handle);
  } catch {
    // Leave the raw handle if it isn't valid percent-encoding.
  }
  return handle || null;
}

/**
 * Parse a set of campaign names into the deals they encode, keyed by handle.
 * When two campaigns name the same collection, the higher rate wins — the
 * safest reading when a deal was renamed and both names briefly coexist.
 */
export function dealsFromCampaigns(names: (string | null | undefined)[]): Map<string, RevShareDeal> {
  const byHandle = new Map<string, RevShareDeal>();
  for (const name of names) {
    const deal = parseRevShareCampaign(name);
    if (!deal) continue;
    const existing = byHandle.get(deal.handle);
    if (!existing || deal.rate > existing.rate) byHandle.set(deal.handle, deal);
  }
  return byHandle;
}

// ---------------------------------------------------------------------------
// Attribution — which of an order's money the rate applies to
// ---------------------------------------------------------------------------

/** A deal plus the set of product keys that belong to its collection. */
export type AttributionDeal = RevShareDeal & {
  /** Line-item keys (sku, else title) of the collection's products. */
  productKeys: ReadonlySet<string>;
};

export type AttributableOrder = {
  /** Whole-order revenue, reporting currency (used by the landing rule). */
  total: number;
  /** Path the customer FIRST landed on, or null when unknown. */
  landingPath: string | null;
  /** Per-line revenue (unit price × qty), reporting currency. */
  lines: { productKey: string; revenue: number }[];
};

/** Path only, lower-cased, no query/hash, no trailing slash — for landing match. */
export function normalizePath(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return null;

  let path: string;
  if (raw.startsWith("/")) {
    // Already a path (the common Shopify landing shape) — drop query/hash.
    path = raw.split(/[?#]/)[0];
  } else {
    try {
      path = new URL(raw.startsWith("http") ? raw : `https://${raw}`).pathname;
    } catch {
      path = raw.split(/[?#]/)[0];
    }
  }
  path = path.replace(/\/+$/, "");
  return path || "/";
}

/**
 * Rev-share base and amount for ONE order (§ the agreed rule):
 *   • landed on an advertised collection's URL → the WHOLE order counts;
 *   • otherwise → only the line items whose product is in an advertised
 *     collection count, each at that collection's rate.
 * A product in two advertised collections bills at the higher rate.
 */
export function orderRevShare(
  order: AttributableOrder,
  deals: AttributionDeal[],
): { base: number; amount: number } {
  if (deals.length === 0) return { base: 0, amount: 0 };

  // Rule (b): the landing page is the advertised collection → whole order.
  const landing = normalizePath(order.landingPath);
  if (landing) {
    const hit = deals.find((deal) => deal.path === landing);
    if (hit) return { base: order.total, amount: (order.total * hit.rate) / 100 };
  }

  // Rule (a): per-line, the deal whose collection holds this product (higher
  // rate wins a tie).
  let base = 0;
  let amount = 0;
  for (const line of order.lines) {
    let best: AttributionDeal | null = null;
    for (const deal of deals) {
      if (deal.productKeys.has(line.productKey) && (!best || deal.rate > best.rate)) best = deal;
    }
    if (best) {
      base += line.revenue;
      amount += (line.revenue * best.rate) / 100;
    }
  }
  return { base, amount };
}
