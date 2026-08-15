import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));
vi.mock("@/components/ui/date-range-picker", () => ({ DateRangePicker: vi.fn() }));
vi.mock("@/lib/portal/range", async () => import("../../lib/portal/range"));

import { rangeHref } from "./range-picker";

describe("rangeHref", () => {
  it("replaces only range params and preserves the selected Analytics scope", () => {
    expect(
      rangeHref(
        "/admin/analytics",
        "client=client-1&store=store-1&range=d7&from=2026-08-09&to=2026-08-15",
        { key: "today", from: "2026-08-15", to: "2026-08-15" },
      ),
    ).toBe(
      "/admin/analytics?client=client-1&store=store-1&range=today&from=2026-08-15&to=2026-08-15",
    );
  });
});
