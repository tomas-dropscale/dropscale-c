import "server-only";

import {
  searchGoogleAdsAsAgency,
  type GaqlRow,
} from "./client";

/** Google reports money as an INT64 count of millionths of the account currency. */
export type RawGoogleSpendDay = {
  date: string;
  costMicros: string;
};

export type GoogleBillingAccountMetadata = {
  customerId: string;
  currency: string;
  timeZone: string;
};

/**
 * The source-owned portion of an `ad_account_billing_starts` row. The caller
 * adds the local account id and reviewer in the same transaction that makes
 * the account billable.
 */
export type CapturedGoogleBillingStart = {
  google_ads_customer_id: string;
  google_local_date: string;
  google_time_zone: string;
  currency: "EUR";
  baseline_cost_micros: string;
  capture_started_at: string;
  captured_at: string;
  capture_id: string;
  source: "agency";
};

/** Source-owned receipt for the immutable Google-reported counter that closes billing. */
export type CapturedGoogleBillingEnd = {
  google_ads_customer_id: string;
  google_local_date: string;
  google_time_zone: string;
  currency: "EUR";
  end_cost_micros: string;
  capture_started_at: string;
  captured_at: string;
  capture_id: string;
  source: "agency";
};

type AgencySearch = (
  customerId: string,
  query: string,
) => Promise<GaqlRow[]>;

type CaptureDependencies = {
  now?: () => Date;
  search?: AgencySearch;
  randomUUID?: () => string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MIDNIGHT_RETRIES = 2;
const ZERO = BigInt(0);
const MICROS_PER_UNIT = BigInt(1_000_000);

function canonicalCustomerId(value: unknown): string {
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      ? String(value).trim()
      : "";
  if (!/^[0-9\s-]+$/.test(text)) {
    throw new Error("Google Ads returned an invalid customer id.");
  }
  const digits = text.replace(/[^0-9]/g, "");
  if (!/^\d{10}$/.test(digits)) {
    throw new Error("Google Ads returned an invalid customer id.");
  }
  return digits;
}

function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Parse an API INT64 without ever taking a detour through a JS float. */
export function parseGoogleMicros(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value < ZERO) throw new Error("Google Ads returned negative cost micros.");
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Google Ads cost micros must be a non-negative safe integer or string.");
    }
    return BigInt(value);
  }

  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text)) {
    throw new Error("Google Ads returned invalid cost micros.");
  }
  return BigInt(text);
}

/** Convert integer micros to the exact numeric(18,6) representation Postgres stores. */
export function microsToDecimal(value: bigint | string): string {
  const micros = parseGoogleMicros(value);
  const whole = micros / MICROS_PER_UNIT;
  const fraction = (micros % MICROS_PER_UNIT).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

/** Parse a non-negative decimal currency value into exact micros. */
export function decimalToMicros(value: string | number): bigint {
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new Error("Ledger money must have at most six decimal places.");
  return BigInt(match[1]) * MICROS_PER_UNIT + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** Exact, non-negative same-day increment over the immutable starting counter. */
export function billableMicrosSinceBaseline(
  currentCostMicros: bigint | string,
  baselineCostMicros: bigint | string,
): bigint {
  const current = parseGoogleMicros(currentCostMicros);
  const baseline = parseGoogleMicros(baselineCostMicros);
  return current > baseline ? current - baseline : ZERO;
}

/**
 * Round a percentage of integer micros to the nearest output micro. All billing
 * values are non-negative, so PostgreSQL's half-away-from-zero is half-up here.
 */
export function percentageOfMicrosToDecimal(
  spendMicros: bigint,
  percentage: string | number,
): string {
  parseGoogleMicros(spendMicros);
  const rateText = String(percentage).trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(rateText);
  if (!match) throw new Error("Commission rate must be a non-negative decimal.");
  const scale = MICROS_PER_UNIT;
  const scaledRate =
    BigInt(match[1]) * scale + BigInt((match[2] ?? "").padEnd(6, "0"));
  const denominator = BigInt(100) * scale;
  const numerator = spendMicros * scaledRate;
  const amountMicros = (numerator + denominator / BigInt(2)) / denominator;
  return microsToDecimal(amountMicros);
}

/** The ISO calendar day at an instant in the Google customer's immutable zone. */
export function googleLocalDate(at: Date, timeZone: string): string {
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid billing capture time.");

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
  } catch {
    throw new Error(`Google Ads returned invalid time zone ${timeZone || "(empty)"}.`);
  }

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  if (!ISO_DAY.test(date)) throw new Error("Could not resolve the Google-local billing date.");
  return date;
}

export function addIsoDays(date: string, offset: number): string {
  if (!isIsoDay(date) || !Number.isInteger(offset)) throw new Error("Invalid ISO billing day.");
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

/** A Sunday is closed only after the customer account itself has entered Monday. */
export function googlePeriodIsClosed(periodEnd: string, at: Date, timeZone: string): boolean {
  if (!isIsoDay(periodEnd)) throw new Error("Invalid Google billing period end.");
  return googleLocalDate(at, timeZone) > periodEnd;
}

function metadataFromRows(expectedCustomerId: string, rows: GaqlRow[]): GoogleBillingAccountMetadata {
  const customer = rows[0]?.customer ?? {};
  const customerId = canonicalCustomerId(customer.id);
  const expected = canonicalCustomerId(expectedCustomerId);
  if (customerId !== expected) throw new Error("Google Ads returned a different customer identity.");

  const currency = String(customer.currencyCode ?? "").trim().toUpperCase();
  const timeZone = String(customer.timeZone ?? "").trim();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Google Ads returned an invalid currency.");
  // Constructing a formatter validates the IANA id and also rejects an empty id.
  googleLocalDate(new Date(0), timeZone);

  return { customerId, currency, timeZone };
}

export async function fetchGoogleBillingMetadataAsAgency(
  customerId: string,
  search: AgencySearch = searchGoogleAdsAsAgency,
): Promise<GoogleBillingAccountMetadata> {
  const rows = await search(
    customerId,
    `SELECT customer.id, customer.currency_code, customer.time_zone FROM customer`,
  );
  if (rows.length !== 1) throw new Error("Google Ads returned no unique customer metadata row.");
  return metadataFromRows(customerId, rows);
}

/** Account-level daily cost, kept in Google's original integer micros. */
export async function fetchGoogleDailyCostMicrosAsAgency(
  customerId: string,
  from: string,
  to: string,
  search: AgencySearch = searchGoogleAdsAsAgency,
): Promise<RawGoogleSpendDay[]> {
  if (!isIsoDay(from) || !isIsoDay(to) || from > to) {
    throw new Error("Invalid Google Ads spend window.");
  }
  const expected = canonicalCustomerId(customerId);
  const rows = await search(
    expected,
    `SELECT customer.id, segments.date, metrics.cost_micros
     FROM customer
     WHERE segments.date BETWEEN '${from}' AND '${to}'`,
  );

  const totals = new Map<string, bigint>();
  for (const row of rows) {
    const returnedId = canonicalCustomerId((row.customer ?? {}).id);
    if (returnedId !== expected) throw new Error("Google Ads spend belongs to another customer.");
    const date = String((row.segments ?? {}).date ?? "");
    if (!isIsoDay(date) || date < from || date > to) {
      throw new Error("Google Ads returned spend outside the requested date range.");
    }
    // No rows is Google's authoritative zero. A returned row with the queried
    // metric missing is instead a malformed response and must fail closed.
    const micros = parseGoogleMicros((row.metrics ?? {}).costMicros);
    totals.set(date, (totals.get(date) ?? ZERO) + micros);
  }

  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, costMicros]) => ({ date, costMicros: costMicros.toString() }));
}

/**
 * Observe the account's currently reported Google-local cumulative counter. If midnight
 * passes while Google is answering, discard the old-day response and retry so
 * the stored date and baseline can never describe different days.
 *
 * Google Ads reporting is not an instantaneous event stream. The receipt is
 * exact evidence of the value returned by Google at `captured_at`; it must not
 * be described as proof that every event before that instant had already been
 * incorporated into Google's reporting counter.
 */
export async function captureGoogleBillingStartAsAgency(
  customerId: string,
  dependencies: CaptureDependencies = {},
): Promise<CapturedGoogleBillingStart> {
  const now = dependencies.now ?? (() => new Date());
  const search = dependencies.search ?? searchGoogleAdsAsAgency;
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const captureStartedAt = now();
  const metadata = await fetchGoogleBillingMetadataAsAgency(customerId, search);
  if (metadata.currency !== "EUR") {
    throw new Error(`Google Ads account currency is ${metadata.currency}, not EUR.`);
  }

  for (let attempt = 0; attempt <= MAX_MIDNIGHT_RETRIES; attempt += 1) {
    const queryDate = googleLocalDate(now(), metadata.timeZone);
    const days = await fetchGoogleDailyCostMicrosAsAgency(
      metadata.customerId,
      queryDate,
      queryDate,
      search,
    );
    const capturedAt = now();
    if (googleLocalDate(capturedAt, metadata.timeZone) !== queryDate) continue;

    return {
      google_ads_customer_id: metadata.customerId,
      google_local_date: queryDate,
      google_time_zone: metadata.timeZone,
      currency: "EUR",
      baseline_cost_micros: (days[0]?.costMicros ?? "0").toString(),
      capture_started_at: captureStartedAt.toISOString(),
      captured_at: capturedAt.toISOString(),
      capture_id: randomUUID(),
      source: "agency",
    };
  }

  throw new Error("Google-local midnight passed repeatedly during billing capture.");
}

/**
 * Observe the account's cumulative counter as reported when commercial service
 * ends. The end receipt deliberately mirrors the start receipt: a later daily
 * Google row may change as reporting catches up, so invoice arithmetic caps
 * the final local day at the immutable value actually captured. This is a
 * reproducible observed boundary, not a guarantee of event-time freshness.
 */
export async function captureGoogleBillingEndAsAgency(
  customerId: string,
  dependencies: CaptureDependencies = {},
): Promise<CapturedGoogleBillingEnd> {
  const now = dependencies.now ?? (() => new Date());
  const search = dependencies.search ?? searchGoogleAdsAsAgency;
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const captureStartedAt = now();
  const metadata = await fetchGoogleBillingMetadataAsAgency(customerId, search);
  if (metadata.currency !== "EUR") {
    throw new Error(`Google Ads account currency is ${metadata.currency}, not EUR.`);
  }

  for (let attempt = 0; attempt <= MAX_MIDNIGHT_RETRIES; attempt += 1) {
    const queryDate = googleLocalDate(now(), metadata.timeZone);
    const days = await fetchGoogleDailyCostMicrosAsAgency(
      metadata.customerId,
      queryDate,
      queryDate,
      search,
    );
    const capturedAt = now();
    if (googleLocalDate(capturedAt, metadata.timeZone) !== queryDate) continue;

    return {
      google_ads_customer_id: metadata.customerId,
      google_local_date: queryDate,
      google_time_zone: metadata.timeZone,
      currency: "EUR",
      end_cost_micros: (days[0]?.costMicros ?? "0").toString(),
      capture_started_at: captureStartedAt.toISOString(),
      captured_at: capturedAt.toISOString(),
      capture_id: randomUUID(),
      source: "agency",
    };
  }

  throw new Error("Google-local midnight passed repeatedly during billing-end capture.");
}
