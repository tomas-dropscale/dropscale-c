"use client";

import { usePathname, useRouter } from "next/navigation";

import { DateRangePicker } from "@/components/ui/date-range-picker";
import { rangeQuery, type RangeSelection } from "@/lib/portal/range";

/**
 * URL-backed wrapper around the shared DateRangePicker: the selection travels
 * as search params (?range=…, or ?range=custom&from=…&to=…), so ranges are
 * shareable links and the server components re-render with the new window.
 */
export function RangePicker({ current }: { current: RangeSelection }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <DateRangePicker
      value={current}
      onApply={(selection) => router.push(`${pathname}${rangeQuery(selection)}`)}
    />
  );
}
