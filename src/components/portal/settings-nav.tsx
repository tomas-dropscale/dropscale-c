"use client";

import { usePathname } from "next/navigation";
import { ArrowLeft, Gift, UserCog, Users } from "lucide-react";

import { SideNav, SideNavItem } from "@/components/ui/side-nav";
import { useI18n } from "@/lib/i18n/provider";

/** Internal sidebar of the settings section — replaces the main app sidebar. */
export function SettingsNav() {
  const pathname = usePathname();
  const { d } = useI18n();

  return (
    <SideNav label={d.nav.mainNav}>
      <ul className="flex flex-col gap-0.5">
        <SideNavItem href="/dashboard" icon={ArrowLeft} label={d.portal.backToDashboard} />
      </ul>

      <ul className="flex flex-1 flex-col gap-0.5">
        <SideNavItem
          href="/dashboard/settings"
          icon={UserCog}
          label={d.portal.personalSettings}
          active={pathname === "/dashboard/settings"}
        />
        <SideNavItem
          href="/dashboard/settings/team"
          icon={Users}
          label={d.team.title}
          active={pathname === "/dashboard/settings/team"}
        />
        <SideNavItem
          href="/dashboard/settings/affiliates"
          icon={Gift}
          label={d.referrals.navLabel}
          active={pathname === "/dashboard/settings/affiliates"}
        />
      </ul>
    </SideNav>
  );
}
