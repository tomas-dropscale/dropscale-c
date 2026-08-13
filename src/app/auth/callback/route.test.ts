import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      verifyOtp: mocks.verifyOtp,
    },
    rpc: mocks.rpc,
  })),
}));
vi.mock("@/lib/site", () => ({
  safeInternalPath: (value: unknown) => {
    if (typeof value !== "string" || !value.startsWith("/")) return null;
    const base = new URL("https://internal.invalid");
    const target = new URL(value, base);
    return target.origin === base.origin && !target.pathname.startsWith("//")
      ? `${target.pathname}${target.search}${target.hash}`
      : null;
  },
}));

import { GET } from "./route";

describe("auth callback redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
    mocks.verifyOtp.mockResolvedValue({ error: null });
  });

  it("returns a successful OAuth session to the requested onboarding path", async () => {
    const response = await GET(
      new NextRequest(
        "https://dropscale.app/auth/callback?code=oauth-code&next=%2Fonboarding%2Fclient%2Fabc",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://dropscale.app/onboarding/client/abc",
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_portal_client");
  });

  it.each([
    "https%3A%2F%2Fevil.example",
    "%2F%2Fevil.example",
    "%2F%5Cevil.example",
    "%2F..%2F%2Fevil.example",
    "%2F.%2F%5Cevil.example",
  ])("rejects an unsafe next target: %s", async (next) => {
    const response = await GET(
      new NextRequest(
        `https://dropscale.app/auth/callback?code=oauth-code&next=${next}`,
      ),
    );

    expect(response.headers.get("location")).toBe(
      "https://dropscale.app/dashboard",
    );
  });

  it("exchanges a cross-device recovery token and opens the reset page", async () => {
    const response = await GET(
      new NextRequest(
        "https://dropscale.app/auth/callback?next=%2Freset-password&token_hash=recovery-token&type=recovery",
      ),
    );

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      type: "recovery",
      token_hash: "recovery-token",
    });
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "https://dropscale.app/reset-password",
    );
  });

  it("keeps the recovery email template on the cross-device token-hash contract", () => {
    const template = readFileSync(
      "supabase/templates/reset-password.html",
      "utf8",
    );

    expect(template).toContain("{{ .RedirectTo }}");
    expect(template).toContain("token_hash={{ .TokenHash }}");
    expect(template).toContain("type=recovery");
    expect(template).not.toContain("{{ .ConfirmationURL }}");
  });
});
