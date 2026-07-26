import { presetSelection, type RangeSelection } from "@/lib/portal/range";

/**
 * Default window for the finance pages, shared by the server (first render)
 * and the client (the date picker). Kept here rather than in finance-ui so a
 * Server Component can import it without pulling in a "use client" module.
 *
 * The admin panel and the portal now speak the same RangeSelection, so both
 * ends of the app use one date control and one set of presets.
 */
export const DEFAULT_FINANCE_PRESET = "d30" as const;

export function defaultSelection(): RangeSelection {
  return presetSelection(DEFAULT_FINANCE_PRESET);
}
