/** First visit evidence from Shopify's order journey, never the purchase visit. */
export type FirstVisitEvidence = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
};

export type LandingSales = { revenue: number; orders: number; units: number; cogs: number | null };

/** Collection figures are additive shares for grouping only. Campaign figures are exact matches. */
export type FirstLandingAttribution = {
  collection: LandingSales | null;
  /** False when relevant collection orders have no first-visit evidence. */
  collectionComplete?: boolean;
  campaign: LandingSales | null;
  unassignedGoogleRevenue: number | null;
  /** False for every member of a collection with unresolved Google orders, even a zero spend share. */
  campaignComplete?: boolean;
};

/** Older snapshots carry the same gap in collectionUnknownOrders. Never call it zero sales. */
export function firstLandingCollectionSales(point: {
  firstLanding?: FirstLandingAttribution;
  collectionUnknownOrders?: number | null;
}): LandingSales | null {
  if (point.firstLanding?.collectionComplete === false || (point.collectionUnknownOrders ?? 0) > 0) return null;
  return point.firstLanding?.collection ?? null;
}

export function firstLandingCampaignSales(value: FirstLandingAttribution | undefined): LandingSales | null {
  if (!value || !(value.campaignComplete ?? value.unassignedGoogleRevenue === 0)) return null;
  return value.campaign;
}

export type CampaignLandingRoas = {
  handle: string;
  revenue: number | null;
  roas: number | null;
  collectionRevenue: number | null;
  collectionRoas: number | null;
  unassignedGoogleRevenue: number | null;
  refreshedAt: string | null;
};

export function projectFirstLandingRoas(
  campaigns: ReadonlyArray<{ ad_account_id: string; providerCampaignId: string; spend: number; collectionHandle?: string | null }>,
  rows: ReadonlyArray<{ accountId: string; campaignId: string; collectionHandle?: string | null; timeline: ReadonlyArray<{ firstLanding?: FirstLandingAttribution; collectionUnknownOrders?: number | null }> }>,
  refreshedAt: string | null,
): Map<string, CampaignLandingRoas> {
  const result = new Map<string, CampaignLandingRoas>();
  const current = new Map(campaigns.map((campaign) => [`${campaign.ad_account_id}:${campaign.providerCampaignId}`, campaign]));
  if (current.size !== campaigns.length || new Set(rows.map(row => `${row.accountId}:${row.campaignId}`)).size !== rows.length) return result;
  const saved = new Map(rows.map(row => [`${row.accountId}:${row.campaignId}`, row]));
  const handleFor = (campaign: typeof campaigns[number]) => campaign.collectionHandle === undefined
    ? saved.get(`${campaign.ad_account_id}:${campaign.providerCampaignId}`)?.collectionHandle
    : campaign.collectionHandle;
  for (const [key, campaign] of current) {
    const handle = handleFor(campaign);
    if (!handle) continue;
    const row = saved.get(key);
    const members = rows.filter(member => member.collectionHandle === handle);
    const expected = campaigns.filter(member => handleFor(member) === handle);
    const complete = expected.every(member => saved.get(`${member.ad_account_id}:${member.providerCampaignId}`)?.collectionHandle === handle
      && Number.isFinite(member.spend) && member.spend >= 0)
      && members.every(member => {
        const present = current.get(`${member.accountId}:${member.campaignId}`);
        return present && handleFor(present) === handle;
      });
    const collection = sumFirstLanding(members.flatMap((member) => member.timeline.map((point) => point.firstLanding)));
    const measuredCollection = sumLandingSales(members.flatMap((member) => member.timeline.map(firstLandingCollectionSales)));
    const individual = sumFirstLanding(row?.collectionHandle === handle ? row.timeline.map(point => point.firstLanding) : []);
    const spend = expected.reduce((sum, member) => sum + member.spend, 0);
    result.set(key, {
      handle,
      revenue: individual.campaign?.revenue ?? null,
      roas: firstLandingCampaignSales(individual) && campaign.spend > 0 ? individual.campaign!.revenue / campaign.spend : null,
      collectionRevenue: complete ? measuredCollection?.revenue ?? null : null,
      collectionRoas: complete && measuredCollection && spend > 0 ? measuredCollection.revenue / spend : null,
      unassignedGoogleRevenue: collection.unassignedGoogleRevenue,
      refreshedAt,
    });
  }
  return result;
}

export function emptyLandingSales(costsKnown: boolean): LandingSales {
  return { revenue: 0, orders: 0, units: 0, cogs: costsKnown ? 0 : null };
}

/** No journey, organic Google, or an unresolved tracking template cannot identify an ad campaign. */
export function firstVisitGoogleCampaign(
  landingPage: string | null,
  visit: FirstVisitEvidence | null | undefined,
): { googleAds: boolean; campaign: string | null; unclassifiedGoogle: boolean } {
  let params = new URLSearchParams();
  try { params = new URL(landingPage ?? "", "https://landing.invalid").searchParams; } catch { /* No usable URL. */ }
  const source = (visit?.source || params.get("utm_source") || "").trim().toLowerCase();
  const medium = (visit?.medium || params.get("utm_medium") || "").trim().toLowerCase();
  const clickId = ["gclid", "gbraid", "wbraid"].some((key) => Boolean(params.get(key)?.trim()));
  const google = /^(google|googleads|google_ads|google ads|adwords|alphabet)$/.test(source);
  const googleAds = clickId || (google && /^(cpc|ppc|paid|paidsearch|paid_search|paid-search|display|cpm|paid_social)$/.test(medium));
  const campaign = (visit?.campaign || params.get("utm_campaign") || params.get("campaignid") || params.get("gad_campaignid") || "").trim();
  const googleOrigin = google || source === "android-app://com.google.android.googlequicksearchbox/";
  return { googleAds, campaign: campaign && !/[{}]/.test(campaign) ? campaign : null, unclassifiedGoogle: googleOrigin && !medium && !googleAds };
}

/** IDs take precedence; a name is accepted only when it is unique in the store. */
export function matchFirstVisitCampaign(
  identity: string | null,
  campaigns: ReadonlyArray<{ key: string; id: string; name: string }>,
): string | null {
  if (!identity) return null;
  const ids = campaigns.filter((campaign) => campaign.id === identity);
  const matches = ids.length ? ids : campaigns.filter((campaign) => campaign.name === identity);
  return matches.length === 1 ? matches[0].key : null;
}

export function sumLandingSales(values: ReadonlyArray<LandingSales | null | undefined>): LandingSales | null {
  if (!values.length || values.some((value) => value == null ||
    ![value.revenue, value.orders, value.units].every(n => Number.isFinite(n) && n >= 0) ||
    (value.cogs !== null && (!Number.isFinite(value.cogs) || value.cogs < 0)))) return null;
  return values.reduce<LandingSales>((sum, value) => ({
    revenue: sum.revenue + value!.revenue,
    orders: sum.orders + value!.orders,
    units: sum.units + value!.units,
    cogs: sum.cogs === null || value!.cogs === null ? null : sum.cogs + value!.cogs,
  }), emptyLandingSales(true));
}

export function sumFirstLanding(values: ReadonlyArray<FirstLandingAttribution | undefined>): FirstLandingAttribution {
  return {
    collection: sumLandingSales(values.map((value) => value?.collectionComplete === false ? null : value?.collection)),
    campaign: sumLandingSales(values.map((value) => value?.campaign)),
    campaignComplete: values.length > 0 && values.every((value) => value && (value.campaignComplete ?? value.unassignedGoogleRevenue === 0)),
    unassignedGoogleRevenue: values.length && values.every((value) => typeof value?.unassignedGoogleRevenue === "number")
      ? values.reduce((sum, value) => sum + value!.unassignedGoogleRevenue!, 0) : null,
  };
}

export function scaleLandingSales(value: LandingSales | null, share: number): LandingSales | null {
  return value && {
    revenue: value.revenue * share, orders: value.orders * share, units: value.units * share,
    cogs: value.cogs === null ? null : value.cogs * share,
  };
}
