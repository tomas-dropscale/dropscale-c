import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listClients: vi.fn() }));

vi.mock("@/lib/admin/client-commissions", () => ({
  listAdminCommissionClients: mocks.listClients,
}));
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
    <span>{`${accountId}: ${listRate}% list → ${rate}% effective${scheduledListRate === null ? "" : ` → ${scheduledListRate}% scheduled`}`}</span>
  ),
}));
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ name }: { name: string }) => <span>{name.slice(0, 1)}</span>,
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/page-container", () => ({
  PageContainer: ({
    title,
    description,
    actions,
    children,
  }: {
    title: ReactNode;
    description: ReactNode;
    actions: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      <div>{actions}</div>
      {children}
    </main>
  ),
}));

import AdminClientsPage from "./page";

describe("Clients commission page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listClients.mockResolvedValue([
      {
        id: "client-1",
        name: "Northwind Commerce",
        email: "owner@northwind.example",
        approvalStatus: "approved",
        stores: [
          {
            id: "anchor-1",
            name: "Northwind Home",
            domain: "northwind-home.com",
            status: "active",
            currency: "EUR",
            billingAccounts: [
              {
                id: "google-eu",
                kind: "google_ads",
                name: "Northwind Google EU",
                googleAdsCustomerId: "1234567890",
                status: "active",
                currency: "EUR",
                commissionRate: 9.5,
                listCommissionRate: 10,
                expectedTermId: "term-2",
                scheduledListCommissionRate: 12.5,
                scheduledEffectiveFrom: "2026-08-17",
                revenueShareEnabled: false,
              },
              {
                id: "google-us",
                kind: "google_ads",
                name: "Northwind Google US",
                googleAdsCustomerId: "9876543210",
                status: "active",
                currency: "EUR",
                commissionRate: 10,
                listCommissionRate: 10,
                expectedTermId: null,
                scheduledListCommissionRate: null,
                scheduledEffectiveFrom: null,
                revenueShareEnabled: false,
              },
            ],
          },
        ],
        unallocatedBillingAccounts: [
          {
            id: "google-unallocated",
            kind: "google_ads",
            name: "Northwind Google Unallocated",
            googleAdsCustomerId: "2222222222",
            status: "active",
            currency: "EUR",
            commissionRate: 10,
            listCommissionRate: 10,
            expectedTermId: null,
            scheduledListCommissionRate: null,
            scheduledEffectiveFrom: null,
            revenueShareEnabled: false,
          },
        ],
      },
    ]);
  });

  it("renders one logical store with its exact physical Google billing accounts", async () => {
    const page = await AdminClientsPage();
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Clients");
    expect(html).toContain("Commission by client");
    expect(html).toContain("Northwind Commerce");
    expect(html).toContain("Northwind Home");
    expect(html).toContain("northwind-home.com");
    expect(html).toContain("Northwind Google EU");
    expect(html).toContain("Northwind Google US");
    expect(html).toContain("Google billing account");
    expect(html).toContain("google-eu: 10% list → 9.5% effective → 12.5% scheduled");
    expect(html).toContain("google-us: 10% list → 10% effective");
    expect(html).toContain("Unallocated Google billing");
    expect(html).toContain("Northwind Google Unallocated");
    expect(html).toContain("google-unallocated: 10% list → 10% effective");
    expect(html).toContain("Not counted as stores");
    expect(html).toContain("1 store");
    expect(html).toContain("3 billing accounts");
    expect(html).toContain("Mixed store rates stay explicit");
    expect(html).toContain("V2 Google children stay inside their Shopify store");
    expect(html).toContain('href="/admin/client-onboarding"');
    expect(html).toContain('href="/admin/referrals"');
  });

  it("shows an explicit empty state when no client owns a store", async () => {
    mocks.listClients.mockResolvedValueOnce([]);

    const page = await AdminClientsPage();
    const html = renderToStaticMarkup(page);

    expect(html).toContain("No client stores yet");
    expect(html).toContain("0 clients");
  });
});
