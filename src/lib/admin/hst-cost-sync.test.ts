import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { FakeHstError } = vi.hoisted(() => ({
  FakeHstError: class FakeHstError extends Error {
    readonly unauthorized: boolean;
    constructor(message: string, unauthorized = false) {
      super(message);
      this.name = "HstError";
      this.unauthorized = unauthorized;
    }
  },
}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  hstGet: vi.fn(),
  clientHstToken: vi.fn(),
  noteClientHstError: vi.fn(),
  applyHstCosts: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/hst/erp", () => ({ HstError: FakeHstError, hstGet: mocks.hstGet }));
vi.mock("@/lib/portal/client-hst", () => ({
  clientHstToken: mocks.clientHstToken,
  noteClientHstError: mocks.noteClientHstError,
}));
vi.mock("./hst-costs", () => ({ applyHstCosts: mocks.applyHstCosts }));

import { syncHstCosts } from "./hst-cost-sync";

const SHOP = "2021639129";
const CLIENT = "aa000000-0000-4000-8000-000000000001";
const OTHER_CLIENT = "aa000000-0000-4000-8000-000000000002";
const ACCOUNT = "cc000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-28T09:00:00.000Z");

type Account = { id: string; client_id: string; hst_shop_id: string | null };

/**
 * A Supabase double answering the one account query this module makes.
 *
 * `.not(...)` is awaited directly when every mapped store is wanted, and
 * followed by `.in(ids)` when only some are — so what it returns has to be both
 * a thenable and a builder.
 */
function service(accounts: Account[]) {
  const narrowed: { ids?: string[] } = {};
  const answer = { data: accounts, error: null };

  const afterNot = {
    then: (resolve: (value: typeof answer) => unknown) => Promise.resolve(answer).then(resolve),
    in: async (_column: string, ids: string[]) => {
      narrowed.ids = ids;
      return { data: accounts.filter((row) => ids.includes(row.id)), error: null };
    },
  };

  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.not = () => afterNot;
  return { client: { from: vi.fn(() => query) } as never, narrowed };
}

/** One Order List page, with `paidTime` written the way the ERP writes it. */
function payload(orders: Array<{ id: string; paidTime: string; shopId?: string }>, lastPage = 1) {
  return {
    data: {
      last_page: lastPage,
      shop_list: [{ id: 2021639129, name: "AWU92655-STOCKHOLM SLOJD-B2B3A3" }],
      data: orders.map((order) => ({
        platformOrderId: order.id,
        shopId: order.shopId ?? SHOP,
        g_tariff: "3",
        g_currency: "EUR",
        paidTime: order.paidTime,
        items: [
          {
            platformSku: "DBAD4-GZ871158",
            originTitle: "Handgjord väska med blommor",
            baojia_price: "8.37",
            baojia_currency: "EUR",
            quantity: 1,
          },
        ],
      })),
    },
  };
}

const ONE_PAGE = () => payload([{ id: "8004536729939", paidTime: "2026-08-28 06:00:00" }]);

describe("HST cost sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientHstToken.mockResolvedValue("token-1");
    mocks.noteClientHstError.mockResolvedValue(undefined);
    mocks.hstGet.mockResolvedValue(ONE_PAGE());
    mocks.applyHstCosts.mockResolvedValue({
      written: 1,
      unchanged: 0,
      unknownProducts: 0,
      charges: 1,
    });
  });

  it("asks the supplier nothing when no store has a shop code", async () => {
    const result = await syncHstCosts({ client: service([]).client, now: NOW });

    expect(result).toMatchObject({ ok: true, accounts: 0, written: 0 });
    expect(mocks.hstGet).not.toHaveBeenCalled();
    expect(mocks.clientHstToken).not.toHaveBeenCalled();
  });

  it("prices a store with the session of the client who owns it", async () => {
    // The whole point of the per-client model: a supplier account sees its
    // owner's shop, so it is the only credential that may price these goods.
    const result = await syncHstCosts({
      client: service([{ id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP }]).client,
      now: NOW,
    });

    expect(mocks.clientHstToken).toHaveBeenCalledWith(expect.anything(), CLIENT);
    expect(result).toMatchObject({ ok: true, accounts: 1, written: 1, charges: 1 });
    const call = mocks.applyHstCosts.mock.calls[0][0];
    expect(call.adAccountId).toBe(ACCOUNT);
    expect(call.orders[0]).toMatchObject({ platformOrderId: "8004536729939", tariff: 3 });
  });

  it("signs a client in once however many stores they own", async () => {
    const second = "cc000000-0000-4000-8000-000000000009";
    await syncHstCosts({
      client: service([
        { id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP },
        { id: second, client_id: CLIENT, hst_shop_id: "2021640421" },
      ]).client,
      now: NOW,
    });

    expect(mocks.clientHstToken).toHaveBeenCalledTimes(1);
    expect(mocks.applyHstCosts).toHaveBeenCalledTimes(2);
  });

  it("never lets one client's session price another client's store", async () => {
    mocks.clientHstToken.mockImplementation(async (_service: unknown, clientId: string) =>
      clientId === CLIENT ? "token-a" : "token-b",
    );
    const seen: string[] = [];
    mocks.hstGet.mockImplementation(async (_url: string, token: string) => {
      seen.push(token);
      return ONE_PAGE();
    });

    await syncHstCosts({
      client: service([
        { id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP },
        { id: "cc000000-0000-4000-8000-000000000003", client_id: OTHER_CLIENT, hst_shop_id: "2021640421" },
      ]).client,
      now: NOW,
    });

    expect(seen).toEqual(["token-a", "token-b"]);
  });

  it("stops paging once the list reaches past the window", async () => {
    // The list is 221 pages and newest-first. Reading to the end every hour
    // would be thousands of requests for costs already known.
    mocks.hstGet.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return payload(
        [
          {
            id: `order-${page}`,
            // Page 1 is inside the 3-day window; page 2 is well outside it.
            paidTime: page === 1 ? "2026-08-28 06:00:00" : "2026-07-01 06:00:00",
          },
        ],
        5,
      );
    });

    const result = await syncHstCosts({
      client: service([{ id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP }]).client,
      now: NOW,
    });

    expect(mocks.hstGet).toHaveBeenCalledTimes(2);
    expect(result.pages).toBe(2);
    expect(
      mocks.applyHstCosts.mock.calls[0][0].orders.map(
        (order: { platformOrderId: string }) => order.platformOrderId,
      ),
    ).toEqual(["order-1"]);
  });

  it("renews a refused session once and carries on", async () => {
    let calls = 0;
    mocks.hstGet.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new FakeHstError("refused", true);
      return ONE_PAGE();
    });

    const result = await syncHstCosts({
      client: service([{ id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP }]).client,
      now: NOW,
    });

    expect(mocks.clientHstToken).toHaveBeenLastCalledWith(expect.anything(), CLIENT, {
      forceRenew: true,
    });
    expect(result).toMatchObject({ ok: true, written: 1 });
  });

  it("writes the reason against the client, who is the only one who can fix it", async () => {
    // Their cost page is the only place they would look, and a sync that fails
    // silently is indistinguishable from a supplier with nothing to report.
    mocks.clientHstToken.mockRejectedValue(new FakeHstError("HST refused those credentials."));

    const result = await syncHstCosts({
      client: service([{ id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP }]).client,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(mocks.noteClientHstError).toHaveBeenCalledWith(
      expect.anything(),
      CLIENT,
      expect.stringMatching(/refused/),
    );
  });

  it("clears a previous failure once a store syncs cleanly", async () => {
    await syncHstCosts({
      client: service([{ id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP }]).client,
      now: NOW,
    });

    expect(mocks.noteClientHstError).toHaveBeenCalledWith(expect.anything(), CLIENT, null);
  });

  it("lets one broken client fail without taking the others with it", async () => {
    const other = "cc000000-0000-4000-8000-000000000002";
    mocks.clientHstToken.mockImplementation(async (_service: unknown, clientId: string) => {
      if (clientId === CLIENT) throw new FakeHstError("no session");
      return "token-b";
    });

    const result = await syncHstCosts({
      client: service([
        { id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP },
        { id: other, client_id: OTHER_CLIENT, hst_shop_id: "2021640421" },
      ]).client,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.written).toBe(1);
    expect(result.stores[0].error).toMatch(/no session/);
    expect(result.stores[1]).toMatchObject({ adAccountId: other, written: 1 });
  });

  it("pulls one store on its own when asked", async () => {
    const other = "cc000000-0000-4000-8000-000000000002";
    const { client, narrowed } = service([
      { id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP },
      { id: other, client_id: OTHER_CLIENT, hst_shop_id: "2021640421" },
    ]);

    const result = await syncHstCosts({ client, adAccountIds: [ACCOUNT], now: NOW });

    expect(narrowed.ids).toEqual([ACCOUNT]);
    expect(result.accounts).toBe(1);
    expect(result.stores.map((store) => store.adAccountId)).toEqual([ACCOUNT]);
  });

  it("takes only the mapped shop's rows out of a shared page", async () => {
    mocks.hstGet.mockResolvedValue(
      payload([
        { id: "mine", paidTime: "2026-08-28 06:00:00" },
        { id: "theirs", paidTime: "2026-08-28 06:00:00", shopId: "2021635417" },
      ]),
    );

    await syncHstCosts({
      client: service([{ id: ACCOUNT, client_id: CLIENT, hst_shop_id: SHOP }]).client,
      now: NOW,
    });

    expect(
      mocks.applyHstCosts.mock.calls[0][0].orders.map(
        (order: { platformOrderId: string }) => order.platformOrderId,
      ),
    ).toEqual(["mine"]);
  });
});
