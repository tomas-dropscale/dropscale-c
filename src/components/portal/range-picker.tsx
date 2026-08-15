"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LoaderCircle } from "lucide-react";

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
  const [pending, startTransition] = React.useTransition();

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

  return (
    <>
      <DateRangePicker value={optimistic} onApply={apply} footer={footer} />
      {pending && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-0 z-[70] bg-black/10"
        >
          <span className="absolute top-4 right-4 flex items-center gap-2 rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] shadow-xl shadow-black/35">
            <LoaderCircle className="size-3.5 animate-spin text-[var(--accent-gold)]" aria-hidden />
            Updating timeframe…
          </span>
        </div>
      )}
    </>
  );
}
