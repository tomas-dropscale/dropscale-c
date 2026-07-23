/**
 * Daily FX rates for converting store-currency order amounts into the
 * account's reporting currency (EUR by default).
 *
 * Why this exists: Shopify's API returns order totals in the store's BASE
 * currency (shopMoney) — a HUF store reports 130 171, and Shopify Analytics
 * quietly converts to EUR only for display. Summing raw shopMoney under a €
 * label showed figures ~360× off.
 *
 * Source: frankfurter.app — ECB reference rates, no API key, plain fetch, so
 * it runs on Cloudflare Workers. Rates are per business day; weekends and
 * holidays fall back to the latest prior rate, which is also what the ECB
 * itself would tell you to do. Conversion happens at SYNC time so
 * daily_metrics stays homogeneous in one currency.
 */

const FX_HOST = "https://api.frankfurter.app";

// Rates change once per business day — cache generously per isolate.
const seriesCache = new Map<string, { rates: [string, number][]; expiresAt: number }>();
const CACHE_MS = 12 * 60 * 60 * 1000;

export class FxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxError";
  }
}

/**
 * Sorted [day, rate] pairs covering [from, to] (business days only).
 * Throws FxError when the pair is unsupported or the service is down —
 * writing unconverted numbers as if converted is the one unacceptable outcome.
 */
export async function fxDailyRates(
  base: string,
  quote: string,
  from: string,
  to: string,
): Promise<[string, number][]> {
  const cacheKey = `${base}:${quote}:${from}:${to}`;
  const cached = seriesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rates;

  const res = await fetch(`${FX_HOST}/${from}..${to}?from=${base}&to=${quote}`);
  if (!res.ok) {
    throw new FxError(`FX service returned ${res.status} for ${base}→${quote}.`);
  }

  const body = (await res.json()) as { rates?: Record<string, Record<string, number>> };
  let pairs: [string, number][] = Object.entries(body.rates ?? {})
    .map(([day, byCurrency]): [string, number] => [day, byCurrency[quote]])
    .filter((pair): pair is [string, number] => typeof pair[1] === "number")
    .sort((a, b) => a[0].localeCompare(b[0]));

  // A short all-weekend/holiday window can come back empty — use the latest.
  if (pairs.length === 0) {
    const latest = await fetch(`${FX_HOST}/latest?from=${base}&to=${quote}`);
    if (latest.ok) {
      const latestBody = (await latest.json()) as {
        date?: string;
        rates?: Record<string, number>;
      };
      const rate = latestBody.rates?.[quote];
      if (typeof rate === "number" && latestBody.date) pairs = [[latestBody.date, rate]];
    }
  }

  if (pairs.length === 0) {
    throw new FxError(
      `No ${base}→${quote} rate available — unsupported currency pair or FX service outage.`,
    );
  }

  seriesCache.set(cacheKey, { rates: pairs, expiresAt: Date.now() + CACHE_MS });
  return pairs;
}

/** Rate for a calendar day: exact, else latest prior, else the earliest known. */
export function rateOn(pairs: [string, number][], day: string): number {
  let chosen = pairs[0][1];
  for (const [rateDay, rate] of pairs) {
    if (rateDay > day) break;
    chosen = rate;
  }
  return chosen;
}
