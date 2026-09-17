import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyMetricRow } from "@/lib/metrics/queries";
import { presetSelection } from "../portal/range";
import {
  mergeDailyMetricFamilies,
  ReportingMetricMergeError,
  type GoogleDailyMetric,
} from "./daily-metrics";

const ACCOUNT = "70000000-0000-4000-8000-000000000001";
const COMPUTED_AT = "2026-08-14T12:00:00.000Z";

function row(day: string, overrides: Partial<DailyMetricRow> = {}): DailyMetricRow {
  return {
    ad_account_id: ACCOUNT,
    day,
    ad_spend: 10,
    impressions: 100,
    clicks: 20,
    conversions: 2,
    conversion_value: 30,
    revenue: 50,
    orders_count: 4,
    units_sold: 5,
    attributed_orders: 3,
    attributed_revenue: 40,
    refunds_amount: 1,
    product_cost: 12,
    payment_fees: 2,
    shipping_cost: 3,
    revenue_share_base: 8,
    revenue_share_amount: 1,
    computed_at: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

const shopifyOnly = (day: string, revenue: number) => ({
  day,
  revenue,
  orders_count: 0,
  units_sold: 0,
  attributed_orders: 0,
  attributed_revenue: 0,
  refunds_amount: 0,
  product_cost: 0,
  payment_fees: 0,
  shipping_cost: 0,
  revenue_share_base: 0,
  revenue_share_amount: 0,
});

describe("daily reporting family merge", () => {
  it("preserves Shopify when Google succeeds and Shopify fails", () => {
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-13",
      to: "2026-08-13",
      existing: [row("2026-08-13")],
      google: {
        state: "succeeded",
        rows: [
          {
            day: "2026-08-13",
            ad_spend: 22,
            impressions: 200,
            clicks: 40,
            conversions: 4,
            conversion_value: 60,
          },
        ],
      },
      shopify: { state: "failed" },
      computedAt: COMPUTED_AT,
    });

    expect(result[0]).toMatchObject({
      ad_spend: 22,
      revenue: 50,
      product_cost: 12,
      computed_at: "2026-08-13T12:00:00.000Z",
    });
  });

  it("preserves Google when Shopify succeeds and Google fails", () => {
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-13",
      to: "2026-08-13",
      existing: [row("2026-08-13")],
      google: { state: "failed" },
      shopify: {
        state: "succeeded",
        rows: [{ ...row("2026-08-13"), revenue: 90 }],
      },
      computedAt: COMPUTED_AT,
    });

    expect(result[0]).toMatchObject({
      ad_spend: 10,
      revenue: 90,
      computed_at: "2026-08-13T12:00:00.000Z",
    });
  });

  it("materializes the full calendar and treats successful missing days as real zero", () => {
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-12",
      to: "2026-08-14",
      existing: [row("2026-08-13", { ad_spend: 99, revenue: 99 })],
      google: { state: "succeeded", rows: [] },
      shopify: { state: "not_applicable" },
      computedAt: COMPUTED_AT,
    });

    expect(result.map((entry) => entry.day)).toEqual([
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
    expect(result.every((entry) => entry.ad_spend === 0)).toBe(true);
    // The stored 08-13 Shopify values are carried: not_applicable means the
    // binding has no such source NOW, never a licence to erase what was
    // measured. The surrounding days never had a row and stay zero.
    expect(result.map((entry) => entry.revenue)).toEqual([0, 99, 0]);
    expect(result.every((entry) => entry.computed_at === COMPUTED_AT)).toBe(true);
  });

  it("carries stored Google history after a store handover removes the source", () => {
    // A handover moves the Google source to another store: the old account's
    // binding becomes Shopify-only, so the google family turns not_applicable
    // while the window still covers days with real recorded spend.
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-12",
      to: "2026-08-13",
      existing: [row("2026-08-12", { ad_spend: 218.64, revenue: 183.07 })],
      google: { state: "not_applicable" },
      shopify: {
        state: "succeeded",
        // Only Shopify-family fields, as the real adapter sends them: a full
        // row here would smuggle google columns into the spread and mask the
        // carry this test exists to prove.
        rows: [shopifyOnly("2026-08-12", 200), shopifyOnly("2026-08-13", 50)],
      },
      computedAt: COMPUTED_AT,
    });

    // Spend history survives; revenue keeps refreshing; the day that never
    // had a row gets zero spend, not an invented carry.
    expect(result[0]).toMatchObject({ day: "2026-08-12", ad_spend: 218.64, revenue: 200 });
    expect(result[1]).toMatchObject({ day: "2026-08-13", ad_spend: 0, revenue: 50 });
  });

  it("keeps refreshing stored days when a family fails and the newest day has no value yet", () => {
    // Every hourly window ends on today, and today's row does not exist until
    // this sync writes it. Failing the whole window there would freeze the
    // HEALTHY family too, from the first midnight after a family started
    // failing — the exact freeze a latched health error used to cause.
    const result = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-08-13",
      to: "2026-08-14",
      existing: [row("2026-08-13")],
      google: { state: "failed" },
      shopify: {
        state: "succeeded",
        rows: [
          { ...row("2026-08-13"), revenue: 90 },
          { ...row("2026-08-14"), revenue: 70 },
        ],
      },
      computedAt: COMPUTED_AT,
    });

    // The stored day refreshes with fresh Shopify and carried Google figures;
    // the day with nothing to carry is skipped rather than invented as zero.
    expect(result.map((entry) => entry.day)).toEqual(["2026-08-13"]);
    expect(result[0]).toMatchObject({ revenue: 90, ad_spend: 10 });
  });

  it("refuses a partial first write when an applicable source failed", () => {
    expect(() =>
      mergeDailyMetricFamilies({
        adAccountId: ACCOUNT,
        from: "2026-08-13",
        to: "2026-08-13",
        existing: [],
        google: { state: "succeeded", rows: [] },
        shopify: { state: "failed" },
        computedAt: COMPUTED_AT,
      }),
    ).toThrowError(ReportingMetricMergeError);
  });

  it("rejects duplicate provider days instead of summing them", () => {
    const google = {
      day: "2026-08-13",
      ad_spend: 1,
      impressions: 1,
      clicks: 1,
      conversions: 1,
      conversion_value: 1,
    };
    expect(() =>
      mergeDailyMetricFamilies({
        adAccountId: ACCOUNT,
        from: "2026-08-13",
        to: "2026-08-13",
        existing: [],
        google: { state: "succeeded", rows: [google, google] },
        shopify: { state: "not_applicable" },
        computedAt: COMPUTED_AT,
      }),
    ).toThrowError(/duplicate day/);
  });

  it("rejects calendar dates that JavaScript would otherwise roll forward", () => {
    expect(() =>
      mergeDailyMetricFamilies({
        adAccountId: ACCOUNT,
        from: "2026-02-31",
        to: "2026-03-01",
        existing: [],
        google: { state: "not_applicable" },
        shopify: { state: "not_applicable" },
        computedAt: COMPUTED_AT,
      }),
    ).toThrowError(/date range is invalid/);
  });
});

describe("the day in progress never regresses its Google family", () => {
  // The Lisbon reporting day is fixed here; the window's last day IS it.
  const TODAY = "2026-09-15";
  const YESTERDAY = "2026-09-14";
  // Measured 2026-09-15 on account 385-546-6298: stored after the 10:03 read.
  const storedToday = row(TODAY, {
    ad_spend: 118.99,
    impressions: 1_500,
    clicks: 90,
    conversions: 3,
    conversion_value: 240,
    revenue: 200,
  });
  const google = (
    day: string,
    values: Partial<Omit<GoogleDailyMetric, "day">> = {},
  ): GoogleDailyMetric => ({
    day,
    ad_spend: 118.99,
    impressions: 1_500,
    clicks: 90,
    conversions: 3,
    conversion_value: 240,
    ...values,
  });
  const merge = (
    input: Partial<Parameters<typeof mergeDailyMetricFamilies>[0]> = {},
  ) =>
    mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: TODAY,
      to: TODAY,
      existing: [storedToday],
      google: { state: "succeeded", rows: [] },
      shopify: { state: "not_applicable" },
      computedAt: COMPUTED_AT,
      today: TODAY,
      ...input,
    });

  it("keeps the stored family when Windsor answers today with no row at all", () => {
    // The 09:50 and 10:02 states: the replica had no row for today yet, and
    // the merge used to write GOOGLE_ZERO over 118.19 and 118.61.
    const [result] = merge({ google: { state: "succeeded", rows: [] } });
    expect(result).toMatchObject({
      day: TODAY,
      ad_spend: 118.99,
      impressions: 1_500,
      clicks: 90,
      conversions: 3,
      conversion_value: 240,
      computed_at: COMPUTED_AT,
    });
  });

  it("decides a missing row for today without looking at the numbers", () => {
    // Same answer as before this branch existed, and deliberately so: with a
    // stored family of zeros the old comparison reached the tie-break and
    // returned zeros too. What changes is why. Absence is now settled before
    // any figure is read, so the protection no longer rides on 0 never being
    // larger than what is stored — a tie-break someone will edit one day.
    const [result] = merge({
      existing: [row(TODAY, { ad_spend: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value: 0, revenue: 40 })],
      google: { state: "succeeded", rows: [] },
    });
    expect(result).toMatchObject({
      day: TODAY,
      ad_spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversion_value: 0,
      computed_at: COMPUTED_AT,
    });
  });

  it("writes a zero today when the Google source reported one", () => {
    // The counterpart, and the reason absence cannot simply be read as zero:
    // an account that is live but spent nothing yet answers WITH a row, and
    // that row is a measurement like any other.
    const [result] = merge({
      existing: [row(TODAY, { ad_spend: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value: 0 })],
      google: {
        state: "succeeded",
        rows: [google(TODAY, { ad_spend: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value: 0 })],
      },
    });
    expect(result).toMatchObject({ day: TODAY, ad_spend: 0, computed_at: COMPUTED_AT });
  });

  it("keeps the stored family whole when today comes back smaller", () => {
    // Account 310-375-0707 at 10:05:30: 51.90 after 185.93. The smaller state
    // is older, so every one of its five metrics is older too; none of them
    // may be mixed into the kept row.
    const [result] = merge({
      google: {
        state: "succeeded",
        rows: [
          google(TODAY, {
            ad_spend: 51.9,
            impressions: 9_000,
            clicks: 400,
            conversions: 11,
            conversion_value: 999,
          }),
        ],
      },
    });
    expect(result).toMatchObject({
      ad_spend: 118.99,
      impressions: 1_500,
      clicks: 90,
      conversions: 3,
      conversion_value: 240,
    });
  });

  it("writes the new family when today grew", () => {
    const [result] = merge({
      google: {
        state: "succeeded",
        rows: [
          google(TODAY, {
            ad_spend: 206.25,
            impressions: 2_000,
            clicks: 120,
            conversions: 5,
            conversion_value: 400,
          }),
        ],
      },
    });
    expect(result).toMatchObject({
      ad_spend: 206.25,
      impressions: 2_000,
      clicks: 120,
      conversions: 5,
      conversion_value: 400,
      computed_at: COMPUTED_AT,
    });
  });

  it("writes the new family when today's spend is equal and no count fell", () => {
    // The same ingestion state read twice, or a plateaued day that only
    // gained a late click and conversion: the fresher read carries them.
    const [result] = merge({
      google: {
        state: "succeeded",
        rows: [google(TODAY, { clicks: 91, conversions: 4 })],
      },
    });
    expect(result).toMatchObject({ ad_spend: 118.99, clicks: 91, conversions: 4 });
  });

  it("keeps the stored family whole when today's spend is equal but a count fell", () => {
    // The daily budget is spent, so 118.99 no longer moves, while Google keeps
    // attributing conversions hours after their clicks: a replica behind the
    // one that wrote 5 conversions answers the same 118.99 with 3. Spend alone
    // cannot tell the older state from the newer; the fallen count can.
    const plateaued = row(TODAY, {
      ad_spend: 118.99,
      impressions: 1_500,
      clicks: 95,
      conversions: 5,
      conversion_value: 400,
    });
    const [result] = merge({
      existing: [plateaued],
      google: {
        state: "succeeded",
        rows: [google(TODAY, { clicks: 95, conversions: 3, conversion_value: 240 })],
      },
    });
    expect(result).toMatchObject({
      ad_spend: 118.99,
      impressions: 1_500,
      clicks: 95,
      conversions: 5,
      conversion_value: 400,
    });
    // Every count is looked at: impressions alone falling keeps the row too.
    const [impressions] = merge({
      existing: [plateaued],
      google: {
        state: "succeeded",
        rows: [
          google(TODAY, {
            impressions: 1_400,
            clicks: 95,
            conversions: 5,
            conversion_value: 400,
          }),
        ],
      },
    });
    expect(impressions).toMatchObject({ impressions: 1_500, clicks: 95 });
  });

  it("writes a smaller value on a closed day, which is Windsor final", () => {
    const result = merge({
      from: YESTERDAY,
      to: TODAY,
      existing: [row(YESTERDAY, { ad_spend: 100, clicks: 50 }), storedToday],
      google: {
        state: "succeeded",
        rows: [google(YESTERDAY, { ad_spend: 90, clicks: 45 }), google(TODAY, { ad_spend: 0 })],
      },
    });
    expect(result.map((entry) => [entry.day, entry.ad_spend, entry.clicks])).toEqual([
      [YESTERDAY, 90, 45],
      [TODAY, 118.99, 90],
    ]);
  });

  it("treats every day of a window that ends before today as closed", () => {
    // The staged refresh and a closed-day backfill end on yesterday: nothing
    // there is in progress, so a smaller answer is the final figure.
    const [result] = merge({
      from: YESTERDAY,
      to: YESTERDAY,
      existing: [row(YESTERDAY, { ad_spend: 100 })],
      google: { state: "succeeded", rows: [google(YESTERDAY, { ad_spend: 90 })] },
    });
    expect(result).toMatchObject({ day: YESTERDAY, ad_spend: 90 });
  });

  it("treats every day from today onwards as in progress when the window ends after it", () => {
    // An account behind Lisbon at 02:00 Lisbon: the window already ends on
    // Lisbon's new day, the account's tomorrow, while the account's today is
    // Lisbon's yesterday and still being filled. Both are guarded; a tomorrow
    // row that does not exist yet has nothing to keep and is written as it
    // comes.
    const TOMORROW = "2026-09-16";
    const first = merge({
      from: TODAY,
      to: TOMORROW,
      existing: [storedToday],
      google: { state: "succeeded", rows: [google(TODAY, { ad_spend: 51.9 })] },
    });
    expect(first.map((entry) => [entry.day, entry.ad_spend])).toEqual([
      [TODAY, 118.99],
      [TOMORROW, 0],
    ]);
    const later = merge({
      from: TODAY,
      to: TOMORROW,
      existing: [storedToday, row(TOMORROW, { ad_spend: 40 })],
      google: {
        state: "succeeded",
        rows: [google(TODAY, { ad_spend: 100 }), google(TOMORROW, { ad_spend: 10 })],
      },
    });
    expect(later.map((entry) => [entry.day, entry.ad_spend])).toEqual([
      [TODAY, 118.99],
      [TOMORROW, 40],
    ]);
  });

  it("writes the new family when today has no stored row yet", () => {
    // The first write of the day has nothing to keep: even a zero is written,
    // so the rolling window materialises today as it always did.
    const [zero] = merge({ existing: [], google: { state: "succeeded", rows: [] } });
    expect(zero).toMatchObject({ day: TODAY, ad_spend: 0, clicks: 0 });
    const [first] = merge({
      existing: [],
      google: { state: "succeeded", rows: [google(TODAY, { ad_spend: 4.38 })] },
    });
    expect(first).toMatchObject({ day: TODAY, ad_spend: 4.38 });
  });

  it("leaves Shopify exact: a smaller store answer for today is written", () => {
    // A cancelled order lowers the day for real; Shopify is read exactly and
    // has no stale replica to guard against.
    const [result] = merge({
      google: { state: "succeeded", rows: [] },
      shopify: { state: "succeeded", rows: [shopifyOnly(TODAY, 150)] },
    });
    expect(result).toMatchObject({ ad_spend: 118.99, revenue: 150 });
  });

  it("leaves the failed family path unchanged", () => {
    const [result] = merge({
      google: { state: "failed" },
      shopify: { state: "succeeded", rows: [shopifyOnly(TODAY, 150)] },
    });
    expect(result).toMatchObject({
      ad_spend: 118.99,
      clicks: 90,
      revenue: 150,
      computed_at: storedToday.computed_at,
    });
  });

  it("defaults the current day to the Lisbon reporting day", () => {
    const lisbonToday = presetSelection("today").to;
    const [result] = mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: lisbonToday,
      to: lisbonToday,
      existing: [row(lisbonToday, { ad_spend: 118.99 })],
      google: { state: "succeeded", rows: [] },
      shopify: { state: "not_applicable" },
      computedAt: COMPUTED_AT,
    });
    expect(result).toMatchObject({ day: lisbonToday, ad_spend: 118.99 });
  });
});

describe("the day in progress follows the Google account's own clock", () => {
  // 03:00 UTC on 15 September: 04:00 in Lisbon, already the 15th; 23:00 in
  // New York, still the 14th. Windsor keys a row day in the account's zone,
  // not in Lisbon's.
  const NOW = new Date("2026-09-15T03:00:00.000Z");
  const stored = [
    row("2026-09-14", { ad_spend: 118.99, clicks: 90 }),
    row("2026-09-15", { ad_spend: 4.38, clicks: 2 }),
  ];
  const googleRow = (day: string, ad_spend: number): GoogleDailyMetric => ({
    day,
    ad_spend,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
  });
  const merge = (timeZone: string | null | undefined, rows: GoogleDailyMetric[]) =>
    mergeDailyMetricFamilies({
      adAccountId: ACCOUNT,
      from: "2026-09-14",
      to: "2026-09-15",
      existing: stored,
      google: { state: "succeeded", rows },
      shopify: { state: "not_applicable" },
      computedAt: COMPUTED_AT,
      timeZone,
    }).map((entry) => [entry.day, entry.ad_spend]);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps Lisbon's yesterday for an account on New York time: its day is still being filled", () => {
    // A replica with no row for the 14th used to zero it, because a Lisbon
    // clock had called the 14th closed five hours before the account's
    // midnight.
    expect(merge("America/New_York", [])).toEqual([
      ["2026-09-14", 118.99],
      ["2026-09-15", 4.38],
    ]);
  });

  it("closes Lisbon's today for an account on Hong Kong time once its own day has ended", () => {
    // 17:00 UTC: 18:00 in Lisbon, still the 15th; 01:00 on the 16th in Hong
    // Kong. The account's 15th ended an hour ago and Windsor's answer for it
    // is final, so a smaller figure is a correction to book, not a replica
    // behind; a Lisbon clock would hold it back until midnight.
    vi.setSystemTime(new Date("2026-09-15T17:00:00.000Z"));
    expect(
      merge("Asia/Hong_Kong", [googleRow("2026-09-14", 100), googleRow("2026-09-15", 3)]),
    ).toEqual([
      ["2026-09-14", 100],
      ["2026-09-15", 3],
    ]);
  });

  it("reads the Lisbon clock for the reporting zone, no zone, and a zone Intl does not know", () => {
    // Lisbon's 14th closed four hours ago, so its answer is written as it
    // comes; the 15th is in progress and keeps its stored value over no row.
    for (const zone of ["Europe/Lisbon", null, undefined, " ", "Mars/Olympus_Mons"]) {
      expect(merge(zone, [])).toEqual([
        ["2026-09-14", 0],
        ["2026-09-15", 4.38],
      ]);
    }
  });
});
