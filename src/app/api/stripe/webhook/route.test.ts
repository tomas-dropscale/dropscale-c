import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  allowedLocalStatusesForStripeUpdate,
  authoritativeInvoiceUpdate,
  localInvoiceStatus,
  stripeInvoiceStatusDecision,
  type StripeLocalInvoiceStatus,
} from "../../../../lib/stripe/client";

describe("Stripe webhook invoice state", () => {
  it("maps only Stripe's supported invoice states", () => {
    expect(localInvoiceStatus("draft")).toBe("draft");
    expect(localInvoiceStatus("open")).toBe("open");
    expect(localInvoiceStatus("paid")).toBe("paid");
    expect(localInvoiceStatus("void")).toBe("void");
    expect(localInvoiceStatus("uncollectible")).toBe("uncollectible");
    expect(localInvoiceStatus("mystery")).toBeNull();
  });

  it("uses current paid state even when a delayed finalized event arrives", () => {
    const update = authoritativeInvoiceUpdate(
      {
        id: "in_paid",
        status: "paid",
        hosted_invoice_url: "https://invoice.stripe.test/in_paid",
        invoice_pdf: "https://stripe.test/in_paid.pdf",
        number: "DS-0042",
        due_date: Date.parse("2026-07-27T00:00:00.000Z") / 1000,
        amount_remaining: 0,
        status_transitions: {
          finalized_at: Date.parse("2026-07-20T00:00:00.000Z") / 1000,
          paid_at: Date.parse("2026-07-21T00:00:00.000Z") / 1000,
        },
      },
      "invoice.finalized",
      Date.parse("2026-07-20T00:00:00.000Z") / 1000,
      new Date("2026-08-03T12:00:00.000Z"),
    );

    expect(update).toEqual({
      status: "paid",
      stripe_invoice_id: "in_paid",
      stripe_hosted_url: "https://invoice.stripe.test/in_paid",
      stripe_invoice_number: "DS-0042",
      stripe_invoice_pdf: "https://stripe.test/in_paid.pdf",
      amount_remaining: 0,
      due_date: "2026-07-27",
      issued_at: "2026-07-20T00:00:00.000Z",
      paid_at: "2026-07-21T00:00:00.000Z",
      payment_failed_at: null,
      updated_at: "2026-08-03T12:00:00.000Z",
    });
  });

  it("records a failed attempt at the Stripe event time while remaining open", () => {
    const update = authoritativeInvoiceUpdate(
      {
        id: "in_open",
        status: "open",
        hosted_invoice_url: "https://invoice.stripe.test/in_open",
        due_date: null,
        amount_remaining: 1_234,
      },
      "invoice.payment_failed",
      Date.parse("2026-07-22T00:00:00.000Z") / 1000,
      new Date("2026-08-03T12:00:00.000Z"),
    );

    expect(update.status).toBe("open");
    expect(update.amount_remaining).toBe(12.34);
    expect(update.payment_failed_at).toBe("2026-07-22T00:00:00.000Z");
    expect(update).not.toHaveProperty("paid_at");
  });

  it("keeps finalized-before-send recoverable and records only a real invoice.sent event", () => {
    const remote = {
      id: "in_delivery",
      status: "open",
      hosted_invoice_url: "https://invoice.stripe.test/in_delivery",
      due_date: null,
      amount_remaining: 1_000,
      status_transitions: {
        finalized_at: Date.parse("2026-07-20T09:00:00.000Z") / 1000,
      },
    };
    const finalized = authoritativeInvoiceUpdate(
      remote,
      "invoice.finalized",
      Date.parse("2026-07-20T09:00:00.000Z") / 1000,
    );
    const sent = authoritativeInvoiceUpdate(
      remote,
      "invoice.sent",
      Date.parse("2026-07-20T09:01:00.000Z") / 1000,
    );

    expect(finalized.status).toBe("open");
    expect(finalized).not.toHaveProperty("stripe_sent_at");
    expect(finalized).not.toHaveProperty("stripe_delivery_assumed_at");
    expect(sent.stripe_sent_at).toBe("2026-07-20T09:01:00.000Z");
    expect(sent.stripe_delivery_assumed_at).toBeNull();
    expect(sent.issue_error).toBeNull();
  });

  it("cannot reopen a paid invoice when an open GET loses a write race", () => {
    // Request A has already fetched this snapshot from Stripe.
    const observedRemoteStatus: StripeLocalInvoiceStatus = "open";
    let localStatus: StripeLocalInvoiceStatus = "draft";

    // Request B (for example invoice.paid) commits before request A writes.
    localStatus = "paid";

    // This is the same compare-and-set predicate used by webhook, issue and
    // reconcile. Request A matches no row and classifies its GET as stale.
    expect(
      allowedLocalStatusesForStripeUpdate(observedRemoteStatus),
    ).not.toContain(localStatus);
    expect(stripeInvoiceStatusDecision(localStatus, observedRemoteStatus)).toBe(
      "ignore_stale",
    );
    expect(localStatus).toBe("paid");
  });

  it.each(["paid", "void", "uncollectible"] as const)(
    "never lets an open or draft snapshot replace terminal status %s",
    (current) => {
      expect(stripeInvoiceStatusDecision(current, "open")).toBe("ignore_stale");
      expect(stripeInvoiceStatusDecision(current, "draft")).toBe(
        "ignore_stale",
      );
    },
  );

  it("allows Stripe's supported uncollectible to paid recovery", () => {
    expect(allowedLocalStatusesForStripeUpdate("paid")).toContain(
      "uncollectible",
    );
    expect(stripeInvoiceStatusDecision("uncollectible", "paid")).toBe("apply");
  });

  it("surfaces mutually exclusive terminal states instead of guessing their order", () => {
    expect(stripeInvoiceStatusDecision("void", "paid")).toBe("conflict");
    expect(stripeInvoiceStatusDecision("paid", "void")).toBe("conflict");
  });
});
