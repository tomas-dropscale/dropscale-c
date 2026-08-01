"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * How long until the report's data is next rebuilt.
 *
 * The rollup behind these numbers is refreshed by a cron on the hour, every
 * hour, starting at midnight UTC — so "next update" is simply the next hour
 * boundary. Reading it off the clock rather than off a stored schedule means
 * the countdown cannot drift out of step with the cron.
 *
 * Mounted empty and filled in on the client. Rendering a countdown on the
 * server would ship a number that is already wrong by the time it arrives, and
 * React would flag the mismatch on hydration.
 */

/** Where the cron fires. Must match `triggers.crons` in wrangler.jsonc. */
const PERIOD_MINUTES = 60;

function msUntilNextRun(now: Date): number {
  const period = PERIOD_MINUTES * 60_000;
  // Anchored to midnight UTC, which is where the cron's hour counting starts.
  const sinceMidnight =
    now.getUTCHours() * 3_600_000 +
    now.getUTCMinutes() * 60_000 +
    now.getUTCSeconds() * 1_000 +
    now.getUTCMilliseconds();

  return period - (sinceMidnight % period);
}

function format(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function NextRefresh({ className }: { className?: string }) {
  const [remaining, setRemaining] = React.useState<number | null>(null);

  React.useEffect(() => {
    const tick = () => setRemaining(msUntilNextRun(new Date()));
    tick();

    // Every second, because the point of this is to be exact. One interval for
    // the life of the dialog; cleared when it closes.
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] tabular-nums",
        className,
      )}
      // Screen readers should not have a ticking clock read out at them.
      aria-live="off"
    >
      <RefreshCw
        className={cn(
          "size-3 text-[var(--accent-gold)]",
          // The last minute is when a reload is actually worth waiting for.
          remaining !== null && remaining < 60_000 && "animate-spin",
        )}
        aria-hidden
      />
      {remaining === null ? "Next update —" : `Next update in ${format(remaining)}`}
    </span>
  );
}
