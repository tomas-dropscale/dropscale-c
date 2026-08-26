import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
  rpc: vi.fn(),
  searchGoogleAds: vi.fn(),
  decryptToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/google-ads/billing-start", () => ({
  captureGoogleBillingStartAsAgency: mocks.capture,
}));
vi.mock("@/lib/google-ads/client", () => ({
  searchGoogleAds: mocks.searchGoogleAds,
}));
vi.mock("@/lib/google-ads/crypto", () => ({
  decryptToken: mocks.decryptToken,
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

function serviceClient(refreshToken: string | null = "encrypted-refresh-token") {
  return {
    rpc: mocks.rpc,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: { google_ads_refresh_token: refreshToken },
            error: null,
          })),
        })),
      })),
    })),
  };
}

describe("admin Google billing activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceClient.mockReturnValue(serviceClient());
    mocks.decryptToken.mockResolvedValue("google-refresh-token");
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
    // ce90b0e: account activation verifies Google through the account's own
    // connected authority — its stored refresh token — not the agency login.
    expect(mocks.capture).toHaveBeenCalledWith("1234567890", {
      search: expect.any(Function),
    });
    expect(mocks.decryptToken).toHaveBeenCalledWith("encrypted-refresh-token");
    const search = mocks.capture.mock.calls[0]?.[1]?.search as (
      customerId: string,
      query: string,
    ) => unknown;
    await search("1234567890", "SELECT customer.id FROM customer");
    expect(mocks.searchGoogleAds).toHaveBeenCalledWith(
      "1234567890",
      "google-refresh-token",
      "SELECT customer.id FROM customer",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reads an account with no stored refresh token through the agency", async () => {
    // A V2 reporting account never holds a Google grant of its own, so
    // demanding one here refused every staged source outright. The agency read
    // proves the same identity through the manager account instead.
    mocks.createClient.mockResolvedValue(
      session({
        account: {
          id: ACCOUNT_ID,
          store_name: "760-812-4103",
          google_ads_customer_id: "1234567890",
          status: "pending",
        },
      }),
    );
    mocks.createServiceClient.mockReturnValue(serviceClient(null));
    mocks.capture.mockResolvedValue(captured);
    mocks.rpc.mockResolvedValue({
      data: [{ id: ACCOUNT_ID, store_name: "760-812-4103", status: "active" }],
      error: null,
    });

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(200);
    expect(mocks.capture).toHaveBeenCalledWith("1234567890", {});
    expect(mocks.decryptToken).not.toHaveBeenCalled();
  });

  it("names the account the agency could not reach", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        account: {
          id: ACCOUNT_ID,
          store_name: "760-812-4103",
          google_ads_customer_id: "7608124103",
          status: "pending",
        },
      }),
    );
    mocks.createServiceClient.mockReturnValue(serviceClient(null));
    mocks.capture.mockRejectedValue(new Error("PERMISSION_DENIED"));

    const response = await POST(request({ accountId: ACCOUNT_ID }));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error).toContain("760-812-4103");
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
    // A request has no stored account token yet, so the capture keeps the
    // default agency authority instead of a connected-account search.
    expect(mocks.capture).toHaveBeenCalledWith("1234567890", {});
    expect(mocks.decryptToken).not.toHaveBeenCalled();
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
