import { getSessionClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchPendingCounts } from "@/lib/admin/approvals";
import { BrowserChrome, LiveIndicator } from "@/components/portal/browser-chrome";
import { NotificationsMenu } from "@/components/admin/notifications-menu";
import { SettingsNav } from "@/components/portal/settings-nav";
import { UserBadge } from "@/components/portal/user-menu";

/**
 * Settings section: same window chrome, but the main sidebar is replaced by
 * the section's own nav — mirroring the reference product.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { client } = await getSessionClient();
  if (!client) return null; // gate already handled this

  // Same rule as the main shell: admins keep the approval bell in every zone.
  const { profile } = await getSessionProfile();
  const pending = profile?.role === "admin" ? await fetchPendingCounts() : null;

  return (
    <div className="flex h-svh flex-col p-2.5 md:p-5">
      <BrowserChrome
        address="dropscale.app/dashboard/settings"
        right={
          <>
            <LiveIndicator />
            <span className="h-4 w-px bg-[var(--border-subtle)]" aria-hidden />
            {pending && <NotificationsMenu counts={pending} />}
            <UserBadge client={client} />
          </>
        }
      >
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-[228px] shrink-0 md:block">
            <SettingsNav />
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
        </div>
      </BrowserChrome>
    </div>
  );
}
