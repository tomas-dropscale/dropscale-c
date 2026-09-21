import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/google-ads/crypto", () => ({
  encryptToken: async (value: string) => value,
  decryptToken: async (value: string) => value,
}));
vi.mock("@/lib/finance/config", () => import("../finance/config"));
vi.mock("@/lib/admin/hst-token", () => import("./hst-token"));
vi.mock("@/lib/admin/hst-parse", () => import("./hst-parse"));

import { fetchHstCommissions, syncHstCommission } from "./hst";

const fetchMock = vi.fn();
const refused = () => Response.json({ code: 401, message: "Unauthorized.", data: null });
const empty = () => Response.json({ code: 0, data: { data: [], all: { total: "0" } } });

/** Only session reads/writes and source lookup are allowed on these failures. */
function service() {
  const update = vi.fn(() => ({ eq: async () => ({ error: null }) }));
  const from = vi.fn((table: string) => {
    if (table === "hst_integration") {
      return {
        select: () => ({
          maybeSingle: async () => ({
            data: {
              access_token: "old-token",
              refresh_token: "refresh-token",
              token_expires_at: "2099-01-01T00:00:00Z",
            },
          }),
        }),
        update,
      };
    }
    if (table === "revenue_sources") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "hst" } }) }) }),
      };
    }
    throw new Error(`Unexpected ledger access: ${table}`);
  });
  return { client: { from } as never, from, update };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("HST commission response validation", () => {
  it.each([401, 403, "401", "403"])("recognises HTTP 200 with auth code %s", async (code) => {
    fetchMock.mockResolvedValue(Response.json({ code, data: null }));
    await expect(fetchHstCommissions("token")).rejects.toMatchObject({ unauthorized: true });
  });

  it("does not mistake genuine empty commission rows for expired authentication", async () => {
    fetchMock.mockResolvedValue(empty());
    await expect(fetchHstCommissions("token")).resolves.toMatchObject({ entries: [], rowCount: 0 });
  });

  it.each([{ code: 500, data: null }, { success: false, data: null }, { code: 0, data: null }])(
    "refuses other unsuccessful or malformed envelopes without an auth retry",
    async (body) => {
      fetchMock.mockResolvedValue(Response.json(body));
      await expect(fetchHstCommissions("token")).rejects.toMatchObject({ unauthorized: false });
    },
  );

  it("rejects a later page auth failure instead of accepting partial commissions", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ data: { data: [], last_page: 2 } }))
      .mockResolvedValueOnce(refused());
    await expect(fetchHstCommissions("token")).rejects.toMatchObject({ unauthorized: true });
  });
});

describe("HST renewal and ledger preservation", () => {
  it("retries the commission request once with the renewed token", async () => {
    const db = service();
    fetchMock
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(Response.json({ data: { accessToken: "renewed-token" } }))
      .mockResolvedValueOnce(empty());

    const result = await syncHstCommission({ force: true, client: db.client });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("https://hsterp.com/refresh-token");
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer renewed-token");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no commission rows") });
    expect(db.from).not.toHaveBeenCalledWith("commissions");
  });

  it("stops after a renewed token is also refused and preserves the ledger", async () => {
    const db = service();
    fetchMock
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(Response.json({ data: { accessToken: "renewed-token" } }))
      .mockResolvedValueOnce(refused());

    const result = await syncHstCommission({ force: true, client: db.client });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("renewal was attempted") });
    expect(db.from).not.toHaveBeenCalledWith("commissions");
    expect(db.update).toHaveBeenLastCalledWith(expect.objectContaining({ last_error: result.error }));
  });

  it("requests a new login when renewal fails without touching commissions", async () => {
    const db = service();
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(refused());

    const result = await syncHstCommission({ force: true, client: db.client });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("sign in to HST again") });
    expect(db.from).not.toHaveBeenCalledWith("commissions");
  });
});
