import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  billingIssuanceEnabled: vi.fn(),
  createServiceClient: vi.fn(),
  getSessionProfile: vi.fn(),
  issueClientWeek: vi.fn(),
}));

vi.mock("@/lib/billing/issuance-gate", () => ({
  billingIssuanceEnabled: mocks.billingIssuanceEnabled,
}));
vi.mock("@/lib/billing/invoices", () => ({
  BillingIssueError: class BillingIssueError extends Error {},
  issueClientWeek: mocks.issueClientWeek,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { POST } from "./route";

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_ID = "00000000-0000-4000-8000-000000000002";
const VALID_BODY = {
  clientId: CLIENT_ID,
  periodStart: "2026-07-27",
  expectedAmount: 123.45,
  expectedReviewToken: "review-token",
};

function request(body: unknown = VALID_BODY) {
  return new NextRequest("http://localhost/api/billing/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function malformedRequest() {
  return new NextRequest("http://localhost/api/billing/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
}

describe("manual billing generate route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionProfile.mockResolvedValue({
      user: { id: ADMIN_ID },
      profile: { id: ADMIN_ID, role: "admin" },
    });
    mocks.billingIssuanceEnabled.mockReturnValue(true);
    mocks.createServiceClient.mockReturnValue({ service: true });
  });

  it("authenticates before revealing or evaluating issuance state", async () => {
    mocks.getSessionProfile.mockResolvedValue({ user: null, profile: null });
    mocks.billingIssuanceEnabled.mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
    expect(mocks.billingIssuanceEnabled).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.issueClientWeek).not.toHaveBeenCalled();
  });

  it("fails closed before parsing input or opening service access", async () => {
    mocks.billingIssuanceEnabled.mockReturnValue(false);

    const response = await POST(malformedRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Billing issuance is disabled.",
    });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.issueClientWeek).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without opening service access", async () => {
    const response = await POST(malformedRequest());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error:
        "clientId, periodStart, numeric expectedAmount and expectedReviewToken are required.",
    });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.issueClientWeek).not.toHaveBeenCalled();
  });

  it("issues only after admin auth, the enabled gate and body validation", async () => {
    const serviceClient = { service: true };
    const invoice = {
      id: "00000000-0000-4000-8000-000000000003",
      status: "open",
    };
    mocks.createServiceClient.mockReturnValue(serviceClient);
    mocks.issueClientWeek.mockResolvedValue(invoice);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, invoice });
    expect(mocks.issueClientWeek).toHaveBeenCalledWith({
      ...VALID_BODY,
      issuedBy: ADMIN_ID,
      client: serviceClient,
    });
    expect(mocks.getSessionProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.billingIssuanceEnabled.mock.invocationCallOrder[0],
    );
    expect(
      mocks.billingIssuanceEnabled.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.createServiceClient.mock.invocationCallOrder[0]);
    expect(mocks.createServiceClient.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.issueClientWeek.mock.invocationCallOrder[0],
    );
  });
});
