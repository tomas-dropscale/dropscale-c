import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeCampaignActionRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/campaign-actions", () => ({
  executeCampaignActionRequest: mocks.executeCampaignActionRequest,
}));
vi.mock("@/lib/client-onboarding/http", () => ({
  clientOnboardingResponse: (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "cache-control": "no-store, max-age=0" },
    }),
  clientOnboardingErrorResponse: () =>
    Response.json(
      {
        error: "The campaign action could not be completed.",
        code: "request_failed",
      },
      { status: 500 },
    ),
}));

import { POST } from "./route";

describe("POST /api/admin/campaign-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the safe campaign action result", async () => {
    mocks.executeCampaignActionRequest.mockResolvedValue({ status: "succeeded" });
    const request = new Request("https://dropscale.app/api/admin/campaign-actions", {
      method: "POST",
      body: "{}",
    });

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "succeeded" });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(mocks.executeCampaignActionRequest).toHaveBeenCalledWith(request);
  });

  it("redacts unclassified failures", async () => {
    mocks.executeCampaignActionRequest.mockRejectedValue(new Error("provider secret"));
    const response = await POST(
      new Request("https://dropscale.app/api/admin/campaign-actions", {
        method: "POST",
        body: "{}",
      }) as never,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "The campaign action could not be completed.",
      code: "request_failed",
    });
  });
});
