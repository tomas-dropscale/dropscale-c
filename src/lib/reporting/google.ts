import "server-only";

import type {
  CampaignLandingPage,
  GoogleCampaignBreakdownRow,
  LiveCampaign,
} from "@/lib/google-ads/portal";
import type { GoogleDailyMetric } from "@/lib/reporting/daily-metrics";
import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import {
  fetchGoogleAdsCampaignBreakdown,
  fetchGoogleAdsCampaignFinalUrls,
  fetchGoogleAdsCampaignTimeline,
  fetchGoogleAdsDailyBreakdownForStore,
  fetchGoogleAdsDemandGenAdBreakdown,
  fetchGoogleAdsPmaxProductBreakdown,
  type WindsorGoogleAdsCampaignRow,
  type WindsorGoogleAdsCampaignTimelineRow,
  type WindsorGoogleAdsDailyRow,
  type WindsorGoogleAdsDemandGenAdRow,
  type WindsorGoogleAdsLandingPageRow,
  type WindsorGoogleAdsPmaxProductRow,
} from "../windsor/client";
import {
  campaignBelongsToStore,
  storeDomainsForSource,
} from "./store-domain-match";

export class GoogleReportingAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleReportingAdapterError";
  }
}

type DailyFetcher = (
  accountId: string,
  from: string,
  to: string,
) => Promise<WindsorGoogleAdsDailyRow[]>;

type CampaignFetcher = (
  accountId: string,
  from: string,
  to: string,
) => Promise<WindsorGoogleAdsCampaignRow[]>;

type CampaignTimelineFetcher = (
  accountId: string,
  from: string,
  to: string,
) => Promise<WindsorGoogleAdsCampaignTimelineRow[]>;

type DemandGenAdFetcher = (
  accountId: string,
  from: string,
  to: string,
) => Promise<WindsorGoogleAdsDemandGenAdRow[]>;

type PmaxProductFetcher = (
  accountId: string,
  from: string,
  to: string,
) => Promise<WindsorGoogleAdsPmaxProductRow[]>;

type CampaignFinalUrlsFetcher = (
  accountId: string,
  from: string,
  to: string,
) => Promise<Map<string, string[]>>;

type LandingPagesFetcher = (
  accountId: string,
  from: string,
  to: string,
) => Promise<WindsorGoogleAdsLandingPageRow[]>;

const NO_FINAL_URLS: Map<string, string[]> = new Map();

export type ReportingCampaign = LiveCampaign & {
  biddingStrategyType: string | null;
};

/**
 * Windsor reports one row per landing page as recorded, so the same page
 * comes back once per query-string variant and once per repeat; here they are
 * summed per campaign and page, most clicked first.
 *
 * The owner rule applies to the pages as it does to the final URLs. A shared
 * Google account keeps its previous store's campaigns, and the ones without a
 * final URL (Performance Max, Shopping) stay attributed to this store because
 * their spend cannot be disproved; but their clicks landed on the other
 * store, and a page there must never name a collection here, where a cloned
 * store has the same handle and would take that campaign's spend and sales.
 * So a page whose host is provably another domain is dropped, while a page
 * with no host evidence is kept, exactly as campaignBelongsToStore decides.
 */
function landingPagesByCampaign(
  rows: readonly WindsorGoogleAdsLandingPageRow[],
  storeDomains: readonly string[],
): Map<string, CampaignLandingPage[]> {
  const clicksByPage = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!campaignBelongsToStore([row.url], storeDomains)) continue;
    const pages = clicksByPage.get(row.campaignId) ?? new Map<string, number>();
    pages.set(row.url, (pages.get(row.url) ?? 0) + row.clicks);
    clicksByPage.set(row.campaignId, pages);
  }
  return new Map(
    [...clicksByPage].map(([campaignId, pages]) => [
      campaignId,
      [...pages]
        .map(([url, clicks]) => ({ url, clicks }))
        .sort((left, right) => right.clicks - left.clicks || left.url.localeCompare(right.url)),
    ]),
  );
}

export type ReportingCampaignTimelinePoint = {
  accountId: string;
  campaignId: string;
  bucket: string;
  granularity: "hour" | "day";
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  googleRevenue: number;
};

export type { GoogleCampaignBreakdownRow };

function verifiedGoogleIdentity(source: CanonicalReportingSource) {
  const google = source.googleAds;
  if (!google?.currency || !google.timeZone) {
    throw new GoogleReportingAdapterError(
      "This reporting source has no verified Google Ads identity.",
    );
  }
  return google;
}

function assertBreakdownIdentity(
  row: {
    accountId: string;
    customerId: string;
    currency: string;
    timeZone: string;
  },
  google: NonNullable<CanonicalReportingSource["googleAds"]>,
) {
  if (
    row.accountId !== google.accountId ||
    row.customerId !== google.customerId ||
    row.currency !== google.currency ||
    row.timeZone !== google.timeZone
  ) {
    throw new GoogleReportingAdapterError(
      "Windsor returned a different Google Ads reporting identity.",
    );
  }
}

function merchantProductKey(product: WindsorGoogleAdsPmaxProductRow): string {
  return [
    product.merchantId,
    product.feedLabel,
    product.language,
    product.country,
    product.channel,
    product.itemId,
  ].map(encodeURIComponent).join("/");
}

/**
 * Reads one exact bound Google Ads source through Windsor and converts it to
 * the existing daily_metrics Google family. Billing never calls this adapter.
 */
export async function fetchGoogleReportingDailyMetrics(
  source: CanonicalReportingSource,
  from: string,
  to: string,
  fetcher?: DailyFetcher,
): Promise<GoogleDailyMetric[]> {
  const google = source.googleAds;
  if (!google) {
    throw new GoogleReportingAdapterError("This reporting source has no Google Ads account.");
  }

  // Owner rule: spend only counts for the store its campaigns link to, so the
  // default read excludes campaigns whose final URLs point at another domain.
  const rows = await (fetcher
    ? fetcher(google.accountId, from, to)
    : fetchGoogleAdsDailyBreakdownForStore(
        google.accountId,
        from,
        to,
        storeDomainsForSource(source),
      ));
  for (const row of rows) {
    if (
      row.accountId !== google.accountId ||
      row.customerId !== google.customerId ||
      (google.currency !== null && row.currency !== google.currency) ||
      (google.timeZone !== null && row.timeZone !== google.timeZone)
    ) {
      throw new GoogleReportingAdapterError(
        "Windsor returned a different Google Ads reporting identity.",
      );
    }
  }

  return rows.map((row) => ({
    day: row.date,
    ad_spend: row.spend,
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
    conversion_value: row.conversionValue,
  }));
}

/**
 * Campaign read path for V2 reporting. It never participates in billing.
 *
 * Where each campaign's clicks landed is attached only when a landing-page
 * reader is passed (`fetchGoogleAdsLandingPages` in production). The store
 * analytics sheet is the one reader of those pages; read by default they
 * would cost every other caller a second provider request per account and
 * ride, unused, into the portal's client payload and the campaign snapshots,
 * thousands of URLs at a time. They ride along best-effort: they only refine
 * which collection a campaign is measured against, so a failed read is logged
 * and the campaigns keep their final URLs, where a failed final-URL read still
 * fails the whole campaign read, as it always did.
 */
export async function fetchGoogleReportingCampaigns(
  source: CanonicalReportingSource,
  from: string,
  to: string,
  landingFetcher: LandingPagesFetcher | null = null,
  fetcher: CampaignFetcher = fetchGoogleAdsCampaignBreakdown,
): Promise<ReportingCampaign[]> {
  const google = source.googleAds;
  if (!google?.currency || !google.timeZone) {
    throw new GoogleReportingAdapterError(
      "This reporting source has no verified Google Ads identity.",
    );
  }

  const status = {
    ENABLED: "active",
    PAUSED: "paused",
    REMOVED: "ended",
  } as const;
  const [rows, landingRows] = await Promise.all([
    fetcher(google.accountId, from, to),
    landingFetcher
      ? landingFetcher(google.accountId, from, to).catch((error: unknown) => {
          console.warn(
            `Google Ads landing pages could not be read for ${google.accountId}; campaigns keep their final URLs only:`,
            error,
          );
          return null;
        })
      : null,
  ]);
  // Owner rule: a campaign whose final URLs point at another store's domain is
  // not this store's campaign, no matter which Google account hosts it, and a
  // landing page on another store's domain names nothing here.
  const storeDomains = storeDomainsForSource(source);
  const landingPages = landingRows ? landingPagesByCampaign(landingRows, storeDomains) : null;
  for (const row of rows) {
    if (
      row.accountId !== google.accountId ||
      row.customerId !== google.customerId ||
      row.currency !== google.currency ||
      row.timeZone !== google.timeZone
    ) {
      throw new GoogleReportingAdapterError(
        "Windsor returned a different Google Ads reporting identity.",
      );
    }
  }

  return rows
    .filter((row) => campaignBelongsToStore(row.finalUrls, storeDomains))
    .map((row) => {
      const landed = landingPages?.get(row.campaignId);
      return {
      id: `windsor-${source.adAccountId}-${row.campaignId}`,
      providerCampaignId: row.campaignId,
      ad_account_id: source.adAccountId,
      name: row.name,
      status: status[row.status],
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
      cpc: row.clicks > 0 ? row.spend / row.clicks : 0,
      daily_budget: row.dailyBudget,
      updated_at: new Date().toISOString(),
      startDate: row.startDate,
      conversions: row.conversions,
      advertisingChannelType: row.advertisingChannelType,
      shoppingFeed: row.shoppingFeed,
      biddingStrategyType: row.biddingStrategyType,
      conversionValue: row.conversionValue,
      googleRoas: row.spend > 0 ? row.conversionValue / row.spend : null,
      ...(row.finalUrls?.length ? { finalUrls: row.finalUrls } : {}),
      ...(landed?.length ? { landingPages: landed } : {}),
      };
    });
}

export async function fetchGoogleReportingCampaignTimeline(
  source: CanonicalReportingSource,
  from: string,
  to: string,
  fetcher: CampaignTimelineFetcher = fetchGoogleAdsCampaignTimeline,
  urlsFetcher: CampaignFinalUrlsFetcher = fetchGoogleAdsCampaignFinalUrls,
): Promise<ReportingCampaignTimelinePoint[]> {
  const google = verifiedGoogleIdentity(source);
  const storeDomains = storeDomainsForSource(source);
  const [rows, finalUrlsByCampaign] = await Promise.all([
    fetcher(google.accountId, from, to),
    storeDomains.length > 0
      ? urlsFetcher(google.accountId, from, to)
      : Promise.resolve(NO_FINAL_URLS),
  ]);
  for (const row of rows) assertBreakdownIdentity(row, google);
  return rows
    .filter(
      (row) =>
        storeDomains.length === 0 ||
        campaignBelongsToStore(finalUrlsByCampaign.get(row.campaignId), storeDomains),
    )
    .map((row) => ({
      accountId: source.adAccountId,
      campaignId: row.campaignId,
      bucket: row.bucket,
      granularity: row.granularity,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      googleRevenue: row.conversionValue,
    }));
}

/** Demand Gen ad detail for one exact V2 reporting source. */
export async function fetchGoogleReportingDemandGenAds(
  source: CanonicalReportingSource,
  from: string,
  to: string,
  fetcher: DemandGenAdFetcher = fetchGoogleAdsDemandGenAdBreakdown,
  urlsFetcher: CampaignFinalUrlsFetcher = fetchGoogleAdsCampaignFinalUrls,
): Promise<GoogleCampaignBreakdownRow[]> {
  const google = verifiedGoogleIdentity(source);
  const storeDomains = storeDomainsForSource(source);
  const [rows, finalUrlsByCampaign] = await Promise.all([
    fetcher(google.accountId, from, to),
    storeDomains.length > 0
      ? urlsFetcher(google.accountId, from, to)
      : Promise.resolve(NO_FINAL_URLS),
  ]);
  for (const row of rows) assertBreakdownIdentity(row, google);
  return rows
    .filter(
      (row) =>
        storeDomains.length === 0 ||
        campaignBelongsToStore(finalUrlsByCampaign.get(row.campaignId), storeDomains),
    )
    .map((row): GoogleCampaignBreakdownRow => {
    return {
      accountId: source.adAccountId,
      campaignId: row.campaignId,
      provider: "google_ads",
      kind: "creative",
      id: row.adId,
      name: row.name,
      // The raw field-type enum (SQUARE_MARKETING_IMAGE…) is Google plumbing,
      // not information — the row already shows the asset name and provider.
      detail: null,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      googleRevenue: row.conversionValue,
      thumbnailUrl: row.thumbnailUrl ?? null,
      assetKind: row.assetKind ?? null,
    };
  });
}

/** PMax Merchant product detail for one exact V2 reporting source. */
export async function fetchGoogleReportingPmaxProducts(
  source: CanonicalReportingSource,
  from: string,
  to: string,
  fetcher: PmaxProductFetcher = fetchGoogleAdsPmaxProductBreakdown,
  urlsFetcher: CampaignFinalUrlsFetcher = fetchGoogleAdsCampaignFinalUrls,
): Promise<GoogleCampaignBreakdownRow[]> {
  const google = verifiedGoogleIdentity(source);
  const storeDomains = storeDomainsForSource(source);
  const [rows, finalUrlsByCampaign] = await Promise.all([
    fetcher(google.accountId, from, to),
    storeDomains.length > 0
      ? urlsFetcher(google.accountId, from, to)
      : Promise.resolve(NO_FINAL_URLS),
  ]);
  for (const row of rows) assertBreakdownIdentity(row, google);
  return rows
    .filter(
      (row) =>
        storeDomains.length === 0 ||
        campaignBelongsToStore(finalUrlsByCampaign.get(row.campaignId), storeDomains),
    )
    .map((row): GoogleCampaignBreakdownRow => {
    return {
      accountId: source.adAccountId,
      campaignId: row.campaignId,
      provider: "google_ads",
      kind: "product",
      id: merchantProductKey(row),
      name: row.title,
      detail: row.brand,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      googleRevenue: row.conversionValue,
    };
  });
}

/**
 * Unified detail family for Analytics. Both provider reads are exact and any
 * provider error remains visible to the caller instead of becoming fake empty data.
 */
export async function fetchGoogleReportingCampaignBreakdowns(
  source: CanonicalReportingSource,
  from: string,
  to: string,
  demandGenFetcher: DemandGenAdFetcher = fetchGoogleAdsDemandGenAdBreakdown,
  pmaxProductFetcher: PmaxProductFetcher = fetchGoogleAdsPmaxProductBreakdown,
): Promise<GoogleCampaignBreakdownRow[]> {
  const [creatives, products] = await Promise.all([
    fetchGoogleReportingDemandGenAds(source, from, to, demandGenFetcher),
    fetchGoogleReportingPmaxProducts(source, from, to, pmaxProductFetcher),
  ]);
  return [...creatives, ...products];
}
