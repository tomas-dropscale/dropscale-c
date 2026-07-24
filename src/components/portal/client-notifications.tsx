"use client";

import * as React from "react";
import { Bell, Clock } from "lucide-react";

import type { AdAccount } from "@/lib/supabase/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/**
 * The client's own notification bell, sat next to their profile.
 *
 * Deliberately state-free: there is no notifications table. The one thing a
 * client waits on is a newly-added account being approved, so the bell simply
 * reflects how many of THEIR accounts are still `pending` — derived from the
 * accounts the shell already has. A soft chime plays when a new pending
 * account appears (e.g. the moment they add one), never on first paint.
 */

/** A soft two-note chime, synthesised so we ship no audio asset. */
function playChime() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    osc.start(now);
    osc.stop(now + 0.42);
    osc.onended = () => void ctx.close();
  } catch {
    // Autoplay blocked or no audio device — the badge is the primary signal.
  }
}

export function ClientNotifications({ accounts }: { accounts: AdAccount[] }) {
  const { d } = useI18n();

  const pending = React.useMemo(
    () => accounts.filter((account) => account.status === "pending"),
    [accounts],
  );
  const count = pending.length;

  // Chime only when the count RISES (a new pending account). Seeded on mount so
  // an initial load that already has pending accounts stays silent.
  const prev = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (prev.current !== null && count > prev.current) playChime();
    prev.current = count;
  }, [count]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={d.notifications.open}
        className="transition-smooth relative rounded-md p-1.5 text-[var(--text-secondary)] outline-none hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30 data-[state=open]:bg-[var(--bg-panel)]"
      >
        <Bell className="size-4" aria-hidden />
        {count > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex min-w-[15px] items-center justify-center rounded-full bg-[var(--warning-orange)] px-1 text-[9px] font-semibold text-[var(--bg-base)]"
            aria-label={fmt(d.notifications.awaitingApproval, { count })}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[280px]">
        <div className="flex items-baseline justify-between gap-2 px-2.5 py-2.5">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            {d.notifications.title}
          </p>
          {count > 0 && (
            <span className="text-[11.5px] text-[var(--text-muted)]">
              {fmt(d.notifications.awaitingApproval, { count })}
            </span>
          )}
        </div>

        <DropdownMenuSeparator />

        {count === 0 ? (
          <p className="px-2.5 py-4 text-center text-[12.5px] text-[var(--text-muted)]">
            {d.notifications.empty}
          </p>
        ) : (
          <ul className="py-1">
            {pending.map((account) => (
              <li key={account.id} className="flex items-start gap-2.5 px-2.5 py-2">
                <Clock
                  className="mt-0.5 size-4 shrink-0 text-[var(--warning-orange)]"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-[var(--text-primary)]">
                    {account.store_name}
                  </span>
                  <span className="block text-[11.5px] text-[var(--text-muted)]">
                    {d.portal.accountPending}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
