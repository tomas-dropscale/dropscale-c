import type {
  ClientStatus,
  CommissionStatus,
  ExpenseCategory,
  SourceCategory,
} from "@/lib/supabase/types";
import type { Dictionary } from "@/lib/i18n";

export const SOURCE_CATEGORIES: SourceCategory[] = [
  "platform",
  "supplier",
  "incorporation",
  "saas",
  "other",
];

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  "ads",
  "tools",
  "salaries",
  "contractors",
  "office",
  "taxes",
  "other",
];

export const COMMISSION_STATUSES: CommissionStatus[] = ["pending", "confirmed", "paid"];

export const CLIENT_STATUSES: ClientStatus[] = ["lead", "active", "paused", "churned"];

export function sourceCategoryLabel(d: Dictionary, category: SourceCategory) {
  return d.finance.sourceCategory[category];
}

export function expenseCategoryLabel(d: Dictionary, category: ExpenseCategory) {
  return d.finance.expenseCategory[category];
}

export function commissionStatusLabel(d: Dictionary, status: CommissionStatus) {
  return d.finance.commissionStatus[status];
}

/** Badge classes per commission status — pending is quiet, paid is green. */
export const COMMISSION_STATUS_BADGE: Record<CommissionStatus, string> = {
  pending: "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
  confirmed:
    "border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]",
  paid: "border-[var(--success-green)]/25 bg-[var(--success-green)]/12 text-[var(--success-green)]",
};

/**
 * Distinct tints for the revenue-by-source bars. Ordered so the biggest source
 * gets the strongest gold and the tail fades out — the ranking stays readable
 * without needing a legend.
 */
export const SOURCE_TINTS = [
  "#d4a86a",
  "#c2955c",
  "#a8814f",
  "#8e6d43",
  "#786038",
  "#63512f",
] as const;

export function sourceTint(index: number) {
  return SOURCE_TINTS[index % SOURCE_TINTS.length];
}

export const EXPENSE_TINTS: Record<ExpenseCategory, string> = {
  ads: "#c46a5f",
  tools: "#a8814f",
  salaries: "#8e6d43",
  contractors: "#786038",
  office: "#63512f",
  taxes: "#d98d54",
  other: "#565350",
};
