import { describe, expect, it } from "vitest";

import {
  isLegacyInvoiceOverdue,
  legacyInvoiceMatchesPeriod,
  legacyPeriodBounds,
  normaliseLegacyInvoice,
  safeStripeHostedUrl,
  stripeDashboardInvoiceUrl,
  summariseLegacyInvoices,
  type LegacyAdminInvoice,
} from "./legacy-admin";
import type { Invoice } from "@/lib/supabase/types";

function source(over: Partial<Invoice> = {}): Invoice {
  return {
    id: "invoice-1",
    client_id: "client-1",
    period_start: "2026-07-27",
    period_end: "2026-08-02",
    amount: 100,
    currency: "EUR",
    status: "open",
    due_date: "2026-08-10",
    line_items: [],
    stripe_invoice_id: "in_123",
    stripe_hosted_url: "https://invoice.stripe.com/i/acct_test/abc",
    issued_at: "2026-08-03T09:00:00.000Z",
    paid_at: null,
    payment_failed_at: null,
    created_at: "2026-08-03T08:00:00.000Z",
    updated_at: "2026-08-03T09:00:00.000Z",
    ...over,
  };
}

function invoice(over: Partial<LegacyAdminInvoice> = {}): LegacyAdminInvoice {
  const normalised = normaliseLegacyInvoice(source(), {
    id: "client-1",
    full_name: "A Client",
    email: "client@example.com",
  });
  return { ...normalised, ...over };
}

describe("legacy invoice normalisation", () => {
  it("normalises numeric strings and legacy line data at the database boundary", () => {
    const row = source({
      amount: "123.45" as unknown as number,
      currency: "eur",
      line_items: [
        { label: "Management fee", amount: "12.34" as unknown as number, accountId: null },
      ],
    });

    expect(normaliseLegacyInvoice(row, undefined)).toMatchObject({
      amount: 123.45,
      currency: "EUR",
      clientName: "Unknown client",
      clientEmail: "client-1",
      billingName: null,
      lineItems: [{ label: "Management fee", amount: 12.34 }],
    });
  });

  it("keeps invalid amounts visible but out of arithmetic", () => {
    const row = normaliseLegacyInvoice(
      source({ amount: "not-a-number" as unknown as number }),
      undefined,
    );

    expect(row.amount).toBeNull();
    expect(summariseLegacyInvoices([row], "2026-08-04").invalidAmountCount).toBe(1);
  });
});

describe("legacy billing summaries", () => {
  it("treats the due date itself as still due, and only later days as overdue", () => {
    const due = invoice({ dueDate: "2026-08-04" });

    expect(isLegacyInvoiceOverdue(due, "2026-08-04")).toBe(false);
    expect(isLegacyInvoiceOverdue(due, "2026-08-05")).toBe(true);
  });

  it("counts failed attempts separately while retaining the open invoice", () => {
    const failed = invoice({ paymentFailedAt: "2026-08-04T08:00:00.000Z" });
    const summary = summariseLegacyInvoices([failed], "2026-08-04");

    expect(summary.failedCount).toBe(1);
    expect(summary.currencies[0]).toMatchObject({
      issuedCount: 1,
      issuedAmount: 100,
      outstandingCount: 1,
      outstandingAmount: 100,
      failedCount: 1,
      failedAmount: 100,
    });
  });

  it("keeps a stored failed attempt visible after an invoice becomes uncollectible", () => {
    const failed = invoice({
      status: "uncollectible",
      paymentFailedAt: "2026-08-04T08:00:00.000Z",
    });
    const summary = summariseLegacyInvoices([failed], "2026-08-04");

    expect(summary.failedCount).toBe(1);
    expect(summary.currencies[0]).toMatchObject({
      failedCount: 1,
      failedAmount: 100,
      outstandingCount: 0,
      uncollectibleCount: 1,
    });
  });

  it("never adds unlike currencies together", () => {
    const eur = invoice({ id: "eur", amount: 100, currency: "EUR" });
    const usd = invoice({ id: "usd", amount: 50, currency: "USD" });
    const paid = invoice({ id: "paid", amount: 20, currency: "EUR", status: "paid" });
    const summary = summariseLegacyInvoices([eur, usd, paid], "2026-08-04");

    expect(summary.currencies).toHaveLength(2);
    expect(summary.currencies[0]).toMatchObject({
      currency: "EUR",
      issuedAmount: 120,
      outstandingAmount: 100,
      paidAmount: 20,
    });
    expect(summary.currencies[1]).toMatchObject({
      currency: "USD",
      issuedAmount: 50,
      outstandingAmount: 50,
      paidAmount: 0,
    });
  });

  it("excludes voided invoices from issued volume", () => {
    const summary = summariseLegacyInvoices([invoice({ status: "void" })], "2026-08-04");
    expect(summary.currencies[0]).toMatchObject({ issuedCount: 0, issuedAmount: 0 });
  });
});

describe("legacy service-period filters", () => {
  it("uses Monday to Sunday for current and previous weeks", () => {
    expect(legacyPeriodBounds("current-week", "2026-08-04")).toEqual({
      from: "2026-08-03",
      to: "2026-08-09",
    });
    expect(legacyPeriodBounds("previous-week", "2026-08-04")).toEqual({
      from: "2026-07-27",
      to: "2026-08-02",
    });
  });

  it("assigns a cross-month week only to the month containing its period end", () => {
    const crossMonth = invoice({ periodStart: "2026-07-27", periodEnd: "2026-08-02" });

    expect(legacyInvoiceMatchesPeriod(crossMonth, "current-month", "2026-08-04")).toBe(true);
    expect(legacyInvoiceMatchesPeriod(crossMonth, "previous-month", "2026-08-04")).toBe(false);
  });

  it("handles previous month across a year boundary", () => {
    expect(legacyPeriodBounds("previous-month", "2026-01-15")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });
});

describe("Stripe links", () => {
  it("accepts Stripe HTTPS hosts and rejects lookalikes or insecure URLs", () => {
    expect(safeStripeHostedUrl("https://invoice.stripe.com/i/abc")).toBe(
      "https://invoice.stripe.com/i/abc",
    );
    expect(safeStripeHostedUrl("http://invoice.stripe.com/i/abc")).toBeNull();
    expect(safeStripeHostedUrl("https://stripe.com.example.test/i/abc")).toBeNull();
    expect(safeStripeHostedUrl("not a URL")).toBeNull();
  });

  it("only builds dashboard links for Stripe invoice IDs", () => {
    expect(stripeDashboardInvoiceUrl("in_123ABC")).toBe(
      "https://dashboard.stripe.com/invoices/in_123ABC",
    );
    expect(stripeDashboardInvoiceUrl("../customers")).toBeNull();
  });
});
