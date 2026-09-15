"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { presetSelection, type RangeSelection } from "@/lib/portal/range";

type ReportingSyncRequest =
  | { scope: "all"; range: RangeSelection }
  | { scope: "campaigns"; range: RangeSelection }
  | {
      scope: "store";
      clientId: string;
      store: {
        accountId: string;
        activityAccountIds: string[];
        currency: string;
      };
      range: RangeSelection;
    };

type MetricCoverage = { data?: { refreshed?: boolean } };
type RefreshSummary = { refreshed?: number; metricCoverage?: MetricCoverage };
type ReportingSyncResponse = {
  error?: string;
  result?: RefreshSummary;
  campaigns?: RefreshSummary;
  stores?: RefreshSummary[];
  metricCoverage?: MetricCoverage;
};

// Each of these is the route saying "some of it worked": a 502 carrying one
// of them with persisted successes is a partial refresh, not a hard error.
// The route-budget one is the portfolio-wide Sync stopping at 120 s with the
// launched stores already saved.
const PARTIAL_REFRESH_ERRORS = new Set([
  "Store reporting could not be fully refreshed.",
  "Campaign reporting could not be fully refreshed.",
  "Some reporting families could not be fully refreshed.",
  "Reporting sync reached its route budget; remaining stores were not launched.",
]);

function hasPersistedSuccess(result: ReportingSyncResponse | null) {
  return Boolean(
    (result?.result?.refreshed ?? 0) > 0 ||
      (result?.campaigns?.refreshed ?? 0) > 0 ||
      result?.stores?.some((store) => (store.refreshed ?? 0) > 0) ||
      result?.metricCoverage?.data?.refreshed ||
      result?.result?.metricCoverage?.data?.refreshed ||
      result?.campaigns?.metricCoverage?.data?.refreshed,
  );
}

export async function requestReportingSync(
  request: ReportingSyncRequest,
  refresh: () => void,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/admin/sync-reporting", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const result = (await response.json().catch(() => null)) as ReportingSyncResponse | null;
  // A classified server response may have persisted some families before
  // reporting an honest partial failure. Refresh those successes either way.
  refresh();
  if (!response.ok) {
    if (
      result?.error &&
      PARTIAL_REFRESH_ERRORS.has(result.error) &&
      hasPersistedSuccess(result)
    ) {
      return;
    }
    throw new Error(result?.error || "Reporting sync failed.");
  }
}

/**
 * The two reporting legs of the global Sync, in the order the machine
 * schedule runs them: the last 7 days, then today on its own.
 *
 * Today is a separate leg because the route keeps separate snapshots for the
 * today range (the ones /admin/campaigns shows when its range is today) and
 * only a request for that exact range rewrites them; the d7 leg leaves them
 * as the last machine run left them, so an admin pressing Sync at 09:49 still
 * saw the 09:05 snapshot with 0.00 spend. The route also reads today's
 * campaign spend from a different Windsor table than the rolling leg, and
 * every leg upserts today's daily_metrics row, so the leg that runs LAST
 * decides today's ad spend; each leg competes its table against the account
 * table, so no leg writes less than the account carried when it ran. The
 * machine schedule runs today last for that reason; this does the same, and
 * runs the legs one after the other rather than at once because the provider
 * load of two portfolio-wide refreshes is the concern, not the wait.
 * The today leg runs even when the d7 leg failed: it is the figure the admin
 * is looking at, and a route budget spent on the rolling leg says nothing
 * about it. Each leg keeps its own classification; the first failure is the
 * one reported. The ranges are computed at call time so a tab left open
 * overnight still syncs the right windows.
 */
export async function requestGlobalReportingSync(
  refresh: () => void,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<void> {
  let failure: { reason: unknown } | null = null;
  for (const key of ["d7", "today"] as const) {
    try {
      await requestReportingSync(
        { scope: "all", range: presetSelection(key, now) },
        refresh,
        fetcher,
      );
    } catch (reason) {
      failure ??= { reason };
    }
  }
  if (failure) throw failure.reason;
}

/**
 * The everywhere-Sync in the admin chrome: one click advances the whole
 * automatic chain (metadata, provisioning, billing starts, cutovers) and
 * refreshes every store for the last 7 days and then for today (see
 * requestGlobalReportingSync for why today is its own leg).
 */
export function GlobalReportingSyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function sync() {
    setError(null);
    startTransition(async () => {
      // The finance ledger is a separate leg from reporting; one global
      // button means both, so the overview figures catch up on the same
      // click that refreshes the stores.
      const [reporting, ledgers] = await Promise.allSettled([
        requestGlobalReportingSync(() => router.refresh()),
        fetch("/api/admin/sync-ledgers", { method: "POST" }).then((res) => {
          if (!res.ok) throw new Error("The finance ledger did not sync.");
        }),
      ]);
      router.refresh();
      const failure = [reporting, ledgers].find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (failure) {
        setError(
          failure.reason instanceof Error
            ? failure.reason.message
            : "Reporting sync failed.",
        );
      }
    });
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      {error && (
        <span
          role="alert"
          title={error}
          className="max-w-40 truncate text-[11px] text-[var(--danger-red)]"
        >
          {error}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        loading={pending}
        onClick={sync}
        aria-label="Sync"
      >
        <RefreshCw aria-hidden />
        Sync
      </Button>
    </span>
  );
}

export function ReportingSyncButton({ request }: { request: ReportingSyncRequest }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function sync() {
    setError(null);
    startTransition(async () => {
      try {
        await requestReportingSync(request, () => router.refresh());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Reporting sync failed.");
      }
    });
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={pending}
        onClick={sync}
      >
        <RefreshCw aria-hidden />
        Sync
      </Button>
      {error && (
        <span
          role="alert"
          title={error}
          className="max-w-48 truncate text-[11px] text-[var(--danger-red)]"
        >
          {error}
        </span>
      )}
    </span>
  );
}
