import "server-only";

import type {
  GoogleCampaignBreakdownRow,
  LiveCampaign,
} from "@/lib/google-ads/portal";
import type { GoogleDailyMetric } from "@/lib/reporting/daily-metrics";
import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import {
  fetchGoogleAdsCampaignBreakdown,
  fetchGoogleAdsDailyBreakdown,
  fetchGoogleAdsDemandGenAdBreakdown,
  fetchGoogleAdsPmaxProductBreakdown,
  type WindsorGoogleAdsCampaignRow,
  type WindsorGoogleAdsDailyRow,
  type WindsorGoogleAdsDemandGenAdRow,
  type WindsorGoogleAdsPmaxProductRow,
} from "../windsor/client";

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

export type ReportingCampaign = LiveCampaign & {
  biddingStrategyType: string | null;
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
  fetcher: DailyFetcher = fetchGoogleAdsDailyBreakdown,
): Promise<GoogleDailyMetric[]> {
  const google = source.googleAds;
  if (!google) {
    throw new GoogleReportingAdapterError("This reporting source has no Google Ads account.");
  }

  const rows = await fetcher(google.accountId, from, to);
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

/** Campaign read path for V2 reporting. It never participates in billing. */
export async function fetchGoogleReportingCampaigns(
  source: CanonicalReportingSource,
  from: string,
  to: string,
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
  const rows = await fetcher(google.accountId, from, to);
  return rows.map((row) => {
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
    };
  });
}

/** Demand Gen ad detail for one exact V2 reporting source. */
export async function fetchGoogleReportingDemandGenAds(
  source: CanonicalReportingSource,
  from: string,
  to: string,
  fetcher: DemandGenAdFetcher = fetchGoogleAdsDemandGenAdBreakdown,
): Promise<GoogleCampaignBreakdownRow[]> {
  const google = verifiedGoogleIdentity(source);
  const rows = await fetcher(google.accountId, from, to);
  return rows.map((row): GoogleCampaignBreakdownRow => {
    assertBreakdownIdentity(row, google);
    return {
      accountId: source.adAccountId,
      campaignId: row.campaignId,
      provider: "google_ads",
      kind: "creative",
      id: row.adId,
      name: row.name,
      detail: row.type,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      googleRevenue: row.conversionValue,
    };
  });
}

/** PMax Merchant product detail for one exact V2 reporting source. */
export async function fetchGoogleReportingPmaxProducts(
  source: CanonicalReportingSource,
  from: string,
  to: string,
  fetcher: PmaxProductFetcher = fetchGoogleAdsPmaxProductBreakdown,
): Promise<GoogleCampaignBreakdownRow[]> {
  const google = verifiedGoogleIdentity(source);
  const rows = await fetcher(google.accountId, from, to);
  return rows.map((row): GoogleCampaignBreakdownRow => {
    assertBreakdownIdentity(row, google);
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
