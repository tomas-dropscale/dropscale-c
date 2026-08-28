import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applyHstCosts, type HstOrderCost } from "./hst-costs";

const ACCOUNT = "cc000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-27T09:00:00.000Z");
const TODAY = "2026-08-27";

type Row = Record<string, unknown>;

/**
 * A Supabase double that answers per table and records what was written, so a
 * test can assert the decision rather than the query builder.
 */
function service(seed: { products?: Row[]; costs?: Row[] } = {}) {
  const writes = {
    inserted: [] as Row[],
    updated: [] as { id: unknown; patch: Row }[],
    upserted: [] as Row[],
  };

  const from = vi.fn((table: string) => {
    if (table === "store_products") {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.in = async () => ({ data: seed.products ?? [], error: null });
      return q;
    }
    if (table === "product_costs") {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (column: string, value: unknown) => {
        if (column === "id") {
          return {
            then: (resolve: (v: unknown) => unknown) => {
              writes.updated[writes.updated.length - 1].id = value;
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
        }
        return q;
      };
      q.in = async () => ({ data: seed.costs ?? [], error: null });
      q.update = (patch: Row) => {
        writes.updated.push({ id: null, patch });
        return q;
      };
      q.insert = async (rows: Row[]) => {
        writes.inserted.push(...rows);
        return { error: null };
      };
      return q;
    }
    if (table === "hst_order_charges") {
      return {
        upsert: async (rows: Row[]) => {
          writes.upserted.push(...rows);
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { client: { from } as never, writes, from };
}

function order(overrides: Partial<HstOrderCost> = {}): HstOrderCost {
  return {
    platformOrderId: "8004536729939",
    orderDay: "2026-08-26",
    paidAt: "2026-08-26T14:50:04.000Z",
    tariff: 3,
    currency: "EUR",
    items: [{ keys: ["44551122"], unitCost: 20.99, currency: "EUR", quantity: 1 }],
    ...overrides,
  };
}

describe("HST supplier costs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a supplier cost against today, marked as the supplier's", async () => {
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
    });

    const outcome = await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [order()],
      now: NOW,
    });

    expect(outcome).toMatchObject({ written: 1, unchanged: 0, unknownProducts: 0 });
    expect(writes.inserted).toEqual([
      { product_id: "p1", cost: 20.99, currency: "EUR", effective_from: TODAY, source: "hst" },
    ]);
  });

  it("lets the most recent order set the price, not the loudest one", async () => {
    // A price list that changed last week must not be outvoted by the twenty
    // orders that came before it.
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
    });

    await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [
        order({ platformOrderId: "1", orderDay: "2026-08-20", items: [{ keys: ["44551122"], unitCost: 18, currency: "EUR", quantity: 1 }] }),
        order({ platformOrderId: "2", orderDay: "2026-08-26", items: [{ keys: ["44551122"], unitCost: 21.5, currency: "EUR", quantity: 1 }] }),
        order({ platformOrderId: "3", orderDay: "2026-08-22", items: [{ keys: ["44551122"], unitCost: 19, currency: "EUR", quantity: 1 }] }),
      ],
      now: NOW,
    });

    expect(writes.inserted).toHaveLength(1);
    expect(writes.inserted[0]).toMatchObject({ cost: 21.5 });
  });

  it("leaves today's row alone when the supplier repeats itself", async () => {
    // The supplier returns the same window every run; rewriting a row to the
    // value it already holds is a statement per product per hour, forever.
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
      costs: [{ id: "c1", product_id: "p1", cost: 20.99 }],
    });

    const outcome = await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [order()],
      now: NOW,
    });

    expect(outcome).toMatchObject({ written: 0, unchanged: 1 });
    expect(writes.inserted).toHaveLength(0);
    expect(writes.updated).toHaveLength(0);
  });

  it("supersedes today's supplier figure when the price moved", async () => {
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
      costs: [{ id: "c1", product_id: "p1", cost: 18 }],
    });

    const outcome = await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [order()],
      now: NOW,
    });

    expect(outcome).toMatchObject({ written: 1 });
    expect(writes.updated).toEqual([{ id: "c1", patch: { cost: 20.99, currency: "EUR" } }]);
  });

  it("falls back to the title for a store that sets no SKUs", async () => {
    // The Shopify sync keys products on `sku || title`. A store with no SKUs
    // is keyed by title, while HST still reports a variant id as platformSku —
    // matching on the SKU alone would find nothing for exactly those stores.
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "Handgjord väska med blommor" }],
    });

    const outcome = await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [
        order({
          items: [
            {
              keys: ["54120322990419", "Handgjord väska med blommor"],
              unitCost: 8.37,
              currency: "EUR",
              quantity: 1,
            },
          ],
        }),
      ],
      now: NOW,
    });

    expect(outcome).toMatchObject({ written: 1, unknownProducts: 0 });
    expect(writes.inserted[0]).toMatchObject({ product_id: "p1", cost: 8.37 });
  });

  it("waits for a product the store has never sold instead of inventing one", async () => {
    const { client, writes } = service({ products: [] });

    const outcome = await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [order()],
      now: NOW,
    });

    expect(outcome).toMatchObject({ written: 0, unknownProducts: 1 });
    expect(writes.inserted).toHaveLength(0);
    // The order's tariff is still real and still recorded.
    expect(outcome.charges).toBe(1);
  });

  it("keeps the tariff whole against its order, never split across articles", async () => {
    const { client, writes } = service({
      products: [
        { id: "p1", platform_key: "44551122" },
        { id: "p2", platform_key: "44551123" },
      ],
    });

    await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [
        order({
          items: [
            { keys: ["44551122"], unitCost: 10, currency: "EUR", quantity: 1 },
            { keys: ["44551123"], unitCost: 12, currency: "EUR", quantity: 2 },
          ],
        }),
      ],
      now: NOW,
    });

    expect(writes.upserted).toHaveLength(1);
    expect(writes.upserted[0]).toMatchObject({
      ad_account_id: ACCOUNT,
      platform_order_id: "8004536729939",
      order_day: "2026-08-26",
      tariff: 3,
      currency: "EUR",
    });
  });

  it("treats a destination with no tariff as zero, not as missing data", async () => {
    // UK and Japan orders come back with "-" from the supplier. That is a real
    // answer — no tariff is charged — and not a sync that failed.
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
    });

    await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [order({ tariff: 0 })],
      now: NOW,
    });

    expect(writes.upserted[0]).toMatchObject({ tariff: 0 });
  });

  it("does nothing at all when the supplier reported nothing", async () => {
    const { client, from } = service();

    const outcome = await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [],
      now: NOW,
    });

    expect(outcome).toMatchObject({ written: 0, charges: 0 });
    expect(from).not.toHaveBeenCalled();
  });
});
