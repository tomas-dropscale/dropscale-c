"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { BrowserChrome, LiveIndicator } from "@/components/portal/browser-chrome";
import { Sidebar } from "@/components/admin/sidebar";
import { UserMenu } from "@/components/admin/user-menu";
import { NotificationsMenu } from "@/components/admin/notifications-menu";
import { RoleWatcher } from "@/components/admin/role-watcher";
import type { PendingCounts } from "@/lib/admin/approvals";
import { useI18n } from "@/lib/i18n/provider";
import type { Profile } from "@/lib/supabase/types";

export function DashboardShell({
  profile,
  pending,
  children,
}: {
  profile: Profile;
  pending: PendingCounts;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { d } = useI18n();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  return (
    <div className="flex h-svh flex-col p-2.5 md:p-5">
      <RoleWatcher userId={profile.id} />
      <BrowserChrome
        address={`dropscale.app${pathname}`}
        right={
          <>
            <LiveIndicator />
            <span className="h-4 w-px bg-[var(--border-subtle)]" aria-hidden />
            <NotificationsMenu counts={pending} />
            <UserMenu profile={profile} />

            <DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <DialogPrimitive.Trigger
                aria-label={d.nav.openMenu}
                className="rounded-md p-1.5 text-[var(--text-secondary)] transition-smooth hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)] md:hidden"
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
                  <Sidebar
                    pendingClients={pending.clients}
                    onNavigate={() => setMobileNavOpen(false)}
                  />
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            </DialogPrimitive.Root>
          </>
        }
      >
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-[228px] shrink-0 md:block">
            <Sidebar pendingClients={pending.clients} />
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
        </div>
      </BrowserChrome>
    </div>
  );
}
