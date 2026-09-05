import { searchGoogleAds, type GaqlRow } from "@/lib/google-ads/client";
import type { Campaign, CampaignStatus } from "@/lib/supabase/types";
import { DROPSCALE_FEE_RATE, type MetricSet } from "@/lib/portal/mock";
import type { RangeSelection } from "@/lib/portal/range";

/**
 * Every selection arrives as concrete from/to dates (parseRange resolves the
 * presets), so GAQL always gets a BETWEEN. The dates are regex-validated ISO
 * at parse time — safe to inline in the query string.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CAMPAIGN_ROWS = 1_001;
const MAX_CAMPAIGN_URL_ROWS = 10_001;
const MAX_CAMPAIGN_TIMELINE_ROWS = 25_001;
const MAX_CREATIVE_ROWS = 1_001;
const MAX_PRODUCT_ROWS = 10_001;

function isDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const dateClause = (range: Pick<RangeSelection, "from" | "to">) => {
  if (!isDay(range.from) || !isDay(range.to) || range.from > range.to) {
    throw new Error("Invalid Google Ads reporting range.");
  }
  return `segments.date BETWEEN '${range.from}' AND '${range.to}'`;
};

const STATUS: Record<string, CampaignStatus> = {
  ENABLED: "active",
  PAUSED: "paused",
  REMOVED: "ended",
};

const micros = (value: unknown) => Number(value ?? 0) / 1_000_000;
const num = (value: unknown) => Number(value ?? 0);

function integerText(value: unknown, label: string, maxLength = 30): string {
  const text = typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : "";
  if (!new RegExp(`^\\d{1,${maxLength}}$`).test(text)) {
    throw new Error(`Google Ads returned an invalid ${label}.`);
  }
  return text;
}

function cleanText(value: unknown, label: string, maxLength = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`Google Ads returned an invalid ${label}.`);
  }
  return text;
}

function optionalText(value: unknown, label: string, maxLength = 500): string | null {
  if (value == null || value === "") return null;
  return cleanText(value, label, maxLength);
}

function nonNegative(value: unknown, label: string, integer = false): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new Error(`Google Ads returned a missing ${label}.`);
  }
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    (integer && !Number.isSafeInteger(parsed))
  ) {
    throw new Error(`Google Ads returned an invalid ${label}.`);
  }
  return parsed === 0 ? 0 : parsed;
}

function exactCustomer(
  row: GaqlRow,
  requestedCustomerId: string,
): { customerId: string; currency: string; timeZone: string } {
  const expected = requestedCustomerId.replace(/\D/g, "");
  if (!/^\d{10}$/.test(expected)) {
    throw new Error("Invalid Google Ads customer identity.");
  }
  const customer = row.customer ?? {};
  const customerId = integerText(customer.id, "customer identity", 10);
  const currency = cleanText(customer.currencyCode, "customer currency", 12).toUpperCase();
  const timeZone = cleanText(customer.timeZone, "customer time zone", 100);
  let validTimeZone = true;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    validTimeZone = false;
  }
  if (customerId !== expected || !/^[A-Z]{3}$/.test(currency) || !validTimeZone) {
    throw new Error("Google Ads returned a different customer identity.");
  }
  return { customerId, currency, timeZone };
}

function detailMetrics(row: GaqlRow) {
  const metrics = row.metrics ?? {};
  return {
    spend: nonNegative(metrics.costMicros, "spend") / 1_000_000,
    impressions: nonNegative(metrics.impressions, "impressions", true),
    clicks: nonNegative(metrics.clicks, "clicks", true),
    conversions: nonNegative(metrics.conversions, "conversions"),
    conversionValue: nonNegative(metrics.conversionsValue, "conversion value"),
  };
}

function assertBounded(rows: GaqlRow[], report: string, sentinel: number) {
  if (rows.length >= sentinel) {
    throw new Error(`Google Ads returned too many ${report} rows for an exact report.`);
  }
}

function hasShoppingFeed(campaign: Record<string, unknown>): boolean {
  const value = campaign.shoppingSetting;
  if (value == null) return false;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Google Ads returned invalid shopping metadata.");
  }

  const merchantId = (value as Record<string, unknown>).merchantId;
  if (merchantId == null) return false;
  const normalized = String(merchantId).trim();
  if (/^0+$/.test(normalized)) return false;
  if (!/^[1-9]\d{0,29}$/.test(normalized)) {
    throw new Error("Google Ads returned invalid shopping metadata.");
  }
  return true;
}

/**
 * Just the names of an account's non-removed campaigns — for rev-share deal
 * discovery (the deal's collection + rate are encoded in the campaign name).
 * No metrics, so no date clause is needed.
 */
export async function fetchCampaignNames(
  customerId: string,
  refreshToken: string,
): Promise<string[]> {
  const rows = await searchGoogleAds(
    customerId,
    refreshToken,
    `SELECT campaign.name FROM campaign WHERE campaign.status != 'REMOVED'`,
  );
  return rows
    .map((row: GaqlRow) => String(row.campaign?.name ?? "").trim())
    .filter((name) => name.length > 0);
}

/**
 * A live campaign plus the two fields Google has but the `campaigns` TABLE does
 * not: when it started, and its conversions.
 *
 * Kept off the `Campaign` type on purpose — that type mirrors a real table, and
 * giving it columns the table has no room for would make every DB read look
 * like it might carry them. These exist only on the live path, which is where
 * the daily report reads from.
 */
export type LiveCampaign = Campaign & {
  /** Exact provider identity. Never derive this back out of the display id. */
  providerCampaignId: string;
  /** ISO day the campaign started, per Google. Null when it does not report one. */
  startDate: string | null;
  /** Google-attributed conversions in the queried range. */
  conversions: number;
  /** Google-attributed conversion value in the account currency. */
  conversionValue: number;
  /** Provider channel enum, such as DEMAND_GEN or PERFORMANCE_MAX. */
  advertisingChannelType: string;
  /** True only when Google reports a Merchant Center id for this campaign. */
  shoppingFeed: boolean;
  /** Google conversion value divided by Google spend. */
  googleRoas: number | null;
  /** Exact ad landing pages reported by Google; absent when the provider does not expose them. */
  finalUrls?: string[];
  /**
   * The currency the daily budget is set in - the Google account's own. Set
   * only when the row's money columns were converted into another currency
   * for display, so the budget can keep being shown and edited in its own.
   */
  budgetCurrency?: string;
  /** The rate the money columns were converted at into the store's currency; absent when untouched. */
  fxRate?: number;
};

export type GoogleCampaignTimelinePoint = {
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

/** One exact range-aggregated Demand Gen asset from a legacy Google connection. */
export type LiveDemandGenAdPerformance = {
  adAccountId: string;
  customerId: string;
  currency: string;
  timeZone: string;
  providerCampaignId: string;
  providerAssetId: string;
  name: string | null;
  fieldType: string;
  assetKind: "image" | "video" | null;
  thumbnailUrl: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

/**
 * One exact provider product row. The full Merchant feed tuple is retained:
 * offer ids alone are not globally unique across feeds, countries or channels.
 */
export type LivePmaxProductPerformance = {
  adAccountId: string;
  customerId: string;
  currency: string;
  timeZone: string;
  providerCampaignId: string;
  merchantId: string;
  feedLabel: string;
  language: string;
  country: string;
  channel: string;
  itemId: string;
  title: string;
  brand: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

/** Unified row consumed by the Analytics campaign expansion. */
export type GoogleCampaignBreakdownRow = {
  /** Internal ad_accounts UUID, never the provider customer id. */
  accountId: string;
  campaignId: string;
  provider: "google_ads";
  kind: "creative" | "product";
  /** Provider ad id, or the complete encoded Merchant product tuple. */
  id: string;
  name: string | null;
  detail: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  googleRevenue: number;
  /** Exact provider image URL. Null when the provider exposes no thumbnail. */
  thumbnailUrl?: string | null;
  assetKind?: "image" | "video" | null;
};

/**
 * Exact, bounded Demand Gen asset performance for every campaign in one account.
 * Google exposes asset metrics and image metadata through separate resources;
 * the stable asset id is the only join key.
 */
export async function fetchLiveDemandGenAdPerformance(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: Pick<RangeSelection, "from" | "to">,
): Promise<LiveDemandGenAdPerformance[]> {
  const rows = await searchGoogleAds(
    customerId,
    refreshToken,
    `SELECT
      customer.id,
      customer.currency_code,
      customer.time_zone,
      campaign.id,
      campaign.advertising_channel_type,
      asset.id,
      ad_group_ad_asset_view.field_type,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group_ad_asset_view
    WHERE campaign.advertising_channel_type = 'DEMAND_GEN'
      AND ${dateClause(range)}
      AND ad_group_ad_asset_view.field_type IN
        ('SQUARE_MARKETING_IMAGE', 'MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'VIDEO')
    ORDER BY metrics.cost_micros DESC, campaign.id, asset.id
    LIMIT ${MAX_CREATIVE_ROWS}`,
  );
  assertBounded(rows, "Demand Gen asset", MAX_CREATIVE_ROWS);

  const aggregated = new Map<string, Omit<LiveDemandGenAdPerformance,
    "name" | "assetKind" | "thumbnailUrl"
  >>();
  for (const row of rows) {
    const identity = exactCustomer(row, customerId);
    const campaign = row.campaign ?? {};
    const asset = row.asset ?? {};
    const view = row.adGroupAdAssetView ?? {};
    const providerCampaignId = integerText(campaign.id, "campaign identity");
    const providerAssetId = integerText(asset.id, "asset identity");
    const channel = cleanText(
      campaign.advertisingChannelType,
      "campaign channel",
      80,
    ).toUpperCase();
    const fieldType = cleanText(view.fieldType, "Demand Gen asset field type", 100)
      .toUpperCase();
    if (channel !== "DEMAND_GEN" || ![
      "SQUARE_MARKETING_IMAGE",
      "MARKETING_IMAGE",
      "PORTRAIT_MARKETING_IMAGE",
      "VIDEO",
    ].includes(fieldType)) {
      throw new Error("Google Ads returned an invalid Demand Gen asset row.");
    }
    const metrics = detailMetrics(row);
    const key = `${providerCampaignId}\u0000${providerAssetId}`;
    const current = aggregated.get(key);
    if (current) {
      if (
        current.customerId !== identity.customerId ||
        current.currency !== identity.currency ||
        current.timeZone !== identity.timeZone
      ) {
        throw new Error("Google Ads returned inconsistent Demand Gen asset identity.");
      }
      current.spend += metrics.spend;
      current.impressions += metrics.impressions;
      current.clicks += metrics.clicks;
      current.conversions += metrics.conversions;
      current.conversionValue += metrics.conversionValue;
      if (!current.fieldType.split(" · ").includes(fieldType)) {
        current.fieldType = `${current.fieldType} · ${fieldType}`;
      }
      continue;
    }
    aggregated.set(key, {
      adAccountId: accountId,
      ...identity,
      providerCampaignId,
      providerAssetId,
      fieldType,
      ...metrics,
    });
  }
  if (aggregated.size === 0) return [];

  const assetIds = [...new Set([...aggregated.values()].map((row) => row.providerAssetId))];
  const metadataRows = await searchGoogleAds(
    customerId,
    refreshToken,
    `SELECT
      customer.id,
      customer.currency_code,
      customer.time_zone,
      asset.id,
      asset.name,
      asset.type,
      asset.image_asset.full_size.url,
      asset.youtube_video_asset.youtube_video_title
    FROM asset
    WHERE asset.id IN (${assetIds.join(", ")})
      AND asset.type IN ('IMAGE', 'YOUTUBE_VIDEO')
    LIMIT ${MAX_CREATIVE_ROWS}`,
  );
  assertBounded(metadataRows, "Demand Gen asset metadata", MAX_CREATIVE_ROWS);
  const metadata = new Map<string, {
    name: string | null;
    assetKind: "image" | "video";
    thumbnailUrl: string | null;
  }>();
  for (const row of metadataRows) {
    const identity = exactCustomer(row, customerId);
    const asset = row.asset ?? {};
    const id = integerText(asset.id, "asset identity");
    if (!assetIds.includes(id) || metadata.has(id)) {
      throw new Error("Google Ads returned invalid Demand Gen asset metadata.");
    }
    const expected = [...aggregated.values()].find((item) => item.providerAssetId === id);
    if (
      !expected ||
      expected.currency !== identity.currency ||
      expected.timeZone !== identity.timeZone
    ) {
      throw new Error("Google Ads returned inconsistent Demand Gen asset metadata.");
    }
    const type = cleanText(asset.type, "asset type", 40).toUpperCase();
    if (type !== "IMAGE" && type !== "YOUTUBE_VIDEO") {
      throw new Error("Google Ads returned invalid Demand Gen asset metadata.");
    }
    const image = asset.imageAsset && typeof asset.imageAsset === "object" &&
      !Array.isArray(asset.imageAsset)
      ? asset.imageAsset as Record<string, unknown>
      : {};
    const fullSize = image.fullSize && typeof image.fullSize === "object" &&
      !Array.isArray(image.fullSize)
      ? image.fullSize as Record<string, unknown>
      : {};
    const rawUrl = fullSize.url;
    let thumbnailUrl: string | null = null;
    if (rawUrl != null && rawUrl !== "") {
      const parsed = new URL(cleanText(rawUrl, "asset image URL", 4_096));
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("Google Ads returned an invalid asset image URL.");
      }
      thumbnailUrl = parsed.toString();
    }
    const video = asset.youtubeVideoAsset && typeof asset.youtubeVideoAsset === "object" &&
      !Array.isArray(asset.youtubeVideoAsset)
      ? asset.youtubeVideoAsset as Record<string, unknown>
      : {};
    metadata.set(id, {
      name: optionalText(
        type === "YOUTUBE_VIDEO" ? video.youtubeVideoTitle ?? asset.name : asset.name,
        "asset name",
      ),
      assetKind: type === "IMAGE" ? "image" : "video",
      thumbnailUrl: type === "IMAGE" ? thumbnailUrl : null,
    });
  }

  return [...aggregated.values()]
    .map((row) => ({
      ...row,
      name: metadata.get(row.providerAssetId)?.name ?? null,
      assetKind: metadata.get(row.providerAssetId)?.assetKind ?? null,
      thumbnailUrl: metadata.get(row.providerAssetId)?.thumbnailUrl ?? null,
    }))
    .sort((left, right) =>
      right.spend - left.spend ||
      left.providerCampaignId.localeCompare(right.providerCampaignId) ||
      left.providerAssetId.localeCompare(right.providerAssetId));
}

/** Exact, bounded product performance for all PMax retail campaigns in one account. */
export async function fetchLivePmaxProductPerformance(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: Pick<RangeSelection, "from" | "to">,
): Promise<LivePmaxProductPerformance[]> {
  const rows = await searchGoogleAds(
    customerId,
    refreshToken,
    `SELECT
      customer.id,
      customer.currency_code,
      customer.time_zone,
      campaign.id,
      campaign.advertising_channel_type,
      segments.product_merchant_id,
      segments.product_feed_label,
      segments.product_language,
      segments.product_country,
      segments.product_channel,
      segments.product_item_id,
      segments.product_title,
      segments.product_brand,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM shopping_performance_view
    WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND ${dateClause(range)}
      AND metrics.cost_micros > 0
    ORDER BY metrics.cost_micros DESC, campaign.id, segments.product_item_id
    LIMIT ${MAX_PRODUCT_ROWS}`,
  );
  assertBounded(rows, "Performance Max product", MAX_PRODUCT_ROWS);

  const seen = new Set<string>();
  return rows.map((row) => {
    const identity = exactCustomer(row, customerId);
    const campaign = row.campaign ?? {};
    const segments = row.segments ?? {};
    const providerCampaignId = integerText(campaign.id, "campaign identity");
    if (
      cleanText(campaign.advertisingChannelType, "campaign channel", 80).toUpperCase() !==
      "PERFORMANCE_MAX"
    ) {
      throw new Error("Google Ads returned a non-PMax product row.");
    }
    const merchantId = integerText(segments.productMerchantId, "product merchant identity");
    const feedLabel = cleanText(segments.productFeedLabel, "product feed label", 100);
    const language = cleanText(segments.productLanguage, "product language", 120);
    const country = cleanText(segments.productCountry, "product country", 120);
    const channel = cleanText(segments.productChannel, "product channel", 40).toUpperCase();
    const itemId = cleanText(segments.productItemId, "product item identity", 500);
    const title = cleanText(segments.productTitle, "product title", 1_000);
    const brand = optionalText(segments.productBrand, "product brand", 500);
    const key = [
      providerCampaignId,
      merchantId,
      feedLabel,
      language,
      country,
      channel,
      itemId,
    ].join("\u0000");
    if (seen.has(key)) {
      throw new Error("Google Ads returned a non-unique PMax product identity.");
    }
    seen.add(key);
    const metrics = detailMetrics(row);
    if (metrics.spend <= 0) {
      throw new Error("Google Ads returned a PMax product without spend.");
    }
    return {
      adAccountId: accountId,
      ...identity,
      providerCampaignId,
      merchantId,
      feedLabel,
      language,
      country,
      channel,
      itemId,
      title,
      brand,
      ...metrics,
    };
  });
}

function merchantProductKey(product: LivePmaxProductPerformance): string {
  return [
    product.merchantId,
    product.feedLabel,
    product.language,
    product.country,
    product.channel,
    product.itemId,
  ].map(encodeURIComponent).join("/");
}

/** Unified legacy Demand Gen family; independent so callers can fail open by type. */
export async function fetchLiveGoogleDemandGenBreakdowns(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: Pick<RangeSelection, "from" | "to">,
): Promise<GoogleCampaignBreakdownRow[]> {
  const creatives = await fetchLiveDemandGenAdPerformance(
    customerId,
    refreshToken,
    accountId,
    range,
  );
  return creatives.map((creative): GoogleCampaignBreakdownRow => ({
    accountId,
    campaignId: creative.providerCampaignId,
    provider: "google_ads",
    kind: "creative",
    id: creative.providerAssetId,
    name: creative.name,
    // The raw field-type enum is Google plumbing, not information.
    detail: null,
    spend: creative.spend,
    impressions: creative.impressions,
    clicks: creative.clicks,
    conversions: creative.conversions,
    googleRevenue: creative.conversionValue,
    thumbnailUrl: creative.thumbnailUrl,
    assetKind: creative.assetKind,
  }));
}

/** Unified legacy PMax product family; independent so callers can fail open by type. */
export async function fetchLiveGooglePmaxProductBreakdowns(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: Pick<RangeSelection, "from" | "to">,
): Promise<GoogleCampaignBreakdownRow[]> {
  const products = await fetchLivePmaxProductPerformance(
    customerId,
    refreshToken,
    accountId,
    range,
  );
  return products.map((product): GoogleCampaignBreakdownRow => ({
    accountId,
    campaignId: product.providerCampaignId,
    provider: "google_ads",
    kind: "product",
    id: merchantProductKey(product),
    name: product.title,
    detail: product.brand,
    spend: product.spend,
    impressions: product.impressions,
    clicks: product.clicks,
    conversions: product.conversions,
    googleRevenue: product.conversionValue,
  }));
}

/**
 * Both exact legacy detail families for one account. Provider errors are not
 * converted to empty rows, allowing the caller to expose an honest failure.
 */
export async function fetchLiveGoogleCampaignBreakdowns(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: Pick<RangeSelection, "from" | "to">,
): Promise<GoogleCampaignBreakdownRow[]> {
  const [creatives, products] = await Promise.all([
    fetchLiveGoogleDemandGenBreakdowns(customerId, refreshToken, accountId, range),
    fetchLiveGooglePmaxProductBreakdowns(customerId, refreshToken, accountId, range),
  ]);
  return [...creatives, ...products];
}

/** Live campaigns for one customer, with everything Google will give us. */
export async function fetchLiveCampaignsDetailed(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: RangeSelection,
  expectedCurrency?: string,
): Promise<LiveCampaign[]> {
  const query = `
    SELECT
      customer.id,
      customer.currency_code,
      customer.time_zone,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.start_date_time,
      campaign.advertising_channel_type,
      campaign.shopping_setting.merchant_id,
      campaign_budget.amount_micros,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE ${dateClause(range)}
    ORDER BY metrics.cost_micros DESC, campaign.id
    LIMIT ${MAX_CAMPAIGN_ROWS}
  `;

  const [rows, finalUrlRows] = await Promise.all([
    searchGoogleAds(customerId, refreshToken, query),
    searchGoogleAds(
      customerId,
      refreshToken,
      `SELECT
        customer.id,
        customer.currency_code,
        customer.time_zone,
        campaign.id,
        ad_group_ad.ad.final_urls,
        ad_group_ad.ad.final_mobile_urls
      FROM ad_group_ad
      WHERE campaign.status != 'REMOVED'
        AND ad_group_ad.status != 'REMOVED'
      ORDER BY campaign.id, ad_group_ad.ad.id
      LIMIT ${MAX_CAMPAIGN_URL_ROWS}`,
    ).catch(() => []),
  ]);
  assertBounded(rows, "campaign", MAX_CAMPAIGN_ROWS);
  const seen = new Set<string>();
  const finalUrlsByCampaign = new Map<string, Set<string>>();
  try {
    assertBounded(finalUrlRows, "campaign landing URL", MAX_CAMPAIGN_URL_ROWS);
    for (const row of finalUrlRows) {
      const identity = exactCustomer(row, customerId);
      if (expectedCurrency && identity.currency !== expectedCurrency) {
        throw new Error("Google Ads returned a different campaign URL currency.");
      }
      const campaignId = integerText(row.campaign?.id, "campaign identity");
      const ad = row.adGroupAd?.ad;
      if (!ad || typeof ad !== "object" || Array.isArray(ad)) continue;
      const record = ad as Record<string, unknown>;
      const rawUrls = [record.finalUrls, record.finalMobileUrls].flatMap((value) =>
        value == null ? [] : Array.isArray(value) ? value : [value]);
      if (rawUrls.length > 40) throw new Error("Google Ads returned too many campaign URLs.");
      const urls = finalUrlsByCampaign.get(campaignId) ?? new Set<string>();
      for (const rawUrl of rawUrls) {
        const parsed = new URL(cleanText(rawUrl, "campaign final URL", 4_096));
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
          throw new Error("Google Ads returned an invalid campaign final URL.");
        }
        urls.add(parsed.toString());
      }
      if (urls.size > 0) finalUrlsByCampaign.set(campaignId, urls);
    }
  } catch {
    // Landing-page metadata is supplemental: never hide valid campaign metrics.
    finalUrlsByCampaign.clear();
  }

  // The REST API serialises fields as camelCase (costMicros, startDateTime), even
  // though the GAQL query above uses the proto snake_case names.
  return rows.map((row: GaqlRow): LiveCampaign => {
    const identity = exactCustomer(row, customerId);
    if (expectedCurrency && identity.currency !== expectedCurrency) {
      throw new Error("Google Ads returned a different campaign currency.");
    }
    const campaign = row.campaign ?? {};
    const budget = row.campaignBudget ?? {};
    const metrics = detailMetrics(row);
    const spend = metrics.spend;
    const conversionValue = metrics.conversionValue;
    const providerCampaignId = String(campaign.id ?? "").trim();
    if (!/^\d{1,30}$/.test(providerCampaignId)) {
      throw new Error("Google Ads returned an invalid campaign identity.");
    }
    if (seen.has(providerCampaignId)) {
      throw new Error("Google Ads returned duplicate campaign identity.");
    }
    seen.add(providerCampaignId);
    const name = cleanText(campaign.name, "campaign name");
    const providerStatus = cleanText(campaign.status, "campaign status", 40).toUpperCase();
    const status = STATUS[providerStatus];
    if (!status) throw new Error("Google Ads returned an invalid campaign status.");
    const advertisingChannelType = cleanText(
      campaign.advertisingChannelType,
      "campaign channel",
      100,
    ).toUpperCase();
    const rawStart = campaign.startDateTime;
    let startDate: string | null = null;
    if (rawStart != null && rawStart !== "") {
      const startText = cleanText(rawStart, "campaign start date", 100);
      const candidate = startText.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(startText) || !isDay(candidate)) {
        throw new Error("Google Ads returned an invalid campaign start date.");
      }
      startDate = candidate;
    }
    const dailyBudget = budget.amountMicros == null
      ? null
      : nonNegative(budget.amountMicros, "daily budget") / 1_000_000;

    const finalUrls = [...(finalUrlsByCampaign.get(providerCampaignId) ?? [])].sort();
    return {
      // Not a DB uuid — the table is never written in the live path. Prefixed
      // so it can never collide with a real row id if the two ever mix.
      id: `gads-${accountId}-${providerCampaignId}`,
      providerCampaignId,
      ad_account_id: accountId,
      name,
      status,
      spend,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      ctr: metrics.impressions > 0 ? metrics.clicks / metrics.impressions : 0,
      cpc: metrics.clicks > 0 ? spend / metrics.clicks : 0,
      daily_budget: dailyBudget,
      updated_at: new Date().toISOString(),
      // v23 replaced campaign.start_date with start_date_time. Google returns
      // the latter in the customer's local time (YYYY-MM-DD HH:mm:ss); this
      // view only needs the calendar day, so keep the exact ISO-day prefix.
      startDate,
      conversions: metrics.conversions,
      conversionValue,
      advertisingChannelType,
      shoppingFeed: hasShoppingFeed(campaign),
      googleRoas: spend > 0 ? conversionValue / spend : null,
      ...(finalUrls.length > 0 ? { finalUrls } : {}),
    };
  });
}

/** One provider read for the chart buckets; hourly for one day, daily otherwise. */
export async function fetchLiveCampaignTimeline(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: Pick<RangeSelection, "from" | "to">,
  expectedCurrency?: string,
): Promise<GoogleCampaignTimelinePoint[]> {
  const hourly = range.from === range.to;
  const rows = await searchGoogleAds(
    customerId,
    refreshToken,
    `SELECT
      customer.id,
      customer.currency_code,
      customer.time_zone,
      campaign.id,
      segments.date,
      ${hourly ? "segments.hour," : ""}
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE ${dateClause(range)}
    ORDER BY segments.date, ${hourly ? "segments.hour," : ""} campaign.id
    LIMIT ${MAX_CAMPAIGN_TIMELINE_ROWS}`,
  );
  assertBounded(rows, "campaign timeline", MAX_CAMPAIGN_TIMELINE_ROWS);
  const seen = new Set<string>();
  return rows.map((row): GoogleCampaignTimelinePoint => {
    const identity = exactCustomer(row, customerId);
    if (expectedCurrency && identity.currency !== expectedCurrency) {
      throw new Error("Google Ads returned a different campaign currency.");
    }
    const campaignId = integerText(row.campaign?.id, "campaign identity");
    const date = cleanText(row.segments?.date, "campaign reporting day", 10);
    if (!isDay(date) || date < range.from || date > range.to) {
      throw new Error("Google Ads returned an invalid campaign reporting day.");
    }
    let bucket = date;
    if (hourly) {
      const hour = Number(row.segments?.hour);
      if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
        throw new Error("Google Ads returned an invalid campaign reporting hour.");
      }
      bucket = `${date}T${String(hour).padStart(2, "0")}:00:00`;
    }
    const key = `${campaignId}\u0000${bucket}`;
    if (seen.has(key)) {
      throw new Error("Google Ads returned duplicate campaign timeline identity.");
    }
    seen.add(key);
    const metrics = detailMetrics(row);
    return {
      accountId,
      campaignId,
      bucket,
      granularity: hourly ? "hour" : "day",
      spend: metrics.spend,
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      conversions: metrics.conversions,
      googleRevenue: metrics.conversionValue,
    };
  });
}

/**
 * Live campaigns shaped like the DB/mock rows — what the UI consumes.
 *
 * Returns the detailed rows as `Campaign[]`: LiveCampaign is a superset, so the
 * two extra fields simply ride along unread. Stripping them would cost a second
 * pass to make a distinction only the type system cares about.
 */
export async function fetchLiveCampaigns(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: RangeSelection,
): Promise<Campaign[]> {
  return fetchLiveCampaignsDetailed(customerId, refreshToken, accountId, range);
}

/**
 * Live account-level metrics for one customer. `FROM customer` returns a
 * single aggregated row for the date range.
 */
export async function fetchLiveMetrics(
  customerId: string,
  refreshToken: string,
  range: RangeSelection,
): Promise<MetricSet> {
  const query = `
    SELECT
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc
    FROM customer
    WHERE ${dateClause(range)}
  `;

  const rows = await searchGoogleAds(customerId, refreshToken, query);
  const metrics = rows[0]?.metrics ?? {};

  // camelCase in the REST response — see fetchLiveCampaigns.
  const spend = micros(metrics.costMicros);
  const impressions = num(metrics.impressions);
  const clicks = num(metrics.clicks);
  const conversions = num(metrics.conversions);
  const conversionValue = num(metrics.conversionsValue);

  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr: num(metrics.ctr),
    fee: spend * DROPSCALE_FEE_RATE,
    cpc: micros(metrics.averageCpc),
    costPerConversion: conversions > 0 ? spend / conversions : 0,
    roas: spend > 0 ? conversionValue / spend : 0,
    conversionValue,
  };
}

/** Spend for one calendar day, straight from Google. */
export type DailySpend = {
  date: string;
  spend: number;
  /** Authoritative account currency returned by Google Ads. */
  currency: string | null;
};

/**
 * Per-day spend for the last 7 days. Feeds the commission ledger sync — a
 * seven-day window so a missed day (deploy, outage, weekend) self-heals on
 * the next run instead of leaving a hole in the ledger.
 */
/**
 * Per-day spend for an explicit [from, to], inclusive. Feeds the commission
 * ledger.
 *
 * `BETWEEN`, not `DURING LAST_7_DAYS`, and that is the whole point: Google's
 * `LAST_7_DAYS` literal EXCLUDES today (today is its own `TODAY` literal). With
 * it, the ledger never booked the current day, so agency commission on the
 * finance overview sat permanently below what /admin/campaigns computes live —
 * a gap no amount of re-syncing could close. Callers pass the window they mean.
 *
 * Dates come from callers that build them with an ISO day helper, so they are
 * safe to interpolate — same contract as `dateClause` above.
 */
export async function fetchLiveDailySpend(
  customerId: string,
  refreshToken: string,
  from: string,
  to: string,
): Promise<DailySpend[]> {
  const query = `
    SELECT customer.currency_code, segments.date, metrics.cost_micros
    FROM customer
    WHERE segments.date BETWEEN '${from}' AND '${to}'
  `;

  const rows = await searchGoogleAds(customerId, refreshToken, query);

  return rows
    .map((row) => ({
      date: String((row.segments ?? {}).date ?? ""),
      spend: micros((row.metrics ?? {}).costMicros),
      currency:
        typeof (row.customer ?? {}).currencyCode === "string"
          ? String((row.customer ?? {}).currencyCode).toUpperCase()
          : null,
    }))
    .filter((entry) => entry.date !== "");
}

/** Full per-day metric row, for the daily_metrics recompute. */
export type DailyBreakdown = {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

/**
 * Per-day account metrics for [from, to] (ISO dates, inclusive). This is the
 * Google side of recomputeDailyMetrics — the only caller that may aggregate
 * over live Google data. Pages read daily_metrics instead.
 */
export async function fetchLiveDailyBreakdown(
  customerId: string,
  refreshToken: string,
  from: string,
  to: string,
  expectedCurrency: string,
): Promise<DailyBreakdown[]> {
  if (!/^[A-Z]{3}$/.test(expectedCurrency)) {
    throw new Error("Invalid Google Ads reporting currency.");
  }
  const fromTimestamp = Date.parse(`${from}T00:00:00.000Z`);
  const toTimestamp = Date.parse(`${to}T00:00:00.000Z`);
  const dayCount = Math.round((toTimestamp - fromTimestamp) / 86_400_000) + 1;
  if (
    !isDay(from) ||
    !isDay(to) ||
    from > to ||
    !Number.isSafeInteger(dayCount) ||
    dayCount < 1 ||
    dayCount > 366
  ) {
    throw new Error("Invalid Google Ads daily reporting range.");
  }
  const maxRows = dayCount + 1;
  const query = `
    SELECT
      customer.id,
      customer.currency_code,
      customer.time_zone,
      segments.date,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE ${dateClause({ from, to })}
    ORDER BY segments.date ASC
    LIMIT ${maxRows}
  `;

  const rows = await searchGoogleAds(customerId, refreshToken, query);
  assertBounded(rows, "daily metric", maxRows);
  const byDay = new Map<string, DailyBreakdown>();
  let reportedTimeZone: string | null = null;
  for (const row of rows) {
    const identity = exactCustomer(row, customerId);
    if (identity.currency !== expectedCurrency) {
      throw new Error("Google Ads returned a different daily reporting currency.");
    }
    if (reportedTimeZone !== null && identity.timeZone !== reportedTimeZone) {
      throw new Error("Google Ads returned inconsistent daily reporting identity.");
    }
    reportedTimeZone = identity.timeZone;
    const date = typeof row.segments?.date === "string" ? row.segments.date.trim() : "";
    if (!isDay(date) || date < from || date > to || byDay.has(date)) {
      throw new Error("Google Ads returned an invalid daily reporting day.");
    }
    const metrics = detailMetrics(row);
    byDay.set(date, { date, ...metrics });
  }
  return [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
}

/** One creative from the account's asset library. */
export type CreativeAsset = {
  id: string;
  name: string;
  kind: "image" | "video";
  /** Image URL, or the YouTube thumbnail for videos. */
  thumbnailUrl: string | null;
  /** Where clicking should go — the full image, or the YouTube watch page. */
  linkUrl: string | null;
  width: number | null;
  height: number | null;
};

/**
 * Live creatives for one customer: the image and YouTube-video assets in the
 * account's library. This is what "seeing your creatives" actually is on
 * Google's side — ads reference these assets.
 */
export async function fetchLiveCreatives(
  customerId: string,
  refreshToken: string,
): Promise<CreativeAsset[]> {
  const query = `
    SELECT
      asset.id,
      asset.name,
      asset.type,
      asset.image_asset.full_size.url,
      asset.image_asset.full_size.width_pixels,
      asset.image_asset.full_size.height_pixels,
      asset.youtube_video_asset.youtube_video_id,
      asset.youtube_video_asset.youtube_video_title
    FROM asset
    WHERE asset.type IN ('IMAGE', 'YOUTUBE_VIDEO')
  `;

  const rows = await searchGoogleAds(customerId, refreshToken, query);

  return rows.flatMap((row): CreativeAsset[] => {
    const asset = row.asset ?? {};
    const image = (asset.imageAsset ?? null) as { fullSize?: Record<string, unknown> } | null;
    const video = (asset.youtubeVideoAsset ?? null) as Record<string, unknown> | null;

    if (String(asset.type) === "IMAGE") {
      const full = image?.fullSize ?? {};
      const url = full.url != null ? String(full.url) : null;
      return [
        {
          id: String(asset.id ?? ""),
          name: String(asset.name ?? "Image asset"),
          kind: "image",
          thumbnailUrl: url,
          linkUrl: url,
          width: full.widthPixels != null ? Number(full.widthPixels) : null,
          height: full.heightPixels != null ? Number(full.heightPixels) : null,
        },
      ];
    }

    const videoId = video?.youtubeVideoId != null ? String(video.youtubeVideoId) : null;
    if (!videoId) return [];
    return [
      {
        id: String(asset.id ?? ""),
        name: String(video?.youtubeVideoTitle ?? asset.name ?? "Video asset"),
        kind: "video",
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        linkUrl: `https://www.youtube.com/watch?v=${videoId}`,
        width: null,
        height: null,
      },
    ];
  });
}
