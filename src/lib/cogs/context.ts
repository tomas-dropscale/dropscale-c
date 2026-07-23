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
  const { data: products } = await supabase
    .from("store_products")
    .select("id, platform_key")
    .eq("ad_account_id", adAccountId);
  const keyById = new Map((products ?? []).map((row) => [row.id, row.platform_key]));
  const productIds = [...keyById.keys()];

  const manualCosts = new Map<string, ManualCost[]>();
  const tiers = new Map<string, CostTier[]>();
  const collections: CostContext["collections"] = [];

  if (productIds.length > 0) {
    const [costsRes, tiersRes, collectionsRes, membersRes, cTiersRes] = await Promise.all([
      supabase.from("product_costs").select("product_id, cost, currency, effective_from").in("product_id", productIds),
      supabase.from("product_cost_tiers").select("product_id, min_qty, total_cost").in("product_id", productIds),
      supabase.from("cogs_collections").select("id").eq("ad_account_id", adAccountId),
      supabase.from("cogs_collection_members").select("collection_id, product_id").in("product_id", productIds),
      supabase.from("cogs_collections").select("id, cogs_collection_tiers ( min_qty, total_cost )").eq("ad_account_id", adAccountId),
    ]);
    void collectionsRes;

    // Convert each cost currency once, lazily.
    const rateByCurrency = new Map<string, number>();
    for (const row of costsRes.data ?? []) {
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

    for (const row of tiersRes.data ?? []) {
      const key = keyById.get(row.product_id);
      if (!key) continue;
      const bucket = tiers.get(key) ?? [];
      bucket.push({ minQty: row.min_qty, totalCost: Number(row.total_cost) });
      tiers.set(key, bucket);
    }

    const membersByCollection = new Map<string, Set<string>>();
    for (const row of membersRes.data ?? []) {
      const key = keyById.get(row.product_id);
      if (!key) continue;
      const set = membersByCollection.get(row.collection_id) ?? new Set<string>();
      set.add(key);
      membersByCollection.set(row.collection_id, set);
    }

    for (const row of cTiersRes.data ?? []) {
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
