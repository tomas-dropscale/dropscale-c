/**
 * Deterministic mock data for everything the real Google Ads / Shopify
 * integrations will eventually provide.
 *
 * MOCK — replace with real queries when the sync jobs exist. The shapes match
 * the DB rows / metric cards 1:1 so swapping means changing only the source.
 *
 * All generation is seeded (mulberry32). Math.random() here would make the
 * server and the client render different numbers and trip a hydration
 * mismatch — same lesson as the admin's overview.
 */

import type { Campaign, CreativeDelivery } from "@/lib/supabase/types";
import { RANGE_SCALE, type RangeKey } from "@/lib/portal/range";

export type MetricSet = {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number; // 0..1
  fee: number;
  cpc: number;
  costPerConversion: number;
  roas: number;
  conversionValue: number;
};

export const DROPSCALE_FEE_RATE = 0.1;

function hashSeed(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(rand: () => number, min: number, max: number) {
  return min + rand() * (max - min);
}

/** Metrics for one ad account over one range. Same inputs → same numbers. */
export function mockMetrics(accountId: string, range: RangeKey): MetricSet {
  const rand = mulberry32(hashSeed(`${accountId}:${range}`));
  const scale = RANGE_SCALE[range];

  const spend = between(rand, 120, 900) * scale;
  const cpc = between(rand, 0.35, 1.6);
  const clicks = Math.round(spend / cpc);
  const ctr = between(rand, 0.015, 0.055);
  const impressions = Math.round(clicks / ctr);
  const cvr = between(rand, 0.02, 0.07);
  const conversions = Math.max(1, Math.round(clicks * cvr));
  const roas = between(rand, 1.4, 4.6);
  const conversionValue = spend * roas;

  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr,
    fee: spend * DROPSCALE_FEE_RATE,
    cpc,
    costPerConversion: spend / conversions,
    roas,
    conversionValue,
  };
}

/** Aggregate several accounts' metrics the way the maths actually works. */
export function aggregateMetrics(sets: MetricSet[]): MetricSet {
  if (sets.length === 0) {
    return {
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      fee: 0,
      cpc: 0,
      costPerConversion: 0,
      roas: 0,
      conversionValue: 0,
    };
  }

  const spend = sets.reduce((sum, s) => sum + s.spend, 0);
  const impressions = sets.reduce((sum, s) => sum + s.impressions, 0);
  const clicks = sets.reduce((sum, s) => sum + s.clicks, 0);
  const conversions = sets.reduce((sum, s) => sum + s.conversions, 0);
  const conversionValue = sets.reduce((sum, s) => sum + s.conversionValue, 0);

  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    fee: spend * DROPSCALE_FEE_RATE,
    cpc: clicks > 0 ? spend / clicks : 0,
    costPerConversion: conversions > 0 ? spend / conversions : 0,
    roas: spend > 0 ? conversionValue / spend : 0,
    conversionValue,
  };
}

const CAMPAIGN_NAMES = [
  "Search — Brand",
  "Search — Generic",
  "PMax — Catalogue",
  "PMax — Bestsellers",
  "Shopping — Standard",
  "Display — Remarketing",
  "YouTube — Prospecting",
  "Demand Gen — Lookalikes",
];

/** Campaigns for one account. Same shape as the campaigns table rows. */
export function mockCampaigns(accountId: string, range: RangeKey): Campaign[] {
  const rand = mulberry32(hashSeed(`campaigns:${accountId}:${range}`));
  const scale = RANGE_SCALE[range];
  const count = 3 + Math.floor(rand() * 4); // 3..6

  return Array.from({ length: count }, (_, index) => {
    const spend = between(rand, 40, 320) * scale;
    const cpc = between(rand, 0.3, 1.8);
    const clicks = Math.round(spend / cpc);
    const ctr = between(rand, 0.012, 0.06);
    const statusRoll = rand();

    return {
      id: `mock-${accountId}-${index}`,
      ad_account_id: accountId,
      name: CAMPAIGN_NAMES[index % CAMPAIGN_NAMES.length],
      status: statusRoll < 0.65 ? "active" : statusRoll < 0.9 ? "paused" : "ended",
      spend,
      impressions: Math.round(clicks / ctr),
      clicks,
      ctr,
      cpc,
      daily_budget: Math.round(between(rand, 20, 150)),
      updated_at: new Date().toISOString(),
    };
  });
}

const DELIVERY_NAMES = [
  "UGC Hooks — June batch",
  "Static ads — Summer sale",
  "Product videos — Hero SKUs",
  "Carousel set — New arrivals",
  "Testimonial cuts",
  "Landing page assets",
];

/** Creative deliveries for one account. Same shape as the DB rows. */
export function mockDeliveries(accountId: string): CreativeDelivery[] {
  const rand = mulberry32(hashSeed(`deliveries:${accountId}`));
  const count = 2 + Math.floor(rand() * 4); // 2..5

  return Array.from({ length: count }, (_, index) => {
    const files = 4 + Math.floor(rand() * 14);
    const daysAgo = Math.floor(between(rand, 1, 60));

    return {
      id: `mock-delivery-${accountId}-${index}`,
      ad_account_id: accountId,
      name: DELIVERY_NAMES[index % DELIVERY_NAMES.length],
      status: rand() < 0.6 ? "published" : "draft",
      file_count: files,
      size_mb: Math.round(between(rand, 8, 240) * 10) / 10,
      thumbnail_urls: [],
      created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    };
  });
}

/** Warm gradient placeholders for deliveries without real thumbnails. */
const THUMB_TINTS = [
  "linear-gradient(135deg,#3a2f22,#211a12)",
  "linear-gradient(135deg,#2b3329,#181f17)",
  "linear-gradient(135deg,#33272b,#1e1518)",
  "linear-gradient(135deg,#2a2f38,#171b21)",
  "linear-gradient(135deg,#332e22,#1f1b12)",
  "linear-gradient(135deg,#2e2a33,#1a171f)",
];

export function thumbTint(seed: string, index: number) {
  return THUMB_TINTS[(hashSeed(seed) + index) % THUMB_TINTS.length];
}
