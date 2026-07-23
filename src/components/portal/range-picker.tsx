"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DateRangePicker } from "@/components/ui/date-range-picker";
import { rangeQuery, type RangeSelection } from "@/lib/portal/range";

/**
 * URL-backed wrapper around the shared DateRangePicker: the selection travels
 * as search params (?range=…, or ?range=custom&from=…&to=…), so ranges are
 * shareable links and the server components re-render with the new window.
 *
 * Non-range params (e.g. ?store= on the main dashboard) survive the change —
 * picking a period must not silently reset the store filter.
 */
export function RangePicker({
  current,
  footer,
}: {
  current: RangeSelection;
  footer?: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  function apply(selection: RangeSelection) {
    const params = new URLSearchParams(searchParams);
    params.delete("range");
    params.delete("from");
    params.delete("to");
    const range = new URLSearchParams(rangeQuery(selection).replace(/^\?/, ""));
    for (const [key, value] of range) params.set(key, value);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return <DateRangePicker value={current} onApply={apply} footer={footer} />;
}
