import { beforeEach, describe, expect, it, vi } from "vitest";

const { FakeHstError } = vi.hoisted(() => ({
  FakeHstError: class FakeHstError extends Error {
    readonly unauthorized: boolean;
    constructor(message: string, unauthorized = false) {
      super(message);
      this.name = "HstError";
      this.unauthorized = unauthorized;
    }
  },
}));

const mocks = vi.hoisted(() => ({
  getSessionProfile: vi.fn(),
  connectHstWithCredentials: vi.fn(),
  forgetHstCredentials: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ getSessionProfile: mocks.getSessionProfile }));
vi.mock("@/lib/admin/hst", () => ({
  HstError: FakeHstError,
  connectHstWithCredentials: mocks.connectHstWithCredentials,
  forgetHstCredentials: mocks.forgetHstCredentials,
}));

import { DELETE, POST } from "./route";

function request(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

describe("HST sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionProfile.mockResolvedValue({ profile: { role: "admin" } });
    mocks.connectHstWithCredentials.mockResolvedValue(undefined);
  });

  it("refuses anyone who is not an admin", async () => {
    // The HST account is the agency's, not a client's — one login covers every
    // shop it buys through.
    mocks.getSessionProfile.mockResolvedValue({ profile: { role: "client" } });

    const res = await POST(request({ username: "u", password: "p" }));

    expect(res.status).toBe(403);
    expect(mocks.connectHstWithCredentials).not.toHaveBeenCalled();
  });

  it("signs in with the credentials given", async () => {
    const res = await POST(request({ username: " agency ", password: "secret" }));

    expect(res.status).toBe(200);
    expect(mocks.connectHstWithCredentials).toHaveBeenCalledWith({
      username: " agency ",
      password: "secret",
      captchaCode: undefined,
    });
  });

  it("passes a captcha code through exactly as typed", async () => {
    // Never invented here or anywhere below: if HST checks the code, the person
    // signing in reads it off the login page.
    await POST(request({ username: "u", password: "p", captchaCode: " 4821 " }));

    expect(mocks.connectHstWithCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ captchaCode: "4821" }),
    );
  });

  it("sends nothing at all when no captcha was typed", async () => {
    await POST(request({ username: "u", password: "p", captchaCode: "   " }));

    expect(mocks.connectHstWithCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ captchaCode: undefined }),
    );
  });

  it("asks for both halves before trying", async () => {
    for (const body of [
      { username: "", password: "p" },
      { username: "u", password: "" },
      { username: "  ", password: "p" },
      {},
    ]) {
      const res = await POST(request(body));
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(mocks.connectHstWithCredentials).not.toHaveBeenCalled();
  });

  it("repeats HST's own refusal, because only it says which half was wrong", async () => {
    mocks.connectHstWithCredentials.mockRejectedValue(
      new FakeHstError("HST did not sign in: captcha error"),
    );

    const res = await POST(request({ username: "u", password: "p" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/captcha error/);
  });

  it("keeps our own failures generic", async () => {
    // An unexpected throw can carry request internals; HST's own message is
    // curated and safe to repeat, ours is not.
    mocks.connectHstWithCredentials.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.4"));

    const res = await POST(request({ username: "u", password: "p" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("Couldn't sign in to HST.");
    expect(body.error).not.toMatch(/10\.0\.0\.4/);
  });

  it("never echoes the password back", async () => {
    mocks.connectHstWithCredentials.mockRejectedValue(new FakeHstError("HST refused those credentials."));

    const res = await POST(request({ username: "u", password: "hunter2" }));

    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });

  it("forgets the credentials on request", async () => {
    const res = await DELETE();

    expect(res.status).toBe(200);
    expect(mocks.forgetHstCredentials).toHaveBeenCalled();
  });

  it("will not let a client forget them", async () => {
    mocks.getSessionProfile.mockResolvedValue({ profile: { role: "client" } });

    const res = await DELETE();

    expect(res.status).toBe(403);
    expect(mocks.forgetHstCredentials).not.toHaveBeenCalled();
  });
});
