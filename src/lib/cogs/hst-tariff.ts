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
 * real per-order total (goods + tariff). This buckets it to the order's day from
 * the paid_at instant IN THE STORE'S ZONE — the same zone the revenue was
 * bucketed in, so cost and revenue land together — and OVERWRITES that day's
 * product cost with the sum.
 *
 * Only days the supplier has actually priced are touched. A day with revenue but
 * no quoted order keeps the per-product estimate `addHstTariffs` already left,
 * so a not-yet-quoted order is a wait, not a zero. Call this AFTER addHstTariffs:
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
  /** The store's reporting zone — bucket paid_at the way the revenue was. */
  timeZone: string;
  costByDay: CostByDay;
}): Promise<number> {
  const { service, adAccountId, from, to, reportingCurrency, timeZone, costByDay } = input;
  if (costByDay.size === 0) return 0;

  // order_day is stored in UTC; the store's day can fall a calendar day either
  // side, so pad the fetch and re-bucket precisely from paid_at below.
  const shift = (day: string, delta: number) => {
    const dt = new Date(`${day}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  };

  const { data, error } = await service
    .from("hst_order_charges")
    .select("order_day, paid_at, our_cost, currency")
    .eq("ad_account_id", adAccountId)
    .gte("order_day", shift(from, -1))
    .lte("order_day", shift(to, 1))
    .not("our_cost", "is", null);
  if (error) {
    console.error(`HST order costs not applied for ${adAccountId}: ${error.message}`);
    return 0;
  }

  const rows = (data ?? []) as Array<{
    order_day: string;
    paid_at: string | null;
    our_cost: number;
    currency: string;
  }>;
  if (rows.length === 0) return 0;

  const dayFor = (row: { paid_at: string | null; order_day: string }): string => {
    if (!row.paid_at) return row.order_day;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(row.paid_at));
  };

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

  // Sum the actual per-order cost into the store-zone day it belongs to.
  const totalByDay = new Map<string, number>();
  for (const row of rows) {
    const amount = Number(row.our_cost);
    if (!Number.isFinite(amount) || amount < 0) continue;
    const pairs = series.get(row.currency);
    if (pairs === undefined) continue;
    if (pairs === null && row.currency !== reportingCurrency) continue;
    const day = dayFor(row);
    totalByDay.set(day, (totalByDay.get(day) ?? 0) + amount * (pairs ? rateOn(pairs, day) : 1));
  }

  let applied = 0;
  for (const [day, total] of totalByDay) {
    const entry = costByDay.get(day);
    // Only days that actually have revenue in this window — never invent a day.
    if (!entry) continue;
    entry.product = total;
    applied += 1;
  }

  return applied;
}
