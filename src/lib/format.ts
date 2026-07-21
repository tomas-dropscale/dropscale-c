/**
 * Number and date formatting for the portal. English-only ("en-GB" gives
 * dd MMM dates and keeps € after the locale-correct side).
 *
 * Amounts come out of Postgres `numeric` as strings via PostgREST, so every
 * helper coerces with Number() rather than trusting the type.
 */
import { compactParts, joinWithSuffix } from "@/lib/compact";

const LOCALE = "en-GB";

export function money(value: number | string, currency = "EUR") {
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

/** Compact form for metric cards: €184.7K. Suffix from ./compact — see why there. */
export function moneyCompact(value: number | string, currency = "EUR") {
  const { value: scaled, suffix } = compactParts(Number(value));
  const parts = new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    // Currency styling would otherwise force EUR's two decimals back on and
    // print "€840.0"; compact notation used to imply this for us.
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).formatToParts(scaled);

  return joinWithSuffix(parts, suffix);
}

export function compact(value: number | string) {
  const { value: scaled, suffix } = compactParts(Number(value));
  const parts = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).formatToParts(scaled);

  return joinWithSuffix(parts, suffix);
}

export function integer(value: number | string) {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(
    Number(value),
  );
}

/** 0.0432 → "4.32%" */
export function percent(value: number, digits = 2) {
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(value);
}

/** ROAS-style multiplier: 3.412 → "3.41x" */
export function multiplier(value: number, digits = 2) {
  return `${Number(value).toFixed(digits)}x`;
}

export function dateTime(iso: string) {
  return new Date(iso).toLocaleString(LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Clock-dependent values live here, NOT in component bodies: the React
 * Compiler's purity rule rejects Date.now() during render, and it can't see
 * through module boundaries. Server Components run per request anyway.
 */
export function nowIso() {
  return new Date().toISOString();
}

/** "HH:mm" one hour from now — the fake next-sync time. */
export function nextSyncLabel() {
  return new Date(Date.now() + 60 * 60 * 1000).toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Whole days since an ISO timestamp. */
export function ageDays(iso: string) {
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}
