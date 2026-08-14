/**
 * Date-range selection shared by the portal and the admin campaign views.
 *
 * Every selection — preset or custom — resolves to concrete `from`/`to` ISO
 * dates at parse time. Downstream nobody branches on preset names: GAQL always
 * gets `BETWEEN from AND to`, the mock always gets a day count.
 */

export const RANGE_PRESETS = ["today", "yesterday", "d7", "d30", "mtd", "ytd"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type RangeKey = RangePreset | "custom";

export type RangeSelection = {
  key: RangeKey;
  /** Inclusive ISO dates (YYYY-MM-DD), always set — presets resolve them. */
  from: string;
  to: string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const REPORTING_TIME_ZONE = "Europe/Lisbon";
const MAX_RANGE_DAYS = 366;

/** YYYY-MM-DD in local time — avoids toISOString() shifting the day. */
export function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function reportingDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error("The reporting day is unavailable.");
  return `${year}-${month}-${day}`;
}

function shifted(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function presetSelection(key: RangePreset, now = new Date()): RangeSelection {
  const today = reportingDay(now);
  switch (key) {
    case "today":
      return { key, from: today, to: today };
    case "yesterday":
      return { key, from: shifted(today, -1), to: shifted(today, -1) };
    case "d7":
      return { key, from: shifted(today, -6), to: today };
    case "d30":
      return { key, from: shifted(today, -29), to: today };
    case "mtd":
      return { key, from: `${today.slice(0, 8)}01`, to: today };
    case "ytd":
      return { key, from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

type RangeParams = {
  range?: string | string[];
  from?: string | string[];
  to?: string | string[];
};

const first = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;

function validIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validExplicitRange(
  key: RangeKey,
  from: string | undefined,
  to: string | undefined,
): from is string {
  if (!from || !to || !validIsoDay(from) || !validIsoDay(to) || from > to) return false;
  const days = inclusiveDayCount(from, to);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RANGE_DAYS) return false;
  switch (key) {
    case "today":
    case "yesterday":
      return days === 1;
    case "d7":
      return days === 7;
    case "d30":
      return days === 30;
    case "mtd":
      return from === `${to.slice(0, 8)}01`;
    case "ytd":
      return from === `${to.slice(0, 4)}-01-01`;
    case "custom":
      return true;
  }
}

export function parseRange(params: RangeParams): RangeSelection {
  const range = first(params.range);
  const from = first(params.from);
  const to = first(params.to);

  if (range && (RANGE_PRESETS as readonly string[]).includes(range)) {
    const key = range as RangePreset;
    return validExplicitRange(key, from, to) && to
      ? { key, from, to }
      : presetSelection(key);
  }
  if (range === "custom" && validExplicitRange("custom", from, to) && to) {
    return { key: "custom", from, to };
  }
  return presetSelection("today");
}

/** Always preserves the concrete reporting dates selected in the browser. */
export function rangeQuery(selection: RangeSelection): string {
  const params = new URLSearchParams({
    range: selection.key,
    from: selection.from,
    to: selection.to,
  });
  return `?${params.toString()}`;
}

/** Inclusive day count of the window. */
function inclusiveDayCount(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.round(ms / 86_400_000) + 1;
}

export function rangeDays(selection: RangeSelection): number {
  return inclusiveDayCount(selection.from, selection.to);
}

/**
 * Whole days a campaign has been running, counting its start day as day 1.
 *
 * Null when there is no start date, or when it is later than the day asked
 * about. That null must reach the screen as "—", never as 0: Google not
 * reporting a start date and a campaign that started today are different facts,
 * and "0 days" would state the second while meaning the first.
 *
 * Parsed as UTC on both sides so the subtraction can't be shifted by the
 * server's own timezone.
 */
export function daysRunning(start: string | null | undefined, until: string): number | null {
  if (!start) return null;
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000) + 1;
}

/** Spend scale for the seeded mock, so longer windows show bigger numbers. */
export function rangeScale(selection: RangeSelection): number {
  const days = rangeDays(selection);
  return days === 1 ? 1 : days * 0.88;
}
