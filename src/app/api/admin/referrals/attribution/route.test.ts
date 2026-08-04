import { beforeEach, describe, expect, it, vi } from "vitest";
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

const REFERRED_ID = "00000000-0000-4000-8000-000000000201";
const REFERRER_ID = "00000000-0000-4000-8000-000000000202";
const ADMIN_ID = "00000000-0000-4000-8000-000000000203";
const DECISION_ID = "00000000-0000-4000-8000-000000000204";
const RECEIPT_ID = "00000000-0000-4000-8000-000000000205";
const REASON = "Verified the introduction from the signed client record.";

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
  return new NextRequest(
    "http://localhost/api/admin/referrals/attribution",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    referredClientId: REFERRED_ID,
    referrerClientId: REFERRER_ID,
    decisionId: DECISION_ID,
    reason: REASON,
    confirmed: true,
    ...overrides,
  };
}

function sealedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    decision_id: DECISION_ID,
    referred_client_id: REFERRED_ID,
    referrer_client_id: REFERRER_ID,
    reason: REASON,
    reviewed_by: ADMIN_ID,
    created_at: "2026-08-03T12:00:00.000Z",
    sealed_at: "2026-08-03T12:00:00.010Z",
    ...overrides,
  };
}

describe("admin manual referral attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue(session());
    mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it("accepts exactly the reviewed attribution fields", async () => {
    const missingConfirmation = await POST(
      request(validBody({ confirmed: false })),
    );
    const injectedCommercialRate = await POST(
      request(validBody({ feeRate: 9.5 })),
    );
    const selfReferral = await POST(
      request(validBody({ referrerClientId: REFERRED_ID })),
    );
    const emptyReason = await POST(request(validBody({ reason: "   " })));

    expect(missingConfirmation.status).toBe(400);
    expect(injectedCommercialRate.status).toBe(400);
    expect(selfReferral.status).toBe(400);
    expect(emptyReason.status).toBe(400);
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

  it("passes only identifiers, the trimmed reason and reviewed admin to SQL", async () => {
    mocks.rpc.mockResolvedValue({ data: [sealedReceipt()], error: null });

    const response = await POST(
      request(validBody({ reason: `  ${REASON}  ` })),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "assign_manual_referral_attribution",
      {
        p_referred_client_id: REFERRED_ID,
        p_referrer_client_id: REFERRER_ID,
        p_decision_id: DECISION_ID,
        p_reason: REASON,
        p_reviewed_by: ADMIN_ID,
      },
    );
    expect(payload).toEqual({
      ok: true,
      attribution: {
        id: RECEIPT_ID,
        decisionId: DECISION_ID,
        referredClientId: REFERRED_ID,
        referrerClientId: REFERRER_ID,
        reason: REASON,
        reviewedBy: ADMIN_ID,
        createdAt: "2026-08-03T12:00:00.000Z",
        sealedAt: "2026-08-03T12:00:00.010Z",
      },
    });
  });

  it("accepts the same sealed receipt on an idempotent retry", async () => {
    mocks.rpc.mockResolvedValue({ data: [sealedReceipt()], error: null });

    const first = await POST(request(validBody()));
    const retry = await POST(request(validBody()));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    await expect(retry.json()).resolves.toMatchObject({
      attribution: { decisionId: DECISION_ID },
    });
  });

  it("maps database state conflicts to a refreshable 409", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "P0001",
        message: "The referred client already has an attribution.",
      },
    });

    const response = await POST(request(validBody()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({ code: "attribution_conflict" });
  });

  it("fails closed when the sealed receipt differs from the decision", async () => {
    mocks.rpc.mockResolvedValue({
      data: [sealedReceipt({ referrer_client_id: REFERRED_ID })],
      error: null,
    });

    const response = await POST(request(validBody()));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("did not match"),
    });
  });
});
