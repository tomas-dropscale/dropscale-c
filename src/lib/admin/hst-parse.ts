/**
 * Reading HST's rows: the date, and who the commission belongs to.
 *
 * Pure and I/O-free so it can be unit-tested (hst-parse.test.ts) — these two
 * functions decide which rows survive and how they are grouped, so a mistake
 * here does not throw, it just silently loses clients.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `express_date` → a date Postgres will accept, or null.
 *
 * The ERP has been seen sending "2026-07-25", "2026/07/25" and values with a
 * time part. Anything else is dropped rather than sent to the database: one
 * unparseable day used to be enough to make the whole booking fail.
 */
export function normalizeDay(value: string): string | null {
  const day = value.trim().replace(/\//g, "-").slice(0, 10);
  return ISO_DAY.test(day) ? day : null;
}

/**
 * Every character HST might be using as the separator in a shop name.
 *
 * ASCII hyphen is the common case, but ERP text is pasted by humans out of
 * spreadsheets and messaging apps, which substitute en/em dashes and the
 * fullwidth form freely. Splitting on the hyphen alone left those shop names
 * unsplit, so the "client" became the entire raw string — a row that looks
 * nothing like the client's name and therefore reads as a client gone missing.
 */
const DASHES = /[-‐‑‒–—―－]/;

/**
 * The client name is the last dash-separated segment of the HST shop name:
 * "AZL90266-РАЯ НИКОЛОВА-Tomas" → "Tomas", "AYW98711-椿工房-Caio" → "Caio".
 *
 * Returns null — not a placeholder — when there is nothing usable. Callers must
 * decide what an unattributable row means; the old behaviour folded them all
 * into a single bucket named "Unknown", which quietly merged several real
 * clients into one line and made them look absent from the list.
 */
export function clientNameFromShop(shopName: string | null | undefined): string | null {
  const parts = (shopName ?? "")
    .split(DASHES)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts[parts.length - 1] : null;
}
