"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const TAB =
  "transition-smooth rounded-full px-3.5 py-1 text-[12.5px] font-medium";
const TAB_ACTIVE = "bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]";
const TAB_IDLE = "text-[var(--text-secondary)] hover:text-[var(--text-primary)]";

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
  const { d } = useI18n();

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
        aria-label={collapsed ? d.portal.expandSidebar : d.portal.collapseSidebar}
        className="hidden md:inline-flex"
      >
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </Button>

      {/* The sidebar carries the brand; with it collapsed the topbar takes over. */}
      {collapsed && (
        <Link href="/dashboard" className="hidden md:block">
          <Logo size="sm" />
        </Link>
      )}

      <div className="flex flex-1 justify-center">
        <div className="flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-1">
          <Link href={performanceHref} className={cn(TAB, !onCreatives ? TAB_ACTIVE : TAB_IDLE)}>
            {d.portal.performance}
          </Link>

          {creativesHref ? (
            <Link href={creativesHref} className={cn(TAB, onCreatives ? TAB_ACTIVE : TAB_IDLE)}>
              {d.portal.creatives}
            </Link>
          ) : (
            <span
              className={cn(TAB, "cursor-not-allowed text-[var(--text-muted)]")}
              title={d.portal.creativesNeedStore}
            >
              {d.portal.creatives}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
