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
  } = {},
) {
  const hasSourceColumn = opts.hasSourceColumn ?? true;
  const refused = { data: null, error: { code: "42501", message: "permission denied" } };
  const asked: string[] = [];

  const from = vi.fn((table: string) => {
    if (table === "store_products") {
      return {
        select: () => ({
          eq: async () =>
            opts.refuse === "store_products"
              ? refused
              : { data: [{ id: "p1", platform_key: "SKU-1" }], error: null },
        }),
      };
    }
    if (table === "product_costs") {
      return {
        select: (columns: string) => {
          asked.push(columns);
          const wantsSource = columns.includes("source");
          return {
            in: async () =>
              wantsSource && !hasSourceColumn
                ? { data: null, error: { message: 'column "source" does not exist' } }
                : !wantsSource && opts.refuse === "legacy_costs"
                  ? refused
                  : {
                    data: costs.map((row) =>
                      wantsSource ? row : { ...row, source: undefined },
                    ),
                    error: null,
                  },
          };
        },
      };
    }
    // Tiers, collections and members are not what these tests are about.
    return {
      select: () => ({
        eq: async () => (opts.refuse === "tiers" ? refused : { data: [], error: null }),
        in: async () => (opts.refuse === "tiers" ? refused : { data: [], error: null }),
      }),
    };
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
});
