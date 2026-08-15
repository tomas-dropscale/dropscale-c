import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/admin/commission-rate", () => ({
  CommissionRate: ({
    accountId,
    rate,
    listRate,
    scheduledListRate,
  }: {
    accountId: string;
    rate: number;
    listRate: number;
    scheduledListRate: number | null;
  }) => (
    <span>
      {accountId}: {listRate}% current → {rate}% effective
      {scheduledListRate === null ? "" : ` → ${scheduledListRate}% scheduled`}
    </span>
  ),
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import type { AdminCommissionClient } from "@/lib/admin/client-commissions";
import { ClientCommercialTerms } from "./client-commercial-terms";

function account(
  id: string,
  overrides: Partial<AdminCommissionClient["stores"][number]["billingAccounts"][number]> = {},
) {
  return {
    id,
    kind: "google_ads" as const,
    name: `Google ${id}`,
    googleAdsCustomerId: id,
    status: "active" as const,
    currency: "EUR",
    commissionRate: 10,
    listCommissionRate: 10,
    expectedTermId: null,
    scheduledListCommissionRate: null,
    scheduledEffectiveFrom: null,
    revenueShareEnabled: false,
    ...overrides,
  };
}

const CLIENT: AdminCommissionClient = {
  id: "client-1",
  name: "Northwind Commerce",
  email: "owner@northwind.example",
  approvalStatus: "approved",
  stores: [
    {
      id: "store-1",
      name: "Northwind Home",
      domain: "northwind-home.com",
      status: "active",
      currency: "EUR",
      billingAccounts: [
        account("google-eu", {
          commissionRate: 9.5,
          expectedTermId: "term-2",
          scheduledListCommissionRate: 12.5,
          scheduledEffectiveFrom: "2026-08-17",
        }),
        account("google-us"),
      ],
    },
  ],
  unallocatedBillingAccounts: [account("google-unallocated")],
};

describe("ClientCommercialTerms", () => {
  it("keeps commission controls collapsed and grouped below the client's logical stores", () => {
    const html = renderToStaticMarkup(<ClientCommercialTerms client={CLIENT} />);

    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Commercial terms");
    expect(html).toContain("Manual base 10%");
    expect(html).toContain("3 billing accounts");
    expect(html).toContain("Northwind Home");
    expect(html).toContain("northwind-home.com");
    expect(html).not.toContain("myshopify.com");
    expect(html).toContain("google-eu: 10% current → 9.5% effective → 12.5% scheduled");
    expect(html).toContain("google-us: 10% current → 10% effective");
    expect(html).toContain("Unallocated Google billing");
    expect(html).toContain("google-unallocated: 10% current → 10% effective");
  });

  it("does not add an empty commercial panel to clients without billing accounts", () => {
    expect(renderToStaticMarkup(<ClientCommercialTerms client={null} />)).toBe("");
  });
});
