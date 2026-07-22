"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import type { AdAccount, Client } from "@/lib/supabase/types";
import type { PendingCounts } from "@/lib/admin/approvals";
import { BrowserChrome, LiveIndicator } from "@/components/portal/browser-chrome";
import { NotificationsMenu } from "@/components/admin/notifications-menu";
import { Sidebar } from "@/components/portal/sidebar";
import { Topbar } from "@/components/portal/topbar";
import { UserBadge } from "@/components/portal/user-menu";
import { useI18n } from "@/lib/i18n/provider";

/**
 * Holds the one piece of chrome state (sidebar collapsed) and derives the
 * currently-selected account from the URL, so sidebar and topbar stay in sync
 * without prop drilling through pages.
 *
 * Structure deliberately mirrors the admin DashboardShell — same frame, same
 * breakpoints, same mobile drawer — so the two areas feel like one product.
 */
export function PortalShell({
  client,
  accounts,
  isAdmin = false,
  pending = null,
  children,
}: {
  client: Client;
  accounts: AdAccount[];
  isAdmin?: boolean;
  /** Approval counts — only supplied when the viewer is staff-admin. */
  pending?: PendingCounts | null;
  children: React.ReactNode;
}) {
  const { d } = useI18n();
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const pathname = usePathname();

  // /dashboard/<uuid>[/creatives] → the uuid; anything else → null (All Stores)
  const activeAccountId = React.useMemo(() => {
    const segments = pathname.split("/").filter(Boolean);
    if (segments[0] !== "dashboard" || segments.length < 2) return null;
    const candidate = segments[1];
    return accounts.some((account) => account.id === candidate) ? candidate : null;
  }, [pathname, accounts]);

  const sidebar = (onNavigate?: () => void) => (
    <Sidebar
      client={client}
      accounts={accounts}
      activeAccountId={activeAccountId}
      isAdmin={isAdmin}
      onNavigate={onNavigate}
    />
  );

  return (
    <div className="flex h-svh flex-col p-2.5 md:p-5">
      <BrowserChrome
        address={`dropscale.app${pathname}`}
        right={
          <>
            <LiveIndicator />
            <span className="h-4 w-px bg-[var(--border-subtle)]" aria-hidden />
            {/* Admins keep sight of the approval queue even while in the
                client zone — the zone scopes DATA, not their duties. */}
            {isAdmin && pending && <NotificationsMenu counts={pending} />}
            <UserBadge client={client} />

            <DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <DialogPrimitive.Trigger
                aria-label={d.nav.openMenu}
                className="transition-smooth rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)] md:hidden"
              >
                <Menu className="size-4" />
              </DialogPrimitive.Trigger>

              <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 md:hidden" />
                <DialogPrimitive.Content
                  className="fixed inset-y-0 left-0 z-50 w-[240px] outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left md:hidden"
                  aria-describedby={undefined}
                >
                  <DialogPrimitive.Title className="sr-only">
                    {d.nav.navigation}
                  </DialogPrimitive.Title>
                  {sidebar(() => setMobileNavOpen(false))}
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            </DialogPrimitive.Root>
          </>
        }
      >
        <div className="flex min-h-0 flex-1">
          {!collapsed && (
            <aside className="hidden w-[228px] shrink-0 md:block">{sidebar()}</aside>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Topbar
              collapsed={collapsed}
              onToggleSidebar={() => setCollapsed((value) => !value)}
              activeAccountId={activeAccountId}
            />
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
          </div>
        </div>
      </BrowserChrome>
    </div>
  );
}
