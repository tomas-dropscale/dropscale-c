import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAdminCampaigns: vi.fn(),
  listCampaignActionViewState: vi.fn(),
}));

vi.mock("@/components/admin/campaigns-view", () => ({
  CampaignsView: () => <div>Campaign table</div>,
}));

vi.mock("@/components/admin/campaigns-toolbar", () => ({
  CampaignsToolbar: () => <div>New Campaign · Sync</div>,
}));

vi.mock("@/components/admin/client-dashboard-dialog", () => ({
  ClientDashboardDialog: () => null,
}));

vi.mock("@/components/admin/commission-rate", () => ({ CommissionRate: () => null }));
vi.mock("@/components/admin/store-name", () => ({ StoreName: () => null }));
vi.mock("@/components/ui/avatar", () => ({ Avatar: () => null }));
vi.mock("@/components/ui/badge", () => ({ Badge: () => null }));
vi.mock("@/components/portal/range-picker", () => ({
  RangePicker: () => <div>Date range</div>,
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

vi.mock("@/lib/admin/campaign-actions", () => ({
  listCampaignActionViewState: mocks.listCampaignActionViewState,
}));

vi.mock("@/lib/admin/campaigns", () => ({
  fetchAdminCampaigns: mocks.fetchAdminCampaigns,
}));

vi.mock("@/lib/admin/campaigns-view", () => ({
  campaignActionBindingIds: () => [],
  projectAdminCampaignsView: () => ({
    clients: [],
    history: [],
    historyTruncated: false,
  }),
}));

vi.mock("@/lib/format", () => ({
  multiplier: (value: number) => `${value.toFixed(2)}x`,
}));

vi.mock("@/lib/format-intl", () => ({
  money: (value: number) => `€${value.toFixed(2)}`,
}));

vi.mock("@/lib/i18n", () => ({ intlLocale: () => "en-GB" }));
vi.mock("@/lib/i18n/server", () => ({
  getServerDictionary: () =>
    Promise.resolve({
      d: { placeholder: { campaigns: { title: "Campaigns" } } },
      locale: "en",
    }),
}));

vi.mock("@/lib/portal/range", () => ({
  parseRange: () => ({ key: "d7", from: "2026-08-08", to: "2026-08-14" }),
}));

import AdminCampaignsPage from "./page";

describe("Campaigns page approved summary", () => {
  it("renders the approved header, actions and six portfolio cards", async () => {
    mocks.fetchAdminCampaigns.mockResolvedValue({
      configured: true,
      clients: [],
      internal: [],
      totals: {
        revenue: 8_400,
        profit: 1_000,
        roas: 3,
        rollupSpend: 2_800,
        spend: 2_800,
        commission: 420,
        activeCampaigns: 3,
        connectedAccounts: 2,
      },
    });
    mocks.listCampaignActionViewState.mockResolvedValue({
      history: [],
      actorNames: new Map(),
      historyTruncated: false,
    });

    const page = await AdminCampaignsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Portfolio performance and active campaign controls");
    expect(html).toContain("2026-08-08 → 2026-08-14");
    expect(html).toContain("New Campaign · Sync");
    expect(html).toContain("Date range");
    expect(html).toContain("Revenue");
    expect(html).toContain("Real ROAS");
    expect(html).toContain("Ad spend");
    expect(html).toContain("Agency commission");
    expect(html).toContain("Active campaigns");
    expect(html).toContain("Connected accounts");
    expect(html).toContain("Across mapped ad accounts");
    expect(html).toContain("Based on each store rate");
    expect(html).toContain("Enabled in Google Ads");
    expect(html).toContain("Available reporting accounts");
    expect(html).not.toContain("Client profit");
    expect(html).not.toContain("Average ROAS");
  });
});
