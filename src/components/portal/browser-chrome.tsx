"use client";

import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * Decorative "browser window" frame around the whole app. The traffic lights
 * and address bar are cosmetic (aria-hidden); the `left` and `right` slots are
 * genuinely interactive — the menu and the user menu live in them.
 *
 * On a phone the dressing steps aside. A 375px row cannot afford three dots
 * and a truncated address that says "dro…", so below the md breakpoint the
 * corners go to the two controls that are actually used: the menu on the left,
 * where a thumb reaches for it, and the account on the right.
 */
export function BrowserChrome({
  address,
  left,
  right,
  children,
  className,
}: {
  address: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // The window frame is a desktop conceit. On a phone the border, the
        // radius and the gutter around them only narrow an already narrow
        // column, so the app goes edge to edge and the frame returns at md.
        "flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]",
        "md:rounded-[var(--radius-window)] md:border md:border-[var(--border-subtle)]",
        className,
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 sm:gap-3 sm:px-4">
        {left && <div className="flex shrink-0 items-center md:hidden">{left}</div>}

        <div className="hidden shrink-0 items-center gap-[6px] md:flex" aria-hidden="true">
          <span className="size-[11px] rounded-full bg-[#e0605a]" />
          <span className="size-[11px] rounded-full bg-[#e0ae4a]" />
          <span className="size-[11px] rounded-full bg-[#5fb45f]" />
        </div>

        {/* The spacer stays on every width so the right slot keeps its corner;
            only the address itself is desktop-only. */}
        <div className="flex min-w-0 flex-1 justify-center" aria-hidden="true">
          <div className="hidden max-w-[280px] min-w-0 truncate rounded-full bg-[var(--bg-panel)] px-3.5 py-1 text-[11.5px] text-[var(--text-secondary)] md:block">
            {address}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 sm:gap-3">{right}</div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** "● LIVE" indicator with a pulsing gold dot. */
export function LiveIndicator() {
  const { d } = useI18n();

  return (
    <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.08em] text-[var(--text-secondary)] uppercase">
      <span className="size-1.5 animate-pulse-gold rounded-full bg-[var(--accent-gold)]" />
      {d.banners.live}
    </span>
  );
}
