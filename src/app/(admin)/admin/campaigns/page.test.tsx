import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAdminCampaigns: vi.fn(),
  listCampaignActionViewState: vi.fn(),
  parseRange: vi.fn(),
}));

vi.mock("@/components/admin/campaigns-view", () => ({
  CampaignsView: () => <div>Campaign table</div>,
}));

vi.mock("@/components/admin/campaigns-toolbar", () => ({
  CampaignsToolbar: () => <div>New Campaign · Sync</div>,
}));

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

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => null,
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
  parseRange: mocks.parseRange,
}));

import AdminCampaignsPage from "./page";

describe("Campaigns page approved summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseRange.mockReturnValue({
      key: "today",
      from: "2026-08-14",
      to: "2026-08-14",
    });
    mocks.fetchAdminCampaigns.mockResolvedValue({
      configured: true,
      clients: [{ clientId: "external-client" }],
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
        currency: "EUR",
        currencies: ["EUR"],
        rollupComplete: true,
      },
    });
    mocks.listCampaignActionViewState.mockResolvedValue({
      history: [],
      actorNames: new Map(),
      historyTruncated: false,
    });
  });

  it("renders the approved header, actions and six portfolio cards", async () => {
    const page = await AdminCampaignsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Portfolio performance and active campaign controls");
    expect(html).toContain("2026-08-14 → 2026-08-14");
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
    expect(html).not.toContain("Client controls");
    expect(html).not.toContain("Commercial terms");
    expect(mocks.parseRange).toHaveBeenCalledWith({});
  });

  it("keeps an explicit range instead of replacing it with the page default", async () => {
    const params = { range: "d30" };
    mocks.parseRange.mockReturnValueOnce({
      key: "d30",
      from: "2026-07-16",
      to: "2026-08-14",
    });

    await AdminCampaignsPage({ searchParams: Promise.resolve(params) });

    expect(mocks.parseRange).toHaveBeenCalledWith(params);
    expect(mocks.fetchAdminCampaigns).toHaveBeenCalledWith(
      {
        key: "d30",
        from: "2026-07-16",
        to: "2026-08-14",
      },
      { campaignSource: "snapshot" },
    );
  });

  it("does not present mixed currencies as a single portfolio total", async () => {
    mocks.fetchAdminCampaigns.mockResolvedValueOnce({
      configured: true,
      clients: [],
      internal: [],
      totals: {
        revenue: null,
        profit: null,
        roas: null,
        rollupSpend: null,
        spend: null,
        commission: null,
        activeCampaigns: 3,
        connectedAccounts: 2,
        currency: null,
        currencies: ["EUR", "USD"],
        rollupComplete: true,
      },
    });

    const page = await AdminCampaignsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("reporting currencies are mixed (EUR, USD)");
    expect(html).not.toContain("€0.00");
  });

  it("does not render a selected-day coverage warning for an empty materialised range", async () => {
    mocks.fetchAdminCampaigns.mockResolvedValueOnce({
      configured: true,
      clients: [],
      internal: [],
      totals: {
        revenue: null,
        profit: null,
        roas: null,
        rollupSpend: null,
        spend: null,
        commission: null,
        activeCampaigns: 0,
        connectedAccounts: 1,
        currency: null,
        currencies: ["EUR"],
        rollupComplete: false,
      },
    });

    const page = await AdminCampaignsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page);

    expect(html).not.toContain("every mapped account and selected day");
    expect(html).not.toContain("could not be verified");
  });

  it("does not invent an active-campaign count before every exact snapshot is ready", async () => {
    mocks.fetchAdminCampaigns.mockResolvedValueOnce({
      configured: true,
      clients: [],
      internal: [],
      totals: {
        revenue: 100,
        profit: 10,
        roas: 2,
        rollupSpend: 50,
        spend: 50,
        commission: 5,
        activeCampaigns: null,
        connectedAccounts: 1,
        currency: "EUR",
        currencies: ["EUR"],
        rollupComplete: true,
      },
    });

    const page = await AdminCampaignsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Active campaigns");
    expect(html).toContain("Not synced for this exact period");
    expect(html).toContain("—");
  });
});
