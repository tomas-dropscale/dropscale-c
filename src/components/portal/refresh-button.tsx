"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Forces the dashboard's data current on demand, bypassing the 15-minute
 * throttle: it re-pulls the recent window for the visible stores, then
 * re-renders. Between clicks the numbers still auto-refresh on navigation.
 */
export function RefreshButton({ accountIds }: { accountIds: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function refresh() {
    setBusy(true);
    try {
      await fetch("/api/metrics/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds }),
      });
    } catch {
      // The next lazy sync heals it; nothing to surface for a refresh.
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <Button variant="secondary" size="sm" onClick={refresh} loading={busy} aria-label="Refresh data">
      <RefreshCw />
      Refresh
    </Button>
  );
}
