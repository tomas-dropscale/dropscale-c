/**
 * One coherent, deliberately fictional dataset for the local Campaigns and
 * Analytics review. Nothing in this module reads an environment variable,
 * database or provider API.
 */

export type PrototypeCampaignStatus = "active" | "paused";
export type PrototypeCampaignKind = "demand_gen" | "performance_max";
export type PrototypePeriod = "today" | "d3" | "d7" | "d14" | "d30";

export const PROTOTYPE_PERIODS: { value: PrototypePeriod; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "d3", label: "3 days" },
  { value: "d7", label: "7 days" },
  { value: "d14", label: "14 days" },
  { value: "d30", label: "30 days" },
];

export type PrototypeMetricSet = {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  googleRevenue: number;
  /** Mock Shopify revenue attributed to this row. */
  realRevenue: number;
};

export type PrototypeCreative = {
  id: string;
  name: string;
  format: "image" | "video";
  tone: "gold" | "blue" | "violet" | "green";
  metrics: PrototypeMetricSet;
};

export type PrototypeProduct = {
  id: string;
  name: string;
  sku: string;
  tone: "gold" | "blue" | "violet" | "green";
  metrics: PrototypeMetricSet;
};

type PrototypeCampaignBase = {
  id: string;
  name: string;
  status: PrototypeCampaignStatus;
  dailyBudget: number;
  collection: string;
  metrics: PrototypeMetricSet;
};

export type PrototypeDemandGenCampaign = PrototypeCampaignBase & {
  kind: "demand_gen";
  creatives: PrototypeCreative[];
};

export type PrototypePerformanceMaxCampaign = PrototypeCampaignBase & {
  kind: "performance_max";
  shoppingFeed: boolean;
  products: PrototypeProduct[];
};

export type PrototypeCampaign =
  | PrototypeDemandGenCampaign
  | PrototypePerformanceMaxCampaign;

export type PrototypeFunnel = {
  sessions: number;
  addToCarts: number;
  checkouts: number;
  purchases: number;
};

export type PrototypeCollection = {
  id: string;
  name: string;
  units: number;
  adSpend: number;
  revenue: number;
  sources: PrototypeCampaignKind[];
  products: PrototypeCollectionProduct[];
};

export type PrototypeCollectionProduct = {
  id: string;
  name: string;
  units: number;
  adSpend: number;
  revenue: number;
};

export type PrototypePerformancePoint = {
  /** Deterministic ISO date-time bucket for the local chart. */
  date: string;
  revenue: number;
  googleSpend: number;
  estimatedProfit: number;
  realRoas: number | null;
  sessions: number;
  addToCarts: number;
  checkouts: number;
  conversions: number;
};

type PrototypeStoreActivityBase = {
  id: string;
  createdAt: string;
  actor: string;
  campaignId: string;
  campaignName: string;
};

export type PrototypeStoreActivity = PrototypeStoreActivityBase &
  (
    | {
        action: "budget_changed";
        previousBudget: number;
        nextBudget: number;
      }
    | {
        action: "campaign_paused" | "campaign_enabled";
      }
    | {
        action: "campaign_launched";
        dailyBudget: number;
      }
  );

export type PrototypeStore = {
  id: string;
  name: string;
  domain: string;
  currency: "EUR";
  mappingStatus: "mapped" | "unmapped";
  revenue: number;
  orders: number;
  units: number;
  commissionRate: number;
  funnel: PrototypeFunnel;
  campaigns: PrototypeCampaign[];
  collections: PrototypeCollection[];
  activity: PrototypeStoreActivity[];
};

export type PrototypeClient = {
  id: string;
  name: string;
  email: string;
  currency: "EUR";
  stores: PrototypeStore[];
};

export type PrototypeRollup = {
  revenue: number;
  adSpend: number;
  realRoas: number;
  orders: number;
  units: number;
  activeCampaigns: number;
  connectedAccounts: number;
  agencyCommission: number;
};

export type PrototypeGoogleMetrics = {
  cpc: number;
  ctr: number;
  cpm: number;
  cpa: number;
  googleRoas: number;
  realRoas: number;
};

const metric = (
  spend: number,
  impressions: number,
  clicks: number,
  conversions: number,
  googleRevenue: number,
  realRevenue: number,
): PrototypeMetricSet => ({
  spend,
  impressions,
  clicks,
  conversions,
  googleRevenue,
  realRevenue,
});

export const PERFORMANCE_PROTOTYPE_CLIENTS: PrototypeClient[] = [
  {
    id: "northwind",
    name: "Northwind Commerce",
    email: "performance@northwind.example",
    currency: "EUR",
    stores: [
      {
        id: "northwind-home",
        name: "Northwind Home",
        domain: "northwind-home.com",
        currency: "EUR",
        mappingStatus: "mapped",
        revenue: 31_842,
        orders: 402,
        units: 518,
        commissionRate: 12,
        funnel: { sessions: 22_140, addToCarts: 2_612, checkouts: 1_184, purchases: 402 },
        campaigns: [
          {
            id: "nw-dg-summer",
            name: "DG · Summer Living · Scale",
            kind: "demand_gen",
            status: "active",
            dailyBudget: 420,
            collection: "Summer Living",
            metrics: metric(8_240, 1_460_000, 24_090, 218, 25_910, 28_420),
            creatives: [
              {
                id: "nw-creative-room",
                name: "Room transformation · 15s",
                format: "video",
                tone: "gold",
                metrics: metric(3_610, 584_000, 10_960, 112, 12_840, 14_760),
              },
              {
                id: "nw-creative-linen",
                name: "Linen textures · Carousel",
                format: "image",
                tone: "blue",
                metrics: metric(2_940, 506_000, 8_760, 71, 8_110, 9_240),
              },
              {
                id: "nw-creative-table",
                name: "Table setting · Product demo",
                format: "video",
                tone: "green",
                metrics: metric(1_690, 370_000, 4_370, 35, 4_960, 4_420),
              },
            ],
          },
          {
            id: "nw-pmax-bestsellers",
            name: "PMax · Best sellers · EU",
            kind: "performance_max",
            shoppingFeed: true,
            status: "active",
            dailyBudget: 310,
            collection: "Best Sellers",
            metrics: metric(6_180, 826_000, 15_230, 164, 19_180, 20_510),
            products: [
              {
                id: "nw-product-lamp",
                name: "Sora Table Lamp",
                sku: "NW-LAMP-04",
                tone: "gold",
                metrics: metric(2_720, 320_000, 6_840, 79, 9_940, 10_720),
              },
              {
                id: "nw-product-throw",
                name: "Aster Linen Throw",
                sku: "NW-THR-12",
                tone: "violet",
                metrics: metric(1_960, 276_000, 4_810, 51, 5_980, 6_410),
              },
              {
                id: "nw-product-vase",
                name: "Milo Ceramic Vase",
                sku: "NW-VAS-08",
                tone: "blue",
                metrics: metric(1_500, 230_000, 3_580, 34, 3_260, 3_380),
              },
              {
                id: "nw-product-chair",
                name: "Oak Dining Chair",
                sku: "NW-CHR-02",
                tone: "green",
                metrics: metric(0, 0, 0, 0, 0, 0),
              },
            ],
          },
          {
            id: "nw-dg-retargeting",
            name: "DG · Retargeting · 30 days",
            kind: "demand_gen",
            status: "paused",
            dailyBudget: 90,
            collection: "Best Sellers",
            metrics: metric(940, 180_000, 3_240, 24, 2_610, 2_912),
            creatives: [
              {
                id: "nw-creative-proof",
                name: "Customer homes · Social proof",
                format: "image",
                tone: "violet",
                metrics: metric(940, 180_000, 3_240, 24, 2_610, 2_912),
              },
            ],
          },
        ],
        collections: [
          {
            id: "nw-col-summer",
            name: "Summer Living",
            units: 246,
            adSpend: 8_240,
            revenue: 18_930,
            sources: ["demand_gen"],
            products: [
              { id: "summer-linen", name: "Aster Linen Throw", units: 126, adSpend: 3_520, revenue: 9_680 },
              { id: "summer-lamp", name: "Sora Table Lamp", units: 74, adSpend: 2_940, revenue: 6_420 },
              { id: "summer-vase", name: "Milo Ceramic Vase", units: 46, adSpend: 1_780, revenue: 2_830 },
            ],
          },
          {
            id: "nw-col-best",
            name: "Best Sellers",
            units: 194,
            adSpend: 7_120,
            revenue: 12_912,
            sources: ["demand_gen", "performance_max"],
            products: [
              { id: "best-lamp", name: "Sora Table Lamp", units: 82, adSpend: 3_060, revenue: 5_810 },
              { id: "best-throw", name: "Aster Linen Throw", units: 71, adSpend: 2_420, revenue: 4_512 },
              { id: "best-vase", name: "Milo Ceramic Vase", units: 41, adSpend: 1_640, revenue: 2_590 },
            ],
          },
        ],
        activity: [
          {
            id: "nw-home-activity-1",
            createdAt: "2026-08-13T16:07:00Z",
            actor: "Bruno Oliveira",
            campaignId: "nw-dg-retargeting",
            campaignName: "DG · Retargeting · 30 days",
            action: "campaign_paused",
          },
          {
            id: "nw-home-activity-2",
            createdAt: "2026-08-13T09:18:00Z",
            actor: "Bruno Oliveira",
            campaignId: "nw-pmax-bestsellers",
            campaignName: "PMax · Best sellers · EU",
            action: "budget_changed",
            previousBudget: 250,
            nextBudget: 310,
          },
          {
            id: "nw-home-activity-3",
            createdAt: "2026-08-12T10:42:00Z",
            actor: "Bruno Oliveira",
            campaignId: "nw-pmax-bestsellers",
            campaignName: "PMax · Best sellers · EU",
            action: "campaign_launched",
            dailyBudget: 250,
          },
        ],
      },
      {
        id: "northwind-outdoor",
        name: "Northwind Outdoor",
        domain: "northwind-outdoor.com",
        currency: "EUR",
        mappingStatus: "mapped",
        revenue: 14_860,
        orders: 176,
        units: 231,
        commissionRate: 12,
        funnel: { sessions: 10_420, addToCarts: 1_106, checkouts: 518, purchases: 176 },
        campaigns: [
          {
            id: "nwo-pmax-feed",
            name: "PMax · Outdoor feed · EU",
            kind: "performance_max",
            shoppingFeed: true,
            status: "active",
            dailyBudget: 260,
            collection: "Outdoor Dining",
            metrics: metric(6_120, 718_000, 11_430, 126, 13_920, 14_860),
            products: [
              {
                id: "nwo-product-bench",
                name: "Teak Garden Bench",
                sku: "NWO-BEN-01",
                tone: "green",
                metrics: metric(3_420, 391_000, 6_140, 74, 8_540, 9_120),
              },
              {
                id: "nwo-product-set",
                name: "Lago Bistro Set",
                sku: "NWO-SET-07",
                tone: "blue",
                metrics: metric(2_700, 327_000, 5_290, 52, 5_380, 5_740),
              },
            ],
          },
        ],
        collections: [
          {
            id: "nwo-col-dining",
            name: "Outdoor Dining",
            units: 231,
            adSpend: 6_120,
            revenue: 14_860,
            sources: ["performance_max"],
            products: [
              { id: "outdoor-bench", name: "Teak Garden Bench", units: 119, adSpend: 3_420, revenue: 9_120 },
              { id: "outdoor-set", name: "Lago Bistro Set", units: 112, adSpend: 2_700, revenue: 5_740 },
            ],
          },
        ],
        activity: [
          {
            id: "nw-outdoor-activity-1",
            createdAt: "2026-08-13T11:26:00Z",
            actor: "Bruno Oliveira",
            campaignId: "nwo-pmax-feed",
            campaignName: "PMax · Outdoor feed · EU",
            action: "budget_changed",
            previousBudget: 220,
            nextBudget: 260,
          },
          {
            id: "nw-outdoor-activity-2",
            createdAt: "2026-08-11T14:05:00Z",
            actor: "Bruno Oliveira",
            campaignId: "nwo-pmax-feed",
            campaignName: "PMax · Outdoor feed · EU",
            action: "campaign_enabled",
          },
        ],
      },
    ],
  },
  {
    id: "atlas",
    name: "Atlas Studio",
    email: "team@atlas.example",
    currency: "EUR",
    stores: [
      {
        id: "atlas-main",
        name: "Atlas Studio",
        domain: "atlas-studio.co",
        currency: "EUR",
        mappingStatus: "mapped",
        revenue: 22_190,
        orders: 287,
        units: 354,
        commissionRate: 10,
        funnel: { sessions: 16_820, addToCarts: 1_894, checkouts: 861, purchases: 287 },
        campaigns: [
          {
            id: "atlas-dg-launch",
            name: "DG · Motion Collection · Launch",
            kind: "demand_gen",
            status: "active",
            dailyBudget: 350,
            collection: "Motion Collection",
            metrics: metric(7_430, 1_120_000, 18_460, 142, 15_940, 16_880),
            creatives: [
              {
                id: "atlas-creative-studio",
                name: "Inside the studio · 30s",
                format: "video",
                tone: "violet",
                metrics: metric(4_280, 650_000, 10_920, 88, 9_940, 10_730),
              },
              {
                id: "atlas-creative-detail",
                name: "Craft details · Static",
                format: "image",
                tone: "gold",
                metrics: metric(3_150, 470_000, 7_540, 54, 6_000, 6_150),
              },
            ],
          },
          {
            id: "atlas-pmax-core",
            name: "PMax · Core catalogue",
            kind: "performance_max",
            shoppingFeed: true,
            status: "active",
            dailyBudget: 180,
            collection: "Core Collection",
            metrics: metric(3_420, 460_000, 8_960, 71, 7_090, 5_310),
            products: [
              {
                id: "atlas-product-tote",
                name: "Motion Carryall",
                sku: "ATL-BAG-18",
                tone: "violet",
                metrics: metric(2_090, 278_000, 5_630, 46, 4_680, 3_510),
              },
              {
                id: "atlas-product-pouch",
                name: "Studio Pouch",
                sku: "ATL-ACC-06",
                tone: "gold",
                metrics: metric(1_330, 182_000, 3_330, 25, 2_410, 1_800),
              },
              {
                id: "atlas-product-wallet",
                name: "Fold Wallet",
                sku: "ATL-WAL-03",
                tone: "green",
                metrics: metric(0, 0, 0, 0, 0, 0),
              },
            ],
          },
        ],
        collections: [
          {
            id: "atlas-col-motion",
            name: "Motion Collection",
            units: 229,
            adSpend: 7_430,
            revenue: 16_880,
            sources: ["demand_gen"],
            products: [
              { id: "motion-carryall", name: "Motion Carryall", units: 141, adSpend: 4_280, revenue: 10_730 },
              { id: "motion-pouch", name: "Studio Pouch", units: 88, adSpend: 3_150, revenue: 6_150 },
            ],
          },
          {
            id: "atlas-col-core",
            name: "Core Collection",
            units: 125,
            adSpend: 3_420,
            revenue: 5_310,
            sources: ["performance_max"],
            products: [
              { id: "core-carryall", name: "Motion Carryall", units: 76, adSpend: 2_090, revenue: 3_510 },
              { id: "core-pouch", name: "Studio Pouch", units: 49, adSpend: 1_330, revenue: 1_800 },
            ],
          },
        ],
        activity: [
          {
            id: "atlas-activity-1",
            createdAt: "2026-08-13T12:34:00Z",
            actor: "Bruno Oliveira",
            campaignId: "atlas-dg-launch",
            campaignName: "DG · Motion Collection · Launch",
            action: "budget_changed",
            previousBudget: 300,
            nextBudget: 350,
          },
          {
            id: "atlas-activity-2",
            createdAt: "2026-08-10T15:20:00Z",
            actor: "Bruno Oliveira",
            campaignId: "atlas-dg-launch",
            campaignName: "DG · Motion Collection · Launch",
            action: "campaign_launched",
            dailyBudget: 300,
          },
        ],
      },
    ],
  },
  {
    id: "cedar",
    name: "Cedar & Coast",
    email: "hello@cedar.example",
    currency: "EUR",
    stores: [
      {
        id: "cedar-main",
        name: "Cedar & Coast",
        domain: "cedar-coast.myshopify.com",
        currency: "EUR",
        mappingStatus: "unmapped",
        revenue: 8_460,
        orders: 104,
        units: 127,
        commissionRate: 10,
        funnel: { sessions: 7_480, addToCarts: 798, checkouts: 352, purchases: 104 },
        campaigns: [],
        collections: [
          {
            id: "cedar-col-core",
            name: "Core range",
            units: 127,
            adSpend: 0,
            revenue: 8_460,
            sources: [],
            products: [
              { id: "cedar-core-one", name: "Coast Knit", units: 73, adSpend: 0, revenue: 4_920 },
              { id: "cedar-core-two", name: "Cedar Overshirt", units: 54, adSpend: 0, revenue: 3_540 },
            ],
          },
        ],
        activity: [],
      },
    ],
  },
];

export function filterPrototypeClients(clients: PrototypeClient[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return clients;

  return clients.filter((client) =>
    [
      client.name,
      client.email,
      ...client.stores.flatMap((store) => [store.name, store.domain]),
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );
}

export function campaignScaleHistory(store: PrototypeStore, campaignId: string) {
  return store.activity
    .filter(
      (
        activity,
      ): activity is Extract<PrototypeStoreActivity, { action: "budget_changed" }> =>
        activity.campaignId === campaignId && activity.action === "budget_changed",
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

const safeRatio = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : 0;

export function realRoas(revenue: number, adSpend: number) {
  return safeRatio(revenue, adSpend);
}

export function googleMetrics(metrics: PrototypeMetricSet): PrototypeGoogleMetrics {
  return {
    cpc: safeRatio(metrics.spend, metrics.clicks),
    ctr: safeRatio(metrics.clicks, metrics.impressions),
    cpm: safeRatio(metrics.spend * 1000, metrics.impressions),
    cpa: safeRatio(metrics.spend, metrics.conversions),
    googleRoas: safeRatio(metrics.googleRevenue, metrics.spend),
    realRoas: safeRatio(metrics.realRevenue, metrics.spend),
  };
}

export function estimatedProfit(
  revenue: number,
  adSpend: number,
  units: number,
  averageCog: number,
) {
  return revenue - adSpend - units * averageCog;
}

export function pmaxProductsWithSpend(campaign: PrototypePerformanceMaxCampaign) {
  return campaign.products.filter((product) => product.metrics.spend > 0);
}

export function periodScale(period: PrototypePeriod) {
  return { today: 0.055, d3: 0.16, d7: 0.34, d14: 0.58, d30: 1 }[period];
}

export function prototypePeriodForDays(days: number): PrototypePeriod {
  if (days <= 1) return "today";
  if (days <= 3) return "d3";
  if (days <= 7) return "d7";
  if (days <= 14) return "d14";
  return "d30";
}

function distributeIntegerTotal(total: number, weights: number[]) {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let distributed = 0;
  let cumulativeWeight = 0;

  return weights.map((weight) => {
    cumulativeWeight += weight;
    const cumulativeTotal = Math.round((total * cumulativeWeight) / weightTotal);
    const value = cumulativeTotal - distributed;
    distributed = cumulativeTotal;
    return value;
  });
}

/** Requested display density: 3d=8 buckets/day, 7d=2/day, 14d=1/day. */
export function performancePointsForPeriod(
  store: PrototypeStore,
  period: PrototypePeriod,
  averageCog = 15,
): PrototypePerformancePoint[] {
  const config = {
    today: { count: 24, hours: 1 },
    d3: { count: 24, hours: 3 },
    d7: { count: 14, hours: 12 },
    d14: { count: 14, hours: 24 },
    d30: { count: 30, hours: 24 },
  }[period];
  const scale = periodScale(period);
  const totalSpend = storeRollup(store).adSpend * scale;
  const totalRevenue = store.revenue * scale;
  const totalCog = Math.round(store.units * scale) * averageCog;
  const anchor = Date.UTC(2026, 7, 13, 23, 0, 0);
  const raw = Array.from({ length: config.count }, (_, index) => {
    const phase = index + store.id.length;
    return {
      revenue: 1 + Math.sin(phase * 0.83) * 0.24 + (index / config.count) * 0.18,
      spend: 1 + Math.cos(phase * 0.61) * 0.13 + (index / config.count) * 0.08,
      sessions: 1 + Math.sin(phase * 0.49) * 0.28 + (index / config.count) * 0.12,
      addToCarts: 1 + Math.sin((phase + 1.3) * 0.68) * 0.32,
      checkouts: 1 + Math.sin((phase + 2.1) * 0.73) * 0.35,
      conversions: 1 + Math.sin((phase + 2.8) * 0.79) * 0.38,
    };
  });
  const revenueWeight = raw.reduce((sum, point) => sum + point.revenue, 0);
  const spendWeight = raw.reduce((sum, point) => sum + point.spend, 0);
  const sessions = distributeIntegerTotal(
    Math.round(store.funnel.sessions * scale),
    raw.map((point) => point.sessions),
  );
  const addToCarts = distributeIntegerTotal(
    Math.round(store.funnel.addToCarts * scale),
    raw.map((point) => point.addToCarts),
  );
  const checkouts = distributeIntegerTotal(
    Math.round(store.funnel.checkouts * scale),
    raw.map((point) => point.checkouts),
  );
  const conversions = distributeIntegerTotal(
    Math.round(store.funnel.purchases * scale),
    raw.map((point) => point.conversions),
  );

  return raw.map((point, index) => {
    const at = new Date(
      anchor - (config.count - 1 - index) * config.hours * 60 * 60 * 1000,
    );
    const revenue = (totalRevenue * point.revenue) / revenueWeight;
    const googleSpend = (totalSpend * point.spend) / spendWeight;
    const estimatedCog = totalRevenue > 0 ? totalCog * (revenue / totalRevenue) : 0;
    return {
      date: at.toISOString(),
      revenue,
      googleSpend,
      estimatedProfit: revenue - googleSpend - estimatedCog,
      realRoas: googleSpend > 0 ? revenue / googleSpend : null,
      sessions: sessions[index],
      addToCarts: addToCarts[index],
      checkouts: checkouts[index],
      conversions: conversions[index],
    };
  });
}

export function storeRollup(store: PrototypeStore): PrototypeRollup {
  const adSpend = store.campaigns.reduce((total, campaign) => total + campaign.metrics.spend, 0);
  return {
    revenue: store.revenue,
    adSpend,
    realRoas: realRoas(store.revenue, adSpend),
    orders: store.orders,
    units: store.units,
    activeCampaigns: store.campaigns.filter((campaign) => campaign.status === "active").length,
    connectedAccounts: store.mappingStatus === "mapped" ? 1 : 0,
    agencyCommission: (adSpend * store.commissionRate) / 100,
  };
}

function mergeRollups(rollups: PrototypeRollup[]): PrototypeRollup {
  const absolute = rollups.reduce(
    (totals, current) => ({
      revenue: totals.revenue + current.revenue,
      adSpend: totals.adSpend + current.adSpend,
      orders: totals.orders + current.orders,
      units: totals.units + current.units,
      activeCampaigns: totals.activeCampaigns + current.activeCampaigns,
      connectedAccounts: totals.connectedAccounts + current.connectedAccounts,
      agencyCommission: totals.agencyCommission + current.agencyCommission,
    }),
    {
      revenue: 0,
      adSpend: 0,
      orders: 0,
      units: 0,
      activeCampaigns: 0,
      connectedAccounts: 0,
      agencyCommission: 0,
    },
  );
  return { ...absolute, realRoas: realRoas(absolute.revenue, absolute.adSpend) };
}

export function clientRollup(client: PrototypeClient) {
  return mergeRollups(client.stores.map(storeRollup));
}

export function portfolioRollup(clients: PrototypeClient[]) {
  return mergeRollups(clients.map(clientRollup));
}
