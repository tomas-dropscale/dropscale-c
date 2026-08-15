import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/format", () => ({
  integer: (value: number) => String(value),
  money: (value: number, currency: string) => `${currency} ${value}`,
  multiplier: (value: number) => `${value}x`,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
}));

import { FunnelDevelopmentChart } from "./performance-charts";

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("performance chart dates", () => {
  it("keeps an ISO reporting day on that day in Lisbon summer time", () => {
    process.env.TZ = "Europe/Lisbon";

    const html = renderToStaticMarkup(
      <FunnelDevelopmentChart
        granularity="day"
        points={[
          {
            date: "2026-08-15",
            sessions: 1,
            addToCarts: 1,
            checkouts: 1,
            conversions: 0,
          },
        ]}
      />,
    );

    expect(html).toContain("15 Aug");
    expect(html).not.toContain("14 Aug");
  });
});
