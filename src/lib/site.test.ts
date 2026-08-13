import { describe, expect, it } from "vitest";
import { safeInternalPath } from "./site";

describe("safeInternalPath", () => {
  it("keeps internal onboarding paths and rejects open redirects", () => {
    expect(safeInternalPath("/onboarding/client/abc?step=assets#shopify")).toBe(
      "/onboarding/client/abc?step=assets#shopify",
    );

    for (const unsafe of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/..//evil.example",
      "/./\\evil.example",
      "javascript:alert(1)",
      ["/onboarding/client/abc", "//evil.example"],
      undefined,
    ]) {
      expect(safeInternalPath(unsafe)).toBeNull();
    }
  });
});
