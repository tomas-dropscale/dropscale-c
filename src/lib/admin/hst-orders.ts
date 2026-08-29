/**
 * Reading the HST ERP's Order List — the screen that already knows what every
 * order cost us.
 *
 * The supplier quotes each line individually ("baojia") and charges one EU/US
 * import tariff per order. Both live on this one endpoint, so a client supplied
 * by HST can have real COGS without anybody typing a price:
 *
 *   g_cost = Σ baojia_price_total + g_tariff        (verified against live rows)
 *
 * Parsing is kept apart from fetching because these are the decisions that go
 * wrong quietly — a line skipped, a day off by one — and none of them need the
 * network to be tested.
 */

import type { HstOrderCost } from "./hst-costs";

/**
 * The ERP renders every timestamp in UTC+8 and says so nowhere.
 *
 * Proof from a live row: `g_audit_time` 1787871486 is 2026-08-27T22:58:06Z,
 * and the same row's `g_audit_time_text` reads "2026-08-28 06:58:06". Unset
 * timestamps come back as "1970-01-01 08:00", which is epoch zero in the same
 * zone. Reading these strings as UTC would push every order paid before 08:00
 * ERP time onto the wrong day, and the tariff with it.
 */
const ERP_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

const ERP_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** One shop the signed-in HST account can see, for mapping a store to it. */
export type HstShop = { id: string; name: string };

export type HstOrderPage = {
  /** Orders on this page that belong to the requested shop. */
  orders: HstOrderCost[];
  /** Every shop the ERP offers, whichever page it came on. */
  shops: HstShop[];
  lastPage: number;
  /**
   * The oldest order instant seen on this page (ISO), so a caller paging a
   * newest-first list knows when it has reached far enough back. Null when the
   * page carried no readable timestamp.
   */
  oldestPaidAt: string | null;
  /** Rows on this page belonging to some other shop. */
  otherShops: number;
  /**
   * Lines the supplier has not quoted yet. They are skipped, never recorded as
   * costing zero: an unquoted product written as 0 would read as pure margin.
   */
  unquotedLines: number;
};

/** "2026-08-27 22:50:04" as the ERP means it → epoch ms, or null. */
function erpInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = ERP_TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  if (!Number.isFinite(asUtc)) return null;
  return asUtc - ERP_UTC_OFFSET_MS;
}

/** An instant as a calendar day in the account's own reporting zone. */
function dayIn(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** The ERP sends money as strings, and "-" / "" for "no figure". */
function money(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/**
 * Which store_products row an HST line refers to.
 *
 * The Shopify sync stores `line.sku?.trim() || title` as the product key
 * because it reads orders without the products scope. HST reports the same
 * two things back: `platformSku` (which is the Shopify SKU, or the variant id
 * when the merchant set no SKU) and `originTitle` (the Shopify title). Sending
 * both, best first, is what makes stores that do not set SKUs match at all —
 * for those, our key is the title while HST's platformSku is a variant id, and
 * matching on the SKU alone would find nothing.
 */
function candidateKeys(item: Record<string, unknown>): string[] {
  const keys = [text(item.platformSku), text(item.originTitle)].filter(Boolean);
  return [...new Set(keys)];
}

type RawPage = {
  data?: {
    data?: unknown;
    last_page?: unknown;
    shop_list?: unknown;
  };
};

/**
 * One page of the Order List, narrowed to one shop.
 *
 * `timeZone` is the account's reporting zone — the same one the Shopify sync
 * assigns order days in — so a tariff lands on the day its order's revenue did.
 */
export function parseHstOrderPage(
  payload: unknown,
  opts: { shopId: string; timeZone: string },
): HstOrderPage {
  const page = (payload ?? {}) as RawPage;
  const rows = Array.isArray(page.data?.data) ? (page.data?.data as unknown[]) : [];

  const shops: HstShop[] = (
    Array.isArray(page.data?.shop_list) ? (page.data?.shop_list as unknown[]) : []
  )
    .map((entry) => {
      const shop = (entry ?? {}) as Record<string, unknown>;
      return { id: text(shop.id), name: text(shop.name) };
    })
    .filter((shop) => shop.id !== "");

  const orders: HstOrderCost[] = [];
  let oldest: number | null = null;
  let otherShops = 0;
  let unquotedLines = 0;

  for (const entry of rows) {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (text(row.shopId) !== opts.shopId) {
      otherShops += 1;
      continue;
    }

    const platformOrderId = text(row.platformOrderId);
    if (!platformOrderId) continue;

    // paidTime is when the customer paid, which is what Shopify dates the
    // order by; createDate is only when HST ingested it, hours later.
    const instant = erpInstant(row.paidTime) ?? erpInstant(row.createDate);
    if (instant === null) continue;
    if (oldest === null || instant < oldest) oldest = instant;

    const items: HstOrderCost["items"] = [];
    const rawItems = Array.isArray(row.items) ? (row.items as unknown[]) : [];
    for (const rawItem of rawItems) {
      const item = (rawItem ?? {}) as Record<string, unknown>;
      const currency = text(item.baojia_currency).toUpperCase();
      const unitCost = money(item.baojia_price);
      // "-" as the currency is the ERP's way of saying this line has no quote.
      // The order's own shipping-protection upsells arrive that way, and so
      // does a real product the supplier has not priced yet; both must wait
      // rather than be booked at zero.
      if (!CURRENCY.test(currency) || unitCost === null || unitCost < 0) {
        unquotedLines += 1;
        continue;
      }
      const keys = candidateKeys(item);
      if (keys.length === 0) {
        unquotedLines += 1;
        continue;
      }
      const quantity = money(item.quantity) ?? money(item.platformQuantity) ?? 1;
      items.push({ keys, unitCost, currency, quantity: Math.max(1, Math.round(quantity)) });
    }

    orders.push({
      platformOrderId,
      orderDay: dayIn(instant, opts.timeZone),
      paidAt: new Date(instant).toISOString(),
      tariff: money(row.g_tariff) ?? 0,
      // g_cost is the ERP's own total for the order (goods + tariff) — what HST
      // actually bills. Kept whole so an HST store reconciles to it exactly.
      totalCost: money(row.g_cost) ?? 0,
      currency: text(row.g_currency).toUpperCase() || "EUR",
      items,
    });
  }

  const lastPage = Number(page.data?.last_page);

  return {
    orders,
    shops,
    lastPage: Number.isFinite(lastPage) && lastPage > 0 ? Math.floor(lastPage) : 1,
    oldestPaidAt: oldest === null ? null : new Date(oldest).toISOString(),
    otherShops,
    unquotedLines,
  };
}
