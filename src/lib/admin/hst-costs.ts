import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Supplier-reported costs, written into the cost chain 0009 already owns.
 *
 * The integration point is deliberately small. The metrics sync does not store
 * orders — it reads them from Shopify, prices them through orderCogs() against
 * the cost context, and lets them go. So a cost that lands in product_costs is
 * a cost that reaches the client's profit on the next sync, with no change to
 * the calculation and no second source of truth to keep in step.
 *
 * What this module owns is the writing: which product a supplier line refers
 * to, what counts as a change worth recording, and keeping the client's own
 * figures distinguishable from the supplier's.
 */

/** One order as the supplier reports it, already normalised off the wire. */
export type HstOrderCost = {
  /** The platform (Shopify) order id — what the metrics sync sees too. */
  platformOrderId: string;
  /** YYYY-MM-DD in the account's reporting zone, the day the order belongs to. */
  orderDay: string;
  /** When the customer paid, as a real instant — the day above is derived. */
  paidAt: string;
  /** EU/US import tariff for the whole order; 0 when the supplier sends "-". */
  tariff: number;
  currency: string;
  items: Array<{
    /**
     * Candidate store_products.platform_key values, best first.
     *
     * The Shopify sync keys products on `sku || title`, so which of the two a
     * store uses is the store's choice, not ours. HST reports both back and
     * the first that resolves against this store wins.
     */
    keys: string[];
    /** Cost of ONE unit, not the line total. */
    unitCost: number;
    currency: string;
    quantity: number;
  }>;
};

export type HstCostOutcome = {
  /** Products whose HST cost was written or updated. */
  written: number;
  /** Products already carrying today's HST cost, left untouched. */
  unchanged: number;
  /** Supplier lines for products this store has never sold. */
  unknownProducts: number;
  /** Orders whose tariff was recorded. */
  charges: number;
};

type Service = SupabaseClient<Database>;

const MONEY = 1e-4;

/** Today in the account's own terms — a date, never a timestamp. */
function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

type Wanted = { unitCost: number; currency: string; day: string };

/**
 * The supplier reports a cost per order line, and the same product appears in
 * many orders. The most recent order wins: a price list that changed last week
 * should not be outvoted by the twenty orders that preceded it.
 *
 * Resolution happens against keys the store actually has, so a line only counts
 * as unknown once every name HST offered for it has failed.
 */
function latestCostByProduct(
  orders: HstOrderCost[],
  idByKey: Map<string, string>,
): { wanted: Map<string, Wanted>; unknown: Set<string> } {
  const wanted = new Map<string, Wanted>();
  const unknown = new Set<string>();

  for (const order of orders) {
    for (const item of order.items) {
      if (!Number.isFinite(item.unitCost) || item.unitCost < 0) continue;
      const key = item.keys.find((candidate) => idByKey.has(candidate));
      if (!key) {
        // A product the store has never sold has no row yet. The Shopify sync
        // creates it from the line item; skipping is not a loss, only a wait.
        if (item.keys[0]) unknown.add(item.keys[0]);
        continue;
      }
      const productId = idByKey.get(key) as string;
      const seen = wanted.get(productId);
      if (!seen || order.orderDay >= seen.day) {
        wanted.set(productId, {
          unitCost: item.unitCost,
          currency: item.currency,
          day: order.orderDay,
        });
      }
    }
  }

  return { wanted, unknown };
}

/**
 * Write what the supplier reported for one store.
 *
 * Owner decision: HST wins and replaces. That is implemented as supersession,
 * not deletion — today's HST figure replaces today's HST figure, and every
 * dated fact before it stays exactly where it was, because 0009's promise is
 * that a cost written today never rewrites June's profit.
 */
export async function applyHstCosts(input: {
  service: Service;
  adAccountId: string;
  orders: HstOrderCost[];
  now?: Date;
}): Promise<HstCostOutcome> {
  const { service, adAccountId, orders } = input;
  const today = isoDay(input.now ?? new Date());
  const outcome: HstCostOutcome = {
    written: 0,
    unchanged: 0,
    unknownProducts: 0,
    charges: 0,
  };
  if (orders.length === 0) return outcome;

  const allKeys = [
    ...new Set(orders.flatMap((order) => order.items.flatMap((item) => item.keys))),
  ];
  if (allKeys.length > 0) {
    const { data: products, error: productsError } = await service
      .from("store_products")
      .select("id, platform_key")
      .eq("ad_account_id", adAccountId)
      .in("platform_key", allKeys);
    if (productsError) throw productsError;

    const idByKey = new Map(
      ((products ?? []) as Array<{ id: string; platform_key: string }>).map((row) => [
        row.platform_key,
        row.id,
      ]),
    );

    const { wanted, unknown } = latestCostByProduct(orders, idByKey);
    outcome.unknownProducts = unknown.size;

    const productIds = [...wanted.keys()];
    if (productIds.length > 0) {
      const { data: existing, error: existingError } = await service
        .from("product_costs")
        .select("id, product_id, cost")
        .eq("effective_from", today)
        .eq("source", "hst")
        .in("product_id", productIds);
      if (existingError) throw existingError;

      const currentByProduct = new Map(
        ((existing ?? []) as Array<{ id: string; product_id: string; cost: number }>).map(
          (row) => [row.product_id, row],
        ),
      );

      const inserts: Array<{
        product_id: string;
        cost: number;
        currency: string;
        effective_from: string;
        source: "hst";
      }> = [];
      for (const [productId, value] of wanted) {
        const current = currentByProduct.get(productId);
        // The supplier returns the same window every run. Rewriting a row to
        // the value it already holds is a statement per product per hour that
        // changes nothing.
        if (current && Math.abs(Number(current.cost) - value.unitCost) < MONEY) {
          outcome.unchanged += 1;
          continue;
        }
        if (current) {
          const { error } = await service
            .from("product_costs")
            .update({ cost: value.unitCost, currency: value.currency })
            .eq("id", current.id);
          if (error) throw error;
          outcome.written += 1;
          continue;
        }
        inserts.push({
          product_id: productId,
          cost: value.unitCost,
          currency: value.currency,
          effective_from: today,
          source: "hst",
        });
      }

      if (inserts.length > 0) {
        const { error } = await service.from("product_costs").insert(inserts);
        if (error) throw error;
        outcome.written += inserts.length;
      }
    }
  }

  // The tariff is per order and has no unit to attach to, so it is kept whole
  // against the order it was charged on.
  const charges = orders
    .filter((order) => Number.isFinite(order.tariff) && order.tariff >= 0)
    .map((order) => ({
      ad_account_id: adAccountId,
      platform_order_id: order.platformOrderId,
      order_day: order.orderDay,
      paid_at: order.paidAt,
      tariff: order.tariff,
      currency: order.currency,
      synced_at: new Date().toISOString(),
    }));
  if (charges.length > 0) {
    const { error } = await service
      .from("hst_order_charges")
      .upsert(charges, { onConflict: "ad_account_id,platform_order_id" });
    if (error) throw error;
    outcome.charges = charges.length;
  }

  return outcome;
}
