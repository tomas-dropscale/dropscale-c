/**
 * Narrowing a store's figures to the part Google could plausibly have earned.
 *
 * The agency sells Google ads. A report that answers "what did we make you"
 * with the shop's TOTAL revenue is answering a different question, because the
 * same shop also sells through Instagram and Facebook — traffic our spend had
 * nothing to do with. Migration 0019 already records the split per day
 * (`attributed_revenue` = gross revenue of orders NOT referred by Meta); this
 * module is what the report divides by.
 *
 * The awkward part is COST. We know which REVENUE was Meta's, but COGS, payment
 * fees and shipping are recorded for the day as a whole — nothing in the schema
 * ties a product cost back to the referrer of the order that incurred it. So
 * profit on the Google slice can only be apportioned: costs are assumed to fall
 * in the same proportion as revenue. That holds when Meta and Google orders look
 * alike (same catalogue, same shipping) and drifts when they do not — a store
 * whose Instagram traffic buys only the cheap SKU has its Google profit
 * understated here. It is an estimate, and the UI says so rather than printing
 * it as though it were measured.
 *
 * Pure and I/O-free so it can be unit-tested (google-attribution.test.ts).
 */

export type DayCosts = {
  /** Gross revenue, every channel — the denominator of the split. */
  revenue: number;
  refunds: number;
  productCost: number;
  paymentFees: number;
  shippingCost: number;
  /** Google ad spend. NOT apportioned: all of it is Google's by definition. */
  adSpend: number;
};

/**
 * What fraction of gross revenue was not Meta-referred, clamped to [0, 1].
 *
 * Returns 0 when nothing is known rather than 1: an unknown split must not
 * silently credit Google with the whole shop, which is the exact failure this
 * module exists to prevent. Callers pass `null` through as "not computed" and
 * render a dash instead of leaning on this value.
 */
export function googleShare(googleRevenue: number | null, grossRevenue: number): number {
  if (googleRevenue === null || grossRevenue <= 0) return 0;
  return Math.min(1, Math.max(0, googleRevenue / grossRevenue));
}

/**
 * Profit on the Google slice: its revenue, less its apportioned share of the
 * variable costs, less ALL the ad spend.
 *
 * Ad spend is deliberately not scaled — every euro of it was spent on Google,
 * so charging only a fraction to the Google slice would invent profit that the
 * store never made.
 *
 * Null in, null out: a window whose attribution has never been computed has no
 * honest profit figure, only a misleading one.
 */
export function googleProfit(googleRevenue: number | null, costs: DayCosts): number | null {
  if (googleRevenue === null) return null;

  const share = googleShare(googleRevenue, costs.revenue);
  const variable =
    (costs.refunds + costs.productCost + costs.paymentFees + costs.shippingCost) * share;

  return googleRevenue - variable - costs.adSpend;
}

/** Google revenue ÷ ad spend. The report's headline return. */
export function googleRoas(googleRevenue: number | null, adSpend: number): number {
  if (googleRevenue === null || adSpend <= 0) return 0;
  return googleRevenue / adSpend;
}

/** Sum that keeps "never computed" distinct from "computed, and zero". */
export function sumAttributed(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}
