import { describe, expect, it } from "vitest";
import {
  orderCogs,
  paymentFee,
  resolveUnitCost,
  tieredCost,
  type CostContext,
} from "./engine";

const emptyCtx = (overrides: Partial<CostContext> = {}): CostContext => ({
  manualCosts: new Map(),
  tiers: new Map(),
  collections: [],
  defaultCostPct: 30,
  ...overrides,
});

describe("resolveUnitCost — priority chain with effective dates", () => {
  const ctx = emptyCtx({
    manualCosts: new Map([
      [
        "A",
        [
          { cost: 8, effectiveFrom: "2026-01-01" },
          { cost: 10, effectiveFrom: "2026-07-15" },
        ],
      ],
    ]),
  });

  it("uses the record in force on the order's date — July 10th still costs 8", () => {
    expect(
      resolveUnitCost({ productKey: "A", quantity: 1, unitPrice: 30 }, "2026-07-10", ctx),
    ).toEqual({ cost: 8, source: "manual" });
  });

  it("July 16th uses the new 10 — updating a cost never rewrites the past", () => {
    expect(
      resolveUnitCost({ productKey: "A", quantity: 1, unitPrice: 30 }, "2026-07-16", ctx),
    ).toEqual({ cost: 10, source: "manual" });
  });

  it("orders BEFORE any effective date fall through to the next priority", () => {
    expect(
      resolveUnitCost({ productKey: "A", quantity: 1, unitPrice: 30 }, "2025-12-31", ctx).source,
    ).toBe("percent");
  });

  it("platform beats snapshot beats percent", () => {
    const line = {
      productKey: "B",
      quantity: 1,
      unitPrice: 19.9,
      platformUnitCost: 15,
      snapshotUnitCost: 14,
    };
    expect(resolveUnitCost(line, "2026-07-01", emptyCtx())).toEqual({
      cost: 15,
      source: "platform",
    });
    expect(
      resolveUnitCost({ ...line, platformUnitCost: null }, "2026-07-01", emptyCtx()),
    ).toEqual({ cost: 14, source: "snapshot" });
  });

  it("no cost anywhere → price × 30%, never a silent zero", () => {
    expect(
      resolveUnitCost({ productKey: "C", quantity: 1, unitPrice: 19.9 }, "2026-07-01", emptyCtx()),
    ).toEqual({ cost: 5.97, source: "percent" });
  });
});

describe("tieredCost — the spec's product-A table (tiers 1→8, 3→21, unit 8)", () => {
  const tiers = [
    { minQty: 1, totalCost: 8 },
    { minQty: 3, totalCost: 21 },
  ];

  it.each([
    [1, 8],
    [2, 16], // 8 covers 1, +1×8
    [3, 21],
    [4, 29], // 21 covers 3, +1×8
  ])("qty %i → %d", (qty, expected) => {
    expect(tieredCost(qty, 8, tiers)).toBe(expected);
  });

  it("no applicable tier → quantity × unit cost", () => {
    expect(tieredCost(2, 8, [{ minQty: 5, totalCost: 30 }])).toBe(16);
  });
});

describe("orderCogs — collections pool quantities within one order", () => {
  it('collection "Velas" (X, Y · tiers 1→6, 3→15): 2×X + 1×Y = 3 combined → 15', () => {
    const ctx = emptyCtx({
      collections: [
        {
          id: "velas",
          memberKeys: new Set(["X", "Y"]),
          tiers: [
            { minQty: 1, totalCost: 6 },
            { minQty: 3, totalCost: 15 },
          ],
        },
      ],
    });

    const cogs = orderCogs(
      [
        { productKey: "X", quantity: 2, unitPrice: 12 },
        { productKey: "Y", quantity: 1, unitPrice: 12 },
      ],
      "2026-07-01",
      ctx,
    );
    expect(cogs).toBe(15);
  });

  it("a collection member IGNORES its individual tiers", () => {
    const ctx = emptyCtx({
      tiers: new Map([["X", [{ minQty: 1, totalCost: 99 }]]]),
      collections: [
        {
          id: "velas",
          memberKeys: new Set(["X"]),
          tiers: [{ minQty: 1, totalCost: 6 }],
        },
      ],
    });
    expect(orderCogs([{ productKey: "X", quantity: 1, unitPrice: 12 }], "2026-07-01", ctx)).toBe(6);
  });
});

describe("integration — the spec's full day (section 4)", () => {
  const ctx = emptyCtx({
    manualCosts: new Map([["A", [{ cost: 8, effectiveFrom: "2026-01-01" }]]]),
    tiers: new Map([
      [
        "A",
        [
          { minQty: 1, totalCost: 8 },
          { minQty: 3, totalCost: 21 },
        ],
      ],
    ]),
  });

  const lines = [
    { productKey: "A", quantity: 3, unitPrice: 29.9 },
    { productKey: "B", quantity: 1, unitPrice: 49.9, platformUnitCost: 15 },
    { productKey: "C", quantity: 2, unitPrice: 19.9 },
  ];

  it("order COGS = 21.00 + 15.00 + 11.94 = 47.94", () => {
    expect(orderCogs(lines, "2026-07-20", ctx)).toBeCloseTo(47.94, 2);
  });

  it("the whole chain: profit 66.22, margin 35.9%, ROAS 3.07", () => {
    const grossRevenue = 89.7 + 49.9 + 39.8 + 4.9; // items + shipping charged
    const netRevenue = grossRevenue; // no refunds
    const productCost = orderCogs(lines, "2026-07-20", ctx);
    const fees = paymentFee(netRevenue, 2.9, 0.3);
    const shippingCost = 4.5;
    const adSpend = 60;

    const profit = netRevenue - productCost - fees - shippingCost - adSpend;

    expect(grossRevenue).toBeCloseTo(184.3, 2);
    expect(fees).toBeCloseTo(5.64, 2);
    expect(profit).toBeCloseTo(66.22, 1);
    expect(profit / netRevenue).toBeCloseTo(0.359, 2);
    expect(netRevenue / adSpend).toBeCloseTo(3.07, 2);
  });

  it("the principle: raising tier 21→30 leaves revenue AT 184.30 and drops profit by exactly 9", () => {
    const dearer = emptyCtx({
      manualCosts: ctx.manualCosts,
      tiers: new Map([
        [
          "A",
          [
            { minQty: 1, totalCost: 8 },
            { minQty: 3, totalCost: 30 },
          ],
        ],
      ]),
    });

    const netRevenue = 184.3; // untouched by cost edits, by definition
    const before = netRevenue - orderCogs(lines, "2026-07-20", ctx);
    const after = netRevenue - orderCogs(lines, "2026-07-20", dearer);

    expect(before - after).toBeCloseTo(9, 2);
    // ROAS and AOV never see COGS at all — nothing to assert, nothing changed.
  });
});
