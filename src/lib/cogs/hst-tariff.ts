import type { SupabaseClient } from "@supabase/supabase-js";

import { fxDailyRates, rateOn } from "@/lib/shopify/fx";
import type { Database } from "@/lib/supabase/types";

/**
 * The supplier's import tariff, folded into the day it was charged on.
 *
 * HST bills an EU/US import duty per ORDER, not per article, so it cannot ride
 * in a unit cost: a two-line order would have one of its articles carrying the
 * whole charge, and the client's per-product margins would be wrong in a way
 * that looks like a pricing mistake. It is recorded whole against its order
 * (0087) and added here, to the same product-cost column, because that is what
 * it is — a cost of getting the goods.
 *
 * Nothing here touches revenue. Like every other cost in this chain, it moves
 * profit by exactly its own amount.
 */

type Supabase = SupabaseClient<Database>;

/** The mutable per-day cost accumulator the recompute already keeps. */
export type CostByDay = Map<string, { product: number; fees: number; shipping: number }>;

/**
 * The store's own orders, keyed by Shopify order id (the number HST reports
 * back as platformOrderId): the day each one's revenue sits on and the
 * per-product cost estimated for it before the supplier's figure is known.
 */
export type HstOrderEstimates = Map<string, { day: string; product: number }>;

/** A split package: the ERP files it as "<parent order id>_<n>". */
const SPLIT_SUFFIX = /_\d+$/;

/**
 * Add every tariff charged between `from` and `to` into `costByDay`.
 *
 * Only days already present are touched. A tariff whose order never reached
 * the Shopify rollup has no revenue to sit beside, and inventing a day for it
 * would put a cost on a date the report otherwise says nothing about.
 *
 * Failure is deliberately silent-but-logged: the tariff is a few euros an
 * order, and losing a whole store's sync over it would cost far more than the
 * charge itself.
 */
export async function addHstTariffs(input: {
  service: Supabase;
  adAccountId: string;
  from: string;
  to: string;
  reportingCurrency: string;
  costByDay: CostByDay;
}): Promise<number> {
  const { service, adAccountId, from, to, reportingCurrency, costByDay } = input;
  if (costByDay.size === 0) return 0;

  const { data, error } = await service
    .from("hst_order_charges")
    .select("order_day, tariff, currency")
    .eq("ad_account_id", adAccountId)
    .gte("order_day", from)
    .lte("order_day", to);
  if (error) {
    console.error(`HST tariffs not applied for ${adAccountId}: ${error.message}`);
    return 0;
  }

  const rows = (data ?? []) as Array<{ order_day: string; tariff: number; currency: string }>;
  if (rows.length === 0) return 0;

  // The supplier bills in euros while the store may report in anything. One
  // rate series per currency seen, fetched once.
  const series = new Map<string, Awaited<ReturnType<typeof fxDailyRates>> | null>();
  for (const currency of new Set(rows.map((row) => row.currency))) {
    if (currency === reportingCurrency) {
      series.set(currency, null);
      continue;
    }
    try {
      series.set(currency, await fxDailyRates(currency, reportingCurrency, from, to));
    } catch (fxError) {
      console.error(
        `HST tariffs not converted from ${currency} for ${adAccountId}:`,
        fxError instanceof Error ? fxError.message : fxError,
      );
      series.set(currency, null);
    }
  }

  let applied = 0;
  for (const row of rows) {
    const entry = costByDay.get(row.order_day);
    if (!entry) continue;
    const amount = Number(row.tariff);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const pairs = series.get(row.currency);
    // A currency we could not convert is skipped, never added at face value:
    // 3 forint-priced euros booked as forints would understate the cost by two
    // orders of magnitude and read as margin.
    if (pairs === undefined) continue;
    if (pairs === null && row.currency !== reportingCurrency) continue;

    entry.product += amount * (pairs ? rateOn(pairs, row.order_day) : 1);
    applied += 1;
  }

  return applied;
}

/**
 * Replace the per-product COGS estimate with the supplier's ACTUAL per-order
 * cost, for a store bought through HST.
 *
 * The per-product model (product_costs → orderCogs) applies one latest unit cost
 * to every unit, which over-counts against what HST really billed — the supplier
 * quotes and bills each ORDER (g_cost), spread across days. `our_cost` is that
 * real per-order total (goods + tariff − discount). Each charge is matched to
 * the store's own order by Shopify order id, so the cost lands on the day that
 * order's revenue sits on — whatever day the ERP filed the row under, and
 * whatever a row written under the old reading of the ERP's clock carries.
 *
 * The day is recomposed order by order, from the store's own orders: one the
 * supplier has priced contributes what HST billed, converted at the day's
 * rate; one still unquoted keeps its own per-product estimate, plus whatever
 * tariff the ERP already knows for it. Booking only the priced orders counted
 * the rest at nothing (Elena Granada, 2026-09-11: four orders, two quoted,
 * €53.01 for all four), and parking the whole day on the estimate priced the
 * quoted ones at a guess. A split package never counts: its parent's bill
 * already holds it. Only days with at least one priced order are touched; a
 * day with revenue but no quoted order keeps what `addHstTariffs` left. Call
 * this AFTER addHstTariffs:
 * the override discards that day's tariff-plus-estimate in favour of the actual,
 * with no double count.
 *
 * A no-op until 0091 is applied and a sync has stored `our_cost`, so it can ship
 * ahead of the migration without changing a single figure.
 */
export async function applyHstOrderCosts(input: {
  service: Supabase;
  adAccountId: string;
  from: string;
  to: string;
  reportingCurrency: string;
  costByDay: CostByDay;
  /**
   * The store's own orders in the window, keyed by Shopify order id, each
   * with the day its revenue sits on and the per-product cost estimated for
   * it. This is what an HST charge is matched to — by id, never by day.
   */
  estimates: HstOrderEstimates;
}): Promise<number> {
  const { service, adAccountId, from, to, reportingCurrency, costByDay, estimates } = input;
  if (costByDay.size === 0 || estimates.size === 0) return 0;

  // A row's order_day is the store's day as the ERP states it; a row written
  // before that was so can sit a calendar day either side. The match below is
  // by order id, so the fetch only has to be wide enough to hold the window.
  const shift = (day: string, delta: number) => {
    const dt = new Date(`${day}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  };

  const { data, error } = await service
    .from("hst_order_charges")
    .select("platform_order_id, tariff, our_cost, currency")
    .eq("ad_account_id", adAccountId)
    .gte("order_day", shift(from, -1))
    .lte("order_day", shift(to, 1));
  if (error) {
    console.error(`HST order costs not applied for ${adAccountId}: ${error.message}`);
    return 0;
  }

  const rows = (data ?? []) as Array<{
    platform_order_id: string;
    tariff: number;
    our_cost: number | null;
    currency: string;
  }>;
  if (rows.length === 0) return 0;

  // One charge per Shopify order, summed over the family the ERP filed it as:
  // the parent row and any split packages ("<id>_1"). The sync writes a
  // package the parent's bill already covers as a known zero, and one the
  // parent does not cover at its own figure, so the family's sum is what HST
  // bills for the order — never twice, never short. A package still waiting
  // for its quote is null and adds nothing yet; the family stays billed on
  // what is known, and the reach-back re-reads it until the package is priced.
  type Charge = { billed: number | null; tariff: number; currency: string };
  const chargeByOrder = new Map<string, Charge>();
  for (const row of rows) {
    const orderId = row.platform_order_id.replace(SPLIT_SUFFIX, "");
    const charge = chargeByOrder.get(orderId) ?? { billed: null, tariff: 0, currency: row.currency };
    if (row.our_cost !== null && row.our_cost !== undefined) {
      const amount = Number(row.our_cost);
      // A package's known zero adds nothing and, alone, bills nothing: a family
      // whose parent still waits is not billed because its package is settled.
      if (Number.isFinite(amount) && amount > 0) charge.billed = (charge.billed ?? 0) + amount;
    }
    const tariff = Number(row.tariff);
    if (Number.isFinite(tariff) && tariff > 0) charge.tariff += tariff;
    chargeByOrder.set(orderId, charge);
  }

  const series = new Map<string, Awaited<ReturnType<typeof fxDailyRates>> | null>();
  for (const currency of new Set(rows.map((row) => row.currency))) {
    if (currency === reportingCurrency) {
      series.set(currency, null);
      continue;
    }
    try {
      series.set(currency, await fxDailyRates(currency, reportingCurrency, from, to));
    } catch (fxError) {
      console.error(
        `HST order costs not converted from ${currency} for ${adAccountId}:`,
        fxError instanceof Error ? fxError.message : fxError,
      );
      series.set(currency, null);
    }
  }
  // The rate a charge's currency converts at on a day, or undefined for one
  // we could not convert — which is then read as no figure at all, never at
  // face value: 3 forint-priced euros booked as forints would read as margin.
  const rateFor = (currency: string, day: string): number | undefined => {
    const pairs = series.get(currency);
    if (pairs === undefined) return undefined;
    if (pairs === null) return currency === reportingCurrency ? 1 : undefined;
    return rateOn(pairs, day);
  };

  // The days to recompose: those where at least one of the store's orders has
  // a priced charge. Everything else keeps what addHstTariffs left.
  const daysToCompose = new Set<string>();
  for (const [orderId, estimate] of estimates) {
    const charge = chargeByOrder.get(orderId);
    if (charge && charge.billed !== null) daysToCompose.add(estimate.day);
  }

  let applied = 0;
  for (const day of daysToCompose) {
    const entry = costByDay.get(day);
    // Only days that actually have revenue in this window — never invent a day.
    if (!entry) continue;
    let product = 0;
    for (const [orderId, estimate] of estimates) {
      if (estimate.day !== day) continue;
      const charge = chargeByOrder.get(orderId);
      const rate = charge ? rateFor(charge.currency, day) : undefined;
      if (charge && charge.billed !== null && rate !== undefined) {
        product += charge.billed * rate;
        continue;
      }
      // Unquoted, or unconvertible: the order's own estimate stands, plus the
      // tariff the ERP already knows for it, if it can be read in our money.
      product += estimate.product;
      if (charge && rate !== undefined && charge.tariff > 0) product += charge.tariff * rate;
    }
    entry.product = product;
    applied += 1;
  }

  return applied;
}
