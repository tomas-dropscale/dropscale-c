"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { AlertCircle, Boxes, Gauge, LayoutGrid, Plus, ShieldCheck, Store, UserPlus } from "lucide-react";

import type { AdAccount, Client } from "@/lib/supabase/types";
import { AddAccountModal } from "@/components/portal/add-account-modal";
import { Logo } from "@/components/brand/logo";
import { SideNav, SideNavAction, SideNavItem, SideNavLabel } from "@/components/ui/side-nav";
import { useI18n } from "@/lib/i18n/provider";

export function Sidebar({
  client,
  accounts,
  activeAccountId,
  isAdmin = false,
  onNavigate,
}: {
  client: Client;
  accounts: AdAccount[];
  activeAccountId: string | null;
  isAdmin?: boolean;
  onNavigate?: () => void;
}) {
  const { d } = useI18n();
  const pathname = usePathname();
  const [addOpen, setAddOpen] = React.useState(false);

  return (
    <SideNav label={d.nav.mainNav}>
      <div className="px-2">
        <Logo />
      </div>

      <div className="flex flex-1 flex-col gap-5">
        {/* The client's home: revenue/profit overview. */}
        <ul className="flex flex-col gap-0.5">
          <SideNavItem
            href="/dashboard"
            icon={Gauge}
            label={d.portal.dashboard}
            active={pathname === "/dashboard"}
            onNavigate={onNavigate}
          />
          <SideNavItem
            href="/dashboard/costs"
            icon={Boxes}
            label={d.portal.cogs}
            active={pathname === "/dashboard/costs"}
            onNavigate={onNavigate}
          />
        </ul>

        {/* Google section: all stores + one entry per store. */}
        <div>
          <SideNavLabel>{d.portal.googleGroup}</SideNavLabel>

          <ul className="flex flex-col gap-0.5">
            <SideNavItem
              href="/dashboard/google"
              icon={LayoutGrid}
              label={d.portal.allStores}
              active={pathname === "/dashboard/google"}
              onNavigate={onNavigate}
            />

            {accounts.map((account) => (
              <SideNavItem
                key={account.id}
                href={`/dashboard/${account.id}`}
                icon={Store}
                label={account.store_name}
                active={activeAccountId === account.id}
                onNavigate={onNavigate}
                trailing={
                  account.status === "suspended" ? (
                    <AlertCircle
                      className="size-3.5 shrink-0 text-[var(--warning-orange)]"
                      aria-label={d.portal.accountSuspended}
                    />
                  ) : account.status === "pending" ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-[var(--warning-orange)]"
                      aria-label={d.portal.accountPending}
                    />
                  ) : undefined
                }
              />
            ))}
          </ul>
        </div>

        <ul className="flex flex-col gap-0.5">
          <SideNavAction icon={Plus} label={d.portal.addAccount} onClick={() => setAddOpen(true)} />
          <SideNavItem
            href="/dashboard/request-account"
            icon={UserPlus}
            label={d.portal.requestAccount}
            onNavigate={onNavigate}
          />
        </ul>
      </div>

      {isAdmin && (
        <ul className="flex flex-col gap-0.5">
          <SideNavItem
            href="/admin"
            icon={ShieldCheck}
            label={d.portal.adminArea}
            onNavigate={onNavigate}
          />
        </ul>
      )}

      <AddAccountModal open={addOpen} onOpenChange={setAddOpen} clientId={client.id} />
    </SideNav>
  );
}
