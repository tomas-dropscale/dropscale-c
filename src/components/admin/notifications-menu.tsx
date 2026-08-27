"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Clapperboard, Store, Ticket, UserPlus, type LucideIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNotificationReadState } from "@/components/ui/use-notification-read-state";
import type { PendingCounts } from "@/lib/admin/approvals";
import { createClient } from "@/lib/supabase/client";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/**
 * Approval inbox in the admin chrome — LIVE.
 *
 * The rows use server counts on first paint. A small client-side ID read then
 * drives the badge, so opening it marks those exact items as read and only a
 * new fingerprint can light it again. Realtime events and a 60-second poll
 * keep both counts and fingerprints current.
 */
export function NotificationsMenu({ counts }: { counts: PendingCounts }) {
  const router = useRouter();
  const { d } = useI18n();

  // null until the first client-side count lands; the server value covers the gap.
  const [live, setLive] = React.useState<{
    counts: PendingCounts;
    fingerprints: string[];
  } | null>(null);
  const current = live?.counts ?? counts;
  const { unread, markRead } = useNotificationReadState(
    "dropscale:admin-notifications:v1",
    live?.fingerprints ?? [],
  );

  const recount = React.useCallback(async () => {
    const supabase = createClient();
    const [clients, accounts, requests, creatives] = await Promise.all([
      supabase
        .from("portal_clients")
        .select("id")
        .eq("approval_status", "pending"),
      // Only accounts a person can actually approve. The normalized reporting
      // rows are pending until billing starts, not until someone clicks; see
      // the note in fetchPendingCounts, which this must agree with exactly.
      supabase
        .from("ad_accounts")
        .select("id")
        .eq("status", "pending")
        .eq("reporting_role", "legacy_hybrid"),
      supabase
        .from("account_requests")
        .select("id")
        .eq("status", "pending"),
      supabase
        .from("creative_submissions")
        .select("id")
        .eq("status", "new"),
    ]);

    const clientIds = (clients.data ?? []).map((row) => `client:${row.id}`);
    const accountIds = (accounts.data ?? []).map((row) => `account:${row.id}`);
    const requestIds = (requests.data ?? []).map((row) => `request:${row.id}`);
    const creativeIds = (creatives.data ?? []).map((row) => `creative:${row.id}`);
    const next = {
      clients: clientIds.length,
      accounts: accountIds.length,
      requests: requestIds.length,
      creatives: creativeIds.length,
    };
    setLive({
      counts: {
        ...next,
        total: next.clients + next.accounts + next.requests + next.creatives,
      },
      fingerprints: [...clientIds, ...accountIds, ...requestIds, ...creativeIds],
    });
  }, []);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Realtime event → recount the badge at once, and (debounced) refresh the
    // server components so any open approval list updates too.
    const onEvent = () => {
      void recount();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 400);
    };

    const supabase = createClient();
    queueMicrotask(() => void recount());
    const channel = supabase
      .channel("admin-approvals")
      .on("postgres_changes", { event: "*", schema: "public", table: "portal_clients" }, onEvent)
      .on("postgres_changes", { event: "*", schema: "public", table: "ad_accounts" }, onEvent)
      .on("postgres_changes", { event: "*", schema: "public", table: "account_requests" }, onEvent)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "creative_submissions" },
        onEvent,
      )
      .subscribe();

    // Poll fallback: badge only (no page refresh), small ID-only queries.
    const interval = setInterval(() => void recount(), 60_000);

    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [router, recount]);

  // Each row carries its own destination: client identity in onboarding,
  // financial/account work in Billing, and submissions in Creatives.
  const rows: {
    icon: LucideIcon;
    label: string;
    help: string;
    count: number;
    href: string;
  }[] = [
    {
      icon: UserPlus,
      label: d.notifications.newClients,
      help: d.notifications.newClientsHelp,
      count: current.clients,
      href: "/admin/client-onboarding",
    },
    {
      icon: Store,
      label: d.notifications.pendingAccounts,
      help: d.notifications.pendingAccountsHelp,
      count: current.accounts,
      href: "/admin/billing#financial-operations",
    },
    {
      icon: Ticket,
      label: d.notifications.pendingRequests,
      help: d.notifications.pendingRequestsHelp,
      count: current.requests,
      href: "/admin/billing#financial-operations",
    },
    {
      icon: Clapperboard,
      label: d.notifications.newCreatives,
      help: d.notifications.newCreativesHelp,
      count: current.creatives,
      href: "/admin/creatives?status=new",
    },
  ].filter((row) => row.count > 0);

  return (
    <DropdownMenu onOpenChange={(open) => open && markRead()}>
      <DropdownMenuTrigger
        aria-label={d.notifications.open}
        className="transition-smooth relative rounded-md p-1.5 text-[var(--text-secondary)] outline-none hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30 data-[state=open]:bg-[var(--bg-panel)]"
      >
        <Bell className="size-4" aria-hidden />
        {unread && current.total > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex min-w-[15px] items-center justify-center rounded-full bg-[var(--accent-gold)] px-1 text-[9px] font-semibold text-[var(--bg-base)]"
            aria-label={fmt(d.notifications.awaitingApproval, { count: current.total })}
          >
            {current.total > 9 ? "9+" : current.total}
          </span>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[280px]">
        <div className="flex items-baseline justify-between gap-2 px-2.5 py-2.5">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            {d.notifications.title}
          </p>
          {current.total > 0 && (
            <span className="text-[11.5px] text-[var(--text-muted)]">
              {fmt(d.notifications.awaitingApproval, { count: current.total })}
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
              <Link href={row.href} className="items-start gap-2.5">
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
