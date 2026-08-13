import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClientOnboardingIdentity: vi.fn(),
  claimExistingClientOnboardingIdentity: vi.fn(),
  recoverClientOnboardingIdentity: vi.fn(),
}));

vi.mock("@/lib/client-onboarding/http", () => ({
  clientOnboardingResponse: (body: unknown, status = 200) => Response.json(body, { status }),
  clientOnboardingErrorResponse: (error: unknown) => {
    const value = error as { message?: string; status?: number; code?: string };
    return Response.json(
      { error: value.message ?? "Request failed.", code: value.code },
      { status: value.status ?? 500 },
    );
  },
  isExactRecord: (value: unknown, required: string[], optional: string[] = []) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return (
      required.every((key) => keys.includes(key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key))
    );
  },
  readSmallJson: (request: Request) => request.json(),
}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  createClientOnboardingIdentity: mocks.createClientOnboardingIdentity,
  claimExistingClientOnboardingIdentity: mocks.claimExistingClientOnboardingIdentity,
  recoverClientOnboardingIdentity: mocks.recoverClientOnboardingIdentity,
}));

import { POST } from "./route";

const SESSION = "40000000-0000-4000-8000-000000000001";
const USER = "40000000-0000-4000-8000-000000000002";
const TOKEN = "a".repeat(43);

function request(body: unknown, includeInvitation = true) {
  return new NextRequest(`http://localhost/api/client-onboarding/${SESSION}/account`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(includeInvitation ? { "x-dropscale-client-onboarding": TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("client onboarding account route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClientOnboardingIdentity.mockResolvedValue({
      needsEmailConfirmation: true,
      alreadyCreated: false,
    });
    mocks.recoverClientOnboardingIdentity.mockResolvedValue({
      needsEmailConfirmation: true,
      alreadyCreated: false,
    });
  });

  it("binds an identity created directly with Supabase without receiving a password", async () => {
    const response = await POST(
      request({
        kind: "new",
        firstName: "Casey",
        lastName: "Example",
        email: "casey@example.com",
        userId: USER,
      }),
      { params: Promise.resolve({ id: SESSION }) },
    );
    expect(response.status).toBe(201);
    expect(mocks.createClientOnboardingIdentity).toHaveBeenCalledWith({
      sessionId: SESSION,
      invitationToken: TOKEN,
      firstName: "Casey",
      lastName: "Example",
      email: "casey@example.com",
      userId: USER,
    });
    expect(JSON.stringify(mocks.createClientOnboardingIdentity.mock.calls)).not.toContain(
      "password",
    );
  });

  it("verifies an authenticated existing client after an OAuth redirect without the bearer", async () => {
    mocks.claimExistingClientOnboardingIdentity.mockResolvedValue(undefined);

    const response = await POST(
      request({ kind: "existing" }, false),
      { params: Promise.resolve({ id: SESSION }) },
    );

    expect(response.ok).toBe(true);
    expect(mocks.claimExistingClientOnboardingIdentity).toHaveBeenCalledWith({
      sessionId: SESSION,
      invitationToken: null,
    });
  });

  it("rejects a password or any other injected field", async () => {
    const response = await POST(
      request({
        kind: "new",
        firstName: "Casey",
        lastName: "Example",
        email: "casey@example.com",
        userId: USER,
        password: "must-not-cross-this-route",
      }),
      { params: Promise.resolve({ id: SESSION }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.createClientOnboardingIdentity).not.toHaveBeenCalled();
  });

  it("recovers a browser-created identity from the authenticated user without a password or user id", async () => {
    const response = await POST(
      request({
        kind: "recover",
        firstName: "Casey",
        lastName: "Example",
        email: "casey@example.com",
      }),
      { params: Promise.resolve({ id: SESSION }) },
    );

    expect(response.ok).toBe(true);
    expect(mocks.recoverClientOnboardingIdentity).toHaveBeenCalledWith({
      sessionId: SESSION,
      invitationToken: TOKEN,
      firstName: "Casey",
      lastName: "Example",
      email: "casey@example.com",
    });
    const serializedCalls = JSON.stringify(mocks.recoverClientOnboardingIdentity.mock.calls);
    expect(serializedCalls).not.toContain("password");
    expect(serializedCalls).not.toContain("userId");
  });

  it("requires the invitation bearer for identity recovery", async () => {
    const response = await POST(
      request(
        {
          kind: "recover",
          firstName: "Casey",
          lastName: "Example",
          email: "casey@example.com",
        },
        false,
      ),
      { params: Promise.resolve({ id: SESSION }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.recoverClientOnboardingIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["password", "must-not-cross-this-route"],
    ["userId", USER],
  ])("rejects injected %s fields during identity recovery", async (field, value) => {
    const response = await POST(
      request({
        kind: "recover",
        firstName: "Casey",
        lastName: "Example",
        email: "casey@example.com",
        [field]: value,
      }),
      { params: Promise.resolve({ id: SESSION }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.recoverClientOnboardingIdentity).not.toHaveBeenCalled();
  });
});
