import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement>
  >(function MockTrigger({ children, ...props }, ref) {
    return <button ref={ref} {...props}>{children}</button>;
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant,
    size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => {
    void variant;
    void size;
    return <button {...props}>{children}</button>;
  },
}));

vi.mock("@/lib/i18n/provider", () => ({
  useI18n: () => ({
    intl: "en-GB",
    d: {
      ranges: {
        today: "Today",
        yesterday: "Yesterday",
        d3: "Last 3 days",
        d7: "Last 7 days",
        d14: "Last 14 days",
        d30: "Last 30 days",
        mtd: "This month",
        ytd: "This year",
        custom: "Custom",
      },
      common: { cancel: "Cancel", apply: "Apply" },
    },
  }),
}));

vi.mock("@/lib/portal/range", async () => import("../../lib/portal/range"));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
}));

import { DateRangePicker } from "./date-range-picker";

describe("DateRangePicker", () => {
  it("opens on and highlights the concrete dates of the selected timeframe", () => {
    const html = renderToStaticMarkup(
      <DateRangePicker
        value={{ key: "d7", from: "2026-08-08", to: "2026-08-14" }}
        onApply={vi.fn()}
      />,
    );

    expect(html).toContain("Last 7 days · 08 Aug – 14 Aug");
    expect(html).toContain("July 2026");
    expect(html).toContain("August 2026");
    expect(html).toMatch(
      /<button[^>]*bg-\[var\(--accent-gold\)\][^>]*>8<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*bg-\[var\(--accent-gold-dim\)\][^>]*>9<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*bg-\[var\(--accent-gold\)\][^>]*>14<\/button>/,
    );
  });
});
