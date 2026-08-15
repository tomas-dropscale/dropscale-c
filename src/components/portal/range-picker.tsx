"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DateRangePicker } from "@/components/ui/date-range-picker";
import {
  presetSelection,
  rangeQuery,
  type RangeSelection,
} from "@/lib/portal/range";

export function rangeHref(
  pathname: string,
  currentQuery: string,
  selection: RangeSelection,
) {
  const params = new URLSearchParams(currentQuery);
  params.delete("range");
  params.delete("from");
  params.delete("to");
  const range = new URLSearchParams(rangeQuery(selection).replace(/^\?/, ""));
  for (const [key, value] of range) params.set(key, value);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

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
  const currentQuery = searchParams.toString();
  const [optimistic, setOptimistic] = React.useOptimistic(current);
  const [, startTransition] = React.useTransition();

  const hrefFor = React.useCallback(
    (selection: RangeSelection) => rangeHref(pathname, currentQuery, selection),
    [currentQuery, pathname],
  );

  React.useEffect(() => {
    if (pathname !== "/admin/analytics") return;
    // These are the two frequent, DB-backed jumps in Analytics. Keeping the
    // prefetch bounded avoids loading every preset and every custom range.
    router.prefetch(hrefFor(presetSelection("today")));
    router.prefetch(hrefFor(presetSelection("d7")));
  }, [hrefFor, pathname, router]);

  function apply(selection: RangeSelection) {
    startTransition(() => {
      setOptimistic(selection);
      router.push(hrefFor(selection), { scroll: false });
    });
  }

  return <DateRangePicker value={optimistic} onApply={apply} footer={footer} />;
}
