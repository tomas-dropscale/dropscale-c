import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  billingAutomationEnabled,
  billingRecoveryEnabled,
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

  it("requires every live and automatic issue arm", () => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_ISSUANCE_ARMED", "true");

    expect(billingAutomationEnabled()).toBe(true);

    vi.stubEnv("BILLING_AUTOMATION_ENABLED", "false");
    expect(billingAutomationEnabled()).toBe(false);
  });

  it("cannot arm automation while live invoice issuance is disabled", () => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", "false");
    vi.stubEnv("BILLING_AUTOMATION_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_ISSUANCE_ARMED", "true");

    expect(billingAutomationEnabled()).toBe(false);
  });

  it("does not reuse an existing recovery arm for automatic invoice issue", () => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_RECOVERY_ARMED", "true");

    expect(billingAutomationEnabled()).toBe(false);
  });

  it("requires the recovery arms while global invoice issuance remains off", () => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", "false");
    vi.stubEnv("BILLING_AUTOMATION_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_RECOVERY_ARMED", "true");

    expect(billingRecoveryEnabled()).toBe(true);
  });

  it.each([
    ["false", undefined, "true"],
    ["false", "true", undefined],
    ["false", "true", "TRUE"],
    ["false", "true", " true"],
  ])("keeps recovery disarmed for %s / %s / %s", (master, automatic, recovery) => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", master);
    vi.stubEnv("BILLING_AUTOMATION_ENABLED", automatic);
    vi.stubEnv("BILLING_AUTOMATION_RECOVERY_ARMED", recovery);

    expect(billingRecoveryEnabled()).toBe(false);
  });

  it("refuses recovery while ordinary invoice issuance is enabled", () => {
    vi.stubEnv("BILLING_ISSUANCE_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_ENABLED", "true");
    vi.stubEnv("BILLING_AUTOMATION_RECOVERY_ARMED", "true");

    expect(billingRecoveryEnabled()).toBe(false);
  });
});
