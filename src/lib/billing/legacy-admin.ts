import type { Invoice, InvoiceLine, InvoiceStatus } from "@/lib/supabase/types";

/**
 * The legacy admin screen intentionally has its own small contract. It reads
 * the columns that are already live without implying that the billing-v3
 * migrations (remaining balance, delivery proof, snapshots, PDFs, etc.) exist.
 */
export type LegacyAdminInvoice = {
  id: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  /** Current profile value; legacy invoices do not snapshot their recipient. */
  billingName: string | null;
  periodStart: string;
  periodEnd: string;
  amount: number | null;
  currency: string;
  status: InvoiceStatus;
  dueDate: string | null;
  lineItems: LegacyInvoiceLine[];
  stripeInvoiceId: string | null;
  stripeHostedUrl: string | null;
  hostedUrlInvalid: boolean;
  issuedAt: string | null;
  paidAt: string | null;
  paymentFailedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LegacyInvoiceLine = {
  label: string;
  amount: number | null;
};

export type LegacyClientIdentity = {
  id: string;
  full_name: string;
  email: string;
};

export type LegacyCurrencySummary = {
  currency: string;
  issuedCount: number;
  issuedAmount: number;
  outstandingCount: number;
  outstandingAmount: number;
  overdueCount: number;
  overdueAmount: number;
  paidCount: number;
  paidAmount: number;
  failedCount: number;
  failedAmount: number;
  draftCount: number;
  voidCount: number;
  uncollectibleCount: number;
};

export type LegacyBillingSummary = {
  totalCount: number;
  failedCount: number;
  invalidAmountCount: number;
  currencies: LegacyCurrencySummary[];
};

export type LegacyPeriodFilter =
  | "all"
  | "current-week"
  | "previous-week"
  | "current-month"
  | "previous-month";

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function currencyCode(value: unknown): string {
  if (typeof value !== "string") return "UNKNOWN";
  const normalized = value.trim().toUpperCase();
  return normalized || "UNKNOWN";
}

function normaliseLines(value: unknown): LegacyInvoiceLine[] {
  if (!Array.isArray(value)) return [];

  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      return { label: `Legacy line ${index + 1}`, amount: null };
    }

    const line = candidate as Partial<InvoiceLine> & Record<string, unknown>;
    return {
      label:
        typeof line.label === "string" && line.label.trim()
          ? line.label.trim()
          : `Legacy line ${index + 1}`,
      amount: finiteNumber(line.amount),
    };
  });
}

/** Only Stripe-owned HTTPS hosts are safe to expose as payment links. */
export function safeStripeHostedUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      (hostname !== "stripe.com" && !hostname.endsWith(".stripe.com"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function stripeDashboardInvoiceUrl(invoiceId: string | null): string | null {
  if (!invoiceId || !/^in_[A-Za-z0-9]+$/.test(invoiceId)) return null;
  return `https://dashboard.stripe.com/invoices/${encodeURIComponent(invoiceId)}`;
}

export function normaliseLegacyInvoice(
  invoice: Invoice,
  client: LegacyClientIdentity | undefined,
  billingName: string | null = null,
): LegacyAdminInvoice {
  const hostedUrl = safeStripeHostedUrl(invoice.stripe_hosted_url);

  return {
    id: invoice.id,
    clientId: invoice.client_id,
    clientName: client?.full_name?.trim() || "Unknown client",
    clientEmail: client?.email?.trim() || invoice.client_id,
    billingName: billingName?.trim() || null,
    periodStart: invoice.period_start,
    periodEnd: invoice.period_end,
    amount: finiteNumber(invoice.amount),
    currency: currencyCode(invoice.currency),
    status: invoice.status,
    dueDate: invoice.due_date,
    lineItems: normaliseLines(invoice.line_items as unknown),
    stripeInvoiceId: invoice.stripe_invoice_id,
    stripeHostedUrl: hostedUrl,
    hostedUrlInvalid: Boolean(invoice.stripe_hosted_url) && hostedUrl === null,
    issuedAt: invoice.issued_at,
    paidAt: invoice.paid_at,
    paymentFailedAt: invoice.payment_failed_at,
    createdAt: invoice.created_at,
    updatedAt: invoice.updated_at,
  };
}

export function isLegacyInvoiceOverdue(
  invoice: Pick<LegacyAdminInvoice, "status" | "dueDate">,
  today: string,
): boolean {
  return invoice.status === "open" && Boolean(invoice.dueDate) && invoice.dueDate! < today;
}

function isoUtcDay(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function legacyPeriodBounds(
  filter: Exclude<LegacyPeriodFilter, "all">,
  today: string,
): { from: string; to: string } {
  const [year, month, day] = today.split("-").map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day));

  if (filter === "current-week" || filter === "previous-week") {
    const weekday = (anchor.getUTCDay() + 6) % 7;
    const monday = new Date(anchor);
    monday.setUTCDate(anchor.getUTCDate() - weekday - (filter === "previous-week" ? 7 : 0));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return { from: isoUtcDay(monday), to: isoUtcDay(sunday) };
  }

  const targetMonth = filter === "previous-month" ? month - 2 : month - 1;
  const first = new Date(Date.UTC(year, targetMonth, 1));
  const last = new Date(Date.UTC(year, targetMonth + 1, 0));
  return { from: isoUtcDay(first), to: isoUtcDay(last) };
}

export function legacyInvoiceMatchesPeriod(
  invoice: Pick<LegacyAdminInvoice, "periodEnd">,
  filter: LegacyPeriodFilter,
  today: string,
): boolean {
  if (filter === "all") return true;
  const range = legacyPeriodBounds(filter, today);

  // Assign a weekly invoice to exactly one month: the one containing its
  // period end. An overlap rule would count a Jul 27–Aug 2 invoice in full in
  // both July and August and make the monthly totals misleading.
  return invoice.periodEnd >= range.from && invoice.periodEnd <= range.to;
}

function emptyCurrencySummary(currency: string): LegacyCurrencySummary {
  return {
    currency,
    issuedCount: 0,
    issuedAmount: 0,
    outstandingCount: 0,
    outstandingAmount: 0,
    overdueCount: 0,
    overdueAmount: 0,
    paidCount: 0,
    paidAmount: 0,
    failedCount: 0,
    failedAmount: 0,
    draftCount: 0,
    voidCount: 0,
    uncollectibleCount: 0,
  };
}

/**
 * Global nominal totals, kept separate per currency. An invalid amount still
 * counts as an invoice/status but is deliberately excluded from money totals.
 */
export function summariseLegacyInvoices(
  invoices: LegacyAdminInvoice[],
  today: string,
): LegacyBillingSummary {
  const byCurrency = new Map<string, LegacyCurrencySummary>();
  let failedCount = 0;
  let invalidAmountCount = 0;

  for (const invoice of invoices) {
    const bucket = byCurrency.get(invoice.currency) ?? emptyCurrencySummary(invoice.currency);
    byCurrency.set(invoice.currency, bucket);

    const amount = invoice.amount;
    if (amount === null) invalidAmountCount += 1;

    // `issued_at` is the strongest evidence the legacy schema has. It is not
    // delivery proof, and a later-voided invoice is excluded from this volume.
    if (invoice.issuedAt && invoice.status !== "void") {
      bucket.issuedCount += 1;
      if (amount !== null) bucket.issuedAmount += amount;
    }

    // A failed attempt remains operationally relevant even if the invoice was
    // later marked uncollectible/void. The legacy webhook only clears this
    // timestamp on successful payment, so the UI and KPI use the same rule.
    if (invoice.paymentFailedAt) {
      bucket.failedCount += 1;
      failedCount += 1;
      if (amount !== null) bucket.failedAmount += amount;
    }

    if (invoice.status === "open") {
      bucket.outstandingCount += 1;
      if (amount !== null) bucket.outstandingAmount += amount;

      if (isLegacyInvoiceOverdue(invoice, today)) {
        bucket.overdueCount += 1;
        if (amount !== null) bucket.overdueAmount += amount;
      }
    } else if (invoice.status === "paid") {
      bucket.paidCount += 1;
      if (amount !== null) bucket.paidAmount += amount;
    } else if (invoice.status === "draft") {
      bucket.draftCount += 1;
    } else if (invoice.status === "void") {
      bucket.voidCount += 1;
    } else if (invoice.status === "uncollectible") {
      bucket.uncollectibleCount += 1;
    }
  }

  const currencies = [...byCurrency.values()].sort((a, b) => {
    if (a.currency === "EUR") return -1;
    if (b.currency === "EUR") return 1;
    return a.currency.localeCompare(b.currency);
  });

  return { totalCount: invoices.length, failedCount, invalidAmountCount, currencies };
}
