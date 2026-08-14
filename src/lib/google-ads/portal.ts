import { searchGoogleAds, type GaqlRow } from "@/lib/google-ads/client";
import type { Campaign, CampaignStatus } from "@/lib/supabase/types";
import { DROPSCALE_FEE_RATE, type MetricSet } from "@/lib/portal/mock";
import type { RangeSelection } from "@/lib/portal/range";

/**
 * Every selection arrives as concrete from/to dates (parseRange resolves the
 * presets), so GAQL always gets a BETWEEN. The dates are regex-validated ISO
 * at parse time — safe to inline in the query string.
 */
const dateClause = (range: RangeSelection) =>
  `segments.date BETWEEN '${range.from}' AND '${range.to}'`;

const STATUS: Record<string, CampaignStatus> = {
  ENABLED: "active",
  PAUSED: "paused",
  REMOVED: "ended",
};

const micros = (value: unknown) => Number(value ?? 0) / 1_000_000;
const num = (value: unknown) => Number(value ?? 0);

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
  googleRoas: number;
};

/** Live campaigns for one customer, with everything Google will give us. */
export async function fetchLiveCampaignsDetailed(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: RangeSelection,
): Promise<LiveCampaign[]> {
  const query = `
    SELECT
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
      metrics.ctr,
      metrics.average_cpc,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE ${dateClause(range)}
    ORDER BY metrics.cost_micros DESC
  `;

  const rows = await searchGoogleAds(customerId, refreshToken, query);

  // The REST API serialises fields as camelCase (costMicros, startDateTime), even
  // though the GAQL query above uses the proto snake_case names.
  return rows.map((row: GaqlRow): LiveCampaign => {
    const campaign = row.campaign ?? {};
    const metrics = row.metrics ?? {};
    const budget = row.campaignBudget ?? {};
    const spend = micros(metrics.costMicros);
    const conversionValue = num(metrics.conversionsValue);
    const providerCampaignId = String(campaign.id ?? "").trim();
    if (!/^\d{1,30}$/.test(providerCampaignId)) {
      throw new Error("Google Ads returned an invalid campaign identity.");
    }

    return {
      // Not a DB uuid — the table is never written in the live path. Prefixed
      // so it can never collide with a real row id if the two ever mix.
      id: `gads-${accountId}-${providerCampaignId}`,
      providerCampaignId,
      ad_account_id: accountId,
      name: String(campaign.name ?? "—"),
      status: STATUS[String(campaign.status ?? "")] ?? "paused",
      spend,
      impressions: num(metrics.impressions),
      clicks: num(metrics.clicks),
      ctr: num(metrics.ctr),
      cpc: micros(metrics.averageCpc),
      daily_budget: budget.amountMicros != null ? micros(budget.amountMicros) : null,
      updated_at: new Date().toISOString(),
      // v23 replaced campaign.start_date with start_date_time. Google returns
      // the latter in the customer's local time (YYYY-MM-DD HH:mm:ss); this
      // view only needs the calendar day, so keep the exact ISO-day prefix.
      startDate:
        typeof campaign.startDateTime === "string" &&
        /^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(campaign.startDateTime)
          ? campaign.startDateTime.slice(0, 10)
          : null,
      conversions: num(metrics.conversions),
      conversionValue,
      advertisingChannelType: String(campaign.advertisingChannelType ?? "UNKNOWN"),
      shoppingFeed: hasShoppingFeed(campaign),
      googleRoas: spend > 0 ? conversionValue / spend : 0,
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
): Promise<DailyBreakdown[]> {
  const query = `
    SELECT
      segments.date,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '${from}' AND '${to}'
  `;

  const rows = await searchGoogleAds(customerId, refreshToken, query);

  return rows
    .map((row) => {
      const metrics = row.metrics ?? {};
      return {
        date: String((row.segments ?? {}).date ?? ""),
        spend: micros(metrics.costMicros),
        impressions: num(metrics.impressions),
        clicks: num(metrics.clicks),
        conversions: num(metrics.conversions),
        conversionValue: num(metrics.conversionsValue),
      };
    })
    .filter((entry) => entry.date !== "");
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
