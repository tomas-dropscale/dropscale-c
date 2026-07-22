import { searchGoogleAds, type GaqlRow } from "@/lib/google-ads/client";
import type { Campaign, CampaignStatus } from "@/lib/supabase/types";
import { DROPSCALE_FEE_RATE, type MetricSet } from "@/lib/portal/mock";
import type { RangeKey } from "@/lib/portal/range";

/**
 * Maps the portal's ranges onto GAQL's predefined date ranges. Keeping to the
 * named ranges avoids timezone drift between our server and the account's
 * configured timezone.
 */
const DURING: Record<RangeKey, string> = {
  today: "TODAY",
  d7: "LAST_7_DAYS",
  d30: "LAST_30_DAYS",
};

const STATUS: Record<string, CampaignStatus> = {
  ENABLED: "active",
  PAUSED: "paused",
  REMOVED: "ended",
};

const micros = (value: unknown) => Number(value ?? 0) / 1_000_000;
const num = (value: unknown) => Number(value ?? 0);

/** Live campaigns for one customer, shaped exactly like the DB/mock rows. */
export async function fetchLiveCampaigns(
  customerId: string,
  refreshToken: string,
  accountId: string,
  range: RangeKey,
): Promise<Campaign[]> {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign_budget.amount_micros,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date DURING ${DURING[range]}
    ORDER BY metrics.cost_micros DESC
  `;

  const rows = await searchGoogleAds(customerId, refreshToken, query);

  // The REST API serialises fields as camelCase (costMicros), even though the
  // GAQL query above uses the proto snake_case names.
  return rows.map((row: GaqlRow): Campaign => {
    const campaign = row.campaign ?? {};
    const metrics = row.metrics ?? {};
    const budget = row.campaignBudget ?? {};

    return {
      // Not a DB uuid — the table is never written in the live path. Prefixed
      // so it can never collide with a real row id if the two ever mix.
      id: `gads-${accountId}-${String(campaign.id ?? "")}`,
      ad_account_id: accountId,
      name: String(campaign.name ?? "—"),
      status: STATUS[String(campaign.status ?? "")] ?? "paused",
      spend: micros(metrics.costMicros),
      impressions: num(metrics.impressions),
      clicks: num(metrics.clicks),
      ctr: num(metrics.ctr),
      cpc: micros(metrics.averageCpc),
      daily_budget: budget.amountMicros != null ? micros(budget.amountMicros) : null,
      updated_at: new Date().toISOString(),
    };
  });
}

/**
 * Live account-level metrics for one customer. `FROM customer` returns a
 * single aggregated row for the date range.
 */
export async function fetchLiveMetrics(
  customerId: string,
  refreshToken: string,
  range: RangeKey,
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
    WHERE segments.date DURING ${DURING[range]}
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
