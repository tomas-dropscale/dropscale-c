import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
}));

vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  SelectValue: () => <span>Select value</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    children,
    value,
    disabled,
  }: {
    children: ReactNode;
    value: string;
    disabled?: boolean;
  }) => (
    <div
      role="option"
      aria-selected="false"
      data-value={value}
      aria-disabled={disabled || undefined}
    >
      {children}
    </div>
  ),
}));

vi.mock("../ui/badge", () => ({
  Badge: ({
    children,
    variant: _variant,
    ...props
  }: { children: ReactNode; variant?: string } & Record<string, unknown>) => {
    void _variant;
    return <span {...props}>{children}</span>;
  },
}));

import { AnalyticsScopeControls } from "./analytics-scope-controls";

describe("AnalyticsScopeControls", () => {
  it("shows exact-range Running/Partial states and a disabled connection-only store", () => {
    const html = renderToStaticMarkup(
      <AnalyticsScopeControls
        clients={[
          {
            id: "client-1",
            name: "Northwind",
            email: "team@northwind.example",
            storeCount: 3,
            stores: [],
          },
        ]}
        clientId="client-1"
        stores={[
          {
            id: "store-running",
            name: "Running store",
            domain: "running.example",
            reportingState: "running",
            reportingCoverage: { rows: 7, expectedRows: 7 },
            updatedAt: "2026-08-15T10:00:00.000Z",
            adSpend: 100,
          },
          {
            id: "store-partial",
            name: "Partial store",
            domain: "partial.example",
            reportingState: "partial",
            reportingCoverage: { rows: 5, expectedRows: 7 },
            updatedAt: "2026-08-15T10:00:00.000Z",
            adSpend: 40,
          },
          {
            id: null,
            name: "Onboarding only",
            domain: "onboarding.example",
            reportingState: "not_materialized",
            reportingCoverage: { rows: 0, expectedRows: 0 },
            updatedAt: null,
            adSpend: 0,
          },
        ]}
        storeId={null}
        range={{ key: "d7", from: "2026-08-09", to: "2026-08-15" }}
      />,
    );

    expect(html).toContain("running.example");
    expect(html).toContain("Running");
    expect(html).toContain("complete selected-period grid");
    expect(html).toContain("partial.example");
    expect(html).toContain("5 of 7 account-days");
    expect(html).toContain("onboarding.example");
    expect(html).toContain("Not activated");
    expect(html).toContain('aria-disabled="true"');
  });
});
