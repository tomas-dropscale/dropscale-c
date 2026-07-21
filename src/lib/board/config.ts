import type { Priority } from "@/lib/supabase/types";
import type { Dictionary } from "@/lib/i18n";

export const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

export function priorityLabel(d: Dictionary, priority: Priority) {
  return d.board.priority[priority];
}

/** Priority badge classes — grey → gold → orange → red. */
export const PRIORITY_BADGE: Record<Priority, string> = {
  low: "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
  medium: "border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]",
  high: "border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/12 text-[var(--warning-orange)]",
  urgent: "border-[var(--danger-red)]/35 bg-[var(--danger-red)]/14 text-[var(--danger-red)]",
};

/** Colour dot used in the filter dropdowns. */
export const PRIORITY_DOT: Record<Priority, string> = {
  low: "bg-[var(--text-muted)]",
  medium: "bg-[var(--accent-gold)]",
  high: "bg-[var(--warning-orange)]",
  urgent: "bg-[var(--danger-red)]",
};

/**
 * Label suggestions. Deliberately not translated: labels are data the team
 * types and shares, so translating them would split one tag into two.
 */
export const SUGGESTED_LABELS = [
  "bug",
  "feature",
  "campaign",
  "client",
  "creatives",
  "tracking",
  "copy",
  "reporting",
] as const;
