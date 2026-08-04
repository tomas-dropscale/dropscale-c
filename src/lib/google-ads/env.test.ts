import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/google-ads/service-account", () => ({
  parseServiceAccountKey: vi.fn(() => null),
}));

import { googleAdsApiBasics } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Google Ads API version selection", () => {
  it("defaults agency reads to the current v25 endpoint", () => {
    vi.stubEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "test-developer-token");
    vi.stubEnv("GOOGLE_ADS_API_VERSION", "");

    expect(googleAdsApiBasics()).toEqual({
      developerToken: "test-developer-token",
      apiVersion: "v25",
    });
  });

  it("keeps an explicit deployment override visible for controlled upgrades", () => {
    vi.stubEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "test-developer-token");
    vi.stubEnv("GOOGLE_ADS_API_VERSION", "v24.2");

    expect(googleAdsApiBasics().apiVersion).toBe("v24.2");
  });
});
