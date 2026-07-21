"use client";

import * as React from "react";
import Link from "next/link";
import { AlertCircle, LayoutGrid, Plus, Store, Ticket, UserPlus } from "lucide-react";

import type { AdAccount, Client } from "@/lib/supabase/types";
import { AddAccountModal } from "@/components/portal/add-account-modal";
import { UserBadge } from "@/components/portal/user-menu";
import { cn } from "@/lib/utils";

function NavItem({
  href,
  active,
  children,
  className,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "transition-smooth flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px]",
        active
          ? "bg-[var(--accent-gold-dim)] font-medium text-[var(--accent-gold-strong)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function Sidebar({
  client,
  accounts,
  activeAccountId,
}: {
  client: Client;
  accounts: AdAccount[];
  activeAccountId: string | null;
}) {
  const [addOpen, setAddOpen] = React.useState(false);

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        <p className="label-caps px-2.5 pt-1 pb-2">Accounts</p>

        <NavItem href="/dashboard" active={activeAccountId === null}>
          <LayoutGrid className="size-4 shrink-0" />
          All Stores
        </NavItem>

        {accounts.map((account) => (
          <NavItem
            key={account.id}
            href={`/dashboard/${account.id}`}
            active={activeAccountId === account.id}
          >
            <Store className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{account.store_name}</span>
            {account.status === "suspended" && (
              <AlertCircle
                className="size-3.5 shrink-0 text-[var(--warning-orange)]"
                aria-label="Account suspended"
              />
            )}
            {account.status === "pending" && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-[var(--warning-orange)]"
                aria-label="Account pending"
              />
            )}
          </NavItem>
        ))}

        <div className="mt-3 space-y-0.5 border-t border-[var(--border-subtle)] pt-3">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="transition-smooth flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
          >
            <Plus className="size-4 shrink-0" />
            Add Account
          </button>

          <NavItem href="/dashboard/request-account">
            <UserPlus className="size-4 shrink-0" />
            Request Account
          </NavItem>
        </div>
      </nav>

      <div className="shrink-0 space-y-1 border-t border-[var(--border-subtle)] p-3">
        {/* Support — placeholder destination for now */}
        <NavItem href="/dashboard/tickets">
          <Ticket className="size-4 shrink-0" />
          Tickets
        </NavItem>

        <UserBadge client={client} />
      </div>

      <AddAccountModal open={addOpen} onOpenChange={setAddOpen} clientId={client.id} />
    </aside>
  );
}
