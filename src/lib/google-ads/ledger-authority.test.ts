import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  hasGoogleAdsEnv: vi.fn(),
  searchGoogleAds: vi.fn(),
  decryptToken: vi.fn(),
  markIfAuthRevoked: vi.fn(),
}));

vi.mock("@/lib/google-ads/env", () => ({
  hasGoogleAdsEnv: mocks.hasGoogleAdsEnv,
}));

vi.mock("@/lib/google-ads/client", () => ({
  searchGoogleAds: mocks.searchGoogleAds,
}));

vi.mock("@/lib/google-ads/crypto", () => ({
  decryptToken: mocks.decryptToken,
}));

vi.mock("@/lib/google-ads/revoked", () => ({
  markIfAuthRevoked: mocks.markIfAuthRevoked,
}));

import { withClientGoogleAds } from "./ledger-authority";

function fakeSupabase(result?: {
  data?: { google_ads_refresh_token: string | null } | null;
  error?: { message: string } | null;
}) {
  const maybeSingle = vi.fn(async () => ({
    data: result?.data ?? { google_ads_refresh_token: "encrypted-token" },
    error: result?.error ?? null,
  }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as never, from, select, eq, maybeSingle };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasGoogleAdsEnv.mockReturnValue(true);
  mocks.decryptToken.mockResolvedValue("plain-refresh-token");
  mocks.searchGoogleAds.mockResolvedValue([]);
  mocks.markIfAuthRevoked.mockResolvedValue(false);
});

describe("recurring ledger client Google connection", () => {
  it("loads, decrypts and uses only the selected account's OAuth token", async () => {
    const supabase = fakeSupabase();

    const result = await withClientGoogleAds(
      supabase.client,
      { id: "account-2", google_ads_connected: true },
      async (search) => {
        await search("1234567890", "metadata query");
        await search("1234567890", "spend query");
        return "client evidence";
      },
    );

    expect(result).toBe("client evidence");
    expect(supabase.from).toHaveBeenCalledWith("ad_accounts");
    expect(supabase.select).toHaveBeenCalledWith("google_ads_refresh_token");
    expect(supabase.eq).toHaveBeenCalledWith("id", "account-2");
    expect(mocks.decryptToken).toHaveBeenCalledWith("encrypted-token");
    expect(mocks.searchGoogleAds).toHaveBeenNthCalledWith(
      1,
      "1234567890",
      "plain-refresh-token",
      "metadata query",
    );
    expect(mocks.searchGoogleAds).toHaveBeenNthCalledWith(
      2,
      "1234567890",
      "plain-refresh-token",
      "spend query",
    );
  });

  it("never uses retained ciphertext for a disconnected account", async () => {
    const supabase = fakeSupabase();

    await expect(
      withClientGoogleAds(
        supabase.client,
        { id: "account-3", google_ads_connected: false },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/authorisation is disconnected/i);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(mocks.decryptToken).not.toHaveBeenCalled();
  });

  it("fails before secret access when the OAuth runtime is incomplete", async () => {
    mocks.hasGoogleAdsEnv.mockReturnValue(false);
    const supabase = fakeSupabase();

    await expect(
      withClientGoogleAds(
        supabase.client,
        { id: "account-4", google_ads_connected: true },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/client Google Ads OAuth is not configured/i);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("passes query failures to the established revocation handler and rethrows", async () => {
    const revoked = new Error("revoked");
    const supabase = fakeSupabase();
    mocks.searchGoogleAds.mockRejectedValueOnce(revoked);
    mocks.markIfAuthRevoked.mockResolvedValueOnce(true);

    await expect(
      withClientGoogleAds(
        supabase.client,
        { id: "account-5", google_ads_connected: true },
        async (search) => search("1234567890", "metadata query"),
      ),
    ).rejects.toBe(revoked);
    expect(mocks.markIfAuthRevoked).toHaveBeenCalledWith(
      supabase.client,
      "account-5",
      revoked,
    );
  });

  it("does not change connection state when ciphertext decryption fails", async () => {
    const decryptError = new Error("bad encryption key");
    const supabase = fakeSupabase();
    mocks.decryptToken.mockRejectedValueOnce(decryptError);

    await expect(
      withClientGoogleAds(
        supabase.client,
        { id: "account-6", google_ads_connected: true },
        async () => "unreachable",
      ),
    ).rejects.toBe(decryptError);
    expect(mocks.markIfAuthRevoked).not.toHaveBeenCalled();
  });

  it("fails closed when a connected row has no token", async () => {
    const supabase = fakeSupabase({
      data: { google_ads_refresh_token: null },
    });

    await expect(
      withClientGoogleAds(
        supabase.client,
        { id: "account-7", google_ads_connected: true },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/has no OAuth credential/i);
    expect(mocks.decryptToken).not.toHaveBeenCalled();
  });

  it("surfaces a server-side credential read error without touching the flag", async () => {
    const supabase = fakeSupabase({ error: { message: "database unavailable" } });

    await expect(
      withClientGoogleAds(
        supabase.client,
        { id: "account-8", google_ads_connected: true },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/could not load.*database unavailable/i);
    expect(mocks.markIfAuthRevoked).not.toHaveBeenCalled();
  });
});
