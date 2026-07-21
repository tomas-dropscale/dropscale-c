"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The one sidebar vocabulary, shared by the admin dashboard and the client
 * portal. Both areas belong to the same product, so an item has to look and
 * measure the same in either — that only holds if there is a single
 * definition of "nav item" rather than one per area.
 */

const ITEM_BASE =
  "transition-smooth flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13.5px]";

const ITEM_IDLE =
  "text-[var(--text-secondary)] hover:bg-[var(--bg-panel)]/60 hover:text-[var(--text-primary)]";

const ITEM_ACTIVE = "bg-[var(--bg-panel)] font-medium text-[var(--text-primary)]";

export function SideNav({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex h-full w-full flex-col gap-5 overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-5",
        className,
      )}
    >
      {children}
    </nav>
  );
}

export function SideNavLabel({ children }: { children: React.ReactNode }) {
  return <p className="label-caps mb-1.5 px-2.5">{children}</p>;
}

function Body({
  icon: Icon,
  active,
  children,
  trailing,
}: {
  icon: LucideIcon;
  active?: boolean;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <>
      <Icon
        size={17}
        strokeWidth={1.5}
        className={cn("shrink-0", active && "text-[var(--accent-gold)]")}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </>
  );
}

export function SideNavItem({
  href,
  icon,
  label,
  active = false,
  trailing,
  onNavigate,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  trailing?: React.ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <li>
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_IDLE)}
      >
        <Body icon={icon} active={active} trailing={trailing}>
          {label}
        </Body>
      </Link>
    </li>
  );
}

/** Same shape as a nav item, for entries that act rather than navigate. */
export function SideNavAction({
  icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button type="button" onClick={onClick} className={cn(ITEM_BASE, ITEM_IDLE)}>
        <Body icon={icon}>{label}</Body>
      </button>
    </li>
  );
}
