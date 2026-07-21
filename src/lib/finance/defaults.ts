import { daysAgo, isoDay } from "@/lib/finance/queries";

/**
 * Default window for the finance pages, shared by the server (first render)
 * and the client (RangeTabs). Kept here rather than in finance-ui so a Server
 * Component can import it without pulling in a "use client" module.
 */
export const DEFAULT_FINANCE_RANGE = "d30" as const;

export function defaultBounds() {
  return { from: daysAgo(29), to: isoDay(new Date()) };
}
