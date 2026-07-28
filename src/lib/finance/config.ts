import type {
  ClientStatus,
  Commission,
  CommissionStatus,
  CrmClient,
  ExpenseCategory,
  SourceCategory,
} from "@/lib/supabase/types";
import type { Dictionary } from "@/lib/i18n";

/**
 * How the HST sync records who a commission is for: `HST · <client>`.
 *
 * HST names a shop as `CODE-store-client` ("AZL90266-РАЯ НИКОЛОВА-Tomas"), so
 * the client name exists only inside that string — most of those people have
 * no CRM record here, and the ledger row's client_id is null. The name still
 * travels on the row, and this prefix is what lets the tables show it instead
 * of "no client". Writer (lib/admin/hst) and readers share this constant so
 * the two can never drift apart.
 */
export const HST_NOTE_PREFIX = "HST · ";
export const GOOGLE_ADS_NOTE_PREFIX = "Google Ads · ";
export const REV_SHARE_NOTE_PREFIX = "Revenue share · ";

/**
 * Synced rows name their client in the note, because they have nowhere else to
 * put it: `client_id` points at the CRM `clients` table, and a portal client is
 * only linked to one if somebody set `crm_client_id` by hand.
 *
 * Every prefix below is followed by the client's name, optionally then
 * " — <detail>" (the store, for the ad sources). HST rows carry the name alone,
 * which is why the split is on the separator rather than a fixed length.
 */
const CLIENT_NOTE_PREFIXES = [
  HST_NOTE_PREFIX,
  GOOGLE_ADS_NOTE_PREFIX,
  REV_SHARE_NOTE_PREFIX,
] as const;

/** Detail after the client's name in a synced note. */
export const NOTE_DETAIL_SEPARATOR = " — ";

/** The client name a synced row carries, or null when it names nobody. */
export function noteClientName(notes: string | null): string | null {
  if (!notes) return null;

  for (const prefix of CLIENT_NOTE_PREFIXES) {
    if (!notes.startsWith(prefix)) continue;

    const name = notes.slice(prefix.length).split(NOTE_DETAIL_SEPARATOR)[0].trim();

    // A note whose name segment is empty — or which runs straight into the
    // detail dash — names nobody. Returning it would show the STORE as the
    // client, which reads as real data and is not.
    if (!name || name.startsWith("—")) return null;
    return name;
  }
  return null;
}

/**
 * What to show in a commission's "client" column: the CRM record when the row
 * is linked to one, else the name the source itself reported, else `fallback`.
 */
export function commissionClientLabel(
  entry: Pick<Commission, "client_id" | "notes">,
  clients: CrmClient[],
  fallback: string,
): string {
  if (entry.client_id) {
    return clients.find((client) => client.id === entry.client_id)?.name ?? "—";
  }
  return noteClientName(entry.notes) ?? fallback;
}

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
