"use client";

import { usePathname } from "next/navigation";
import {
  BarChart3,
  BadgePercent,
  Clapperboard,
  FileText,
  LayoutGrid,
  Plug,
  Receipt,
  Settings,
  Store,
  Target,
  TrendingUp,
  Truck,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { SideNav, SideNavItem, SideNavLabel } from "@/components/ui/side-nav";
import { useI18n } from "@/lib/i18n/provider";
import type { Dictionary } from "@/lib/i18n";

type Item = {
  href: string;
  icon: LucideIcon;
  label: (d: Dictionary) => string;
  badge?: (d: Dictionary) => string;
};
type Group = { label: ((d: Dictionary) => string) | null; items: Item[] };

/**
 * Grouped so the day-to-day screens sit at the top and the finance module reads
 * as one block instead of being scattered through a flat list.
 */
const NAV_GROUPS: Group[] = [
  {
    label: null,
    items: [
      { href: "/admin", icon: LayoutGrid, label: (d) => d.nav.overview },
    ],
  },
  {
    label: (d) => d.nav.groupFinance,
    items: [
      // Revenue and the daily P&L are one screen: money in, then what it left
      // behind, then every transaction that produced it.
      { href: "/admin/revenue", icon: TrendingUp, label: (d) => d.nav.revenue },
      { href: "/admin/billing", icon: FileText, label: (d) => d.nav.billing },
      { href: "/admin/expenses", icon: Receipt, label: (d) => d.nav.expenses },
      // A brand name — the same word in every locale, so no dictionary entry.
      { href: "/admin/hst", icon: Truck, label: () => "HST" },
    ],
  },
  {
    label: (d) => d.nav.groupGrowth,
    items: [
      {
        href: "/admin/client-onboarding",
        icon: UserPlus,
        label: (d) => d.nav.clients,
      },
      { href: "/admin/referrals", icon: BadgePercent, label: () => "Referrals" },
    ],
  },
  {
    label: () => "Google",
    items: [
      { href: "/admin/campaigns", icon: Target, label: (d) => d.nav.campaigns },
      { href: "/admin/analytics", icon: BarChart3, label: (d) => d.nav.analytics },
      { href: "/admin/creatives", icon: Clapperboard, label: (d) => d.nav.creatives },
    ],
  },
  {
    // External stores linked only for internal audits. Kept apart from Growth
    // because these credentials never enter client metrics or billing.
    label: (d) => d.nav.groupAudit,
    items: [
      {
        href: "/admin/audit/connections",
        icon: Plug,
        label: (d) => d.nav.connections,
      },
    ],
  },
];

/**
 * Mirror of the portal sidebar's "Admin area" link. Every admin also holds a
 * portal_clients row, so this always has somewhere to land.
 */
const FOOTER_ITEMS: Item[] = [
  { href: "/dashboard", icon: Store, label: (d) => d.nav.clientArea },
  { href: "/admin/settings", icon: Settings, label: (d) => d.nav.settings },
];

export function Sidebar({
  pendingClients = 0,
  newCreatives = 0,
  onNavigate,
  activePath,
}: {
  pendingClients?: number;
  /** Client submissions nobody has reviewed yet (migration 0018). */
  newCreatives?: number;
  onNavigate?: () => void;
  /** Lets read-only visual previews highlight the production destination. */
  activePath?: string;
}) {
  const pathname = usePathname();
  const currentPath = activePath ?? pathname;
  const { d } = useI18n();

  // "/admin" only lights up on an exact match, otherwise every nested
  // route would mark it active too. "/dashboard" never matches in here.
  const isActive = (href: string) =>
    href === "/admin" ? currentPath === href : currentPath.startsWith(href);

  // Counts live on the screen that clears them: approvals on Clients, unreviewed
  // submissions on Creatives.
  const count = (href: string) =>
    href === "/admin/client-onboarding"
      ? pendingClients
      : href === "/admin/creatives"
        ? newCreatives
        : 0;

  const renderItem = ({ href, label, icon, badge: badgeLabel }: Item) => {
    const countBadge = count(href);
    const textBadge = badgeLabel?.(d);

    return (
      <SideNavItem
        key={href}
        href={href}
        icon={icon}
        label={label(d)}
        active={isActive(href)}
        onNavigate={onNavigate}
        trailing={
          textBadge ? (
            <span className="rounded-full border border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.04em] text-[var(--accent-gold-strong)] uppercase">
              {textBadge}
            </span>
          ) : countBadge > 0 ? (
            <span className="flex min-w-[18px] items-center justify-center rounded-full bg-[var(--accent-gold)] px-1 text-[10px] font-semibold text-[var(--bg-base)]">
              {countBadge > 9 ? "9+" : countBadge}
            </span>
          ) : undefined
        }
      />
    );
  };

  return (
    <SideNav label={d.nav.mainNav}>
      <div className="px-2">
        <Logo />
      </div>

      <div className="flex flex-1 flex-col gap-5">
        {NAV_GROUPS.map((group, index) => (
          <div key={group.label?.(d) ?? `group-${index}`}>
            {group.label && <SideNavLabel>{group.label(d)}</SideNavLabel>}
            <ul className="flex flex-col gap-0.5">{group.items.map(renderItem)}</ul>
          </div>
        ))}
      </div>

      <ul className="flex flex-col gap-0.5">{FOOTER_ITEMS.map(renderItem)}</ul>
    </SideNav>
  );
}
