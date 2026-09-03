import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  windsorSearch: vi.fn(() => vi.fn()),
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/google-ads/billing-start", () => ({
  captureGoogleBillingEndAsAgency: mocks.capture,
}));
vi.mock("@/lib/google-ads/windsor-capture", () => ({
  windsorCaptureSearch: mocks.windsorSearch,
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
const ADMIN_ID = "00000000-0000-4000-8000-000000000012";
const START_ID = "00000000-0000-4000-8000-000000000013";
const END_ID = "00000000-0000-4000-8000-000000000014";

const account = {
  id: ACCOUNT_ID,
  store_name: "Lisbon Store",
  google_ads_customer_id: "1234567890",
  status: "suspended",
};

const billingStart = {
  id: START_ID,
  google_ads_customer_id: "1234567890",
  google_local_date: "2026-08-03",
  google_time_zone: "Europe/Lisbon",
  currency: "EUR",
};

const captured = {
  google_ads_customer_id: "1234567890",
  google_local_date: "2026-08-06",
  google_time_zone: "Europe/Lisbon",
  currency: "EUR",
  end_cost_micros: "234567890",
  capture_started_at: "2026-08-06T12:00:00.000Z",
  captured_at: "2026-08-06T12:00:01.000Z",
  capture_id: "10000000-0000-4000-8000-000000000001",
  source: "agency",
} as const;

function session({
  userId = ADMIN_ID,
  role = "admin",
  accountRow = account,
  startRow = billingStart,
  endRow = null,
}: {
  userId?: string | null;
  role?: string | null;
  accountRow?: Record<string, unknown> | null;
  startRow?: Record<string, unknown> | null;
  endRow?: Record<string, unknown> | null;
} = {}) {
  const result = (data: Record<string, unknown> | null): QueryResult => ({ data, error: null });

  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: userId ? { id: userId } : null } })),
    },
    from: vi.fn((table: string) => {
      const data =
        table === "profiles"
          ? userId && role
            ? { id: userId, role }
            : null
          : table === "ad_accounts"
            ? accountRow
            : table === "ad_account_billing_starts"
              ? startRow
              : table === "ad_account_billing_ends"
                ? endRow
                : null;
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => result(data)) })),
        })),
      };
    }),
  };
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/google-ads/terminate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin Google billing termination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it("accepts only one valid accountId", async () => {
    const missing = await POST(request({}));
    const extra = await POST(request({ accountId: ACCOUNT_ID, surprise: true }));
    const invalid = await POST(request({ accountId: "not-a-uuid" }));

    expect(missing.status).toBe(400);
    expect(extra.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("does not expose Google or service access to a non-admin", async () => {
    mocks.createClient.mockResolvedValue(session({ role: "client" }));

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(403);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requires a start and refuses to replace an existing end", async () => {
    mocks.createClient.mockResolvedValue(session({ startRow: null }));
    const missingStart = await POST(request({ accountId: ACCOUNT_ID }));

    mocks.createClient.mockResolvedValue(session({ endRow: { id: END_ID } }));
    const existingEnd = await POST(request({ accountId: ACCOUNT_ID }));

    expect(missingStart.status).toBe(409);
    expect(existingEnd.status).toBe(409);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("leaves billing active when the live Google capture fails", async () => {
    mocks.createClient.mockResolvedValue(session());
    mocks.capture.mockRejectedValue(new Error("agency account has no access"));

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(502);
    expect(mocks.capture).toHaveBeenCalledWith("1234567890");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("falls back to the Windsor counter when the direct Google grant lapses", async () => {
    mocks.createClient.mockResolvedValue(session());
    const service = { rpc: mocks.rpc };
    mocks.createServiceClient.mockReturnValue(service);
    mocks.rpc.mockResolvedValue({ data: [{ id: END_ID }], error: null });
    const windsorBackedSearch = vi.fn();
    mocks.windsorSearch.mockReturnValue(windsorBackedSearch);
    mocks.capture
      .mockRejectedValueOnce(new Error("USER_PERMISSION_DENIED"))
      .mockResolvedValueOnce(captured);

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(200);
    // The retry runs the SAME capture loop, only with the Windsor-backed
    // read, and the identity it enforces is the immutable billing start.
    expect(mocks.windsorSearch).toHaveBeenCalledWith({
      customerId: "1234567890",
      timeZone: "Europe/Lisbon",
      currency: "EUR",
    });
    expect(mocks.capture).toHaveBeenNthCalledWith(2, "1234567890", {
      search: windsorBackedSearch,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects live evidence that no longer matches the immutable start", async () => {
    mocks.createClient.mockResolvedValue(session());
    mocks.capture.mockResolvedValue({ ...captured, google_time_zone: "Europe/Madrid" });

    const response = await POST(request({ accountId: ACCOUNT_ID }));

    expect(response.status).toBe(502);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes one complete receipt to the service-only atomic commit", async () => {
    mocks.createClient.mockResolvedValue(session());
    mocks.capture.mockResolvedValue(captured);
    mocks.rpc.mockResolvedValue({
      data: [
        {
          id: END_ID,
          billing_start_id: START_ID,
          ad_account_id: ACCOUNT_ID,
        },
      ],
      error: null,
    });

    const response = await POST(request({ accountId: ACCOUNT_ID }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("commit_google_ads_billing_end", {
      p_account_id: ACCOUNT_ID,
      p_capture_id: captured.capture_id,
      p_google_ads_customer_id: captured.google_ads_customer_id,
      p_google_local_date: captured.google_local_date,
      p_google_time_zone: captured.google_time_zone,
      p_currency: captured.currency,
      p_end_cost_micros: captured.end_cost_micros,
      p_capture_started_at: captured.capture_started_at,
      p_captured_at: captured.captured_at,
      p_source: captured.source,
      p_reviewed_by: ADMIN_ID,
    });
    expect(payload).toMatchObject({
      ok: true,
      account: { id: ACCOUNT_ID, status: "suspended" },
      billingEnd: {
        id: END_ID,
        billingStartId: START_ID,
        endCostMicros: captured.end_cost_micros,
      },
    });
  });
});
