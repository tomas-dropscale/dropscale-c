import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptWindsorAccessToken: vi.fn(),
  pollLinkedGoogleAdsAccounts: vi.fn(),
  submitClientOnboardingSessionIfReady: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/windsor/client", () => ({
  decryptWindsorAccessToken: mocks.decryptWindsorAccessToken,
  pollLinkedGoogleAdsAccounts: mocks.pollLinkedGoogleAdsAccounts,
}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  submitClientOnboardingSessionIfReady: mocks.submitClientOnboardingSessionIfReady,
}));

import { finishAbandonedWindsorAuthorizations } from "./windsor-sweep";

const SESSION = "66000000-0000-4000-8000-000000000001";
const OTHER = "66000000-0000-4000-8000-000000000002";
const HASH = "c".repeat(64);

type Row = Record<string, unknown>;

/** Answers each table from a fixture; the filters are recorded, not applied. */
function fakeService(tables: Record<string, Row[]>, filters: Array<[string, string, unknown]> = []) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const record = (method: string) => (...args: unknown[]) => {
        filters.push([table, method, args]);
        return chain;
      };
      for (const method of ["select", "eq", "not", "gt", "contains", "in"]) chain[method] = record(method);
      chain.then = (resolve: (value: unknown) => unknown) =>
        resolve({ data: tables[table] ?? [], error: null });
      return chain;
    },
    rpc: mocks.rpc,
  };
}

function openSession(over: Row = {}): Row {
  return {
    id: SESSION,
    mode: "add_assets",
    requested_assets: ["google_ads", "shopify"],
    status: "collecting",
    invite_token_hash: HASH,
    invite_expires_at: "2099-01-01T00:00:00.000Z",
    claimed_user_id: "66000000-0000-4000-8000-000000000009",
    reconnect_completed_at: null,
    ...over,
  };
}

const LINKED = {
  status: "connected",
  attempts: 1,
  accounts: [
    {
      datasource: "google_ads",
      accountId: "756-774-4574",
      customerId: "7567744574",
      accountName: "Ito-Tsuzuri",
      status: null,
      currency: null,
      timeZone: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decryptWindsorAccessToken.mockResolvedValue("windsor-token");
  mocks.pollLinkedGoogleAdsAccounts.mockResolvedValue(LINKED);
  mocks.submitClientOnboardingSessionIfReady.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});

describe("finishing a Windsor authorization the client never came back for", () => {
  it("saves the linked accounts and closes the link, exactly as the button would", async () => {
    const service = fakeService({
      client_onboarding_sessions: [openSession()],
      client_onboarding_secrets: [{ session_id: SESSION, windsor_access_token_ciphertext: "ct" }],
      client_google_ads_connections: [],
    });

    const outcome = await finishAbandonedWindsorAuthorizations(service as never);

    expect(outcome).toEqual({ attempted: 1, connected: 1, completed: 1, failed: 0 });
    expect(mocks.decryptWindsorAccessToken).toHaveBeenCalledWith("ct");
    expect(mocks.pollLinkedGoogleAdsAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "windsor-token", maxAttempts: 1 }),
    );
    // The stored hash stands in for the token the browser would carry.
    expect(mocks.rpc).toHaveBeenCalledWith("upsert_client_google_ads_connections", {
      p_session_id: SESSION,
      p_token_hash: HASH,
      p_accounts: [
        {
          windsorAccountId: "756-774-4574",
          accountName: "Ito-Tsuzuri",
          currency: null,
          timeZone: null,
          dataSourceId: null,
        },
      ],
    });
    expect(mocks.submitClientOnboardingSessionIfReady).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: HASH, session: expect.objectContaining({ id: SESSION }) }),
    );
  });

  it("asks only about links that can still be used, and only for Google", async () => {
    // The gates the save RPC applies, sent to the database rather than
    // filtered here, so a link this sweep would be refused on is never read.
    const filters: Array<[string, string, unknown]> = [];
    await finishAbandonedWindsorAuthorizations(
      fakeService({ client_onboarding_sessions: [] }, filters) as never,
    );
    const sessionFilters = filters
      .filter(([table]) => table === "client_onboarding_sessions")
      .map(([, method, args]) => [method, ...(args as unknown[])]);
    expect(sessionFilters).toEqual(
      expect.arrayContaining([
        ["eq", "status", "collecting"],
        ["not", "claimed_user_id", "is", null],
        ["not", "invite_token_hash", "is", null],
        ["gt", "invite_expires_at", expect.any(String)],
        ["contains", "requested_assets", ["google_ads"]],
      ]),
    );
  });

  it("leaves alone a link with no authorization started, and one already connected", async () => {
    const service = fakeService({
      client_onboarding_sessions: [openSession(), openSession({ id: OTHER })],
      // SESSION never clicked "Create Google link"; OTHER did and its accounts
      // are already saved - it is open for another reason (a mapping to pick).
      client_onboarding_secrets: [{ session_id: OTHER, windsor_access_token_ciphertext: "ct" }],
      client_google_ads_connections: [{ session_id: OTHER }],
    });

    const outcome = await finishAbandonedWindsorAuthorizations(service as never);

    expect(outcome).toEqual({ attempted: 0, connected: 0, completed: 0, failed: 0 });
    expect(mocks.pollLinkedGoogleAdsAccounts).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does nothing when Windsor has nothing yet, and saves nothing", async () => {
    mocks.pollLinkedGoogleAdsAccounts.mockResolvedValue({ status: "pending", accounts: [], attempts: 1 });
    const service = fakeService({
      client_onboarding_sessions: [openSession()],
      client_onboarding_secrets: [{ session_id: SESSION, windsor_access_token_ciphertext: "ct" }],
      client_google_ads_connections: [],
    });

    const outcome = await finishAbandonedWindsorAuthorizations(service as never);

    expect(outcome).toEqual({ attempted: 1, connected: 0, completed: 0, failed: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submitClientOnboardingSessionIfReady).not.toHaveBeenCalled();
  });

  it("counts a link it could not finish and goes on to the next", async () => {
    // A link whose accounts are already active in another onboarding is
    // refused by the save RPC. That is one client's problem, not the hourly
    // sync's: the pass records it and finishes everyone else.
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "already active" } })
      .mockResolvedValueOnce({ data: null, error: null });
    const service = fakeService({
      client_onboarding_sessions: [openSession(), openSession({ id: OTHER })],
      client_onboarding_secrets: [
        { session_id: SESSION, windsor_access_token_ciphertext: "ct-1" },
        { session_id: OTHER, windsor_access_token_ciphertext: "ct-2" },
      ],
      client_google_ads_connections: [],
    });

    const outcome = await finishAbandonedWindsorAuthorizations(service as never);

    expect(outcome).toEqual({ attempted: 2, connected: 1, completed: 1, failed: 1 });
  });

  it("reports the accounts saved even when the link stays open for a mapping", async () => {
    mocks.submitClientOnboardingSessionIfReady.mockResolvedValue(false);
    const service = fakeService({
      client_onboarding_sessions: [openSession()],
      client_onboarding_secrets: [{ session_id: SESSION, windsor_access_token_ciphertext: "ct" }],
      client_google_ads_connections: [],
    });

    const outcome = await finishAbandonedWindsorAuthorizations(service as never);

    expect(outcome).toEqual({ attempted: 1, connected: 1, completed: 0, failed: 0 });
  });
});
