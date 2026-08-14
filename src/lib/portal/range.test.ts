import { describe, expect, it } from "vitest";

import { parseRange, presetSelection, rangeQuery } from "./range";

describe("rangeQuery", () => {
  it("keeps Today explicit when a page has a different bare-URL default", () => {
    expect(
      rangeQuery({
        key: "today",
        from: "2026-08-14",
        to: "2026-08-14",
      }),
    ).toBe("?range=today&from=2026-08-14&to=2026-08-14");
  });

  it("keeps the browser's concrete preset dates when the Worker parses the URL", () => {
    expect(
      parseRange({
        range: "d7",
        from: "2026-08-08",
        to: "2026-08-14",
      }),
    ).toEqual({ key: "d7", from: "2026-08-08", to: "2026-08-14" });
  });

  it("uses the Lisbon reporting day across the summer midnight UTC boundary", () => {
    expect(presetSelection("today", new Date("2026-08-14T23:30:00.000Z"))).toEqual({
      key: "today",
      from: "2026-08-15",
      to: "2026-08-15",
    });
    expect(presetSelection("d7", new Date("2026-08-14T23:30:00.000Z"))).toEqual({
      key: "d7",
      from: "2026-08-09",
      to: "2026-08-15",
    });
  });

  it("rejects forged preset spans and unbounded custom reads", () => {
    const forged = parseRange({
      range: "d7",
      from: "2025-01-01",
      to: "2026-08-14",
    });
    expect(forged.key).toBe("d7");
    expect(forged.from).not.toBe("2025-01-01");

    const unbounded = parseRange({
      range: "custom",
      from: "2025-01-01",
      to: "2026-08-14",
    });
    expect(unbounded.key).toBe("today");
  });
});
