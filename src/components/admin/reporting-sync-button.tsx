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

const PARTIAL_REFRESH_ERRORS = new Set([
  "Store reporting could not be fully refreshed.",
  "Campaign reporting could not be fully refreshed.",
  "Some reporting families could not be fully refreshed.",
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
 * The everywhere-Sync in the admin chrome: one click advances the whole
 * automatic chain (metadata, provisioning, billing starts, cutovers) and
 * refreshes every store for the last 7 days. The range is computed at click
 * time so a tab left open overnight still syncs the right window.
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
        requestReportingSync(
          { scope: "all", range: presetSelection("d7", new Date()) },
          () => router.refresh(),
        ),
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
