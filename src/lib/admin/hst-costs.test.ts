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
    baseOrderId: "8004536729939",
    split: false,
    coveredByParent: null,
    orderDay: "2026-08-26",
    unquotedLines: 0,
    linesTotal: 20.99,
    tariff: 3,
    totalCost: 23.99,
    discount: 0,
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

  it("books the supplier's total as the order's charge, and keeps no instant beside the day", async () => {
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
    });

    await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [order({ totalCost: 23.99, currency: "USD" })],
      now: NOW,
    });

    expect(writes.upserted[0]).toMatchObject({ our_cost: 23.99, currency: "USD", paid_at: null });
  });

  it("charges a package nothing when its parent's bill already holds it", async () => {
    // 8110621458771 bills 112.80 for every package's lines plus one tariff;
    // "_1" carries its own 19.02 and tariff 3.44 in the ERP's books and is
    // settled at nothing. Booked as its own charge, the day counted it twice.
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
    });

    await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [
        order({ platformOrderId: "8110621458771", baseOrderId: "8110621458771", totalCost: 112.8, tariff: 3.44 }),
        order({
          platformOrderId: "8110621458771_1",
          baseOrderId: "8110621458771",
          split: true,
          coveredByParent: true,
          totalCost: 19.02,
          tariff: 3.44,
        }),
      ],
      now: NOW,
    });

    expect(writes.upserted.map((row) => [row.platform_order_id, row.our_cost, row.tariff])).toEqual([
      ["8110621458771", 112.8, 3.44],
      ["8110621458771_1", 0, 0],
    ]);
  });

  it("bills a package on its own when the parent's bill does not carry it", async () => {
    // Stockholm Slojd's multi-package families: the parent holds its own
    // lines only and each package carries real cost, tariff included.
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
    });

    await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [
        order({ platformOrderId: "7987533316435", baseOrderId: "7987533316435", totalCost: 32.65, tariff: 3 }),
        order({
          platformOrderId: "7987533316435_1",
          baseOrderId: "7987533316435",
          split: true,
          coveredByParent: false,
          totalCost: 55.09,
          tariff: 3,
        }),
      ],
      now: NOW,
    });

    expect(writes.upserted.map((row) => [row.platform_order_id, row.our_cost, row.tariff])).toEqual([
      ["7987533316435", 32.65, 3],
      ["7987533316435_1", 55.09, 3],
    ]);
  });

  it("writes a wait, never a known zero, for anything the ERP has not named", async () => {
    // A covered package with no figure and an unquoted line (the fourth item
    // of 8015506997587, waiting for its quote), a package whose parent was
    // not collected, and a row with no figure at all: each is null, so the
    // reach-back re-reads it — a 0 would have closed the book on money still
    // to come. The undecided package carries no tariff: what it shows is the
    // parent's, copied.
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
    });

    await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [
        order({ platformOrderId: "8015506997587_1", baseOrderId: "8015506997587", split: true, coveredByParent: true, unquotedLines: 1, linesTotal: 0, totalCost: 0, tariff: 0 }),
        order({ platformOrderId: "orphan_1", baseOrderId: "orphan", split: true, coveredByParent: null, totalCost: 18.58, tariff: 3 }),
        order({ platformOrderId: "no-figure", totalCost: 0, tariff: 0 }),
      ],
      now: NOW,
    });

    expect(writes.upserted.map((row) => [row.platform_order_id, row.our_cost, row.tariff])).toEqual([
      ["8015506997587_1", null, 0],
      ["orphan_1", null, 0],
      ["no-figure", null, 0],
    ]);
  });

  it("bills a row the ERP has priced even when one of its lines is unquoted", async () => {
    // Stockholm Slojd sells shipping protection on half its orders and the
    // supplier never quotes it — the line is an upsell, not a wait. The
    // total the ERP names already says what it covers; nulling the row would
    // have swapped a real bill for a guess, on half the store, for good.
    const { client, writes } = service({
      products: [{ id: "p1", platform_key: "44551122" }],
    });

    await applyHstCosts({
      service: client,
      adAccountId: ACCOUNT,
      orders: [order({ unquotedLines: 1, totalCost: 23.99, tariff: 3 })],
      now: NOW,
    });

    expect(writes.upserted[0]).toMatchObject({ our_cost: 23.99, tariff: 3 });
  });
});
