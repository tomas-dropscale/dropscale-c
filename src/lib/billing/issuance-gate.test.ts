import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { billingIssuanceEnabled } from "./issuance-gate";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("billing issuance gate", () => {
  it("enables issuance only for the exact lowercase true value", () => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", "true");

    expect(billingIssuanceEnabled()).toBe(true);
  });

  it.each([undefined, "", "false", "TRUE", "True", "1", " true", "true "])(
    "fails closed for %s",
    (value) => {
      vi.stubEnv("BILLING_ISSUANCE_ENABLED", value);

      expect(billingIssuanceEnabled()).toBe(false);
    },
  );
});
