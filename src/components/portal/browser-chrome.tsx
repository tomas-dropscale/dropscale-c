import { cn } from "@/lib/utils";

/**
 * Decorative "browser window" frame around the whole app. The traffic lights
 * and address bar are cosmetic (aria-hidden); the `right` slot is genuinely
 * interactive — that is where the user menu lives.
 */
export function BrowserChrome({
  address,
  right,
  children,
  className,
}: {
  address: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-window)] border border-[var(--border-subtle)] bg-[var(--bg-base)]",
        className,
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4">
        <div className="flex shrink-0 items-center gap-[6px]" aria-hidden="true">
          <span className="size-[11px] rounded-full bg-[#e0605a]" />
          <span className="size-[11px] rounded-full bg-[#e0ae4a]" />
          <span className="size-[11px] rounded-full bg-[#5fb45f]" />
        </div>

        <div className="flex min-w-0 flex-1 justify-center" aria-hidden="true">
          <div className="max-w-[280px] min-w-0 truncate rounded-full bg-[var(--bg-panel)] px-3.5 py-1 text-[11.5px] text-[var(--text-secondary)]">
            {address}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3">{right}</div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** "● LIVE" indicator with a pulsing gold dot. */
export function LiveIndicator() {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.08em] text-[var(--text-secondary)] uppercase">
      <span className="size-1.5 animate-pulse-gold rounded-full bg-[var(--accent-gold)]" />
      Live
    </span>
  );
}
