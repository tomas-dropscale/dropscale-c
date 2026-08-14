import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configureCampaignActionPolicyRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/campaign-actions", () => ({
  configureCampaignActionPolicyRequest: mocks.configureCampaignActionPolicyRequest,
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
        error: "The campaign action policy could not be configured.",
        code: "request_failed",
      },
      { status: 500 },
    ),
}));

import { POST } from "./route";

describe("POST /api/admin/campaign-action-policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the safe policy result", async () => {
    mocks.configureCampaignActionPolicyRequest.mockResolvedValue({
      revision: 2,
      enabled: true,
    });
    const request = new Request(
      "https://dropscale.app/api/admin/campaign-action-policies",
      { method: "POST", body: "{}" },
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, revision: 2, enabled: true });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(mocks.configureCampaignActionPolicyRequest).toHaveBeenCalledWith(request);
  });

  it("redacts unclassified failures", async () => {
    mocks.configureCampaignActionPolicyRequest.mockRejectedValue(new Error("secret"));
    const response = await POST(
      new Request("https://dropscale.app/api/admin/campaign-action-policies", {
        method: "POST",
        body: "{}",
      }) as never,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "The campaign action policy could not be configured.",
      code: "request_failed",
    });
  });
});
