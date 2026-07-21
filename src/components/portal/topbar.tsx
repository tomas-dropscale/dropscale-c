"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HelpCircle, LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/components/portal/user-menu";
import { cn } from "@/lib/utils";

export function Topbar({
  collapsed,
  onToggleSidebar,
  activeAccountId,
}: {
  collapsed: boolean;
  onToggleSidebar: () => void;
  activeAccountId: string | null;
}) {
  const pathname = usePathname();
  const signOut = useSignOut();

  const onCreatives = pathname.endsWith("/creatives");

  // Performance/Creatives are per-store views; on All Stores the Creatives
  // tab has no store to show, so it stays disabled (as in the reference).
  const performanceHref = activeAccountId ? `/dashboard/${activeAccountId}` : "/dashboard";
  const creativesHref = activeAccountId ? `/dashboard/${activeAccountId}/creatives` : null;

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleSidebar}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </Button>

      <Link href="/dashboard" className="hidden sm:block">
        <Logo size="sm" />
      </Link>

      <div className="flex flex-1 justify-center">
        <div className="flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-1">
          <Link
            href={performanceHref}
            className={cn(
              "transition-smooth rounded-full px-3.5 py-1 text-[12.5px] font-medium",
              !onCreatives
                ? "bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
            )}
          >
            Performance
          </Link>

          {creativesHref ? (
            <Link
              href={creativesHref}
              className={cn(
                "transition-smooth rounded-full px-3.5 py-1 text-[12.5px] font-medium",
                onCreatives
                  ? "bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              Creatives
            </Link>
          ) : (
            <span
              className="cursor-not-allowed rounded-full px-3.5 py-1 text-[12.5px] font-medium text-[var(--text-muted)]"
              title="Select a store to see its creatives"
            >
              Creatives
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="Help" title="Help">
          <HelpCircle />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={signOut}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut />
        </Button>
      </div>
    </div>
  );
}
