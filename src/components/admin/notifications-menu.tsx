"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Store, Ticket, UserPlus, type LucideIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PendingCounts } from "@/lib/admin/approvals";
import { createClient } from "@/lib/supabase/client";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/**
 * Approval inbox in the admin chrome.
 *
 * The counts are rendered on the server; this component keeps them honest by
 * refreshing when the underlying tables change, so a client registering while
 * an admin sits on a page shows up without a manual reload. Realtime here is
 * a nudge to re-fetch, never the source of the numbers.
 */
export function NotificationsMenu({ counts }: { counts: PendingCounts }) {
  const router = useRouter();
  const { d } = useI18n();

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Coalesce bursts: approving five accounts fires five events, and each
    // refresh() is a full server round-trip.
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 400);
    };

    const supabase = createClient();
    const channel = supabase
      .channel("admin-approvals")
      .on("postgres_changes", { event: "*", schema: "public", table: "portal_clients" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "ad_accounts" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "account_requests" }, refresh)
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  const rows: { icon: LucideIcon; label: string; help: string; count: number }[] = [
    {
      icon: UserPlus,
      label: d.notifications.newClients,
      help: d.notifications.newClientsHelp,
      count: counts.clients,
    },
    {
      icon: Store,
      label: d.notifications.pendingAccounts,
      help: d.notifications.pendingAccountsHelp,
      count: counts.accounts,
    },
    {
      icon: Ticket,
      label: d.notifications.pendingRequests,
      help: d.notifications.pendingRequestsHelp,
      count: counts.requests,
    },
  ].filter((row) => row.count > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={d.notifications.open}
        className="transition-smooth relative rounded-md p-1.5 text-[var(--text-secondary)] outline-none hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30 data-[state=open]:bg-[var(--bg-panel)]"
      >
        <Bell className="size-4" aria-hidden />
        {counts.total > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex min-w-[15px] items-center justify-center rounded-full bg-[var(--accent-gold)] px-1 text-[9px] font-semibold text-[var(--bg-base)]"
            aria-label={fmt(d.notifications.awaitingApproval, { count: counts.total })}
          >
            {counts.total > 9 ? "9+" : counts.total}
          </span>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[280px]">
        <div className="flex items-baseline justify-between gap-2 px-2.5 py-2.5">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            {d.notifications.title}
          </p>
          {counts.total > 0 && (
            <span className="text-[11.5px] text-[var(--text-muted)]">
              {fmt(d.notifications.awaitingApproval, { count: counts.total })}
            </span>
          )}
        </div>

        <DropdownMenuSeparator />

        {rows.length === 0 ? (
          <p className="px-2.5 py-4 text-center text-[12.5px] text-[var(--text-muted)]">
            {d.notifications.empty}
          </p>
        ) : (
          rows.map((row) => (
            <DropdownMenuItem key={row.label} asChild>
              <Link href="/admin/clients" className="items-start gap-2.5">
                <row.icon className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-[var(--text-primary)]">
                    {row.count} · {row.label}
                  </span>
                  <span className="block text-[11.5px] text-[var(--text-muted)]">{row.help}</span>
                </span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
