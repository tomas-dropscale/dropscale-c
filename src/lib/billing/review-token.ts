import type {
  BillingRecipientSnapshot,
  Commission,
  InvoiceLine,
} from "../supabase/types";
import { BILLING_CURRENCY, CALCULATION_VERSION, round2 } from "./weekly";

type ReviewLedgerRow = Pick<
  Commission,
  "id" | "ad_account_id" | "gross_amount" | "currency" | "occurred_on"
>;

export type { BillingRecipientSnapshot } from "../supabase/types";

const RECIPIENT_KEYS = [
  "email",
  "fallbackName",
  "billingName",
  "taxId",
  "addressLine1",
  "addressLine2",
  "addressCity",
  "addressPostalCode",
  "addressState",
  "addressCountry",
] as const satisfies readonly (keyof BillingRecipientSnapshot)[];

function canonicalOptionalText(
  value: unknown,
  maxLength: number,
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength &&
      value.trim() === value)
  );
}

/** Runtime mirror of the database's exact v3 recipient JSON contract. */
export function parseBillingRecipientSnapshot(
  value: unknown,
): BillingRecipientSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== RECIPIENT_KEYS.length ||
    RECIPIENT_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key),
    )
  ) {
    return null;
  }
  if (
    typeof record.email !== "string" ||
    record.email.trim() !== record.email ||
    record.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email) ||
    typeof record.fallbackName !== "string" ||
    record.fallbackName.trim() !== record.fallbackName ||
    record.fallbackName.length === 0 ||
    record.fallbackName.length > 200 ||
    !canonicalOptionalText(record.billingName, 120) ||
    !canonicalOptionalText(record.taxId, 30) ||
    !canonicalOptionalText(record.addressLine1, 500) ||
    !canonicalOptionalText(record.addressLine2, 500) ||
    !canonicalOptionalText(record.addressCity, 200) ||
    !canonicalOptionalText(record.addressPostalCode, 100) ||
    !canonicalOptionalText(record.addressState, 200) ||
    !canonicalOptionalText(record.addressCountry, 2) ||
    (record.addressCountry !== null &&
      !/^[A-Z]{2}$/.test(record.addressCountry))
  ) {
    return null;
  }
  return record as BillingRecipientSnapshot;
}

export function requireBillingRecipientSnapshot(
  value: unknown,
): BillingRecipientSnapshot {
  const recipient = parseBillingRecipientSnapshot(value);
  if (!recipient) {
    throw new Error(
      "The invoice has no valid immutable billing-recipient snapshot.",
    );
  }
  return recipient;
}

function canonicalGrossAmount(value: string | number): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value).trim());
  if (!match)
    throw new Error("Billing review received an invalid Google spend amount.");
  return `${BigInt(match[1]).toString()}.${(match[2] ?? "").padEnd(6, "0")}`;
}

function stableLines(lines: InvoiceLine[]) {
  return [...lines]
    .map((line) => ({
      accountId: line.accountId,
      kind: line.kind ?? null,
      store: line.store ?? null,
      rate: line.rate ?? null,
      pricingMode: line.pricingMode ?? null,
      commissionTermId: line.commissionTermId ?? null,
      listRate: line.listRate ?? null,
      referralDiscountRate: line.referralDiscountRate ?? null,
      referralCount: line.referralCount ?? null,
      baseAmount: line.baseAmount ?? null,
      sourceGrossAmount: line.sourceGrossAmount ?? null,
      baselineDeductionAmount: line.baselineDeductionAmount ?? null,
      billingStartBaselineAmount: line.billingStartBaselineAmount ?? null,
      billingStartId: line.billingStartId ?? null,
      billingStartDate: line.billingStartDate ?? null,
      billingStartedAt: line.billingStartedAt ?? null,
      billingTimeZone: line.billingTimeZone ?? null,
      endDeductionAmount: line.endDeductionAmount ?? null,
      endingCapApplied: line.endingCapApplied ?? null,
      billingEndCounterAmount: line.billingEndCounterAmount ?? null,
      billingEndId: line.billingEndId ?? null,
      billingEndDate: line.billingEndDate ?? null,
      billingEndedAt: line.billingEndedAt ?? null,
      billingEndTimeZone: line.billingEndTimeZone ?? null,
      label: line.label,
      amount: Number(line.amount),
    }))
    .sort((a, b) =>
      `${a.accountId ?? ""}\u0000${a.kind ?? ""}\u0000${a.label}`.localeCompare(
        `${b.accountId ?? ""}\u0000${b.kind ?? ""}\u0000${b.label}`,
      ),
    );
}

/** Bind an admin confirmation to every value that can change an Invoice. */
export async function billingReviewToken(input: {
  clientId: string;
  week: { start: string; end: string };
  amount: number;
  lines: InvoiceLine[];
  ledgerRows: ReviewLedgerRow[];
  /** The immutable manual commercial snapshot, including its sealed items. */
  referralTermId: string | null;
  /** Prevent a profile edit from changing who receives an approved invoice. */
  recipient: BillingRecipientSnapshot;
  /** A retry binds to the immutable local invoice instead of today's ledger. */
  invoiceId?: string;
}): Promise<string> {
  const payload = JSON.stringify({
    clientId: input.clientId,
    periodStart: input.week.start,
    periodEnd: input.week.end,
    currency: BILLING_CURRENCY,
    calculationVersion: CALCULATION_VERSION,
    amount: round2(input.amount),
    referralTermId: input.referralTermId,
    recipient: input.recipient,
    invoiceId: input.invoiceId ?? null,
    lines: stableLines(input.lines),
    ledgerRows: input.invoiceId
      ? []
      : [...input.ledgerRows]
          .map((row) => ({
            id: row.id,
            accountId: row.ad_account_id,
            occurredOn: row.occurred_on,
            grossAmount: canonicalGrossAmount(row.gross_amount),
            currency: row.currency.toUpperCase(),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
