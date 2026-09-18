/**
 * Reading the HST ERP's Order List — the screen that already knows what every
 * order cost us.
 *
 * The supplier quotes each line individually ("baojia") and charges one EU/US
 * import tariff per order. Both live on this one endpoint, so a client supplied
 * by HST can have real COGS without anybody typing a price:
 *
 *   g_cost = Σ baojia_price_total + g_tariff − g_discount   (verified on 44/44
 *   undivided live rows; 22 of them carried a 3 or 6 USD discount)
 *
 * Parsing is kept apart from fetching because these are the decisions that go
 * wrong quietly — a line skipped, a day off by one — and none of them need the
 * network to be tested.
 */

import type { HstOrderCost } from "./hst-costs";

/**
 * Two clocks on one screen, and the ERP says so nowhere.
 *
 * Its own acts — `createDate`, the ingestion; `g_audit_time_text` — are on
 * UTC+8: `g_audit_time` 1787871486 is 2026-08-27T22:58:06Z and the same row's
 * text reads "2026-08-28 06:58:06". But `paidTime`, the platform's payment
 * time, is written in the STORE's own zone: measured 2026-09-18 against
 * Shopify's createdAt for every order of three stores (840 of 840, to the
 * second), it stands exactly 8 h minus the store's offset ahead of a UTC+8
 * reading — Lisbon stores 7.00 h, Madrid 6.00 h. Reading it on the ERP's
 * clock, as this parser once did, filed every order paid before 06:00 or
 * 07:00 local on the previous day, and its cost with it.
 *
 * So the day an order belongs to is the date `paidTime` is written with — the
 * store's day as it stands, the same day its revenue sits on — and it needs
 * no zone at all. No instant is derived from it: the store's zone is not
 * known here, and a guessed one is what went wrong. A row with no readable
 * `paidTime` is not dated by the ingestion clock instead; it waits.
 */
const ERP_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;
/** A split package: the ERP files it as "<parent order id>_<n>". */
const SPLIT_SUFFIX = /_\d+$/;
/** Two figures the ERP rounded to the cent that mean the same money. */
const MONEY_TOLERANCE = 0.011;

/** One shop the signed-in HST account can see, for mapping a store to it. */
export type HstShop = { id: string; name: string };

export type HstOrderPage = {
  /** Orders on this page that belong to the requested shop. */
  orders: HstOrderCost[];
  /** Every shop the ERP offers, whichever page it came on. */
  shops: HstShop[];
  lastPage: number;
  /**
   * The oldest order day seen on this page, so a caller paging a newest-first
   * list knows when it has reached far enough back. Null when the page carried
   * no readable timestamp.
   */
  oldestOrderDay: string | null;
  /**
   * Orders whose currency the ERP left blank and this parser read off their
   * quoted lines or the shop's other rows instead of defaulting.
   */
  currencyInferred: number;
  /** Rows of this shop with no readable payment time, left for a later page. */
  undated: number;
  /** Rows on this page belonging to some other shop. */
  otherShops: number;
  /**
   * Lines the supplier has not quoted yet. They are skipped, never recorded as
   * costing zero: an unquoted product written as 0 would read as pure margin.
   */
  unquotedLines: number;
};

/**
 * The currency the ERP writes beside a money figure — "112.8 USD" — or null.
 * It is the figure's own declared currency, which is what to believe.
 */
function textCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^-?[\d.,]+\s+([A-Za-z]{3})$/.exec(value.trim());
  return match ? match[1].toUpperCase() : null;
}

/** The calendar date an ERP timestamp is written with, exactly as written. */
function storeDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ERP_TIMESTAMP.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
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
 * Each order is dated by the day the ERP writes its payment time with — the
 * store's own day, the one its revenue sits on — so no zone is needed here.
 */
export function parseHstOrderPage(
  payload: unknown,
  opts: { shopId: string },
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
  let oldestDay: string | null = null;
  let otherShops = 0;
  let unquotedLines = 0;
  let currencyInferred = 0;
  let undated = 0;

  // The shop's settlement currency, read off every quoted line of this shop's
  // rows on the page — for an order that states none and has no quoted line
  // of its own to read it from. One shop settles in one currency.
  const pageCurrencies = new Set<string>();
  for (const entry of rows) {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (text(row.shopId) !== opts.shopId) continue;
    for (const rawItem of Array.isArray(row.items) ? (row.items as unknown[]) : []) {
      const code = text(((rawItem ?? {}) as Record<string, unknown>).baojia_currency).toUpperCase();
      if (CURRENCY.test(code)) pageCurrencies.add(code);
    }
  }
  const shopCurrency = pageCurrencies.size === 1 ? [...pageCurrencies][0] : null;

  for (const entry of rows) {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (text(row.shopId) !== opts.shopId) {
      otherShops += 1;
      continue;
    }

    const platformOrderId = text(row.platformOrderId);
    if (!platformOrderId) continue;

    // paidTime is when the customer paid, which is what Shopify dates the
    // order by, and the ERP writes it in the store's own clock (see the note
    // on the two clocks above): its date is the store's day as it stands.
    const orderDay = storeDay(row.paidTime);
    if (orderDay === null) {
      undated += 1;
      continue;
    }
    if (oldestDay === null || orderDay < oldestDay) oldestDay = orderDay;

    // A split package is filed under its parent's id with "_<n>" appended and
    // its parent's payment time. Whether it is a bill of its own is decided
    // per family once the page is read (coveredByParent, below).
    const split = SPLIT_SUFFIX.test(platformOrderId);
    const baseOrderId = platformOrderId.replace(SPLIT_SUFFIX, "");

    const items: HstOrderCost["items"] = [];
    const rawItems = Array.isArray(row.items) ? (row.items as unknown[]) : [];
    let rowUnquoted = 0;
    let linesTotal = 0;
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
        rowUnquoted += 1;
        continue;
      }
      const keys = candidateKeys(item);
      if (keys.length === 0) {
        unquotedLines += 1;
        rowUnquoted += 1;
        continue;
      }
      const quantity = Math.max(1, Math.round(money(item.quantity) ?? money(item.platformQuantity) ?? 1));
      items.push({ keys, unitCost, currency, quantity });
      linesTotal += unitCost * quantity;
    }

    // The ERP writes the total's own currency beside it ("112.8 USD"), which
    // is the one to believe; g_currency, when it is there at all, agrees. An
    // account billed in dollars leaves g_currency out on every order while
    // each quoted line still says USD, and the old default booked its dollar
    // totals as euros (Elena Granada, September 2026: 13.7% over). Failing
    // both, the lines name it — they are the same money as the total — then
    // the shop's currency as the rest of the page states it, and only then
    // the default.
    const stated =
      textCurrency(row.g_cost_text) ??
      textCurrency(row.g_tariff_text) ??
      text(row.g_currency).toUpperCase();
    const lineCurrencies = new Set(items.map((item) => item.currency));
    let currency: string;
    if (CURRENCY.test(stated)) {
      currency = stated;
    } else {
      currency = lineCurrencies.size === 1 ? [...lineCurrencies][0] : (shopCurrency ?? "EUR");
      currencyInferred += 1;
    }

    orders.push({
      platformOrderId,
      baseOrderId,
      split,
      // Decided per family once every page is read — decideFamilies, below.
      coveredByParent: null,
      orderDay,
      unquotedLines: rowUnquoted,
      linesTotal,
      tariff: money(row.g_tariff) ?? 0,
      // g_cost is the ERP's own total for the order (goods + tariff − discount)
      // — what HST actually bills. Kept whole so an HST store reconciles to
      // it exactly.
      totalCost: money(row.g_cost) ?? 0,
      discount: money(row.g_discount) ?? 0,
      currency,
      items,
    });
  }

  const lastPage = Number(page.data?.last_page);

  return {
    orders,
    shops,
    lastPage: Number.isFinite(lastPage) && lastPage > 0 ? Math.floor(lastPage) : 1,
    oldestOrderDay: oldestDay,
    currencyInferred,
    undated,
    otherShops,
    unquotedLines,
  };
}

/**
 * Decide, for every split package among `orders`, whether its parent's bill
 * already covers it. Run over everything a sync collected, never over one
 * page: a family straddling a page boundary would be judged on half its rows.
 *
 * Two shapes coexist, even within one store (measured 2026-09-18). A package
 * split off AFTER the parent's cost was set has its lines in the parent's
 * g_cost and is settled at nothing — Elena Granada, 9 of 10 families;
 * 8110621458771: 45.16 + 15.58 + 48.62 + 3.44 = 112.80 across three rows.
 * One split off BEFORE carries cost the parent's bill does not — the fourth
 * item of 8015506997587 lives only in "_1" — and Stockholm Slojd's
 * multi-package families carry more on the packages than on the parent. The
 * suffix does not tell them apart; the arithmetic does: the parent's goods
 * equal the whole family's quoted lines exactly when it covers them
 * (checked to the cent on 10 of 10 families, discounts included). A package
 * whose parent was not collected stays undecided (null).
 */
export function decideFamilies(orders: HstOrderCost[]): void {
  const parents = new Map(orders.filter((order) => !order.split).map((o) => [o.baseOrderId, o]));
  const familyLines = new Map<string, number>();
  for (const order of orders) {
    familyLines.set(order.baseOrderId, (familyLines.get(order.baseOrderId) ?? 0) + order.linesTotal);
  }
  for (const order of orders) {
    if (!order.split) continue;
    const parent = parents.get(order.baseOrderId);
    if (!parent) {
      order.coveredByParent = null;
      continue;
    }
    const parentGoods = parent.totalCost - parent.tariff + parent.discount;
    order.coveredByParent =
      Math.abs(parentGoods - (familyLines.get(order.baseOrderId) ?? 0)) < MONEY_TOLERANCE;
  }
}
