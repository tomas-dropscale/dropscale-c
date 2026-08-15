"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { RangeSelection } from "@/lib/portal/range";

type ReportingSyncRequest =
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
  const result = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  // A classified server response may have persisted some families before
  // reporting an honest partial failure. Refresh those successes either way.
  refresh();
  if (!response.ok) {
    throw new Error(result?.error || "Reporting sync failed.");
  }
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
