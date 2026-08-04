import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class GoogleAuthRevokedError extends Error {}
  return { GoogleAuthRevokedError };
});

vi.mock("@/lib/google-ads/client", () => ({
  GoogleAuthRevokedError: mocks.GoogleAuthRevokedError,
}));

import { markIfAuthRevoked } from "./revoked";

function fakeSupabase() {
  const eq = vi.fn(async () => ({ error: null }));
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));
  return { client: { from } as never, from, update, eq };
}

describe("revoked per-client Google authorization", () => {
  it("marks the connection false without treating retained ciphertext as usable", async () => {
    const supabase = fakeSupabase();
    const error = new mocks.GoogleAuthRevokedError("invalid_grant");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      markIfAuthRevoked(supabase.client, "account-1", error),
    ).resolves.toBe(true);
    expect(supabase.from).toHaveBeenCalledWith("ad_accounts");
    expect(supabase.update).toHaveBeenCalledWith({
      google_ads_connected: false,
    });
    expect(supabase.eq).toHaveBeenCalledWith("id", "account-1");
  });

  it("does not mutate an account for a transient Google error", async () => {
    const supabase = fakeSupabase();

    await expect(
      markIfAuthRevoked(
        supabase.client,
        "account-2",
        new Error("temporary upstream failure"),
      ),
    ).resolves.toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
