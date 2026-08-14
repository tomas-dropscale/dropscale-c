import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  CampaignActionHistory,
  CampaignViewClient,
} from "@/lib/admin/campaigns-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement> & {
      asChild?: boolean;
      loading?: boolean;
      variant?: string;
      size?: string;
    }
  >(function MockButton(
    { asChild, loading: _loading, variant: _variant, size: _size, children, ...props },
    ref,
  ) {
    void _loading;
    void _variant;
    void _size;
    if (asChild) return children;
    return (
      <button ref={ref} {...props}>
        {children}
      </button>
    );
  }),
}));

vi.mock("@/components/ui/input", () => ({
  Input: forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
    function MockInput(props, ref) {
      return <input ref={ref} {...props} />;
    },
  ),
}));

vi.mock("@/lib/admin/campaigns-view", async () =>
  import("../../lib/admin/campaigns-view"),
);

vi.mock("@/lib/format", () => ({
  money: (value: number | string, currency: string) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value)),
  multiplier: (value: number) => `${value.toFixed(2)}x`,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

import { CampaignsView } from "./campaigns-view";

const clients: CampaignViewClient[] = [
  {
    id: "client-1",
    name: "Northwind Commerce",
    email: "performance@northwind.example",
    currency: "EUR",
    revenue: 8_400,
    adSpend: 2_800,
    realRoas: 3,
    stores: [
      {
        id: "store-1",
        name: "Northwind Home",
        domain: "northwind-home.com",
        currency: "EUR",
        realRoas: 3,
        rollupSpend: 2_800,
        campaignState: "ready",
        campaigns: [
          {
            bindingId: "binding-1",
            adAccountId: "account-1",
            providerCampaignId: "77",
            name: "DGEN · Summer Living · Scale",
            status: "active",
            spend: 2_000,
            dailyBudget: "120",
            currency: "EUR",
            type: "DEMAND_GEN",
            shoppingFeed: false,
            googleRoas: 2.5,
            actionable: true,
          },
          {
            bindingId: "binding-1",
            adAccountId: "account-1",
            providerCampaignId: "88",
            name: "PMax · Best sellers · EU",
            status: "paused",
            spend: 800,
            dailyBudget: "80",
            currency: "EUR",
            type: "PERFORMANCE_MAX",
            shoppingFeed: true,
            googleRoas: 1.25,
            actionable: true,
          },
        ],
      },
    ],
  },
];

const history: CampaignActionHistory[] = [
  {
    id: "scale-1",
    adAccountId: "account-1",
    providerCampaignId: "77",
    campaignName: "DGEN · Summer Living · Scale",
    action: "budget_changed",
    outcome: "succeeded",
    previousDailyBudget: 100,
    nextDailyBudget: 120,
    currency: "EUR",
    occurredAt: "2026-08-14T10:00:00.000Z",
    actorName: "Ana Costa",
  },
];

describe("CampaignsView approved visual structure", () => {
  it("opens the first client and renders its real totals, store total and approved actions", () => {
    const html = renderToStaticMarkup(
      <CampaignsView clients={clients} history={history} historyTruncated={false} />,
    );

    expect(html).toContain("Revenue");
    expect(html).toContain("Ad spend");
    expect(html).toContain("Real ROAS");
    expect(html).toContain("€8,400.00");
    expect(html.match(/3\.00x/g)).toHaveLength(2);
    expect(html).toContain("https://northwind-home.com");
    expect(html).toContain("TOTAL");
    expect(html).toContain("€2,800.00");
    expect(html).toContain("€200.00");
    expect(html).toContain("Google-attributed ROAS per campaign");
    expect(html).not.toContain(">real<");
    expect(html).toContain("PMAX (SF)");
    expect(html).toContain("Last Scaled at");
    expect(html).toContain(
      'href="/admin/analytics?client=client-1&amp;store=store-1"',
    );
    expect(html).toContain('aria-label="Pause DGEN · Summer Living · Scale"');
    expect(html).toContain('aria-label="Enable PMax · Best sellers · EU"');
    expect(html).toContain("hover or focus for scale history");
    expect(html).toContain(
      "xl:grid-cols-[1.75rem_minmax(0,auto)_1.75rem]",
    );
    expect(html).toContain('class="hidden size-7 xl:block" aria-hidden="true"');
    expect(html).not.toContain("binding policy");
    expect(html).not.toContain("Configure campaign controls");
  });

  it.each([
    ["empty", "No campaign rows were returned for this period."],
    ["failed", "Campaign reporting failed for this store."],
    ["disconnected", "Campaign reporting is unavailable"],
  ] as const)("keeps the approved table and TOTAL visible for %s stores", (state, message) => {
    const emptyClients: CampaignViewClient[] = [{
      ...clients[0],
      stores: [{
        ...clients[0].stores[0],
        campaignState: state,
        campaigns: [],
      }],
    }];
    const html = renderToStaticMarkup(
      <CampaignsView clients={emptyClients} history={[]} historyTruncated={false} />,
    );

    for (const heading of [
      "Campaign",
      "Type",
      "Status",
      "Spend",
      "Daily budget",
      "ROAS",
      "Last Scaled at",
      "Action",
    ]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("TOTAL");
    expect(html).toContain("€2,800.00");
    expect(html).toContain(message);
  });

  it("keeps successful source rows while warning that a store is partial", () => {
    const partialClients: CampaignViewClient[] = [{
      ...clients[0],
      stores: [{ ...clients[0].stores[0], campaignState: "partial" }],
    }];
    const html = renderToStaticMarkup(
      <CampaignsView clients={partialClients} history={history} historyTruncated={false} />,
    );

    expect(html).toContain("Some Google Ads sources could not be loaded");
    expect(html).toContain("DGEN · Summer Living · Scale");
  });
});
