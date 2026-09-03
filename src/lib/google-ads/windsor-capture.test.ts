import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./client", () => ({ searchGoogleAdsAsAgency: vi.fn() }));

const mocks = vi.hoisted(() => ({
  fetchGoogleAdsDailyBreakdown: vi.fn(),
}));
vi.mock("@/lib/windsor/client", () => ({
  fetchGoogleAdsDailyBreakdown: mocks.fetchGoogleAdsDailyBreakdown,
}));

import { captureGoogleBillingEndAsAgency } from "./billing-start";
import { windsorCaptureSearch } from "./windsor-capture";

const IDENTITY = {
  customerId: "5586446242",
  timeZone: "Europe/Lisbon",
  currency: "EUR",
};

const day = (overrides: Partial<Record<string, unknown>> = {}) => ({
  date: "2026-09-03",
  accountId: "558-644-6242",
  customerId: "5586446242",
  currency: "EUR",
  timeZone: "Europe/Lisbon",
  spend: 123.456789,
  impressions: 10,
  clicks: 1,
  conversions: 0,
  conversionValue: 0,
  ...overrides,
});

describe("Windsor-backed billing capture search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers the metadata query from the immutable identity, never from spend rows", async () => {
    const search = windsorCaptureSearch(IDENTITY);
    const rows = await search(
      "5586446242",
      "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer",
    );
    expect(rows).toEqual([
      {
        customer: {
          id: "5586446242",
          currencyCode: "EUR",
          timeZone: "Europe/Lisbon",
        },
      },
    ]);
    expect(mocks.fetchGoogleAdsDailyBreakdown).not.toHaveBeenCalled();
  });

  it("converts Windsor's six-decimal spend into exact integer micros", async () => {
    mocks.fetchGoogleAdsDailyBreakdown.mockResolvedValue([day()]);
    const search = windsorCaptureSearch(IDENTITY);
    const rows = await search(
      "5586446242",
      `SELECT customer.id, segments.date, metrics.cost_micros
       FROM customer
       WHERE segments.date BETWEEN '2026-09-03' AND '2026-09-03'`,
    );
    expect(rows).toEqual([
      {
        customer: { id: "5586446242" },
        segments: { date: "2026-09-03" },
        metrics: { costMicros: "123456789" },
      },
    ]);
    expect(mocks.fetchGoogleAdsDailyBreakdown).toHaveBeenCalledWith(
      "558-644-6242",
      "2026-09-03",
      "2026-09-03",
    );
  });

  it("treats an idle day as Windsor's authoritative zero", async () => {
    mocks.fetchGoogleAdsDailyBreakdown.mockResolvedValue([]);
    const search = windsorCaptureSearch(IDENTITY);
    const rows = await search(
      "5586446242",
      `SELECT customer.id, segments.date, metrics.cost_micros
       FROM customer WHERE segments.date BETWEEN '2026-09-03' AND '2026-09-03'`,
    );
    expect(rows).toEqual([]);
  });

  it("refuses a Windsor row whose identity contradicts the boundary on file", async () => {
    mocks.fetchGoogleAdsDailyBreakdown.mockResolvedValue([day({ currency: "USD" })]);
    const search = windsorCaptureSearch(IDENTITY);
    await expect(
      search(
        "5586446242",
        `SELECT customer.id, segments.date, metrics.cost_micros
         FROM customer WHERE segments.date BETWEEN '2026-09-03' AND '2026-09-03'`,
      ),
    ).rejects.toThrow(/different account identity/i);
  });

  it("refuses queries about a different customer and unsupported queries", async () => {
    const search = windsorCaptureSearch(IDENTITY);
    await expect(search("1111111111", "SELECT customer.id FROM customer")).rejects.toThrow(
      /different customer/i,
    );
    await expect(search("5586446242", "SELECT campaign.id FROM campaign")).rejects.toThrow(
      /unsupported query/i,
    );
  });

  it("drives the real end-capture loop to a Windsor-backed closing counter", async () => {
    mocks.fetchGoogleAdsDailyBreakdown.mockImplementation(async (_id, from) => [
      day({ date: from, spend: 42.5 }),
    ]);
    // A fixed clock keeps the capture inside one Google-local day.
    const at = new Date("2026-09-03T12:00:00.000Z");
    const captured = await captureGoogleBillingEndAsAgency("5586446242", {
      search: windsorCaptureSearch(IDENTITY),
      now: () => at,
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    });
    expect(captured).toMatchObject({
      google_ads_customer_id: "5586446242",
      google_time_zone: "Europe/Lisbon",
      currency: "EUR",
      end_cost_micros: "42500000",
      source: "agency",
    });
    expect(captured.google_local_date).toBe("2026-09-03");
  });
});
