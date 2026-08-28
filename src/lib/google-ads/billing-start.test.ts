import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./client", () => ({ searchGoogleAdsAsAgency: vi.fn() }));

import {
  billableMicrosSinceBaseline,
  captureGoogleBillingEndAsAgency,
  captureBillingStartFromConnection,
  captureGoogleBillingStartAsAgency,
  decimalToMicros,
  fetchGoogleDailyCostMicrosAsAgency,
  googleLocalDate,
  googlePeriodIsClosed,
  microsToDecimal,
  parseGoogleMicros,
  percentageOfMicrosToDecimal,
} from "./billing-start";

describe("exact Google Ads micros", () => {
  it("preserves zero and values above Number.MAX_SAFE_INTEGER", () => {
    expect(parseGoogleMicros("0")).toBe(BigInt(0));
    const huge = "9007199254740993123";
    expect(parseGoogleMicros(huge)).toBe(BigInt("9007199254740993123"));
    expect(microsToDecimal(huge)).toBe("9007199254740.993123");
    expect(decimalToMicros("9007199254740.993123")).toBe(BigInt("9007199254740993123"));
  });

  it("rejects an unsafe numeric representation instead of rounding it", () => {
    expect(() => parseGoogleMicros(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/i);
    expect(() => parseGoogleMicros("1.5")).toThrow(/invalid cost micros/i);
    expect(() => microsToDecimal(BigInt(-1))).toThrow(/negative cost micros/i);
  });

  it("computes the first-day delta and never creates a negative billable base", () => {
    expect(billableMicrosSinceBaseline("242990000", "127384002")).toBe(BigInt(115_605_998));
    expect(billableMicrosSinceBaseline("90000000", "127384002")).toBe(BigInt(0));
  });

  it("rounds a percentage to the same six-decimal storage unit", () => {
    expect(percentageOfMicrosToDecimal(BigInt(115_605_998), 10)).toBe("11.560600");
    expect(percentageOfMicrosToDecimal(BigInt(5), 10)).toBe("0.000001");
    expect(percentageOfMicrosToDecimal(BigInt(4), 10)).toBe("0.000000");
    expect(percentageOfMicrosToDecimal(BigInt(10_000_000), "9.5")).toBe("0.950000");
  });
});

describe("Google-local calendar boundaries", () => {
  it("uses the customer timezone on opposite sides of UTC", () => {
    const instant = new Date("2026-08-04T00:30:00.000Z");
    expect(googleLocalDate(instant, "Europe/Lisbon")).toBe("2026-08-04");
    expect(googleLocalDate(instant, "America/Los_Angeles")).toBe("2026-08-03");
    expect(googleLocalDate(instant, "Asia/Tokyo")).toBe("2026-08-04");
  });

  it("stays on the correct date across a daylight-saving transition", () => {
    expect(googleLocalDate(new Date("2026-03-29T00:30:00.000Z"), "Europe/Lisbon")).toBe(
      "2026-03-29",
    );
    expect(googleLocalDate(new Date("2026-03-29T23:30:00.000Z"), "Europe/Lisbon")).toBe(
      "2026-03-30",
    );
  });

  it("does not call a Sunday closed while the account is still on Sunday", () => {
    expect(
      googlePeriodIsClosed(
        "2026-08-02",
        new Date("2026-08-03T06:30:00.000Z"),
        "America/Los_Angeles",
      ),
    ).toBe(false);
    expect(
      googlePeriodIsClosed(
        "2026-08-02",
        new Date("2026-08-03T07:30:00.000Z"),
        "America/Los_Angeles",
      ),
    ).toBe(true);
  });
});

describe("agency Google billing reads", () => {
  it("sums raw INT64 rows without a Number conversion", async () => {
    const search = vi.fn(async () => [
      {
        customer: { id: "1234567890" },
        segments: { date: "2026-08-03" },
        metrics: { costMicros: "9007199254740993123" },
      },
      {
        customer: { id: "1234567890" },
        segments: { date: "2026-08-03" },
        metrics: { costMicros: "7" },
      },
    ]);

    await expect(
      fetchGoogleDailyCostMicrosAsAgency(
        "123-456-7890",
        "2026-08-03",
        "2026-08-03",
        search,
      ),
    ).resolves.toEqual([
      { date: "2026-08-03", costMicros: "9007199254740993130" },
    ]);
  });

  it("fails closed on malformed identities, dates or metric rows", async () => {
    const malformedMetric = vi.fn(async () => [
      {
        customer: { id: "1234567890" },
        segments: { date: "2026-08-03" },
        metrics: {},
      },
    ]);

    await expect(
      fetchGoogleDailyCostMicrosAsAgency(
        "abc1234567890",
        "2026-08-03",
        "2026-08-03",
        malformedMetric,
      ),
    ).rejects.toThrow(/invalid customer id/i);
    await expect(
      fetchGoogleDailyCostMicrosAsAgency(
        "1234567890",
        "2026-02-30",
        "2026-02-30",
        malformedMetric,
      ),
    ).rejects.toThrow(/invalid Google Ads spend window/i);
    await expect(
      fetchGoogleDailyCostMicrosAsAgency(
        "1234567890",
        "2026-08-03",
        "2026-08-03",
        malformedMetric,
      ),
    ).rejects.toThrow(/invalid cost micros/i);
  });

  it("records an authoritative zero when the exact-day query has no metric row", async () => {
    const search = vi.fn(async (_customerId: string, query: string) =>
      query.includes("customer.time_zone")
        ? [
            {
              customer: {
                id: "1234567890",
                currencyCode: "EUR",
                timeZone: "Europe/Lisbon",
              },
            },
          ]
        : [],
    );
    const times = [
      new Date("2026-08-03T10:00:00.000Z"),
      new Date("2026-08-03T10:00:01.000Z"),
      new Date("2026-08-03T10:00:02.000Z"),
    ];

    await expect(
      captureGoogleBillingStartAsAgency("1234567890", {
        search,
        now: () => times.shift() ?? new Date("2026-08-03T10:00:02.000Z"),
        randomUUID: () => "capture-zero",
      }),
    ).resolves.toMatchObject({
      google_local_date: "2026-08-03",
      baseline_cost_micros: "0",
      google_time_zone: "Europe/Lisbon",
      capture_id: "capture-zero",
    });
  });

  it("captures the exact cumulative counter that closes billing", async () => {
    const search = vi.fn(async (_customerId: string, query: string) =>
      query.includes("customer.time_zone")
        ? [
            {
              customer: {
                id: "1234567890",
                currencyCode: "EUR",
                timeZone: "Europe/Lisbon",
              },
            },
          ]
        : [
            {
              customer: { id: "1234567890" },
              segments: { date: "2026-08-06" },
              metrics: { costMicros: "9007199254740993123" },
            },
          ],
    );
    const times = [
      new Date("2026-08-06T14:00:00.000Z"),
      new Date("2026-08-06T14:00:01.000Z"),
      new Date("2026-08-06T14:00:02.000Z"),
    ];

    await expect(
      captureGoogleBillingEndAsAgency("123-456-7890", {
        search,
        now: () => times.shift() ?? new Date("2026-08-06T14:00:02.000Z"),
        randomUUID: () => "capture-end",
      }),
    ).resolves.toMatchObject({
      google_ads_customer_id: "1234567890",
      google_local_date: "2026-08-06",
      google_time_zone: "Europe/Lisbon",
      end_cost_micros: "9007199254740993123",
      capture_id: "capture-end",
      source: "agency",
    });
  });

  it("discards an old-day answer when Google-local midnight passes", async () => {
    const queriedDays: string[] = [];
    const search = vi.fn(async (_customerId: string, query: string) => {
      if (query.includes("customer.time_zone")) {
        return [
          {
            customer: {
              id: "1234567890",
              currencyCode: "EUR",
              timeZone: "America/Los_Angeles",
            },
          },
        ];
      }
      const day = query.match(/BETWEEN '(\d{4}-\d{2}-\d{2})'/)?.[1] ?? "";
      queriedDays.push(day);
      return [
        {
          customer: { id: "1234567890" },
          segments: { date: day },
          metrics: { costMicros: day === "2026-08-03" ? "999" : "12" },
        },
      ];
    });
    const times = [
      new Date("2026-08-04T06:59:57.000Z"),
      new Date("2026-08-04T06:59:59.000Z"),
      new Date("2026-08-04T07:00:01.000Z"),
      new Date("2026-08-04T07:00:02.000Z"),
      new Date("2026-08-04T07:00:03.000Z"),
    ];

    const captured = await captureGoogleBillingStartAsAgency("1234567890", {
      search,
      now: () => times.shift() ?? new Date("2026-08-04T07:00:03.000Z"),
      randomUUID: () => "capture-midnight",
    });

    expect(queriedDays).toEqual(["2026-08-03", "2026-08-04"]);
    expect(captured).toMatchObject({
      google_local_date: "2026-08-04",
      baseline_cost_micros: "12",
      capture_id: "capture-midnight",
    });
  });

  it("fails closed for a foreign-currency customer", async () => {
    const search = vi.fn(async () => [
      {
        customer: {
          id: "1234567890",
          currencyCode: "USD",
          timeZone: "America/New_York",
        },
      },
    ]);

    await expect(
      captureGoogleBillingStartAsAgency("1234567890", { search }),
    ).rejects.toThrow(/USD, not EUR/i);
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe("zero baseline from a reporting connection", () => {
  const NOW = new Date("2026-08-28T22:30:00.000Z"); // 23:30 in Lisbon (summer, UTC+1)
  const deps = { now: () => NOW, randomUUID: () => "conn-capture-1" };

  it("writes a zero baseline dated the capture day in the account's zone", () => {
    const start = captureBillingStartFromConnection(
      { customerId: "310-450-1594", currency: "EUR", timeZone: "Europe/Lisbon" },
      deps,
    );

    expect(start).toEqual({
      google_ads_customer_id: "3104501594",
      google_local_date: "2026-08-28",
      google_time_zone: "Europe/Lisbon",
      currency: "EUR",
      baseline_cost_micros: "0",
      capture_started_at: NOW.toISOString(),
      captured_at: NOW.toISOString(),
      capture_id: "conn-capture-1",
      source: "agency",
    });
  });

  it("dates it by the account's zone, not UTC — the instant that is next-day in Tokyo", () => {
    // 22:30 UTC is already 07:30 the next day in Tokyo. The billing day must be
    // the account's local day, or a whole day of spend lands on the wrong side.
    const start = captureBillingStartFromConnection(
      { customerId: "3104501594", currency: "EUR", timeZone: "Asia/Tokyo" },
      deps,
    );
    expect(start.google_local_date).toBe("2026-08-29");
  });

  it("refuses a non-EUR connection, because the baseline and invoices are EUR-only", () => {
    expect(() =>
      captureBillingStartFromConnection(
        { customerId: "3104501594", currency: "HUF", timeZone: "Europe/Budapest" },
        deps,
      ),
    ).toThrow(/EUR/);
  });

  it("refuses a connection with no time zone", () => {
    expect(() =>
      captureBillingStartFromConnection(
        { customerId: "3104501594", currency: "EUR", timeZone: "  " },
        deps,
      ),
    ).toThrow(/time zone/i);
  });

  it("refuses anything that is not a 10-digit customer id", () => {
    expect(() =>
      captureBillingStartFromConnection(
        { customerId: "123", currency: "EUR", timeZone: "Europe/Lisbon" },
        deps,
      ),
    ).toThrow(/10-digit/);
  });
});
