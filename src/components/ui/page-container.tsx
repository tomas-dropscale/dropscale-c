import { cn } from "@/lib/utils";

/**
 * Standard page frame for both the admin dashboard and the client portal: owns
 * vertical scroll, page padding, and the title/description/actions header, so
 * every screen in the product lines up on the same grid.
 *
 * The Board is the one exception — it manages its own horizontal scroll.
 */
export function PageContainer({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-7", className)}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold tracking-tight text-[var(--text-primary)]">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {children}
    </div>
  );
}
