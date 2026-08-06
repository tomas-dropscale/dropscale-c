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

describe("deferred acceptance when the agency has no Google access yet", () => {
  function serviceWithBuilder() {
    const maybeSingle = vi.fn(async () => ({
      data: { id: ACCOUNT_ID, store_name: "Store", status: "active" },
      error: null,
    }));
    const builder: Record<string, unknown> = {};
    for (const method of ["update", "insert", "eq", "select"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.maybeSingle = maybeSingle;
    // account_requests approval ends the chain on eq(); make it awaitable.
    builder.then = undefined;
    const from = vi.fn(() => builder);
    const service = { rpc: mocks.rpc, from };
    return { service, from, builder, maybeSingle };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a pending account and defers the baseline on USER_PERMISSION_DENIED", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        account: {
          id: ACCOUNT_ID,
          store_name: "Store",
          google_ads_customer_id: "1234567890",
          status: "pending",
        },
      }),
    );
    const { service } = serviceWithBuilder();
    mocks.createServiceClient.mockReturnValue(service);
    mocks.capture.mockRejectedValue(
      new Error(
        'Google Ads query failed for 1234567890 (403): {"authorizationError":"USER_PERMISSION_DENIED"}',
      ),
    );

    const response = await POST(request({ accountId: ACCOUNT_ID }));
    const payload = (await response.json()) as {
      ok?: boolean;
      deferred?: boolean;
      billingStart?: unknown;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.deferred).toBe(true);
    expect(payload.billingStart).toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("still refuses an already-active account, naming the missing access", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        account: {
          id: ACCOUNT_ID,
          store_name: "Store",
          google_ads_customer_id: "1234567890",
          status: "active",
        },
      }),
    );
    const { service, from } = serviceWithBuilder();
    mocks.createServiceClient.mockReturnValue(service);
    mocks.capture.mockRejectedValue(
      new Error("(403): USER_PERMISSION_DENIED"),
    );

    const response = await POST(request({ accountId: ACCOUNT_ID }));
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(502);
    expect(payload.error).toMatch(/grant the agency access/i);
    expect(from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a customer id Google says does not exist, accepting nothing", async () => {
    mocks.createClient.mockResolvedValue(
      session({
        account: {
          id: ACCOUNT_ID,
          store_name: "Store",
          google_ads_customer_id: "1234567890",
          status: "pending",
        },
      }),
    );
    const { service, from } = serviceWithBuilder();
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

