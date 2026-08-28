import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  hstAccessToken: vi.fn(),
  applyHstCosts: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("./hst", () => ({
  HstError: FakeHstError,
  hstAccessToken: mocks.hstAccessToken,
}));
vi.mock("./hst-costs", () => ({ applyHstCosts: mocks.applyHstCosts }));

import { syncHstCosts } from "./hst-cost-sync";

const SHOP = "2021639129";
const ACCOUNT = "cc000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-28T09:00:00.000Z");

/** A Supabase double answering the one account query this module makes. */
function service(accounts: Array<{ id: string; hst_shop_id: string | null }>) {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.not = () => Promise.resolve({ data: accounts, error: null });
  return { from: vi.fn(() => query) } as never;
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

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  } as unknown as Response;
}

describe("HST cost sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hstAccessToken.mockResolvedValue("token-1");
    mocks.applyHstCosts.mockResolvedValue({
      written: 1,
      unchanged: 0,
      unknownProducts: 0,
      charges: 1,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks the supplier nothing when no store is mapped to a shop", async () => {
    // One HST login sees ten shops. Without a mapping there is no way to know
    // which is this client's, and guessing writes another client's costs.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await syncHstCosts({ client: service([]), now: NOW });

    expect(result).toMatchObject({ ok: true, accounts: 0, written: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.hstAccessToken).not.toHaveBeenCalled();
  });

  it("passes the mapped store's orders through to the cost writer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(payload([{ id: "8004536729939", paidTime: "2026-08-28 06:00:00" }]))),
    );

    const result = await syncHstCosts({
      client: service([{ id: ACCOUNT, hst_shop_id: SHOP }]),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, accounts: 1, written: 1, charges: 1 });
    const call = mocks.applyHstCosts.mock.calls[0][0];
    expect(call.adAccountId).toBe(ACCOUNT);
    expect(call.orders).toHaveLength(1);
    expect(call.orders[0]).toMatchObject({ platformOrderId: "8004536729939", tariff: 3 });
  });

  it("stops paging once the list reaches past the window", async () => {
    // The list is 221 pages and newest-first. Reading to the end every hour
    // would be thousands of requests for orders whose costs are already known.
    const fetchSpy = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse(
        payload([
          {
            id: `order-${page}`,
            // Page 1 is inside the 3-day window; page 2 is well outside it.
            paidTime: page === 1 ? "2026-08-28 06:00:00" : "2026-07-01 06:00:00",
          },
        ],
        5,
      ),
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await syncHstCosts({
      client: service([{ id: ACCOUNT, hst_shop_id: SHOP }]),
      now: NOW,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.pages).toBe(2);
    // The out-of-window page contributes nothing.
    expect(mocks.applyHstCosts.mock.calls[0][0].orders.map((o: { platformOrderId: string }) => o.platformOrderId)).toEqual([
      "order-1",
    ]);
  });

  it("renews a refused session once and carries on", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: "expired" }, 401);
        return jsonResponse(payload([{ id: "8004536729939", paidTime: "2026-08-28 06:00:00" }]));
      }),
    );
    mocks.hstAccessToken.mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-2");

    const result = await syncHstCosts({
      client: service([{ id: ACCOUNT, hst_shop_id: SHOP }]),
      now: NOW,
    });

    expect(mocks.hstAccessToken).toHaveBeenLastCalledWith(expect.anything(), { forceRenew: true });
    expect(result).toMatchObject({ ok: true, written: 1 });
  });

  it("lets one broken store fail without taking the others with it", async () => {
    const other = "cc000000-0000-4000-8000-000000000002";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("shopIds=broken")
          ? jsonResponse({ error: "nope" }, 500)
          : jsonResponse(payload([{ id: "8004536729939", paidTime: "2026-08-28 06:00:00" }])),
      ),
    );

    const result = await syncHstCosts({
      client: service([
        { id: ACCOUNT, hst_shop_id: "broken" },
        { id: other, hst_shop_id: SHOP },
      ]),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.accounts).toBe(2);
    // The healthy store still had its costs written, and the log names the sick one.
    expect(result.written).toBe(1);
    expect(result.stores[0]).toMatchObject({ adAccountId: ACCOUNT });
    expect(result.stores[0].error).toMatch(/500/);
    expect(result.stores[1]).toMatchObject({ adAccountId: other, written: 1 });
  });

  it("reports a session it could not obtain instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    mocks.hstAccessToken.mockRejectedValue(new FakeHstError("No HST session saved yet."));

    const result = await syncHstCosts({
      client: service([{ id: ACCOUNT, hst_shop_id: SHOP }]),
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No HST session/);
  });

  it("takes only the mapped shop's rows out of a shared page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          payload([
            { id: "mine", paidTime: "2026-08-28 06:00:00" },
            { id: "theirs", paidTime: "2026-08-28 06:00:00", shopId: "2021635417" },
          ]),
        ),
      ),
    );

    await syncHstCosts({ client: service([{ id: ACCOUNT, hst_shop_id: SHOP }]), now: NOW });

    expect(
      mocks.applyHstCosts.mock.calls[0][0].orders.map((o: { platformOrderId: string }) => o.platformOrderId),
    ).toEqual(["mine"]);
  });
});
