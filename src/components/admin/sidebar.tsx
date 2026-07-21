"use client";

import { usePathname } from "next/navigation";
import {
  BarChart3,
  KanbanSquare,
  LayoutGrid,
  Receipt,
  Settings,
  Store,
  Target,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { SideNav, SideNavItem, SideNavLabel } from "@/components/ui/side-nav";
import { useI18n } from "@/lib/i18n/provider";
import type { Dictionary } from "@/lib/i18n";

type Item = { href: string; icon: LucideIcon; label: (d: Dictionary) => string };
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
      { href: "/admin/board", icon: KanbanSquare, label: (d) => d.nav.board },
    ],
  },
  {
    label: (d) => d.nav.groupFinance,
    items: [
      { href: "/admin/revenue", icon: TrendingUp, label: (d) => d.nav.revenue },
      { href: "/admin/expenses", icon: Receipt, label: (d) => d.nav.expenses },
      { href: "/admin/profit", icon: Wallet, label: (d) => d.nav.profit },
    ],
  },
  {
    label: (d) => d.nav.groupGrowth,
    items: [
      { href: "/admin/clients", icon: UserCheck, label: (d) => d.nav.clients },
      { href: "/admin/campaigns", icon: Target, label: (d) => d.nav.campaigns },
      { href: "/admin/leads", icon: Users, label: (d) => d.nav.leads },
      { href: "/admin/analytics", icon: BarChart3, label: (d) => d.nav.analytics },
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
  onNavigate,
}: {
  pendingClients?: number;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { d } = useI18n();

  // "/admin" only lights up on an exact match, otherwise every nested
  // route would mark it active too. "/dashboard" never matches in here.
  const isActive = (href: string) =>
    href === "/admin" ? pathname === href : pathname.startsWith(href);

  const renderItem = ({ href, label, icon }: Item) => (
    <SideNavItem
      key={href}
      href={href}
      icon={icon}
      label={label(d)}
      active={isActive(href)}
      onNavigate={onNavigate}
      // Clients is where approvals are handled, so it carries the count.
      trailing={
        href === "/admin/clients" && pendingClients > 0 ? (
          <span className="flex min-w-[18px] items-center justify-center rounded-full bg-[var(--accent-gold)] px-1 text-[10px] font-semibold text-[var(--bg-base)]">
            {pendingClients > 9 ? "9+" : pendingClients}
          </span>
        ) : undefined
      }
    />
  );

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
