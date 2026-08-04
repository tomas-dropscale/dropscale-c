import { AlertTriangle } from "lucide-react";

import type { CurrencyScope } from "@/lib/portal/currency";

/**
 * Says out loud that the totals above cannot be added up.
 *
 * Shown only when a client's stores trade in more than one currency. The
 * figures still render — a dashboard that blanked itself would be worse — but
 * they are sums of unlike quantities, and the one thing that must not happen is
 * for them to look ordinary.
 *
 * Deliberately not a conversion. Converting would need a rate, a rate needs a
 * date and a source, and a wrong rate is harder to notice than a warning.
 */
export function MixedCurrencyNotice({
  scope,
  className,
}: {
  scope: CurrencyScope;
  className?: string;
}) {
  if (!scope.mixed) return null;

  return (
    <div
      className={`flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/10 px-4 py-3 ${className ?? ""}`}
    >
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-[var(--warning-orange)]"
        aria-hidden
      />
      <div>
        <p className="text-[13px] font-semibold text-[var(--text-primary)]">
          These stores trade in {scope.currencies.join(", ")}
        </p>
        <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          Totals below add those amounts together without converting them, so they are
          not a real figure in any single currency. Pick one store to see numbers you
          can rely on.
        </p>
      </div>
    </div>
  );
}
