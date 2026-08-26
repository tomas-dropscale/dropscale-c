"use client";

import * as React from "react";
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

  /**
   * Creatives without a store used to be a dead tab: a title attribute, which
   * a touch screen never shows and a click never triggers, so the tab simply
   * did nothing and left the one thing the client DOES here unexplained. The
   * click now says why, out loud.
   */
  // Held against the page it was asked on, so navigating away retires it
  // without an effect that would have to chase the route.
  const [noticeFor, setNoticeFor] = React.useState<string | null>(null);
  const storeNeeded = noticeFor === pathname;
  React.useEffect(() => {
    if (!storeNeeded) return;
    const timer = setTimeout(() => setNoticeFor(null), 6_000);
    return () => clearTimeout(timer);
  }, [storeNeeded]);

  /**
   * The switch belongs to the dashboard and the store views it moves between —
   * nowhere else. On Costs, Payments or Request account it offered to navigate
   * away from the page you just opened, which is noise, not navigation.
   *
   * A whitelist rather than a blacklist: a section added later should stay
   * clean by default and opt in, not inherit a control that doesn't apply.
   */
  const showTabs =
    pathname === "/dashboard" || pathname === "/dashboard/google" || activeAccountId !== null;

  // Performance/Creatives are per-store views; without a store selected,
  // Performance falls back to the Google all-stores view and Creatives stays
  // disabled (as in the reference).
  const performanceHref = activeAccountId ? `/dashboard/${activeAccountId}` : "/dashboard/google";
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
        {showTabs && (
          <div className="relative flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-1">
            <Link href={performanceHref} className={cn(TAB, !onCreatives ? TAB_ACTIVE : TAB_IDLE)}>
              {d.portal.performance}
            </Link>

            {creativesHref ? (
              <Link href={creativesHref} className={cn(TAB, onCreatives ? TAB_ACTIVE : TAB_IDLE)}>
                {d.portal.creatives}
              </Link>
            ) : (
              <button
                type="button"
                aria-disabled
                onClick={() => setNoticeFor(pathname)}
                className={cn(TAB, "text-[var(--text-muted)] hover:text-[var(--text-secondary)]")}
              >
                {d.portal.creatives}
              </button>
            )}

            {storeNeeded && (
              <p
                role="status"
                className="absolute left-1/2 top-full z-30 mt-2 w-max max-w-[min(22rem,90vw)] -translate-x-1/2 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-2 text-center text-[12px] leading-relaxed text-[var(--text-secondary)] shadow-lg"
              >
                {d.portal.creativesNeedStore}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
