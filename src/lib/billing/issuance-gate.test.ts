import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  automaticBillingIssuanceEnabled,
  billingIssuanceEnabled,
} from "./issuance-gate";

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

  it("arms automatic issuance only when both exact gates are true", () => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_ENABLED", "true");

    expect(automaticBillingIssuanceEnabled()).toBe(true);
  });

  it.each([
    { master: "false", automatic: "true" },
    { master: "true", automatic: "false" },
    { master: "true", automatic: "TRUE" },
    { master: "true", automatic: undefined },
  ])("keeps automatic issue disarmed for $master / $automatic", (gates) => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", gates.master);
    vi.stubEnv("BILLING_AUTOMATION_ENABLED", gates.automatic);

    expect(automaticBillingIssuanceEnabled()).toBe(false);
  });
});
