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

/** YYYY-MM-DD in local time — avoids toISOString() shifting the day. */
export function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shifted(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDay(date);
}

export function presetSelection(key: RangePreset): RangeSelection {
  const today = isoDay(new Date());
  switch (key) {
    case "today":
      return { key, from: today, to: today };
    case "yesterday":
      return { key, from: shifted(-1), to: shifted(-1) };
    case "d7":
      return { key, from: shifted(-6), to: today };
    case "d30":
      return { key, from: shifted(-29), to: today };
    case "mtd": {
      const now = new Date();
      return { key, from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    }
    case "ytd":
      return { key, from: isoDay(new Date(new Date().getFullYear(), 0, 1)), to: today };
  }
}

type RangeParams = {
  range?: string | string[];
  from?: string | string[];
  to?: string | string[];
};

const first = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;

export function parseRange(params: RangeParams): RangeSelection {
  const range = first(params.range);
  const from = first(params.from);
  const to = first(params.to);

  if (range === "custom" && from && to && ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to) {
    return { key: "custom", from, to };
  }
  if (range && (RANGE_PRESETS as readonly string[]).includes(range)) {
    return presetSelection(range as RangePreset);
  }
  return presetSelection("today");
}

/** ?range=… (presets) or ?range=custom&from=…&to=… — for link-based pickers. */
export function rangeQuery(selection: RangeSelection): string {
  return selection.key === "custom"
    ? `?range=custom&from=${selection.from}&to=${selection.to}`
    : selection.key === "today"
      ? ""
      : `?range=${selection.key}`;
}

/** Inclusive day count of the window. */
export function rangeDays(selection: RangeSelection): number {
  const [fy, fm, fd] = selection.from.split("-").map(Number);
  const [ty, tm, td] = selection.to.split("-").map(Number);
  const ms = new Date(ty, tm - 1, td).getTime() - new Date(fy, fm - 1, fd).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** Spend scale for the seeded mock, so longer windows show bigger numbers. */
export function rangeScale(selection: RangeSelection): number {
  const days = rangeDays(selection);
  return days === 1 ? 1 : days * 0.88;
}
