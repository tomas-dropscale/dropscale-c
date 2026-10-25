import { describe, expect, it } from "vitest";
import { reviewedWeeklyExtras } from "./reviewed-weekly-extras";

const CLIENT = "5107292f-1bf6-42a4-ba8d-dc1d730d4044";

describe("owner-approved weekly service supplement", () => {
  it("adds the exact EUR 34.80 supplement only to Lourenço's 19–25 October cycle", () => {
    expect(reviewedWeeklyExtras(CLIENT, "2026-10-19")).toEqual([{
      kind: "service",
      extraId: "lourenco-customer-service-2026-10-26",
      label: "Customer service",
      amount: 34.8,
      accountId: null,
    }]);
    expect(reviewedWeeklyExtras("another-client", "2026-10-19")).toEqual([]);
    expect(reviewedWeeklyExtras(CLIENT, "2026-10-12")).toEqual([]);
    expect(reviewedWeeklyExtras(CLIENT, "2026-10-26")).toEqual([]);
  });

  it("does not let a caller change the approved amount for a later preview", () => {
    const firstPreview = reviewedWeeklyExtras(CLIENT, "2026-10-19");
    firstPreview[0].amount = 100;
    firstPreview.push({ label: "Duplicate", amount: 34.8, accountId: null });
    const nextPreview = reviewedWeeklyExtras(CLIENT, "2026-10-19");
    expect(nextPreview).toHaveLength(1);
    expect(nextPreview[0].amount).toBe(34.8);
  });
});
