import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { POST } from "./route";

const CLIENT_ID = "00000000-0000-4000-8000-000000000101";
const REFERRED_ID = "00000000-0000-4000-8000-000000000102";
const ADMIN_ID = "00000000-0000-4000-8000-000000000103";
const TERM_ID = "00000000-0000-4000-8000-000000000104";
const DECISION_ID = "00000000-0000-4000-8000-000000000105";
const DEFAULT_REASON = "Verified independent client and recent Google spend.";

function session(
  role: string | null = "admin",
  userId: string | null = ADMIN_ID,
) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: null,
      })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: userId && role ? { id: userId, role } : null,
            error: null,
          })),
        })),
      })),
    })),
  };
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/referrals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    clientId: CLIENT_ID,
    referredClientId: REFERRED_ID,
    action: "grant",
    expectedTermId: null,
    decisionId: DECISION_ID,
    reason: DEFAULT_REASON,
    ...overrides,
  };
}

function sealedTerm(effectiveFrom: string, reason = DEFAULT_REASON) {
  return {
    id: TERM_ID,
    client_id: CLIENT_ID,
    effective_from: effectiveFrom,
    revision: 1,
    decision_id: DECISION_ID,
    decision_action: "grant",
    decision_referred_client_id: REFERRED_ID,
    expected_term_id: null,
    list_rate: 10,
    referral_step_rate: 0.5,
    referral_count: 1,
    referral_discount_rate: 0.5,
    fee_rate: 9.5,
    reason,
    reviewed_by: ADMIN_ID,
    created_at: "2026-08-03T00:00:00.000Z",
    sealed_at: "2026-08-03T00:00:00.010Z",
  };
}

describe("admin manual referral decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue(session());
    mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the Lisbon day when UTC has not yet entered Monday", async () => {
    vi.useFakeTimers();
    // UTC is still Sunday, but Lisbon has already entered Monday.
    vi.setSystemTime(new Date("2026-08-02T23:30:00.000Z"));
    mocks.rpc.mockResolvedValue({
      data: [sealedTerm("2026-08-03")],
      error: null,
    });

    const response = await POST(request(validBody()));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "schedule_manual_referral_discount",
      expect.objectContaining({ p_effective_from: "2026-08-03" }),
    );
  });

  it("accepts exactly the six non-commercial decision fields", async () => {
    const missing = await POST(request({ ...validBody(), reason: undefined }));
    const injectedRate = await POST(request({ ...validBody(), feeRate: 2.5 }));
    const injectedDate = await POST(
      request({ ...validBody(), effectiveFrom: "2026-08-10" }),
    );
    const emptyReason = await POST(request(validBody({ reason: "   " })));
    const malformedExpected = await POST(
      request(validBody({ expectedTermId: "latest", action: "revoke" })),
    );

    expect(missing.status).toBe(400);
    expect(injectedRate.status).toBe(400);
    expect(injectedDate.status).toBe(400);
    expect(emptyReason.status).toBe(400);
    expect(malformedExpected.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("never constructs a service client for a non-admin", async () => {
    mocks.createClient.mockResolvedValue(session("client"));

    const response = await POST(request(validBody()));

    expect(response.status).toBe(403);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("calculates effectiveFrom server-side and passes only evidence identifiers to SQL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    mocks.rpc.mockResolvedValue({
      data: [sealedTerm("2026-08-10", "Verified evidence.")],
      error: null,
    });

    const response = await POST(
      request(validBody({ reason: "  Verified evidence.  " })),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "schedule_manual_referral_discount",
      {
        p_client_id: CLIENT_ID,
        p_referred_client_id: REFERRED_ID,
        p_action: "grant",
        p_effective_from: "2026-08-10",
        p_expected_term_id: null,
        p_decision_id: DECISION_ID,
        p_reason: "Verified evidence.",
        p_reviewed_by: ADMIN_ID,
      },
    );
    expect(payload).toMatchObject({
      ok: true,
      effectiveFrom: "2026-08-10",
      term: {
        id: TERM_ID,
        referralCount: 1,
        referralDiscountRate: 0.5,
        feeRate: 9.5,
      },
    });
  });

  it("maps the optimistic concurrency SQLSTATE to a refreshable 409", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "40001",
        message: "The referral term changed while it was being reviewed.",
      },
    });

    const response = await POST(
      request(validBody({ expectedTermId: TERM_ID })),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({ code: "stale_term" });
  });
});
