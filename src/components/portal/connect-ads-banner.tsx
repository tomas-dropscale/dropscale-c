import Link from "next/link";
import { BarChart3, ArrowRight } from "lucide-react";

/**
 * Shown on a store view when Google Ads is configured but this store hasn't
 * been connected yet. It replaces what used to be silent demo data — the
 * numbers below it are real zeroes, and this explains why.
 */
export function ConnectAdsBanner() {
  return (
    <Link
      href="/dashboard/settings/accounts"
      className="transition-smooth flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] px-4 py-3.5 hover:border-[var(--accent-gold)]/50"
    >
      <BarChart3 className="size-4 shrink-0 text-[var(--accent-gold)]" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-semibold text-[var(--text-primary)]">
          This store isn&apos;t connected to Google Ads yet
        </span>
        <span className="block text-[12.5px] text-[var(--text-secondary)]">
          Connect it to see live campaigns and metrics. Until then, figures show zero.
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-[var(--accent-gold-strong)]">
        Connect
        <ArrowRight className="size-3.5" />
      </span>
    </Link>
  );
}
