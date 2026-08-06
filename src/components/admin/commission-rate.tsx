import { Percent, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Read-only commercial rate. Pricing is client-wide and may change only via
 * an append-only manual referral decision in /admin/referrals; a store row is
 * never allowed to rewrite its own list rate, discount or revenue share.
 */
export function CommissionRate({
  rate,
  listRate,
  revenueShareEnabled = false,
  revenueShareRate = 0,
}: {
  rate: number;
  listRate: number;
  /** Legacy pricing flag — hard-blocks automatic weekly fee billing. */
  revenueShareEnabled?: boolean;
  /** Tracked collection revenue share; billed separately, never blocks fees. */
  revenueShareRate?: number;
}) {
  const discount = Math.max(0, listRate - rate);
  const legacyContract = listRate !== 10 || revenueShareEnabled;

  return (
    <div
      className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1"
      title="Commercial pricing is controlled by append-only manual referral terms"
    >
      <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
        <Percent className="size-3 text-[var(--text-muted)]" aria-hidden />
        {discount > 0 && (
          <span className="text-[var(--text-muted)] line-through">{listRate}%</span>
        )}
        {rate}% agency fee
      </span>
      {revenueShareRate > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-gold)]/10 px-1.5 py-0.5 text-[10.5px] leading-none font-medium text-[var(--accent-gold)]">
          +{revenueShareRate}% rev share
        </span>
      )}
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] leading-none font-medium",
          legacyContract
            ? "bg-[var(--warning-orange)]/15 text-[var(--warning-orange)]"
            : "bg-[var(--success-green)]/10 text-[var(--success-green)]",
        )}
      >
        <ShieldCheck className="size-2.5" aria-hidden />
        {legacyContract
          ? "legacy contract — billing blocked"
          : discount > 0
            ? `${discount} pp manual referral`
            : "manual terms"}
      </span>
    </div>
  );
}
