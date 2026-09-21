import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fxDailyRates: vi.fn(),
  rateOn: vi.fn(),
}));

vi.mock("@/lib/shopify/fx", () => ({
  fxDailyRates: mocks.fxDailyRates,
  rateOn: mocks.rateOn,
}));

import { loadCostContext } from "./context";

const ACCOUNT = "cc000000-0000-4000-8000-000000000001";
const TODAY = "2026-08-28";

type CostRow = {
  product_id: string;
  cost: number;
  currency: string;
  effective_from: string;
  source?: string;
};

/**
 * A Supabase double that can also refuse the `source` column, which is how a
 * database without migration 0087 answers.
 */
function service(
  costs: CostRow[],
  opts: {
    hasSourceColumn?: boolean;
    /** Which read comes back refused, the way RLS or a dropped grant answers. */
    refuse?: "store_products" | "legacy_costs" | "tiers";
    products?: { id: string; platform_key: string }[];
    tiers?: { product_id: string; min_qty: number; total_cost: number }[];
    members?: { collection_id: string; product_id: string }[];
    collections?: { id: string; cogs_collection_tiers: { min_qty: number; total_cost: number }[] }[];
    refuseProductId?: string;
    refusePage?: number;
  } = {},
) {
  const hasSourceColumn = opts.hasSourceColumn ?? true;
  const refused = { data: null, error: { code: "42501", message: "permission denied" } };
  const asked: string[] = [];

  const from = vi.fn((table: string) => {
    let columns = "";
    let ids: string[] | null = null;
    const query = {
      select: (value: string) => {
        columns = value;
        if (table === "product_costs") asked.push(value);
        return query;
      },
      eq: () => query,
      in: (_column: string, values: string[]) => { ids = values; return query; },
      order: () => query,
      range: async (start: number, end: number) => {
        // Reproduce the production gateway failure for an oversized URL.
        if (ids && ids.length > 100) return { data: null, error: { code: "URL_TOO_LONG" } };
        if (table === "store_products") {
          return opts.refuse === "store_products" || opts.refusePage === start
            ? refused
            : { data: (opts.products ?? [{ id: "p1", platform_key: "SKU-1" }]).slice(start, end + 1), error: null };
        }
        if (table === "product_costs") {
          const wantsSource = columns.includes("source");
          if (wantsSource && !hasSourceColumn) {
            return { data: null, error: { message: 'column "source" does not exist' } };
          }
          if ((!wantsSource && opts.refuse === "legacy_costs") ||
              (opts.refuseProductId && ids?.includes(opts.refuseProductId))) return refused;
          return {
            data: costs.filter(row => ids?.includes(row.product_id)).slice(start, end + 1)
              .map(row => wantsSource ? row : { ...row, source: undefined }),
            error: null,
          };
        }
        if (opts.refuse === "tiers") return refused;
        const rows = table === "product_cost_tiers"
          ? (opts.tiers ?? []).filter(row => ids?.includes(row.product_id))
          : table === "cogs_collection_members"
            ? (opts.members ?? []).filter(row => ids?.includes(row.product_id))
            : opts.collections ?? [];
        return { data: rows.slice(start, end + 1), error: null };
      },
    };
    return query;
  });

  return { client: { from } as never, asked };
}

describe("cost context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateOn.mockReturnValue(1);
    mocks.fxDailyRates.mockResolvedValue([]);
  });

  it("lets the supplier's figure win a same-day tie", async () => {
    // The engine breaks a tie on effective_from by row order, which is whatever
    // the database returned. The owner's rule is that HST wins and replaces,
    // and a rule that depends on row order is not a rule.
    const ctx = await loadCostContext(
      service([
        { product_id: "p1", cost: 25, currency: "EUR", effective_from: TODAY, source: "manual" },
        { product_id: "p1", cost: 8.37, currency: "EUR", effective_from: TODAY, source: "hst" },
      ]).client,
      ACCOUNT,
      30,
      "EUR",
    );

    expect(ctx.manualCosts.get("SKU-1")).toEqual([{ cost: 8.37, effectiveFrom: TODAY }]);
  });

  it("wins that tie whichever order the rows arrive in", async () => {
    const ctx = await loadCostContext(
      service([
        { product_id: "p1", cost: 8.37, currency: "EUR", effective_from: TODAY, source: "hst" },
        { product_id: "p1", cost: 25, currency: "EUR", effective_from: TODAY, source: "manual" },
      ]).client,
      ACCOUNT,
      30,
      "EUR",
    );

    expect(ctx.manualCosts.get("SKU-1")).toEqual([{ cost: 8.37, effectiveFrom: TODAY }]);
  });

  it("keeps every other day of the history intact", async () => {
    // Deduplicating per day must not collapse the history: June's orders still
    // have to resolve to June's cost.
    const ctx = await loadCostContext(
      service([
        { product_id: "p1", cost: 20, currency: "EUR", effective_from: "2026-06-01", source: "manual" },
        { product_id: "p1", cost: 8.37, currency: "EUR", effective_from: TODAY, source: "hst" },
      ]).client,
      ACCOUNT,
      30,
      "EUR",
    );

    expect(ctx.manualCosts.get("SKU-1")).toHaveLength(2);
  });

  it("still loads costs on a database without migration 0087", async () => {
    // PostgREST fails the whole select on an unknown column. Asking for source
    // unconditionally would take every store's COGS down between a deploy and
    // its migration.
    const { client, asked } = service(
      [{ product_id: "p1", cost: 20, currency: "EUR", effective_from: TODAY }],
      { hasSourceColumn: false },
    );

    const ctx = await loadCostContext(client, ACCOUNT, 30, "EUR");

    expect(asked[0]).toContain("source");
    expect(asked[1]).not.toContain("source");
    expect(ctx.manualCosts.get("SKU-1")).toEqual([{ cost: 20, effectiveFrom: TODAY }]);
  });

  it("fails closed when the catalogue is refused, instead of costing it by default", async () => {
    // A store with no products legitimately falls back to the percentage. A
    // refused read looked identical, so a fully costed catalogue was written
    // at the default too — and the difference lands in product_cost, in the
    // client's P&L and in what the agency invoices.
    await expect(
      loadCostContext(service([], { refuse: "store_products" }).client, ACCOUNT, 30, "EUR"),
    ).rejects.toThrow(/store products could not be read/i);
  });

  it("fails closed when the pre-0087 retry is refused rather than missing a column", async () => {
    await expect(
      loadCostContext(
        service([{ product_id: "p1", cost: 20, currency: "EUR", effective_from: TODAY }], {
          hasSourceColumn: false,
          refuse: "legacy_costs",
        }).client,
        ACCOUNT,
        30,
        "EUR",
      ),
    ).rejects.toThrow(/product costs could not be read/i);
  });

  it("fails closed when the tier tables are refused", async () => {
    // No tiers means a store that priced no packs; refused means packs we
    // cannot see, and costing those lines per unit undercharges every one.
    await expect(
      loadCostContext(
        service([{ product_id: "p1", cost: 20, currency: "EUR", effective_from: TODAY }], {
          refuse: "tiers",
        }).client,
        ACCOUNT,
        30,
        "EUR",
      ),
    ).rejects.toThrow(/cost tiers could not be read/i);
  });

  it("loads costs, packs and collection members beyond the first thousand products", async () => {
    const products = Array.from({ length: 1056 }, (_, i) => ({
      id: `p${i}`, platform_key: `SKU-${i}`,
    }));
    const ctx = await loadCostContext(service([
      { product_id: "p655", cost: 8.37, currency: "EUR", effective_from: TODAY },
      { product_id: "p1055", cost: 19, currency: "EUR", effective_from: TODAY },
    ], {
      products,
      tiers: [{ product_id: "p1055", min_qty: 2, total_cost: 30 }],
      members: [{ collection_id: "c1", product_id: "p655" }, { collection_id: "c1", product_id: "p1055" }],
      collections: [{ id: "c1", cogs_collection_tiers: [{ min_qty: 3, total_cost: 40 }] }],
    }).client, ACCOUNT, 30, "EUR");

    expect(ctx.manualCosts.get("SKU-655")).toEqual([{ cost: 8.37, effectiveFrom: TODAY }]);
    expect(ctx.manualCosts.get("SKU-1055")).toEqual([{ cost: 19, effectiveFrom: TODAY }]);
    expect(ctx.tiers.get("SKU-1055")).toEqual([{ minQty: 2, totalCost: 30 }]);
    expect(ctx.collections).toEqual([{
      id: "c1", memberKeys: new Set(["SKU-655", "SKU-1055"]),
      tiers: [{ minQty: 3, totalCost: 40 }],
    }]);
  });

  it("reads every cost history page within a product batch", async () => {
    const costs = Array.from({ length: 1101 }, (_, i) => ({
      product_id: "p1", cost: i + 1, currency: "EUR",
      effective_from: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    }));
    const ctx = await loadCostContext(service(costs).client, ACCOUNT, 30, "EUR");
    expect(ctx.manualCosts.get("SKU-1")).toHaveLength(1101);
    expect(ctx.manualCosts.get("SKU-1")?.at(-1)?.cost).toBe(1101);
  });

  it("refuses an incomplete cost context when a later batch fails", async () => {
    const products = Array.from({ length: 656 }, (_, i) => ({ id: `p${i}`, platform_key: `SKU-${i}` }));
    await expect(loadCostContext(service([
      { product_id: "p0", cost: 10, currency: "EUR", effective_from: TODAY },
    ], { products, refuseProductId: "p655" }).client, ACCOUNT, 30, "EUR"))
      .rejects.toThrow(/product costs could not be read/i);
  });

  it("refuses a catalogue when a later product page fails", async () => {
    const products = Array.from({ length: 656 }, (_, i) => ({ id: `p${i}`, platform_key: `SKU-${i}` }));
    await expect(loadCostContext(service([], { products, refusePage: 500 }).client, ACCOUNT, 30, "EUR"))
      .rejects.toThrow(/store products could not be read/i);
  });
});
