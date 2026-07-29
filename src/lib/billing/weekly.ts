/**
 * The arithmetic behind a weekly invoice — which week is billable, and what a
 * week's ledger totals cost the client.
 *
 * Deliberately free of imports beyond a type: this is the money, and it should
 * be testable without a database, a Stripe key or a request. `invoices.ts` does
 * the I/O and calls in here for every figure that matters.
 */

import type { InvoiceLine } from "@/lib/supabase/types";

/** How long a client has to pay before an invoice counts as late. */
export const DAYS_UNTIL_DUE = 7;

/** How many closed weeks back the generator will heal on a run. */
export const BACKFILL_WEEKS = 8;

/**
 * How many closed weeks back may be BILLED without someone asking for it.
 *
 * Separate from BACKFILL_WEEKS on purpose. Creating rows for old weeks is
 * harmless bookkeeping — the ledger should be complete. Sending them to Stripe
 * is not: with ad spend now on the invoice, a first run against a live key
 * would have emailed (or charged) up to eight weeks of back-invoices at once,
 * per client. Nobody wants to discover that from a client's reply.
 *
 * Anything older is created as a draft and waits for an admin to release it
 * (POST /api/billing/generate with billBacklog). Two weeks covers a cron that
 * missed a Monday without ever reaching back into history on its own.
 */
export const AUTO_BILL_WEEKS = 2;

/**
 * Whether a closed week may be invoiced automatically.
 *
 * `weeks` is the newest-first list from closedWeeks(), so an index below the
 * limit is one of the most recent weeks.
 */
export function isAutoBillable(weekIndex: number): boolean {
  return weekIndex < AUTO_BILL_WEEKS;
}

export const round2 = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Week maths — Monday is day 1
// ---------------------------------------------------------------------------

export function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return isoDay(date);
}

/** The Monday of the week `date` falls in. */
export function mondayOf(date: Date): string {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (copy.getDay() + 6) % 7; // 0 = Monday
  copy.setDate(copy.getDate() - weekday);
  return isoDay(copy);
}

/**
 * The billable weeks: every Monday→Sunday that has fully CLOSED, newest first.
 * The current week is never invoiced — it isn't over, and commission for it is
 * still moving.
 */
export function closedWeeks(
  now = new Date(),
  count = BACKFILL_WEEKS,
): { start: string; end: string }[] {
  const thisMonday = mondayOf(now);
  return Array.from({ length: count }, (_, index) => {
    const start = addDays(thisMonday, -7 * (index + 1));
    return { start, end: addDays(start, 6) };
  });
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** Per store, per week: what was spent, what we charge on it, what it's in. */
export type StoreTotals = {
  /** Google Ads spend the agency fronted, re-billed at cost. */
  spend: number;
  /** Management fee earned on that spend. */
  fee: number;
  /** The agency's cut of attributed revenue, for stores with rev share on. */
  revShare: number;
  /** Revenue that cut was taken from — only used to name the blended rate. */
  revShareBase: number;
  currency: string | null;
};

export function emptyTotals(): StoreTotals {
  return { spend: 0, fee: 0, revShare: 0, revShareBase: 0, currency: null };
}

/**
 * One store's week as invoice lines: what went to Google, then what we earn.
 *
 * Rates are BLENDED over the week (fee ÷ spend), so they stay true even if the
 * agency changed commission_rate mid-week — printing a flat 10% would be a lie
 * about what was actually charged.
 */
export function storeLines(accountId: string, store: string, totals: StoreTotals): InvoiceLine[] {
  const lines: InvoiceLine[] = [];

  // Sub-cent lines would finalise at zero in Stripe and read as noise.
  const push = (kind: InvoiceLine["kind"], label: string, amount: number, rate: number | null) => {
    if (amount < 0.01) return;
    lines.push({ accountId, kind, store, rate, label, amount: round2(amount) });
  };

  // One decimal is enough to name a rate, and avoids 9.999999% from float drift.
  const blend = (part: number, whole: number) =>
    whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

  const feeRate = blend(totals.fee, totals.spend);
  const shareRate = blend(totals.revShare, totals.revShareBase);

  push("spend", `${store} — Google Ads spend`, totals.spend, null);
  push(
    "fee",
    `${store} — management fee${feeRate !== null ? ` (${feeRate}%)` : ""}`,
    totals.fee,
    feeRate,
  );
  push(
    "rev_share",
    `${store} — revenue share${shareRate !== null ? ` (${shareRate}%)` : ""}`,
    totals.revShare,
    shareRate,
  );

  return lines;
}

/**
 * The currency to bill a client's week in.
 *
 * One currency across their stores means we can use it. Mixed currencies cannot
 * be summed honestly, so fall back to the column default rather than silently
 * labelling one currency as another.
 */
export function billingCurrency(currencies: Set<string>): string {
  return currencies.size === 1 ? [...currencies][0] : "EUR";
}
