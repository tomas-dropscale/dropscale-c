/**
 * The supplier's Order List, read for the screen rather than for the books.
 *
 * hst-orders.ts parses the same endpoint down to exactly what the cost sync
 * writes — a line cost and a tariff — and nothing it does not use. This reads
 * the same page for a different job: showing a client their orders as HST bills
 * them, one row each, with the goods, the EU/US import tariff and the total
 * kept apart so the €3 is visible instead of folded away.
 *
 * It is deliberately separate. The sync's parser is load-bearing for profit and
 * tested to the cent; a display that wants more fields must not reshape it.
 * Nothing here is written anywhere — it is read live and thrown away.
 */

/** One order as HST bills it, for display only. */
export type HstOrderDisplay = {
  /** The Shopify order id. */
  platformOrderId: string;
  /** HST's own order number (salesRecordNumber, e.g. "STS1790"). */
  orderNumber: string;
  /** Who it ships to. */
  recipient: string;
  country: string;
  /** HST's status in its own words ("To process", …); "" when it sent none. */
  status: string;
  /** Goods cost — the whole order's line costs, tariff excluded. */
  goods: number;
  /** The per-order EU/US import tariff, on its own. */
  tariff: number;
  /** The ERP's own discount on the order, already off the total; 0 when none. */
  discount: number;
  /** What HST charges for the order in total: goods + tariff. */
  total: number;
  /** The settlement currency of the three figures above (usually EUR). */
  currency: string;
  /** What the store sold it for, in the customer's currency, or null. */
  sold: number | null;
  soldCurrency: string;
  /** The paid date as HST states it (its own clock); null when absent. */
  paidDay: string | null;
  itemsCount: number;
};

const CURRENCY = /^[A-Z]{3}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
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

/** The currency the ERP writes beside a money figure — "112.8 USD" — or null. */
function textCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^-?[\d.,]+\s+([A-Za-z]{3})$/.exec(value.trim());
  return match ? match[1].toUpperCase() : null;
}

type RawPage = { data?: { data?: unknown } };

/**
 * Every order on this page that belongs to `shopId`, newest first (the order
 * HST returns them in). `limit` caps the result so a page of 100 does not
 * become a wall of rows.
 */
export function parseHstOrderDisplay(
  payload: unknown,
  opts: { shopId: string; limit?: number },
): HstOrderDisplay[] {
  const page = (payload ?? {}) as RawPage;
  const rows = Array.isArray(page.data?.data) ? (page.data?.data as unknown[]) : [];
  const out: HstOrderDisplay[] = [];
  const cap = Math.max(1, opts.limit ?? 60);

  // The shop's settlement currency as its quoted lines state it, for an order
  // the ERP names none for. A dollar-billed account leaves g_currency blank
  // on every order while each line still says USD; defaulting showed the
  // client its dollar figures under a euro sign (Elena Granada, 2026-09).
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
    if (out.length >= cap) break;
    const row = (entry ?? {}) as Record<string, unknown>;
    if (text(row.shopId) !== opts.shopId) continue;

    const platformOrderId = text(row.platformOrderId);
    if (!platformOrderId) continue;

    const total = money(row.g_cost) ?? 0;
    const tariff = money(row.g_tariff) ?? 0;
    const discount = money(row.g_discount) ?? 0;
    // Goods is what the lines were quoted at: the total HST bills, with the
    // tariff taken back out and the discount it took off put back — the
    // identity the cost sync proves (Σ lines + tariff − discount = g_cost).
    const goods = Math.max(0, total - tariff + discount);
    // The total's own declared currency ("112.8 USD") first; g_currency, when
    // present, agrees. It is absent on a dollar-billed account while every
    // quoted line says USD, and defaulting showed dollars under a euro sign.
    const currencyRaw =
      textCurrency(row.g_cost_text) ??
      textCurrency(row.g_tariff_text) ??
      text(row.g_currency).toUpperCase();
    const lineCurrencies = new Set(
      (Array.isArray(row.items) ? (row.items as unknown[]) : [])
        .map((item) => text(((item ?? {}) as Record<string, unknown>).baojia_currency).toUpperCase())
        .filter((code) => CURRENCY.test(code)),
    );
    const currency = CURRENCY.test(currencyRaw)
      ? currencyRaw
      : lineCurrencies.size === 1
        ? [...lineCurrencies][0]
        : (shopCurrency ?? "EUR");

    const sold = money(row.itemTotalOrigin);
    const soldCurrencyRaw = text(row.currencyId).toUpperCase();
    const soldCurrency = CURRENCY.test(soldCurrencyRaw) ? soldCurrencyRaw : currency;

    const paid = text(row.paidTime);
    const paidDay = /^\d{4}-\d{2}-\d{2}/.test(paid) ? paid.slice(0, 10) : null;

    out.push({
      platformOrderId,
      orderNumber: text(row.salesRecordNumber),
      recipient: text(row.buyerName),
      country: text(row.countryNameEN),
      status: text(row.order_status_text),
      goods,
      tariff,
      discount,
      total,
      currency,
      sold,
      soldCurrency,
      paidDay,
      itemsCount: money(row.items_num) ?? 0,
    });
  }

  return out;
}
