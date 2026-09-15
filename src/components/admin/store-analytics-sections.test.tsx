import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AdminAnalyticsCampaign,
  AdminAnalyticsCampaignTimelinePoint,
  AdminProviderFreshness,
  AdminStoreAnalytics,
  CampaignSheetFees,
} from "@/lib/admin/store-analytics";

vi.mock("@/components/admin/performance-charts", () => ({
  SpendDevelopmentChart: () => <div>Spend chart</div>,
  FunnelDevelopmentChart: () => <div>Funnel chart</div>,
  RoasEvolutionHover: () => <span>ROAS hover</span>,
}));

// The sheet itself is tested next door; here it only has to say what it was
// fed. The fold that feeds a collection's sheet is the real one.
vi.mock("./campaign-profit-loss", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./campaign-profit-loss")>()),
  CampaignProfitLossSheet: ({
    title,
    campaign,
    fees,
  }: {
    title: string;
    campaign: { members?: number; timeline: unknown[] };
    fees?: CampaignSheetFees | null;
  }) => (
    <div>
      P&amp;L sheet: {title} · {campaign.members ?? 1} campaigns · {campaign.timeline.length} buckets ·{" "}
      {fees ? "with fees" : "no fees"}
    </div>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <span {...props}>{children}</span>
  ),
}));

vi.mock("@/lib/format", () => ({
  integer: (value: number) => String(value),
  money: (value: number, currency: string) => `${currency} ${value.toFixed(2)}`,
  multiplier: (value: number) => `${value.toFixed(2)}x`,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

import {
  CampaignCollectionsBlock,
  CampaignPerformanceSection,
  snapshotFreshnessLine,
} from "./store-analytics-sections";

function campaign(over: Partial<AdminAnalyticsCampaign> = {}): AdminAnalyticsCampaign {
  return {
    accountId: "google-child",
    campaignId: "123456789",
    name: "PMax · Best sellers",
    status: "active",
    type: "PERFORMANCE_MAX",
    shoppingFeed: true,
    budget: 90,
    spend: 250,
    impressions: 10_000,
    clicks: 400,
    conversions: 12,
    googleRevenue: 800,
    shopifySessions: null,
    shopifyOrders: null,
    shopifyRevenue: null,
    ctr: 0.04,
    cpc: 0.625,
    cpm: 25,
    cpa: 20.83,
    googleRoas: 3.2,
    realRoas: null,
    attributionState: "unavailable",
    timeline: [],
    breakdown: {
      state: "unavailable",
      reason: "Asset detail is not available for this reporting source.",
      rows: [],
      sources: [],
    },
    ...over,
  };
}

function point(over: Partial<AdminAnalyticsCampaignTimelinePoint> & { bucket: string }): AdminAnalyticsCampaignTimelinePoint {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    shopifyRevenue: null,
    shopifySessions: null,
    addedToCart: null,
    shopifyOrders: null,
    units: null,
    googleRevenue: 0,
    realRoas: null,
    googleRoas: null,
    ...over,
  };
}

/**
 * A campaign with no UTM match that lands on a collection, holding its
 * spend share of one day's collection sales: the Emma Gyor shape.
 */
function landing(
  name: string,
  handle: string,
  shares: {
    spend: number;
    revenue: number;
    orders: number;
    /** The part of the share bought by people whose first visit landed on the page, when the snapshot carries it. */
    landed?: { revenue: number; orders: number };
    /** The part of the share Shopify reported no journey for; zero unless the fixture says otherwise. */
    unknown?: { revenue: number; orders: number };
    /** What the page brought in beside the collection's own sales. */
    brought?: { revenue: number; orders: number };
  },
): AdminAnalyticsCampaign {
  return campaign({
    campaignId: name,
    name,
    spend: shares.spend,
    attributionState: "unmatched",
    collectionHandle: handle,
    collectionSource: "final_url",
    timeline: [
      point({
        bucket: "2026-08-06",
        spend: shares.spend,
        clicks: 100,
        impressions: 1_000,
        collectionRevenue: shares.revenue,
        collectionUnits: 1,
        collectionOrders: shares.orders,
        collectionLandedRevenue: shares.landed?.revenue ?? null,
        collectionLandedUnits: shares.landed ? 1 : null,
        collectionLandedOrders: shares.landed?.orders ?? null,
        collectionUnknownRevenue: shares.landed ? shares.unknown?.revenue ?? 0 : null,
        collectionUnknownOrders: shares.landed ? shares.unknown?.orders ?? 0 : null,
        collectionBroughtRevenue: shares.brought?.revenue ?? null,
        collectionBroughtOrders: shares.brought?.orders ?? null,
        collectionAddedToCart: 10,
        cogs: 5,
      }),
    ],
  });
}

const BLUSAS = ["[HU] BLUSAS - 27/08", "[HU] BLUSAS #2", "[HU] BLUSAS #3", "[HU] BLUSAS #4"].map((name) =>
  landing(name, "mintas-kardiganok", {
    spend: 25,
    revenue: 100,
    orders: 0.5,
    landed: { revenue: 75, orders: 0.25 },
    brought: { revenue: 25, orders: 0.5 },
  }),
);
/** The BOHO snapshot was taken before the split existed, so its row has none to show. */
const BOHO = landing("BOHO - HU - 30/07", "kenyelmes-ruhak", { spend: 40, revenue: 80, orders: 1 });

/** The collections family knows the BLUSAS collection by title; the BOHO one did not sell, so it is absent. */
const COLLECTIONS: AdminStoreAnalytics["collections"] = {
  state: "ready",
  data: {
    granularity: "day",
    rows: [
      {
        collectionId: "gid://shopify/Collection/1",
        title: "Mintás kardigánok",
        handle: "mintas-kardiganok",
        products: [],
        revenue: 400,
        units: 4,
        spend: null,
        roas: null,
        timeline: [],
      },
    ],
  },
};

const FEES: CampaignSheetFees = { paymentFeePct: 1.7, paymentFeeFixed: 0.25, shippingCostPerOrder: 0, agencyFeeRate: 10 };

function campaigns(
  overrides: Partial<Extract<AdminStoreAnalytics["campaigns"], { data: unknown }>> = {},
): AdminStoreAnalytics["campaigns"] {
  return {
    state: "ready",
    data: { granularity: "day", rows: [campaign()], storeToday: "2026-08-07" },
    ...overrides,
  } as AdminStoreAnalytics["campaigns"];
}

const KEPT: AdminProviderFreshness = {
  state: "partial",
  refreshedAt: "2026-08-07T09:03:00.000Z",
  lastAttemptAt: "2026-08-07T10:01:00.000Z",
  lastErrorCode: "provider_partial",
  stale: false,
};

const KEPT_MESSAGE =
  "Last failure: Google metrics are ready; Shopify last-non-direct-click UTM attribution matched to Google campaign IDs is unavailable. The last refresh failed (provider_partial); showing the last successful snapshot.";

function render(
  section: AdminStoreAnalytics["campaigns"],
  freshness?: AdminProviderFreshness | null,
  collections?: AdminStoreAnalytics["collections"] | null,
) {
  return renderToStaticMarkup(
    <CampaignPerformanceSection
      campaigns={section}
      collections={collections}
      currency="GBP"
      rangeEnd="2026-08-07"
      freshness={freshness}
    />,
  );
}

describe("snapshotFreshnessLine", () => {
  it("says when the kept snapshot was taken and what the failed refresh said", () => {
    expect(snapshotFreshnessLine(KEPT_MESSAGE, KEPT)).toBe(
      "Snapshot from 7 Aug 2026, 10:03 · last refresh 7 Aug 2026, 11:01 failed: " +
        "Google metrics are ready; Shopify last-non-direct-click UTM attribution matched to Google campaign IDs is unavailable. " +
        "The last refresh failed (provider_partial); showing the last successful snapshot.",
    );
  });

  it("dates a persisted partial without calling it a failure", () => {
    expect(snapshotFreshnessLine(
      "Google metrics are ready; Shopify attribution is unavailable.",
      { ...KEPT, lastAttemptAt: "2026-08-07T09:03:00.000Z", lastErrorCode: null },
    )).toBe(
      "Snapshot from 7 Aug 2026, 10:03 · Google metrics are ready; Shopify attribution is unavailable.",
    );
  });

  it("falls back to the error code when the row kept no message", () => {
    expect(snapshotFreshnessLine(null, KEPT)).toBe(
      "Snapshot from 7 Aug 2026, 10:03 · last refresh 7 Aug 2026, 11:01 failed (provider_partial); showing the last good data.",
    );
  });

  it("renders a live family's message alone and nothing for a clean ready family", () => {
    expect(snapshotFreshnessLine("Shopify attribution was withheld.", null)).toBe(
      "Shopify attribution was withheld.",
    );
    expect(snapshotFreshnessLine(null, { ...KEPT, lastErrorCode: null })).toBeNull();
    expect(snapshotFreshnessLine("  ", null)).toBeNull();
  });
});

describe("CampaignPerformanceSection", () => {
  it("heads a populated table with the snapshot notice when the last refresh failed", () => {
    const html = render(campaigns({ message: KEPT_MESSAGE }), KEPT);

    expect(html).toContain('role="status"');
    expect(html).toContain("Snapshot from 7 Aug 2026, 10:03 · last refresh 7 Aug 2026, 11:01 failed: Google metrics are ready");
    expect(html).toContain("warning-orange");
    // The rows themselves are still the kept sheet.
    expect(html).toContain("PMax · Best sellers");
    expect(html.indexOf("Snapshot from")).toBeLessThan(html.indexOf("PMax · Best sellers"));
    expect(html).not.toContain('role="alert"');
  });

  it("shows a ready family's caption above the rows in the muted style", () => {
    const html = render(
      campaigns({ message: "Shopify attribution was withheld for campaign IDs repeated across Google accounts." }),
      { ...KEPT, lastErrorCode: null, state: "ready" },
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Snapshot from 7 Aug 2026, 10:03 · Shopify attribution was withheld");
    expect(html).not.toContain("warning-orange");
    expect(html).not.toContain("failed");
  });

  it("renders no notice for a clean ready family with rows", () => {
    const html = render(campaigns(), { ...KEPT, lastErrorCode: null, state: "ready" });

    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("Snapshot from");
    expect(html).toContain("PMax · Best sellers");
  });

  it("keeps the family notice when there are no rows", () => {
    const html = render(
      campaigns({
        state: "partial",
        message: KEPT_MESSAGE,
        data: { granularity: "day", rows: [] },
      }),
      KEPT,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("last refresh failed (provider_partial)");
    expect(html).not.toContain("Snapshot from");
    expect(html).not.toContain("<table");
  });

  it("keeps the failed family notice when the family has no data", () => {
    const html = render(
      { state: "failed", message: "Campaign performance could not be loaded for this store." },
      KEPT,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Campaign performance could not be loaded for this store.");
    expect(html).not.toContain("Snapshot from");
  });

  it("groups the campaigns by the collection they land on, above the table, summed", () => {
    // Paulo & Joao keep one sheet per collection: HU BLUSAS is four
    // campaigns, BOHO is one, and the PMax lands on no collection at all.
    const html = render(
      campaigns({ data: { granularity: "day", rows: [...BLUSAS, BOHO, campaign()], storeToday: "2026-08-07" } }),
      null,
      COLLECTIONS,
    );

    expect(html).toContain('aria-label="Collections landed on by campaigns"');
    // Titled by the collections family where it has the handle; the handle
    // itself stands in for a collection the family did not list.
    expect(html).toContain("Mintás kardigánok");
    expect(html).toContain("/collections/mintas-kardiganok · 4 campaigns");
    expect(html).toContain("/collections/kenyelmes-ruhak · 1 campaign<");
    // Four shares of GBP 25 spend, GBP 100 revenue and half an order add up
    // to the collection's whole: 100, 400, 2 orders, 4.00x.
    expect(html).toContain("GBP 100.00");
    expect(html).toContain("GBP 400.00");
    expect(html).toContain("4.00x");
    expect(html).toContain("GBP 50.00");
    expect(html).toContain('aria-label="P&amp;L: show Mintás kardigánok collection profit and loss by day"');
    expect(html).toContain('aria-label="P&amp;L: show kenyelmes-ruhak collection profit and loss by day"');
    // The block sits above the campaign table, whose rows stay as they were.
    expect(html.indexOf("Mintás kardigánok")).toBeLessThan(html.indexOf("[HU] BLUSAS - 27/08"));
    expect(html).toContain("[HU] BLUSAS #4");
    expect(html).toContain("PMax · Best sellers");
    expect(html).not.toContain("P&amp;L sheet:");
  });

  it("renders no Collections block when no campaign lands on a collection", () => {
    const html = render(campaigns(), null, COLLECTIONS);

    expect(html).not.toContain("Collections landed on by campaigns");
    expect(html).toContain("PMax · Best sellers");
  });

  it("names the collection by its handle when the collections family is unknown", () => {
    const html = render(campaigns({ data: { granularity: "day", rows: BLUSAS, storeToday: "2026-08-07" } }));

    expect(html).toContain("Collections landed on by campaigns");
    expect(html).toContain('aria-label="P&amp;L: show mintas-kardiganok collection profit and loss by day"');
    expect(html).not.toContain("Mintás kardigánok");
  });
});

describe("CampaignCollectionsBlock", () => {
  const block = (openSheets: ReadonlySet<string>, fees: CampaignSheetFees | null = null) =>
    renderToStaticMarkup(
      <CampaignCollectionsBlock
        rows={[...BLUSAS, BOHO]}
        collections={COLLECTIONS}
        currency="GBP"
        today="2026-08-07"
        fees={fees}
        openSheets={openSheets}
        onToggleSheet={() => undefined}
      />,
    );

  it("keeps the collection sheets closed until their P&L is toggled", () => {
    const html = block(new Set());

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain("P&amp;L sheet:");
  });

  it("opens the collection sheet fed with the summed campaigns, and the store's fees", () => {
    const html = block(new Set(["mintas-kardiganok"]), FEES);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="P&amp;L: hide Mintás kardigánok collection profit and loss by day"');
    // Four campaigns summed over their one shared day, the fees passed along.
    expect(html).toContain("P&amp;L sheet: Mintás kardigánok (collection) · 4 campaigns · 1 buckets · with fees");
    // The other collection's sheet stays closed.
    expect(html).not.toContain("P&amp;L sheet: kenyelmes-ruhak");
    expect(html).toContain('aria-expanded="false"');
  });

  it("says under each row how that collection's sales arrived", () => {
    const html = block(new Set());

    // Four shares of 75 landed and 25 brought in add back to the page's
    // whole: 300 of the 400 the row shows, and 100 the row counts as zero.
    // "first visit" because that is the only visit Shopify reports.
    expect(html).toContain(
      "first visit landed GBP 300.00 (75.0%) · elsewhere GBP 100.00 · brought in GBP 100.00 that bought nothing here",
    );
    // The collection whose snapshot has no split says nothing rather than
    // printing a zero for a number nobody measured.
    expect((html.match(/first visit landed GBP/g) ?? []).length).toBe(1);
    // And the row above it is unchanged.
    expect(html).toContain("GBP 400.00");
    expect(html).toContain("/collections/kenyelmes-ruhak · 1 campaign<");
    // An order counted as brought in bought some other collection's items,
    // which are that row's revenue, so the caption warns off adding the two
    // down the table.
    expect(html).toContain("the brought figures do not add across the table");
  });

  it("names the part of a row Shopify reported no journey for", () => {
    // Folded into "elsewhere" the row would say the page lost GBP 100.00 of
    // sales that were never measured either way.
    const html = renderToStaticMarkup(
      <CampaignCollectionsBlock
        rows={[
          landing("[HU] BLUSAS - 27/08", "mintas-kardiganok", {
            spend: 25,
            revenue: 400,
            orders: 2,
            landed: { revenue: 240, orders: 1 },
            unknown: { revenue: 100, orders: 0.5 },
          }),
        ]}
        collections={COLLECTIONS}
        currency="GBP"
        today="2026-08-07"
        fees={null}
        openSheets={new Set()}
        onToggleSheet={() => undefined}
      />,
    );

    expect(html).toContain(
      "first visit landed GBP 240.00 (60.0%) · elsewhere GBP 60.00 · not reported GBP 100.00",
    );
  });

  it("renders nothing when no row lands on a collection", () => {
    const html = renderToStaticMarkup(
      <CampaignCollectionsBlock
        rows={[campaign()]}
        collections={COLLECTIONS}
        currency="GBP"
        today="2026-08-07"
        fees={null}
        openSheets={new Set()}
        onToggleSheet={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});
