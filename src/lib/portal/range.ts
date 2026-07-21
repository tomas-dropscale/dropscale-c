/** Date-range selector shared by the Overview and the store view. */

export const RANGES = ["today", "d7", "d30"] as const;
export type RangeKey = (typeof RANGES)[number];

export const RANGE_LABELS: Record<RangeKey, string> = {
  today: "Today",
  d7: "Last 7 days",
  d30: "Last 30 days",
};

export function parseRange(value: string | string[] | undefined): RangeKey {
  return typeof value === "string" && (RANGES as readonly string[]).includes(value)
    ? (value as RangeKey)
    : "today";
}

/** Spend scale per range, so switching ranges visibly changes the numbers. */
export const RANGE_SCALE: Record<RangeKey, number> = {
  today: 1,
  d7: 6.4,
  d30: 26.5,
};
