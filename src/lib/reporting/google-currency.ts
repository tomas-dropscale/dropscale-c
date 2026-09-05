import "server-only";

import type { LiveCampaign } from "@/lib/google-ads/portal";
import type { ReportingCampaignTimelinePoint } from "@/lib/reporting/google";
import type { CanonicalReportingSource } from "@/lib/reporting/sources";
import { fxDailyRates, rateOn } from "@/lib/shopify/fx";

/**
 * Google campaign money in the STORE's currency.
 *
 * daily_metrics has always been written in the account's reporting currency
 * (the sync converts each day with the ECB rate), but the live campaign
 * readers return Windsor's figures in the Google account's OWN billing
 * currency. For every store until 0098 the two were equal. A store whose
 * Google account bills in another currency (a USD account under an EUR
 * store) made the admin analytics divide EUR revenue by USD spend for Real
 * ROAS and label dollars as euros.
 *
 * These helpers convert campaign rows and timelines into a target currency
 * with the same per-day ECB rates the sync uses. When the currencies already
 * match they return the input untouched, so every existing store's numbers
 * are byte-identical. Daily budgets are NOT converted: a budget is set in the
 * Google account's currency, and that is the currency it must be shown and
 * edited in - `budgetCurrency` carries it to the view.
 */

export type FxRates = [string, number][];

/** Per-day rates from the source's Google currency to `targetCurrency`, or null when no conversion applies. */
export async function reportingMoneyRates(
  source: CanonicalReportingSource,
  targetCurrency: string,
  from: string,
  to: string,
): Promise<FxRates | null> {
  const googleCurrency = source.googleAds?.currency ?? null;
  if (!googleCurrency || googleCurrency === targetCurrency) return null;
  return fxDailyRates(googleCurrency, targetCurrency, from, to);
}

function dayOf(bucket: string): string {
  return bucket.slice(0, 10);
}

/** Every money column of a timeline point converted with its own day's rate. */
export function convertCampaignTimeline<T extends ReportingCampaignTimelinePoint>(
  points: T[],
  rates: FxRates,
): T[] {
  return points.map((point) => {
    const rate = rateOn(rates, dayOf(point.bucket));
    return {
      ...point,
      spend: point.spend * rate,
      googleRevenue: point.googleRevenue * rate,
    };
  });
}

/**
 * Campaign rows converted at each campaign's EFFECTIVE rate over the range:
 * the spend-weighted mean of the daily rates on the days it actually spent,
 * taken from its timeline. A campaign with no timeline point falls back to
 * the rate of the range's last day. The row's own totals are preserved -
 * the timeline only decides the rate - so a converted row still reconciles
 * with Windsor's figure for the campaign.
 */
export function convertCampaigns<T extends LiveCampaign>(
  rows: T[],
  rates: FxRates,
  timeline: readonly ReportingCampaignTimelinePoint[] | null,
  rangeTo: string,
  budgetCurrency: string,
): T[] {
  const weighted = new Map<string, { native: number; converted: number }>();
  for (const point of timeline ?? []) {
    if (point.spend <= 0) continue;
    const entry = weighted.get(point.campaignId) ?? { native: 0, converted: 0 };
    entry.native += point.spend;
    entry.converted += point.spend * rateOn(rates, dayOf(point.bucket));
    weighted.set(point.campaignId, entry);
  }
  const fallback = rateOn(rates, rangeTo);

  return rows.map((row) => {
    const sample = weighted.get(row.providerCampaignId);
    const rate = sample && sample.native > 0 ? sample.converted / sample.native : fallback;
    const spend = row.spend * rate;
    const conversionValue = row.conversionValue * rate;
    return {
      ...row,
      spend,
      cpc: row.clicks > 0 ? spend / row.clicks : 0,
      conversionValue,
      googleRoas: spend > 0 ? conversionValue / spend : null,
      budgetCurrency,
      // The rate this row was converted at, so anything broken down under it
      // (Demand Gen ads, PMax products) converts at the same rate and still
      // adds up to the parent.
      fxRate: rate,
    };
  });
}

/** A breakdown row (ad, product) converted at its parent campaign's rate; untouched when the parent was not converted. */
export function convertBreakdownAtParentRate<T extends { spend: number; googleRevenue: number }>(
  rows: T[],
  parent: { fxRate?: number },
): T[] {
  const rate = parent.fxRate;
  if (rate === undefined || rate === 1) return rows;
  return rows.map((row) => ({
    ...row,
    spend: row.spend * rate,
    googleRevenue: row.googleRevenue * rate,
  }));
}
