/**
 * COGS engine — pure functions, no I/O, unit-tested against the spec's
 * worked examples (engine.test.ts).
 *
 * The one principle everything here serves:
 *
 *   COGS never changes REVENUE. It changes PROFIT and MARGIN.
 *   Revenue = what customers paid. COGS = what serving that cost.
 *   Raise a cost and revenue stays put while profit drops by exactly
 *   the same amount.
 *
 * Cost resolution per line item — first match wins:
 *   1. manual cost EFFECTIVE on the order's date (largest effective_from ≤ D)
 *   2. platform variant cost (e.g. Shopify inventory unit cost)
 *   3. the line's synced unit_cost snapshot
 *   4. selling price × defaultCostPct / 100 — a product with no cost must
 *      never silently count as zero.
 *
 * Tiers are per ORDER: they depend on how many units were bought TOGETHER.
 * The winning tier is the one with the largest min_qty ≤ quantity; it covers
 * min_qty units for total_cost and every unit above pays the resolved unit
 * cost. Collection members pool their quantities and use the collection's
 * tiers, ignoring their individual tiers.
 */

export type CostedLine = {
  /** Stable product key (platform variant id, else product id). */
  productKey: string;
  quantity: number;
  /** Unit selling price — the fallback base. */
  unitPrice: number;
  /** Priority 2: platform-reported unit cost, when the catalog gave one. */
  platformUnitCost?: number | null;
  /** Priority 3: unit cost snapshotted on the line at sync time. */
  snapshotUnitCost?: number | null;
};

export type ManualCost = {
  cost: number;
  /** ISO date; the record with the largest effective_from ≤ order day wins. */
  effectiveFrom: string;
};

export type CostTier = {
  minQty: number;
  /** TOTAL cost for minQty units — not per-unit. */
  totalCost: number;
};

export type CogsCollection = {
  id: string;
  memberKeys: ReadonlySet<string>;
  tiers: CostTier[];
};

export type CostContext = {
  /** productKey → manual cost history (any order; the engine sorts). */
  manualCosts: ReadonlyMap<string, ManualCost[]>;
  /** productKey → its own tiers. */
  tiers: ReadonlyMap<string, CostTier[]>;
  collections: CogsCollection[];
  /** Fallback percentage of the selling price (default 30). */
  defaultCostPct: number;
};

/** Priority chain of section 2. Exported for the UI's "source" badge. */
export function resolveUnitCost(
  line: CostedLine,
  orderDay: string,
  ctx: CostContext,
): { cost: number; source: "manual" | "platform" | "snapshot" | "percent" } {
  const history = ctx.manualCosts.get(line.productKey);
  if (history && history.length > 0) {
    // Largest effective_from ≤ orderDay. Editing a cost today NEVER rewrites
    // the past: June's orders keep resolving to June's record.
    let winner: ManualCost | null = null;
    for (const record of history) {
      if (record.effectiveFrom <= orderDay && (!winner || record.effectiveFrom > winner.effectiveFrom)) {
        winner = record;
      }
    }
    if (winner) return { cost: winner.cost, source: "manual" };
  }

  if (line.platformUnitCost != null && line.platformUnitCost > 0) {
    return { cost: line.platformUnitCost, source: "platform" };
  }
  if (line.snapshotUnitCost != null && line.snapshotUnitCost > 0) {
    return { cost: line.snapshotUnitCost, source: "snapshot" };
  }
  return { cost: (line.unitPrice * ctx.defaultCostPct) / 100, source: "percent" };
}

/**
 * Tier rule of section 3: the tier with the largest minQty ≤ quantity covers
 * minQty units at totalCost; the remainder pays unitCost each. No applicable
 * tier → quantity × unitCost.
 *
 * Spec examples (product tiers 1→8, 3→21, unit cost 8):
 *   qty 1 → 8 · qty 2 → 16 · qty 3 → 21 · qty 4 → 29
 */
export function tieredCost(quantity: number, unitCost: number, tiers: CostTier[]): number {
  let winner: CostTier | null = null;
  for (const tier of tiers) {
    if (tier.minQty <= quantity && (!winner || tier.minQty > winner.minQty)) {
      winner = tier;
    }
  }
  if (!winner) return quantity * unitCost;
  return winner.totalCost + (quantity - winner.minQty) * unitCost;
}

/**
 * COGS for ONE order (section 3). Collection members pool their quantities;
 * products with own tiers apply them to that product's total quantity in the
 * order; everything else is line-by-line.
 *
 * For pooled collections the "remainder unit cost" is the quantity-weighted
 * average of the members' resolved unit costs — the spec fixes the rule for
 * single products and is silent for mixed collections, so this is the
 * least-surprising reading. Documented on purpose.
 */
export function orderCogs(lines: CostedLine[], orderDay: string, ctx: CostContext): number {
  if (lines.length === 0) return 0;

  const collectionOf = new Map<string, CogsCollection>();
  for (const collection of ctx.collections) {
    for (const key of collection.memberKeys) collectionOf.set(key, collection);
  }

  let total = 0;
  const handled = new Set<string>();

  // --- collections: combined quantity across members in THIS order --------
  const byCollection = new Map<string, { collection: CogsCollection; lines: CostedLine[] }>();
  for (const line of lines) {
    const collection = collectionOf.get(line.productKey);
    if (!collection) continue;
    const bucket = byCollection.get(collection.id) ?? { collection, lines: [] };
    bucket.lines.push(line);
    byCollection.set(collection.id, bucket);
    handled.add(line.productKey);
  }

  for (const { collection, lines: memberLines } of byCollection.values()) {
    const combinedQty = memberLines.reduce((sum, line) => sum + line.quantity, 0);
    const weighted = memberLines.reduce(
      (sum, line) => sum + resolveUnitCost(line, orderDay, ctx).cost * line.quantity,
      0,
    );
    const averageUnitCost = combinedQty > 0 ? weighted / combinedQty : 0;
    total += tieredCost(combinedQty, averageUnitCost, collection.tiers);
  }

  // --- products with their own tiers: per-product total quantity ----------
  const byProduct = new Map<string, CostedLine[]>();
  for (const line of lines) {
    if (handled.has(line.productKey)) continue;
    const bucket = byProduct.get(line.productKey) ?? [];
    bucket.push(line);
    byProduct.set(line.productKey, bucket);
  }

  for (const [productKey, productLines] of byProduct) {
    const quantity = productLines.reduce((sum, line) => sum + line.quantity, 0);
    const unitCost = resolveUnitCost(productLines[0], orderDay, ctx).cost;
    const tiers = ctx.tiers.get(productKey);

    total += tiers && tiers.length > 0 ? tieredCost(quantity, unitCost, tiers) : quantity * unitCost;
  }

  return total;
}

/** Per-order payment fee (section 4): net × pct/100 + fixed. */
export function paymentFee(orderNet: number, feePct: number, feeFixed: number): number {
  return (orderNet * feePct) / 100 + feeFixed;
}
