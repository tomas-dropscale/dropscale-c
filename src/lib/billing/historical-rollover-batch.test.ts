import { describe, expect, it } from "vitest";

import {
  planHistoricalRolloverDelivery,
  type HistoricalRolloverReceipt,
} from "./historical-rollover-batch";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const LOCK_MS = 5 * 60 * 1000;

function rollover(rolloverId: string, invoiceId: string | null = null) {
  return { rollover_id: rolloverId, invoice_id: invoiceId };
}

function receipt(
  overrides: Partial<HistoricalRolloverReceipt> & Pick<HistoricalRolloverReceipt, "id">,
): HistoricalRolloverReceipt {
  return {
    status: "draft",
    issued_at: null,
    stripe_invoice_id: null,
    stripe_sent_at: null,
    stripe_delivery_assumed_at: null,
    issue_attempted_at: null,
    issue_error: null,
    ...overrides,
  };
}

function plan(
  rollovers: ReturnType<typeof rollover>[],
  receipts: HistoricalRolloverReceipt[] = [],
  options: { now?: number; lockMs?: number } = {},
) {
  return planHistoricalRolloverDelivery(
    rollovers,
    new Map(receipts.map((row) => [row.id, row])),
    { now: options.now ?? NOW, lockMs: options.lockMs ?? LOCK_MS },
  );
}

describe("historical rollover delivery planning", () => {
  it("treats a finalized-but-unsent invoice as send-only work, never as settled", () => {
    // A webhook `invoice.finalized` can land before /send is durably recorded:
    // status=open, issued_at set, stripe_sent_at still null. The previous
    // helper called this "durably issued" and skipped the send forever.
    const result = plan(
      [rollover("r-1", "inv-1")],
      [
        receipt({
          id: "inv-1",
          status: "open",
          issued_at: "2026-08-04T20:00:00.000Z",
          stripe_invoice_id: "in_stripe_1",
        }),
      ],
    );

    expect(result.settled).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].recoveryMode).toBe("send_only");
  });

  it("settles on any durable delivery marker even when issued_at lags", () => {
    const sent = receipt({
      id: "inv-sent",
      status: "draft",
      stripe_invoice_id: "in_stripe_2",
      stripe_sent_at: "2026-08-04T20:05:00.000Z",
    });
    const assumed = receipt({
      id: "inv-assumed",
      status: "open",
      stripe_invoice_id: "in_stripe_3",
      stripe_delivery_assumed_at: "2026-08-04T20:05:00.000Z",
    });

    const result = plan(
      [rollover("r-sent", "inv-sent"), rollover("r-assumed", "inv-assumed")],
      [sent, assumed],
    );

    expect(result.settled.map((row) => row.rollover_id)).toEqual([
      "r-sent",
      "r-assumed",
    ]);
    expect(result.candidates).toEqual([]);
  });

  it("resumes an interrupted local draft through the same idempotent intent", () => {
    // The 2.78 EUR incident shape: local draft exists, Stripe id never
    // persisted. It must surface as a draft-mode candidate, not a new invoice.
    const result = plan(
      [rollover("r-draft", "inv-draft")],
      [receipt({ id: "inv-draft" })],
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].recoveryMode).toBe("draft");
    expect(result.candidates[0].receipt?.id).toBe("inv-draft");
  });

  it("puts never-attempted rollovers before failed attempts", () => {
    const failed = receipt({
      id: "inv-failed",
      issue_attempted_at: "2026-08-04T20:00:00.000Z",
      issue_error: "Stripe invoice issue failed.",
    });

    const result = plan(
      [rollover("z-fresh"), rollover("a-failed", "inv-failed")],
      [failed],
    );

    expect(result.candidates.map((entry) => entry.rollover.rollover_id)).toEqual([
      "z-fresh",
      "a-failed",
    ]);
  });

  it("rotates failed attempts oldest-first so one bad rollover cannot starve the rest", () => {
    const oldFailure = receipt({
      id: "inv-old",
      issue_attempted_at: "2026-08-04T18:00:00.000Z",
      issue_error: "Stripe invoice issue failed.",
    });
    const newFailure = receipt({
      id: "inv-new",
      issue_attempted_at: "2026-08-04T22:00:00.000Z",
      issue_error: "Stripe invoice issue failed.",
    });

    const result = plan(
      [rollover("a-new", "inv-new"), rollover("b-old", "inv-old")],
      [oldFailure, newFailure],
    );

    expect(result.candidates.map((entry) => entry.rollover.rollover_id)).toEqual([
      "b-old",
      "a-new",
    ]);
  });

  it("defers a recent errorless attempt to its owning worker", () => {
    const inFlight = receipt({
      id: "inv-live",
      issue_attempted_at: new Date(NOW - LOCK_MS + 60_000).toISOString(),
    });

    const result = plan([rollover("r-live", "inv-live")], [inFlight]);

    expect(result.inProgress.map((row) => row.rollover_id)).toEqual(["r-live"]);
    expect(result.candidates).toEqual([]);
  });

  it("retries immediately once the attempt recorded an error", () => {
    const failedRecently = receipt({
      id: "inv-err",
      issue_attempted_at: new Date(NOW - 60_000).toISOString(),
      issue_error: "Stripe invoice issue failed.",
    });

    const result = plan([rollover("r-err", "inv-err")], [failedRecently]);

    expect(result.inProgress).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  });

  it("retries after the attempt lock expires without an error", () => {
    const stale = receipt({
      id: "inv-stale",
      issue_attempted_at: new Date(NOW - LOCK_MS - 1).toISOString(),
    });

    const result = plan([rollover("r-stale", "inv-stale")], [stale]);

    expect(result.inProgress).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  });

  it("isolates a missing invoice receipt without hiding its siblings", () => {
    const result = plan(
      [rollover("r-gone", "inv-gone"), rollover("r-fresh")],
      [],
    );

    expect(result.missingReceipts.map((row) => row.rollover_id)).toEqual([
      "r-gone",
    ]);
    expect(result.candidates.map((entry) => entry.rollover.rollover_id)).toEqual([
      "r-fresh",
    ]);
  });

  it("demotes never-attempted invoices carrying a recorded error behind clean work", () => {
    // A pre-claim permanent failure (e.g. sealed-snapshot mismatch) records
    // issue_error but never gains an attempt stamp. It must not permanently
    // head the queue ahead of deliverable siblings.
    const preClaimFailure = receipt({
      id: "inv-preclaim",
      issue_error: "The historical rollover invoice does not match its sealed automation snapshot.",
    });

    const result = plan(
      [rollover("a-broken", "inv-preclaim"), rollover("z-clean")],
      [preClaimFailure],
    );

    expect(result.candidates.map((entry) => entry.rollover.rollover_id)).toEqual([
      "z-clean",
      "a-broken",
    ]);
  });

  it("orders the certified backlog deterministically by rollover id", () => {
    const result = plan([
      rollover("r-3"),
      rollover("r-1"),
      rollover("r-2"),
    ]);

    expect(result.candidates.map((entry) => entry.rollover.rollover_id)).toEqual([
      "r-1",
      "r-2",
      "r-3",
    ]);
  });

  it("rejects a non-finite clock or lock window", () => {
    expect(() =>
      plan([], [], { now: Number.NaN }),
    ).toThrow(/finite clock/);
    expect(() =>
      plan([], [], { lockMs: Number.POSITIVE_INFINITY }),
    ).toThrow(/finite clock/);
  });
});
