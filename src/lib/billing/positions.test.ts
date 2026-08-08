import { describe, expect, it } from "vitest";

import {
  buildBillingPositions,
  type BillingPositionAccount,
  type BillingPositionCertifiedClosedAmount,
  type BillingPositionClient,
  type BillingPositionInvoice,
} from "./positions";

const client: BillingPositionClient = {
  id: "client-1",
  fullName: "Example Client",
  email: "client@example.com",
};

function account(over: Partial<BillingPositionAccount> = {}): BillingPositionAccount {
  return {
    id: "account-1",
    clientId: client.id,
    storeName: "Example Store",
    createdAt: "2026-07-30T09:00:00.000Z",
    currency: "EUR",
    ...over,
  };
}

function certified(
  over: Partial<BillingPositionCertifiedClosedAmount> = {},
): BillingPositionCertifiedClosedAmount {
  return {
    clientId: client.id,
    periodStart: "2026-07-27",
    periodEnd: "2026-08-02",
    amount: 10,
    currency: "EUR",
    source: "automatic_v3",
    certifiedAt: "2026-08-03T15:00:00.000Z",
    ...over,
  };
}

function invoice(
  over: Partial<BillingPositionInvoice> = {},
): BillingPositionInvoice {
  return {
    clientId: client.id,
    periodStart: "2026-07-27",
    currency: "EUR",
    status: "open",
    amount: 10,
    amountRemaining: 10,
    issuedAt: "2026-08-03T16:00:00.000Z",
    calculationVersion:
      "agency-fee-eur-v3-manual-referrals-google-boundaries",
    issueError: null,
    paymentFailedAt: null,
    ...over,
  };
}

function position(over: Partial<Parameters<typeof buildBillingPositions>[0]> = {}) {
  return buildBillingPositions({
    now: new Date("2026-08-04T14:00:00.000Z"),
    clients: [client],
    accounts: [account()],
    starts: [],
    ends: [],
    certifiedClosedAmounts: [],
    metricRows: [],
    invoices: [],
    ...over,
  });
}

describe("billing positions", () => {
  it("keeps one certified closed amount separate from the current week", () => {
    const result = position({
      reviewedFullDayEntries: [
        { accountId: "account-1", entryDay: "2026-07-30" },
      ],
      certifiedClosedAmounts: [certified({ amount: 15 })],
      metricRows: [
        {
          accountId: "account-1",
          day: "2026-08-03",
          adSpend: 200,
          computedAt: "2026-08-04T13:30:00.000Z",
        },
        {
          accountId: "account-1",
          day: "2026-08-04",
          adSpend: 25,
          computedAt: "2026-08-04T13:30:00.000Z",
        },
      ],
    });

    expect(result.closedThrough).toBe("2026-08-02");
    expect(result.currentPeriod).toEqual({
      start: "2026-08-03",
      end: "2026-08-09",
    });
    expect(result.clients[0].closed).toMatchObject({
      unissuedEstimate: 15,
      supportedUnissued: 15,
      supportedNotReceived: 15,
      maximumNotReceived: 15,
      needsEntryReview: 0,
    });
    expect(result.clients[0].current).toMatchObject({
      grossSpend: 225,
      accruedFee: 22.5,
    });
  });

  it("cannot turn an unproven confirmed ledger row into closed money", () => {
    const result = buildBillingPositions({
      now: new Date("2026-08-04T14:00:00.000Z"),
      clients: [client],
      accounts: [account()],
      starts: [],
      ends: [],
      certifiedClosedAmounts: [],
      metricRows: [],
      invoices: [],
      // A legacy caller may still carry this runtime property during rollout;
      // it is deliberately outside PositionInput and therefore ignored.
      ledgerRows: [
        {
          accountId: "account-1",
          occurredOn: "2026-08-02",
          grossAmount: "999.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
      ],
    } as Parameters<typeof buildBillingPositions>[0] & {
      ledgerRows: unknown[];
    });

    expect(result.summary.supportedNotReceived).toBe(0);
    expect(result.summary.closedSupportedUnissued).toBe(0);
  });

  it("accepts the isolated certified historical rollover without reopening its rows", () => {
    const result = position({
      reviewedFullDayEntries: [
        { accountId: "account-1", entryDay: "2026-07-30" },
      ],
      certifiedClosedAmounts: [
        certified({ source: "historical_rollover_v1", amount: 9.62 }),
      ],
    });

    expect(result.clients[0].closed).toMatchObject({
      supportedUnissued: 9.62,
      supportedNotReceived: 9.62,
      maximumNotReceived: 9.62,
      periodCount: 1,
    });
  });

  it("uses immutable boundaries only for the provisional current cycle", () => {
    const result = position({
      starts: [
        {
          id: "start-1",
          accountId: "account-1",
          basis: "observed_google_counter",
          googleLocalDate: "2026-08-03",
          baselineCostMicros: "40000000",
        },
      ],
      metricRows: [
        {
          accountId: "account-1",
          day: "2026-08-03",
          adSpend: 100,
          computedAt: "2026-08-04T13:30:00.000Z",
        },
        {
          accountId: "account-1",
          day: "2026-08-04",
          adSpend: 20,
          computedAt: "2026-08-04T13:30:00.000Z",
        },
      ],
    });

    expect(result.clients[0].closed.supportedNotReceived).toBe(0);
    expect(result.clients[0].current).toMatchObject({
      grossSpend: 80,
      accruedFee: 8,
      missingStartCount: 0,
    });
  });

  it("marks an account without an immutable start for attention without inventing debt", () => {
    const result = position({
      accounts: [account({ createdAt: "2026-08-04T09:00:00.000Z" })],
    });

    expect(result.clients[0]).toMatchObject({
      closed: {
        supportedNotReceived: 0,
        missingStartCount: 0,
        needsAttentionCount: 1,
      },
      current: { missingStartCount: 1 },
    });
  });

  it("merges durable blocked automation into one attention signal", () => {
    const result = position({
      reviewedFullDayEntries: [
        { accountId: "account-1", entryDay: "2026-07-30" },
      ],
      automationAttentionClientIds: [client.id, client.id],
    });

    expect(result.clients[0].closed.needsAttentionCount).toBe(1);
    expect(result.summary.clientsNeedingAttention).toBe(1);
  });

  it("uses an issued open invoice's remaining balance instead of its certified week", () => {
    const result = position({
      certifiedClosedAmounts: [certified()],
      invoices: [invoice({ amountRemaining: 7.5 })],
    });

    expect(result.clients[0].closed).toMatchObject({
      unissuedEstimate: 0,
      supportedUnissued: 0,
      issuedOutstanding: 7.5,
      supportedNotReceived: 7.5,
      maximumNotReceived: 7.5,
    });
  });

  it("counts a payment-failed open invoice once and marks attention", () => {
    const result = position({
      invoices: [
        invoice({
          amountRemaining: 7.5,
          paymentFailedAt: "2026-08-04T10:00:00.000Z",
        }),
      ],
    });

    expect(result.clients[0].closed).toMatchObject({
      issuedOutstanding: 7.5,
      failedNotReceived: 0,
      supportedNotReceived: 7.5,
      needsAttentionCount: 1,
    });
  });

  it("requires proof input for a retryable draft", () => {
    const draft = invoice({
      status: "draft",
      issuedAt: null,
      amountRemaining: null,
      issueError: "Stripe request timed out.",
    });
    const unsupported = position({ invoices: [draft] });
    const certifiedDraft = position({
      invoices: [draft],
      certifiedClosedAmounts: [certified()],
    });

    expect(unsupported.clients[0].closed.supportedNotReceived).toBe(0);
    expect(unsupported.clients[0].closed.needsAttentionCount).toBe(1);
    expect(certifiedDraft.clients[0].closed.supportedNotReceived).toBe(10);
  });

  it("does not present a written-off uncollectible invoice as collectible", () => {
    const result = position({
      certifiedClosedAmounts: [certified()],
      invoices: [
        invoice({
          status: "uncollectible",
          amountRemaining: 7.5,
        }),
      ],
    });

    expect(result.clients[0].closed).toMatchObject({
      issuedOutstanding: 0,
      // Visible as a written-off balance, but never in the collectible headline.
      failedNotReceived: 7.5,
      supportedNotReceived: 0,
      needsAttentionCount: 1,
    });
    expect(result.summary.failedNotReceived).toBe(7.5);
  });

  it("excludes a non-EUR open invoice from the EUR position", () => {
    const result = position({
      invoices: [invoice({ currency: "USD", amountRemaining: 8 })],
    });

    expect(result.clients[0].closed).toMatchObject({
      issuedOutstanding: 0,
      supportedNotReceived: 0,
      needsAttentionCount: 1,
    });
  });

  it("does not let an archived legacy void suppress the certified rollover", () => {
    const result = position({
      certifiedClosedAmounts: [
        certified({ source: "historical_rollover_v1", amount: 10 }),
      ],
      invoices: [
        invoice({
          status: "void",
          issuedAt: null,
          amountRemaining: null,
          amount: 110,
          calculationVersion: "legacy",
        }),
      ],
    });

    expect(result.clients[0].closed.supportedNotReceived).toBe(10);
  });

  it("fails closed for conflicting certified sources on one client/week", () => {
    expect(() =>
      position({
        certifiedClosedAmounts: [
          certified(),
          certified({ source: "historical_rollover_v1" }),
        ],
      }),
    ).toThrow("more than one certified closed amount");
  });

  it.each([
    certified({ currency: "USD" }),
    certified({ amount: 10.001 }),
    certified({ periodStart: "2026-07-28", periodEnd: "2026-08-03" }),
    certified({ periodStart: "2026-08-03", periodEnd: "2026-08-09" }),
  ])("fails closed for a malformed certification contract", (candidate) => {
    expect(() =>
      position({ certifiedClosedAmounts: [candidate] }),
    ).toThrow("Invalid certified closed billing amount");
  });

  it("sums exact certified clients while keeping current estimates separate", () => {
    const secondClient: BillingPositionClient = {
      id: "client-2",
      fullName: "Second Client",
      email: "second@example.com",
    };
    const firstAccount = account({ id: "first-account" });
    const secondAccount = account({
      id: "second-account",
      clientId: secondClient.id,
    });
    const result = position({
      clients: [client, secondClient],
      accounts: [firstAccount, secondAccount],
      reviewedFullDayEntries: [
        { accountId: firstAccount.id, entryDay: "2026-07-30" },
        { accountId: secondAccount.id, entryDay: "2026-07-30" },
      ],
      certifiedClosedAmounts: [
        certified({ clientId: client.id, amount: 94.14 }),
        certified({
          clientId: secondClient.id,
          amount: 9.62,
          source: "historical_rollover_v1",
        }),
      ],
      metricRows: [
        {
          accountId: firstAccount.id,
          day: "2026-08-04",
          adSpend: 196.54,
          computedAt: "2026-08-04T14:10:00.000Z",
        },
        {
          accountId: secondAccount.id,
          day: "2026-08-04",
          adSpend: 64.84,
          computedAt: "2026-08-04T14:10:00.000Z",
        },
      ],
    });

    expect(result.summary).toMatchObject({
      closedSupportedUnissued: 103.76,
      closedUnissuedEstimate: 103.76,
      closedNeedsEntryReview: 0,
      supportedNotReceived: 103.76,
      maximumNotReceived: 103.76,
      currentGrossSpend: 261.38,
      currentAccruedFee: 26.13,
    });
  });
});

describe("pending closed weeks and overdue balances", () => {
  it("lists an unbilled certified week with its date range", () => {
    const result = position({
      certifiedClosedAmounts: [certified({ amount: 42.17 })],
    });

    expect(result.clients[0].closed.weeks).toEqual([
      {
        periodStart: "2026-07-27",
        periodEnd: "2026-08-02",
        amount: 42.17,
        state: "unissued",
        overdueDays: 0,
      },
    ]);
  });

  it("shows the invoice-backed state instead of a duplicate certified row", () => {
    const result = position({
      certifiedClosedAmounts: [certified({ amount: 2.78 })],
      invoices: [
        invoice({ status: "draft", amount: 2.78, issuedAt: null }),
      ],
    });

    expect(result.clients[0].closed.weeks).toEqual([
      {
        periodStart: "2026-07-27",
        periodEnd: "2026-08-02",
        amount: 2.78,
        state: "draft",
        overdueDays: 0,
      },
    ]);
  });

  it("marks an open invoice past its due date as overdue, per week and in totals", () => {
    const result = position({
      invoices: [
        invoice({
          amountRemaining: 16.86,
          periodEnd: "2026-08-02",
          dueDate: "2026-08-01",
        }),
      ],
    });

    expect(result.clients[0].closed.weeks).toEqual([
      {
        periodStart: "2026-07-27",
        periodEnd: "2026-08-02",
        amount: 16.86,
        state: "open",
        overdueDays: 3,
      },
    ]);
    expect(result.clients[0].closed.overdueOutstanding).toBe(16.86);
    expect(result.summary.overdueOutstanding).toBe(16.86);
    expect(result.summary.clientsOverdue).toBe(1);
  });

  it("keeps an open invoice inside its payment window out of the overdue bucket", () => {
    const result = position({
      invoices: [invoice({ amountRemaining: 9.62, dueDate: "2026-08-10" })],
    });

    expect(result.clients[0].closed.weeks[0]).toMatchObject({
      state: "open",
      overdueDays: 0,
    });
    expect(result.clients[0].closed.overdueOutstanding).toBe(0);
    expect(result.summary.clientsOverdue).toBe(0);
  });

  it("lists a written-off week as failed and never lists a paid week", () => {
    const result = position({
      invoices: [
        invoice({ status: "uncollectible", amountRemaining: 7.5 }),
        invoice({
          status: "paid",
          periodStart: "2026-07-20",
          amountRemaining: 0,
        }),
      ],
    });

    expect(result.clients[0].closed.weeks).toEqual([
      {
        periodStart: "2026-07-27",
        periodEnd: "2026-08-02",
        amount: 7.5,
        state: "failed",
        overdueDays: 0,
      },
    ]);
  });

  it("orders pending weeks oldest first across certified and invoiced cycles", () => {
    const result = position({
      certifiedClosedAmounts: [
        certified({ periodStart: "2026-07-27", periodEnd: "2026-08-02" }),
      ],
      invoices: [
        invoice({
          periodStart: "2026-07-20",
          periodEnd: "2026-07-26",
          amountRemaining: 12.83,
        }),
      ],
    });

    expect(
      result.clients[0].closed.weeks.map((week) => week.periodStart),
    ).toEqual(["2026-07-20", "2026-07-27"]);
  });
});

describe("skipped billing cycles", () => {
  const KEY = `${client.id}:2026-07-27`;

  it("stops a skipped week being owed, while keeping it visible", () => {
    const result = position({
      certifiedClosedAmounts: [certified({ amount: 42.17 })],
      skippedWeeks: [KEY],
    });

    expect(result.clients[0].closed).toMatchObject({
      unissuedEstimate: 0,
      supportedUnissued: 0,
      supportedNotReceived: 0,
    });
    expect(result.summary.supportedNotReceived).toBe(0);
    // The certified amount stays on the week as evidence of what was forgiven.
    expect(result.clients[0].closed.weeks).toEqual([
      {
        periodStart: "2026-07-27",
        periodEnd: "2026-08-02",
        amount: 42.17,
        state: "skipped",
        overdueDays: 0,
      },
    ]);
  });

  it("leaves other clients' weeks owed", () => {
    const other = { id: "client-2", fullName: "Other", email: "o@example.com" };
    const result = buildBillingPositions({
      now: new Date("2026-08-04T14:00:00.000Z"),
      clients: [client, other],
      accounts: [account()],
      starts: [],
      ends: [],
      certifiedClosedAmounts: [
        certified({ amount: 10 }),
        certified({ clientId: other.id, amount: 25 }),
      ],
      metricRows: [],
      invoices: [],
      skippedWeeks: [KEY],
    });

    const byId = new Map(result.clients.map((p) => [p.clientId, p]));
    expect(byId.get(client.id)?.closed.supportedNotReceived).toBe(0);
    expect(byId.get(other.id)?.closed.supportedNotReceived).toBe(25);
    expect(result.summary.supportedNotReceived).toBe(25);
  });

  it("never suppresses an already-issued week's outstanding balance", () => {
    // A skip only forgives money that has not been invoiced; an open invoice
    // is Stripe's, and the database refuses to skip such a week anyway.
    const result = position({
      invoices: [invoice({ amountRemaining: 16.86 })],
      skippedWeeks: [KEY],
    });

    expect(result.clients[0].closed.issuedOutstanding).toBe(16.86);
    expect(result.clients[0].closed.supportedNotReceived).toBe(16.86);
  });
});
