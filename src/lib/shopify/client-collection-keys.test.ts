import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shopify/referrer", () => ({ isMetaReferral: () => false }));

import {
  fetchCollectionProductKeys,
  readCollectionProductKeys,
  type ShopifyGraphqlExecutor,
} from "./client";

/**
 * Two readers of one collection's products, one contract each. The ledger's
 * (fetchCollectionProductKeys) never throws and bills on whatever it read.
 * The admin sheet's (readCollectionProductKeys) tells a collection the store
 * lacks (null) from a read that failed (rejects): the sheet drops a
 * campaign's basis on the first and keeps its last good snapshot on the
 * second, and a set cut short by a failed later page must never pass for the
 * whole membership.
 */

const SHOP = "northwind-demo.myshopify.com";
const TOKEN = "shpat_test";

function page(titles: string[], endCursor: string | null) {
  return {
    collectionByHandle: {
      products: {
        pageInfo: { hasNextPage: endCursor !== null, endCursor },
        nodes: titles.map((title) => ({
          title,
          variants: { nodes: [{ sku: ` ${title.toUpperCase()}-1 ` }, { sku: null }] },
        })),
      },
    },
  };
}

/** Answers the calls in order; an Error entry is thrown in its turn. */
function executor(answers: unknown[]): ShopifyGraphqlExecutor & { cursors: (string | null)[] } {
  const cursors: (string | null)[] = [];
  let call = 0;
  const run = async (
    _domain: string,
    _token: string,
    _query: string,
    variables?: Record<string, unknown>,
  ) => {
    cursors.push((variables?.cursor as string | null | undefined) ?? null);
    const answer = answers[call];
    call += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return Object.assign(run as ShopifyGraphqlExecutor, { cursors });
}

describe("readCollectionProductKeys (the admin sheet's read)", () => {
  it("collects SKUs and titles across pages, following the cursor", async () => {
    const graphql = executor([page(["Lamp"], "c1"), page(["Vase"], null)]);

    await expect(readCollectionProductKeys(SHOP, TOKEN, "best-sellers", graphql)).resolves.toEqual(
      new Set(["Lamp", "LAMP-1", "Vase", "VASE-1"]),
    );
    expect(graphql.cursors).toEqual([null, "c1"]);
  });

  it("answers null for a collection the store does not have", async () => {
    const graphql = executor([{ collectionByHandle: null }]);

    await expect(readCollectionProductKeys(SHOP, TOKEN, "renamed", graphql)).resolves.toBeNull();
  });

  it("answers an empty set for a collection with no products", async () => {
    const graphql = executor([page([], null)]);

    await expect(readCollectionProductKeys(SHOP, TOKEN, "empty", graphql)).resolves.toEqual(new Set());
  });

  it("rejects when a page cannot be read, the first or a later one", async () => {
    const throttled = new Error("Throttled");

    await expect(readCollectionProductKeys(SHOP, TOKEN, "x", executor([throttled]))).rejects.toBe(throttled);
    await expect(
      readCollectionProductKeys(SHOP, TOKEN, "x", executor([page(["Lamp"], "c1"), throttled])),
    ).rejects.toBe(throttled);
  });
});

describe("fetchCollectionProductKeys (the ledger's best-effort read)", () => {
  it("degrades to an empty set for a missing collection or a failed first page", async () => {
    await expect(
      fetchCollectionProductKeys(SHOP, TOKEN, "renamed", executor([{ collectionByHandle: null }])),
    ).resolves.toEqual(new Set());
    await expect(
      fetchCollectionProductKeys(SHOP, TOKEN, "x", executor([new Error("Throttled")])),
    ).resolves.toEqual(new Set());
  });

  it("keeps what it read when a later page fails", async () => {
    const graphql = executor([page(["Lamp"], "c1"), new Error("Throttled")]);

    await expect(fetchCollectionProductKeys(SHOP, TOKEN, "x", graphql)).resolves.toEqual(
      new Set(["Lamp", "LAMP-1"]),
    );
  });

  it("reads the same keys as the sheet's reader when every page answers", async () => {
    const answers = [page(["Lamp"], "c1"), page(["Vase"], null)];

    await expect(fetchCollectionProductKeys(SHOP, TOKEN, "x", executor(answers))).resolves.toEqual(
      await readCollectionProductKeys(SHOP, TOKEN, "x", executor(answers)),
    );
  });
});
