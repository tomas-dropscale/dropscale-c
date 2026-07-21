import { getSessionClient } from "@/lib/supabase/server";
import { BrowserChrome, LiveIndicator } from "@/components/portal/browser-chrome";
import { SettingsNav } from "@/components/portal/settings-nav";
import { UserBadge } from "@/components/portal/user-menu";

/**
 * Settings section: same window chrome, but the main sidebar is replaced by
 * the section's own nav — mirroring the reference product.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { client } = await getSessionClient();
  if (!client) return null; // gate already handled this

  return (
    <div className="flex min-h-svh flex-col p-3 sm:p-4">
      <BrowserChrome
        address="portal.dropscale.app/dashboard/settings"
        right={
          <>
            <LiveIndicator />
            <UserBadge client={client} compact />
          </>
        }
      >
        <div className="flex min-h-0 flex-1">
          <SettingsNav />
          <main className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">{children}</main>
        </div>
      </BrowserChrome>
    </div>
  );
}
