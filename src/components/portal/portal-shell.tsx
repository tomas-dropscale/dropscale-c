"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import type { AdAccount, Client } from "@/lib/supabase/types";
import { BrowserChrome, LiveIndicator } from "@/components/portal/browser-chrome";
import { Sidebar } from "@/components/portal/sidebar";
import { Topbar } from "@/components/portal/topbar";
import { UserBadge } from "@/components/portal/user-menu";

/**
 * Holds the one piece of chrome state (sidebar collapsed) and derives the
 * currently-selected account from the URL, so sidebar and topbar stay in sync
 * without prop drilling through pages.
 */
export function PortalShell({
  client,
  accounts,
  children,
}: {
  client: Client;
  accounts: AdAccount[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const pathname = usePathname();

  // /dashboard/<uuid>[/creatives] → the uuid; anything else → null (All Stores)
  const activeAccountId = React.useMemo(() => {
    const segments = pathname.split("/").filter(Boolean);
    if (segments[0] !== "dashboard" || segments.length < 2) return null;
    const candidate = segments[1];
    return accounts.some((account) => account.id === candidate) ? candidate : null;
  }, [pathname, accounts]);

  return (
    <div className="flex min-h-svh flex-col p-3 sm:p-4">
      <BrowserChrome
        address="portal.dropscale.app/dashboard"
        right={
          <>
            <LiveIndicator />
            <UserBadge client={client} compact />
          </>
        }
      >
        <div className="flex min-h-0 flex-1">
          {!collapsed && (
            <Sidebar client={client} accounts={accounts} activeAccountId={activeAccountId} />
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar
              collapsed={collapsed}
              onToggleSidebar={() => setCollapsed((value) => !value)}
              activeAccountId={activeAccountId}
            />
            <main className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">
              {children}
            </main>
          </div>
        </div>
      </BrowserChrome>
    </div>
  );
}
