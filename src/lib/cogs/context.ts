/**
 * Loads one account's cost configuration into the engine's CostContext, and
 * registers products discovered in synced orders.
 *
 * Currency: the context is built in the account's REPORTING currency. Manual
 * costs saved in another currency convert at the latest ECB rate (they are
 * configuration entered "today", not historical amounts); order-side numbers
 * convert per order-day in the rollup.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CostContext, CostTier, ManualCost } from "@/lib/cogs/engine";
import type { Database } from "@/lib/supabase/types";
import type { SyncedOrder } from "@/lib/shopify/client";
import { fxDailyRates, rateOn } from "@/lib/shopify/fx";

type Supabase = SupabaseClient<Database>;

// UUID filters become part of the request URL. A catalogue of 656 products
// exceeded the gateway limit and blocked the whole Shopify revenue refresh.
const ID_BATCH_SIZE = 50;
const READ_PAGE_SIZE = 500;

async function readPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  failure: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += READ_PAGE_SIZE) {
    const result = await page(offset, offset + READ_PAGE_SIZE - 1);
    if (result.error || !Array.isArray(result.data)) throw new Error(failure);
    rows.push(...result.data);
    if (result.data.length < READ_PAGE_SIZE) return rows;
  }
}

/** Latest single rate, via the same ECB series the revenue conversion uses. */
async function latestRate(base: string, quote: string): Promise<number> {
  if (base === quote) return 1;
  const today = new Date().toISOString().slice(0, 10);
  const pairs = await fxDailyRates(base, quote, today, today);
  return rateOn(pairs, today);
}

/**
 * Upsert every product seen in these orders — including ones sold but absent
 * from any catalog. `storeCurrency` labels the stored selling price.
 */
export async function registerSoldProducts(
  supabase: Supabase,
  adAccountId: string,
  orders: SyncedOrder[],
  storeCurrency: string,
): Promise<void> {
  const byKey = new Map<string, { title: string; price: number }>();
  for (const order of orders) {
    for (const line of order.lines) {
      if (!line.productKey) continue;
      // Last write wins — the most recent price seen is the one kept.
      byKey.set(line.productKey, { title: line.title, price: line.unitPrice });
    }
  }
  if (byKey.size === 0) return;

  const rows = [...byKey.entries()].map(([platform_key, info]) => ({
    ad_account_id: adAccountId,
    platform_key,
    title: info.title,
    price: info.price,
    currency: storeCurrency,
    source: "orders" as const,
    last_seen: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("store_products")
    .upsert(rows, { onConflict: "ad_account_id,platform_key" });
  if (error) throw error;
}

/** One stored cost, with where it came from when the column exists. */
type CostRow = {
  product_id: string;
  cost: number;
  currency: string;
  effective_from: string;
  source?: "manual" | "hst";
};

/**
 * The stored costs, asking for their provenance but not depending on it.
 *
 * `source` arrives with migration 0087. PostgREST fails the WHOLE select on an
 * unknown column, so asking for it unconditionally would take every store's
 * COGS down on any database where 0087 has not been applied yet — including
 * between a deploy and its migration. The retry keeps the old behaviour
 * exactly: no source column, everything reads as the merchant's own.
 */
async function fetchProductCosts(
  supabase: Supabase,
  productIds: string[],
): Promise<CostRow[]> {
  return readPages<CostRow>(async (from, to) => {
    const withSource = await supabase
      .from("product_costs")
      .select("product_id, cost, currency, effective_from, source")
      .in("product_id", productIds)
      .order("id")
      .range(from, to);
    if (!withSource.error) return withSource;

    // Preserve pre-0087 compatibility, but never accept a refused page as
    // an empty catalogue or publish only the batches that happened to work.
    return supabase
      .from("product_costs")
      .select("product_id, cost, currency, effective_from")
      .in("product_id", productIds)
      .order("id")
      .range(from, to);
  }, "The product costs could not be read.");
}

/**
 * Which of two costs effective on the SAME day for the same product stands.
 *
 * The engine picks the largest effective_from ≤ the order day, and breaks a tie
 * by whichever row it happened to see first — which is whatever order the
 * database returned. That is fine while every cost is the merchant's own, and
 * not fine once a supplier writes too: the owner's rule is that HST wins and
 * replaces, and a rule that depends on row order is not a rule.
 */
function preferred(a: CostRow, b: CostRow): CostRow {
  if (a.source === "hst" && b.source !== "hst") return a;
  if (b.source === "hst" && a.source !== "hst") return b;
  return a;
}

/**
 * Build the CostContext for an account, amounts in `reportingCurrency`.
 * Missing config degrades gracefully: no products/costs → every line falls
 * back to the default percentage, exactly as the spec's edge case demands.
 */
export async function loadCostContext(
  supabase: Supabase,
  adAccountId: string,
  defaultCostPct: number,
  reportingCurrency: string,
): Promise<CostContext> {
  // A store with no products degrades to the default percentage on purpose.
  // A read that was refused is not that store: it would put every line of a
  // fully costed catalogue on the default too, and the difference lands in
  // product_cost, in the client's P&L and in what the agency invoices.
  const products = await readPages(
    (from, to) => supabase.from("store_products")
      .select("id, platform_key").eq("ad_account_id", adAccountId)
      .order("id").range(from, to),
    "The store products could not be read for costing.",
  );
  const keyById = new Map(products.map((row) => [row.id, row.platform_key]));
  const productIds = [...keyById.keys()];

  const manualCosts = new Map<string, ManualCost[]>();
  const tiers = new Map<string, CostTier[]>();
  const collections: CostContext["collections"] = [];

  if (productIds.length > 0) {
    const costRows: CostRow[] = [];
    const tierRows: { product_id: string; min_qty: number; total_cost: number }[] = [];
    const memberRows: { collection_id: string; product_id: string }[] = [];
    for (let offset = 0; offset < productIds.length; offset += ID_BATCH_SIZE) {
      const ids = productIds.slice(offset, offset + ID_BATCH_SIZE);
      const [costs, productTiers, members] = await Promise.all([
        fetchProductCosts(supabase, ids),
        readPages(
          (from, to) => supabase.from("product_cost_tiers")
            .select("product_id, min_qty, total_cost").in("product_id", ids)
            .order("id").range(from, to),
          "The cost tiers could not be read.",
        ),
        readPages(
          (from, to) => supabase.from("cogs_collection_members")
            .select("collection_id, product_id").in("product_id", ids)
            .order("product_id").range(from, to),
          "The cost tiers could not be read.",
        ),
      ]);
      costRows.push(...costs);
      tierRows.push(...productTiers);
      memberRows.push(...members);
    }
    const collectionRows = await readPages(
      (from, to) => supabase.from("cogs_collections")
        .select("id, cogs_collection_tiers ( min_qty, total_cost )")
        .eq("ad_account_id", adAccountId).order("id").range(from, to),
      "The cost tiers could not be read.",
    );

    // One cost per product per day, decided here rather than by row order.
    const chosen = new Map<string, CostRow>();
    for (const row of costRows) {
      const slot = `${row.product_id}|${row.effective_from}`;
      const held = chosen.get(slot);
      chosen.set(slot, held ? preferred(held, row) : row);
    }

    // Convert each cost currency once, lazily.
    const rateByCurrency = new Map<string, number>();
    for (const row of chosen.values()) {
      let rate = rateByCurrency.get(row.currency);
      if (rate == null) {
        rate = await latestRate(row.currency, reportingCurrency);
        rateByCurrency.set(row.currency, rate);
      }
      const key = keyById.get(row.product_id);
      if (!key) continue;
      const bucket = manualCosts.get(key) ?? [];
      bucket.push({ cost: Number(row.cost) * rate, effectiveFrom: row.effective_from });
      manualCosts.set(key, bucket);
    }

    for (const row of tierRows) {
      const key = keyById.get(row.product_id);
      if (!key) continue;
      const bucket = tiers.get(key) ?? [];
      bucket.push({ minQty: row.min_qty, totalCost: Number(row.total_cost) });
      tiers.set(key, bucket);
    }

    const membersByCollection = new Map<string, Set<string>>();
    for (const row of memberRows) {
      const key = keyById.get(row.product_id);
      if (!key) continue;
      const set = membersByCollection.get(row.collection_id) ?? new Set<string>();
      set.add(key);
      membersByCollection.set(row.collection_id, set);
    }

    for (const row of collectionRows) {
      const memberKeys = membersByCollection.get(row.id);
      if (!memberKeys || memberKeys.size === 0) continue;
      collections.push({
        id: row.id,
        memberKeys,
        tiers: (row.cogs_collection_tiers ?? []).map((tier) => ({
          minQty: tier.min_qty,
          totalCost: Number(tier.total_cost),
        })),
      });
    }
  }

  return { manualCosts, tiers, collections, defaultCostPct };
}
