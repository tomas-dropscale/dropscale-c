"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Store, UserCog } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/dashboard/settings", label: "Personal Settings", icon: UserCog },
  { href: "/dashboard/settings/accounts", label: "Google Ads Accounts", icon: Store },
];

/** Internal sidebar of the settings section — replaces the main app sidebar. */
export function SettingsNav() {
  const pathname = usePathname();

  return (
    <aside className="flex w-[240px] shrink-0 flex-col gap-0.5 border-r border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
      <Link
        href="/dashboard"
        className="transition-smooth mb-3 flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="size-4" />
        Back to Dashboard
      </Link>

      {ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "transition-smooth flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px]",
              active
                ? "bg-[var(--accent-gold-dim)] font-medium text-[var(--accent-gold-strong)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]",
            )}
          >
            <item.icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </aside>
  );
}
