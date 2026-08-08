import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/google-ads/billing-start", () => ({
  captureGoogleBillingStartAsAgency: mocks.capture,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import { POST } from "./route";

type QueryResult = { data: Record<string, unknown> | null; error: null | { message: string } };

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000010";
const REQUEST_ID = "00000000-0000-4000-8000-000000000011";
const ADMIN_ID = "00000000-0000-4000-8000-000000000012";

function session({
  userId = ADMIN_ID,
  role = "admin",
  account = null,
  accountRequest = null,
  billingStart = null,
}: {
  userId?: string | null;
  role?: string | null;
  account?: Record<string, unknown> | null;
  accountRequest?: Record<string, unknown> | null;
  billingStart?: Record<string, unknown> | null;
} = {}) {
  const result = (data: Record<string, unknown> | null): QueryResult => ({ data, error: null });

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
      })),
    },
    from: vi.fn((table: string) => {
      const data =
        table === "profiles"
          ? userId && role
            ? { id: userId, role }
            : null
          : table === "ad_accounts"
            ? account
            : table === "account_requests"
              ? accountRequest
              : table === "ad_account_billing_starts"
                ? billingStart
                : null;
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => result(data)),
          })),
        })),
      };
    }),
  };
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/google-ads/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const captured = {
  google_ads_customer_id: "1234567890",
  google_local_date: "2026-08-03",
  google_time_zone: "Europe/Lisbon",
  currency: "EUR",
  baseline_cost_micros: "123456789",
  capture_started_at: "2026-08-03T12:00:00.000Z",
  captured_at: "2026-08-03T12:00:01.000Z",
  capture_id: "10000000-0000-4000-8000-000000000001",
  source: "agency",
} as const;

describe("admin Google billing activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it("accepts exactly one accountId or requestId", async () => {
    const neither = await POST(request({}));
    const both = await POST(request({ accountId: ACCOUNT_ID, requestId: REQUEST_ID }));
    const extra = await POST(request({ accountId: ACCOUNT_ID, surprise: true }));
    const invalid = await POST(request({ accountId: "not-a-uuid" }));

    expect(neither.status).toBe(400);
    expect(both.status).toBe(400);
    expect(extra.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("does not open Google or service access before authenticating an admin", async () => {
    mocks.createClient.mockResolvedValue(session({ userId: null }));

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(401);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not let an authenticated non-admin reach Google or the service client", async () => {
    mocks.createClient.mockResolvedValue(session({ role: "client" }));

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(403);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("leaves a pending account untouched when the live Google read fails", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        account: {
          id: ACCOUNT_ID,
          store_name: "Lisbon Store",
          google_ads_customer_id: "123-456-7890",
          status: "pending",
        },
      }),
    );
    mocks.capture.mockRejectedValue(new Error("agency account has no access"));

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(502);
    expect(mocks.capture).toHaveBeenCalledWith("1234567890");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not recapture an account that already has an opening counter", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        account: {
          id: ACCOUNT_ID,
          store_name: "Lisbon Store",
          google_ads_customer_id: "1234567890",
          status: "active",
        },
        billingStart: { id: captured.capture_id },
      }),
    );

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(409);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes one complete live receipt to the atomic account commit", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        account: {
          id: ACCOUNT_ID,
          store_name: "Lisbon Store",
          google_ads_customer_id: "1234567890",
          status: "pending",
        },
      }),
    );
    mocks.capture.mockResolvedValue(captured);
    mocks.rpc.mockResolvedValue({
      data: [{ id: ACCOUNT_ID, store_name: "Lisbon Store", status: "active" }],
      error: null,
    });

    const response = await POST(request({ accountId: ACCOUNT_ID }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("commit_google_ads_billing_start", {
      p_account_id: ACCOUNT_ID,
      p_request_id: null,
      p_capture_id: captured.capture_id,
      p_google_ads_customer_id: captured.google_ads_customer_id,
      p_google_local_date: captured.google_local_date,
      p_google_time_zone: captured.google_time_zone,
      p_currency: captured.currency,
      p_baseline_cost_micros: captured.baseline_cost_micros,
      p_capture_started_at: captured.capture_started_at,
      p_captured_at: captured.captured_at,
      p_source: captured.source,
      p_reviewed_by: ADMIN_ID,
    });
    expect(payload).toMatchObject({
      ok: true,
      account: { id: ACCOUNT_ID, status: "active" },
      billingStart: {
        baselineCostMicros: captured.baseline_cost_micros,
        googleLocalDate: captured.google_local_date,
      },
    });
  });

  it("does not fall back to a direct status write when the atomic commit rejects", async () => {
    const viewer = session({
      account: {
        id: ACCOUNT_ID,
        store_name: "Lisbon Store",
        google_ads_customer_id: "1234567890",
        status: "pending",
      },
    });
    mocks.createClient.mockResolvedValue(viewer);
    mocks.capture.mockResolvedValue(captured);
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "The account changed during review." },
    });

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(409);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(viewer.from).toHaveBeenCalledWith("ad_accounts");
    expect(viewer.from).toHaveBeenCalledWith("ad_account_billing_starts");
  });

  it("provisions a pending Google request only through the same atomic commit", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        accountRequest: {
          id: REQUEST_ID,
          request_type: "google_ads",
          google_ads_customer_id: "1234567890",
          store_name: "Porto Store",
          status: "pending",
        },
      }),
    );
    mocks.capture.mockResolvedValue(captured);
    mocks.rpc.mockResolvedValue({
      data: [{ id: "account-2", store_name: "Porto Store", status: "active" }],
      error: null,
    });

    const response = await POST(request({ requestId: REQUEST_ID }));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "commit_google_ads_billing_start",
      expect.objectContaining({
        p_account_id: null,
        p_request_id: REQUEST_ID,
        p_google_ads_customer_id: "1234567890",
      }),
    );
  });
});

describe("when the agency has no Google access yet", () => {
  const denied = new Error(
    'Google Ads query failed for 1234567890 (403): {"authorizationError":"USER_PERMISSION_DENIED"}',
  );

  /**
   * Table-aware PostgREST double. The previous version shared one builder for
   * every table and was not awaitable, so the approval write silently resolved
   * to the builder itself and its failure branch was untestable.
   */
  function serviceDouble(options: {
    existingAccount?: Record<string, unknown> | null;
    insertResult?: { data: Record<string, unknown> | null; error: { message: string } | null };
    approveError?: { message: string } | null;
  } = {}) {
    const calls = {
      insertedInto: [] as string[],
      inserted: [] as Record<string, unknown>[],
      approvedRequests: [] as Record<string, unknown>[],
      selectedAccountBy: [] as string[],
    };

    const from = vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;

      chain.select = vi.fn(self);
      chain.eq = vi.fn((column: string, value: unknown) => {
        if (table === "ad_accounts" && column === "google_ads_customer_id") {
          calls.selectedAccountBy.push(String(value));
        }
        return chain;
      });
      chain.insert = vi.fn((row: Record<string, unknown>) => {
        calls.insertedInto.push(table);
        calls.inserted.push(row);
        return chain;
      });
      chain.update = vi.fn((row: Record<string, unknown>) => {
        if (table === "account_requests") calls.approvedRequests.push(row);
        return chain;
      });
      chain.maybeSingle = vi.fn(async () => {
        if (calls.inserted.length > 0 && table === "ad_accounts") {
          return (
            options.insertResult ?? {
              data: { id: ACCOUNT_ID, store_name: "New Store", status: "pending" },
              error: null,
            }
          );
        }
        return { data: options.existingAccount ?? null, error: null };
      });
      // The approval write ends on .eq() and is awaited directly.
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ error: options.approveError ?? null }).then(resolve);
      return chain;
    });

    return { service: { rpc: mocks.rpc, from }, from, calls };
  }

  function accountSession(status: string) {
    return session({
      account: {
        id: ACCOUNT_ID,
        store_name: "Store",
        google_ads_customer_id: "1234567890",
        status,
      },
    });
  }

  function requestSession() {
    return session({
      accountRequest: {
        id: REQUEST_ID,
        client_id: "00000000-0000-4000-8000-0000000000aa",
        request_type: "google_ads",
        google_ads_customer_id: "1234567890",
        store_name: "New Store",
        status: "pending",
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never forces a pending account active without its agency-captured counter", async () => {
    mocks.createClient.mockResolvedValue(accountSession("pending"));
    const { service, from } = serviceDouble();
    mocks.createServiceClient.mockReturnValue(service);
    mocks.capture.mockRejectedValue(denied);

    const response = await POST(request({ accountId: ACCOUNT_ID }));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(502);
    expect(payload.error).toMatch(/1234567890/);
    expect(payload.error).toMatch(/stays pending/i);
    expect(from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("tells an active account it stays connected, not pending", async () => {
    mocks.createClient.mockResolvedValue(accountSession("active"));
    const { service } = serviceDouble();
    mocks.createServiceClient.mockReturnValue(service);
    mocks.capture.mockRejectedValue(denied);

    const response = await POST(request({ accountId: ACCOUNT_ID }));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(502);
    expect(payload.error).toMatch(/stays connected but unbilled/i);
    expect(payload.error).not.toMatch(/stays pending/i);
  });

  it("turns a stuck request into a PENDING account and closes the request", async () => {
    mocks.createClient.mockResolvedValue(requestSession());
    const { service, calls } = serviceDouble();
    mocks.createServiceClient.mockReturnValue(service);
    mocks.capture.mockRejectedValue(denied);

    const response = await POST(request({ requestId: REQUEST_ID }));
    const payload = (await response.json()) as {
      ok?: boolean;
      deferred?: boolean;
      message?: string;
      account?: { status?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.deferred).toBe(true);
    expect(payload.message).toMatch(/refused access/i);
    expect(payload.account?.status).toBe("pending");
    // The database rejects any other status without a committed billing start.
    expect(calls.insertedInto).toEqual(["ad_accounts"]);
    expect(calls.inserted[0]).toMatchObject({ status: "pending" });
    // The request must actually be closed, or it reappears and the admin
    // retries into a duplicate-key error.
    expect(calls.approvedRequests).toEqual([{ status: "approved" }]);
  });

  it("reuses an existing store for the same customer id instead of duplicating it", async () => {
    mocks.createClient.mockResolvedValue(requestSession());
    const { service, calls } = serviceDouble({
      existingAccount: { id: ACCOUNT_ID, store_name: "Existing", status: "pending" },
    });
    mocks.createServiceClient.mockReturnValue(service);
    mocks.capture.mockRejectedValue(denied);

    const response = await POST(request({ requestId: REQUEST_ID }));
    const payload = (await response.json()) as { ok?: boolean; account?: { storeName?: string } };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.account?.storeName).toBe("Existing");
    expect(calls.selectedAccountBy).toContain("1234567890");
    expect(calls.inserted).toEqual([]);
    expect(calls.approvedRequests).toEqual([{ status: "approved" }]);
  });

  it("reports a half-finished acceptance instead of showing a success banner", async () => {
    mocks.createClient.mockResolvedValue(requestSession());
    const { service } = serviceDouble({ approveError: { message: "row locked" } });
    mocks.createServiceClient.mockReturnValue(service);
    mocks.capture.mockRejectedValue(denied);

    const response = await POST(request({ requestId: REQUEST_ID }));
    const payload = (await response.json()) as { ok?: boolean; error?: string };

    expect(response.status).toBe(500);
    expect(payload.ok).toBeUndefined();
    expect(payload.error).toMatch(/could not be closed/i);
    expect(payload.error).toMatch(/will not be duplicated/i);
  });

  it("rejects a customer id Google says does not exist, accepting nothing", async () => {
    mocks.createClient.mockResolvedValue(accountSession("pending"));
    const { service, from } = serviceDouble();
    mocks.createServiceClient.mockReturnValue(service);
    mocks.capture.mockRejectedValue(
      new Error('(401): {"authenticationError":"CUSTOMER_NOT_FOUND"}'),
    );

    const response = await POST(request({ accountId: ACCOUNT_ID }));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(422);
    expect(payload.error).toMatch(/does not exist/i);
    expect(from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
