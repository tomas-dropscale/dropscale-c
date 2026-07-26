"use client";

import * as React from "react";
import Link from "next/link";
import { Bell, Boxes, Clock, PlugZap, ShoppingBag, Store, type LucideIcon } from "lucide-react";

import type { AdAccount } from "@/lib/supabase/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/**
 * The client's own notification bell, next to their profile. State-free (no
 * notifications table): it reflects two things until they're resolved —
 *   1. store SETUP steps still open (connect Google/Shopify, set costs);
 *   2. accounts still PENDING team approval.
 * A soft chime plays when the count rises (e.g. a new pending account), never
 * on first paint.
 */

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

type SetupTask = { key: string; label: string; help: string; href: string; icon: LucideIcon };

export function ClientNotifications({
  accounts,
  setup,
}: {
  accounts: AdAccount[];
  setup?: { needsGoogle: boolean; costsDone: boolean };
}) {
  const { d } = useI18n();

  const pending = React.useMemo(
    () => accounts.filter((account) => account.status === "pending"),
    [accounts],
  );

  const setupTasks = React.useMemo<SetupTask[]>(() => {
    if (!setup) return [];
    const hasAccounts = accounts.length > 0;
    const googleConnected = accounts.some((account) => account.google_ads_connected);
    const shopifyConnected = accounts.some((account) => account.shopify_connected);

    const tasks: SetupTask[] = [];
    if (!hasAccounts)
      tasks.push({
        key: "store",
        label: "Add your store",
        help: "Create your store account",
        href: "/dashboard/settings/accounts",
        icon: Store,
      });
    if (setup.needsGoogle && !googleConnected)
      tasks.push({
        key: "google",
        label: "Connect Google Ads",
        help: "Bring in spend, ROAS & conversions",
        href: "/dashboard/settings/accounts",
        icon: PlugZap,
      });
    // Shopify is gated on approval: while every store is still pending, this
    // would nag about a step the client is not allowed to take. The pending
    // accounts are already listed on their own below.
    const anyApproved = accounts.some((account) => account.status !== "pending");
    if (!shopifyConnected && anyApproved)
      tasks.push({
        key: "shopify",
        label: "Connect Shopify",
        help: "Bring in revenue, orders & refunds",
        href: "/dashboard/settings/connections",
        icon: ShoppingBag,
      });
    if (!setup.costsDone)
      tasks.push({
        key: "cogs",
        label: "Set your product costs",
        help: "For exact profit and margin",
        href: "/dashboard/costs",
        icon: Boxes,
      });
    return tasks;
  }, [accounts, setup]);

  const count = setupTasks.length + pending.length;

  // Chime only when the count RISES. Seeded on mount so a first load with open
  // items stays silent.
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
          <span className="absolute -top-0.5 -right-0.5 flex min-w-[15px] items-center justify-center rounded-full bg-[var(--warning-orange)] px-1 text-[9px] font-semibold text-[var(--bg-base)]">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[300px]">
        <div className="px-2.5 py-2.5">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            {d.notifications.title}
          </p>
        </div>

        <DropdownMenuSeparator />

        {count === 0 ? (
          <p className="px-2.5 py-4 text-center text-[12.5px] text-[var(--text-muted)]">
            {d.notifications.empty}
          </p>
        ) : (
          <>
            {setupTasks.length > 0 && (
              <>
                <p className="label-caps px-2.5 pt-2 pb-1 text-[var(--text-muted)]">Finish setup</p>
                {setupTasks.map((task) => (
                  <DropdownMenuItem key={task.key} asChild>
                    <Link href={task.href} className="items-start gap-2.5">
                      <task.icon
                        className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-[var(--text-primary)]">
                          {task.label}
                        </span>
                        <span className="block text-[11.5px] text-[var(--text-muted)]">
                          {task.help}
                        </span>
                      </span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              </>
            )}

            {pending.length > 0 && (
              <>
                {setupTasks.length > 0 && <DropdownMenuSeparator />}
                <p className="label-caps px-2.5 pt-2 pb-1 text-[var(--text-muted)]">
                  {fmt(d.notifications.awaitingApproval, { count: pending.length })}
                </p>
                {pending.map((account) => (
                  <div key={account.id} className="flex items-start gap-2.5 px-2.5 py-2">
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
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
