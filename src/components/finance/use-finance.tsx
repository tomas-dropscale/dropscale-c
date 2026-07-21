"use client";

import * as React from "react";

import { createClient } from "@/lib/supabase/client";
import { fetchFinanceSnapshot, type FinanceSnapshot } from "@/lib/finance/queries";
import { rangeBounds, type RangeKey } from "@/components/finance/finance-ui";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";

/**
 * Owns the finance data for a page: the selected window, refetching when it
 * changes, and a manual refresh for after a mutation.
 *
 * The server renders the first window so the page is never blank on load;
 * changing the range refetches from the browser.
 */
export function useFinance(initial: FinanceSnapshot, initialRange: RangeKey) {
  const { d } = useI18n();

  const [range, setRange] = React.useState<RangeKey>(initialRange);
  const [data, setData] = React.useState<FinanceSnapshot>(initial);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (key: RangeKey) => {
      const { from, to } = rangeBounds(key);
      setLoading(true);

      try {
        const supabase = createClient();
        setData(await fetchFinanceSnapshot(supabase, from, to));
      } catch (cause) {
        setError(
          fmt(d.finance.loadFailed, {
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      } finally {
        setLoading(false);
      }
    },
    [d],
  );

  const changeRange = React.useCallback(
    (next: RangeKey) => {
      setRange(next);
      void load(next);
    },
    [load],
  );

  const refresh = React.useCallback(() => load(range), [load, range]);

  return { data, range, setRange: changeRange, refresh, loading, error, setError };
}
