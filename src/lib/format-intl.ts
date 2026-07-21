/**
 * Money and date formatting.
 *
 * Amounts come out of Postgres `numeric` as strings via PostgREST, so every
 * helper coerces with Number() rather than trusting the type.
 */

import { compactParts, joinWithSuffix } from "@/lib/compact";

export function money(value: number | string, intl: string, currency = "EUR") {
  return new Intl.NumberFormat(intl, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

/** Compact form for metric cards: €184.7K. Suffix from ./compact — see why there. */
export function moneyCompact(value: number | string, intl: string, currency = "EUR") {
  const { value: scaled, suffix } = compactParts(Number(value));
  const parts = new Intl.NumberFormat(intl, {
    style: "currency",
    currency,
    // Currency styling would otherwise force EUR's two decimals back on and
    // print "840,0 €"; compact notation used to imply this for us.
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).formatToParts(scaled);

  return joinWithSuffix(parts, suffix);
}

export function percent(value: number, intl: string, digits = 1) {
  return new Intl.NumberFormat(intl, {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(value);
}

/** "2026-07-21" → "21 Jul", without the browser timezone shifting the day. */
export function shortDate(iso: string, intl: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(intl, {
    day: "2-digit",
    month: "short",
  });
}

export function longDate(iso: string, intl: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(intl, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
