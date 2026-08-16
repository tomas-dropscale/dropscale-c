import { describe, expect, it } from "vitest";

import {
  billingReviewQueue,
  stripeInvoiceRecoveryMode,
} from "./invoice-delivery";

const BASE = {
  status: "draft" as const,
  issued_at: null,
  stripe_invoice_id: "in_test",
  stripe_sent_at: null,
  stripe_delivery_assumed_at: null,
};

describe("Stripe invoice delivery recovery", () => {
  it("allows an unissued draft only while delivery has no evidence", () => {
    expect(stripeInvoiceRecoveryMode(BASE)).toBe("draft");
    expect(
      stripeInvoiceRecoveryMode({
        ...BASE,
        stripe_sent_at: "2026-08-03T09:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      stripeInvoiceRecoveryMode({
        ...BASE,
        stripe_delivery_assumed_at: "2026-08-03T09:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      stripeInvoiceRecoveryMode({
        ...BASE,
        issued_at: "2026-08-03T08:59:00.000Z",
      }),
    ).toBeNull();
  });

  it("allows send-only recovery only for a linked, explicitly unsent open invoice", () => {
    expect(
      stripeInvoiceRecoveryMode({ ...BASE, status: "open" }),
    ).toBe("send_only");
    expect(
      stripeInvoiceRecoveryMode({
        ...BASE,
        status: "open",
        stripe_invoice_id: null,
      }),
    ).toBeNull();
    expect(
      stripeInvoiceRecoveryMode({
        ...BASE,
        status: "open",
        stripe_sent_at: "2026-08-03T09:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      stripeInvoiceRecoveryMode({
        ...BASE,
        status: "open",
        stripe_delivery_assumed_at: "2026-08-03T09:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("never retries terminal or locally waived states", () => {
    for (const status of ["paid", "void", "uncollectible", "waived"] as const) {
      expect(stripeInvoiceRecoveryMode({ ...BASE, status })).toBeNull();
    }
  });

  it("keeps only actionable review entries and orders ready clients first", () => {
    const invoice = (status: "draft" | "open" | "paid", sent = false) => ({
      ...BASE,
      status,
      issued_at: status === "draft" ? null : "2026-08-10T23:56:03.000Z",
      stripe_sent_at: sent ? "2026-08-10T23:56:05.000Z" : null,
    });

    expect(
      billingReviewQueue([
        {
          clientName: "Diogo Barbosa",
          canIssue: false,
          existingInvoice: invoice("open", true),
        },
        {
          clientName: "Edgar e Rodrigo",
          canIssue: false,
          existingInvoice: null,
        },
        {
          clientName: "Paulo & Joao",
          canIssue: false,
          existingInvoice: invoice("paid", true),
        },
        {
          clientName: "Ready client",
          canIssue: true,
          existingInvoice: null,
        },
        {
          clientName: "Retry client",
          canIssue: true,
          existingInvoice: invoice("draft"),
        },
      ]).map((entry) => entry.clientName),
    ).toEqual(["Ready client", "Retry client", "Edgar e Rodrigo"]);
  });
});
