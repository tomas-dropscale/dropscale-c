import { describe, expect, it } from "vitest";
import {
  billingReviewToken,
  parseBillingRecipientSnapshot,
} from "./review-token";

const week = { start: "2026-07-20", end: "2026-07-26" };
const recipient = {
  email: "billing@example.com",
  fallbackName: "Billing Owner",
  billingName: "Example, Lda.",
  taxId: "PT123456789",
  addressLine1: "Rua do Exemplo 1",
  addressLine2: null,
  addressCity: "Lisboa",
  addressPostalCode: "1000-001",
  addressState: null,
  addressCountry: "PT",
};

describe("billing recipient snapshot", () => {
  it("accepts only the exact canonical recipient contract", () => {
    expect(parseBillingRecipientSnapshot(recipient)).toEqual(recipient);
    expect(
      parseBillingRecipientSnapshot({ ...recipient, unexpected: true }),
    ).toBeNull();
    expect(
      parseBillingRecipientSnapshot({ ...recipient, taxId: "X".repeat(31) }),
    ).toBeNull();
    expect(
      parseBillingRecipientSnapshot({
        ...recipient,
        addressCountry: "Portugal",
      }),
    ).toBeNull();
    expect(
      parseBillingRecipientSnapshot({ ...recipient, billingName: " Entity " }),
    ).toBeNull();
    expect(parseBillingRecipientSnapshot("recipient")).toBeNull();
  });
});

describe("billing review token", () => {
  it("changes when store composition changes even if the approved total is identical", async () => {
    const common = {
      clientId: "client-1",
      week,
      amount: 100,
      ledgerRows: [],
      referralTermId: null,
      recipient,
    };
    const reviewed = await billingReviewToken({
      ...common,
      lines: [
        {
          accountId: "store-a",
          kind: "fee" as const,
          store: "A",
          rate: 10,
          baseAmount: 500,
          label: "A fee",
          amount: 50,
        },
        {
          accountId: "store-b",
          kind: "fee" as const,
          store: "B",
          rate: 10,
          baseAmount: 500,
          label: "B fee",
          amount: 50,
        },
      ],
    });
    const changed = await billingReviewToken({
      ...common,
      lines: [
        {
          accountId: "store-a",
          kind: "fee" as const,
          store: "A",
          rate: 10,
          baseAmount: 600,
          label: "A fee",
          amount: 60,
        },
        {
          accountId: "store-b",
          kind: "fee" as const,
          store: "B",
          rate: 10,
          baseAmount: 400,
          label: "B fee",
          amount: 40,
        },
      ],
    });

    expect(reviewed).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(reviewed);
  });

  it("is independent of query row order but changes with a ledger value", async () => {
    const line = {
      accountId: "store-a",
      kind: "fee" as const,
      store: "A",
      rate: 10,
      baseAmount: 300,
      label: "A fee",
      amount: 30,
    };
    const first = {
      id: "row-a",
      ad_account_id: "store-a",
      occurred_on: "2026-07-20",
      gross_amount: 100,
      currency: "EUR",
    };
    const second = {
      id: "row-b",
      ad_account_id: "store-a",
      occurred_on: "2026-07-21",
      gross_amount: 200,
      currency: "EUR",
    };
    const input = {
      clientId: "client-1",
      week,
      amount: 30,
      lines: [line],
      referralTermId: null,
      recipient,
    };

    const ordered = await billingReviewToken({
      ...input,
      ledgerRows: [first, second],
    });
    const reversed = await billingReviewToken({
      ...input,
      ledgerRows: [second, first],
    });
    const restated = await billingReviewToken({
      ...input,
      ledgerRows: [first, { ...second, gross_amount: 199 }],
    });

    expect(reversed).toBe(ordered);
    expect(restated).not.toBe(ordered);
  });

  it("does not collapse distinct high-value Google micros through Number", async () => {
    const common = {
      clientId: "client-1",
      week,
      amount: 1,
      referralTermId: null,
      recipient,
      lines: [
        {
          accountId: "store-a",
          kind: "fee" as const,
          store: "A",
          rate: 10,
          baseAmount: 10,
          label: "A fee",
          amount: 1,
        },
      ],
    };
    const row = {
      id: "row-a",
      ad_account_id: "store-a",
      occurred_on: "2026-07-20",
      gross_amount: "9007199254740.993123",
      currency: "EUR",
    };

    const first = await billingReviewToken({ ...common, ledgerRows: [row] });
    const oneMicroMore = await billingReviewToken({
      ...common,
      ledgerRows: [{ ...row, gross_amount: "9007199254740.993124" }],
    });

    expect(oneMicroMore).not.toBe(first);
  });

  it("changes when the reviewed opening-baseline evidence changes", async () => {
    const common = {
      clientId: "client-1",
      week,
      amount: 7,
      ledgerRows: [],
      referralTermId: null,
      recipient,
    };
    const line = {
      accountId: "store-a",
      kind: "fee" as const,
      store: "A",
      rate: 10,
      baseAmount: 70,
      sourceGrossAmount: 100,
      baselineDeductionAmount: 30,
      billingStartId: "start-a",
      billingStartDate: "2026-07-24",
      billingStartedAt: "2026-07-24T12:00:00.000Z",
      billingTimeZone: "Europe/Lisbon",
      billingStartBaselineAmount: 30,
      label: "A fee",
      amount: 7,
    };

    const reviewed = await billingReviewToken({ ...common, lines: [line] });
    const changed = await billingReviewToken({
      ...common,
      lines: [{ ...line, baselineDeductionAmount: 29 }],
    });

    expect(changed).not.toBe(reviewed);
  });

  it("binds the admin confirmation to the exact manual referral term", async () => {
    const common = {
      clientId: "client-1",
      week,
      amount: 9.5,
      lines: [
        {
          accountId: "store-a",
          kind: "fee" as const,
          store: "A",
          rate: 9.5,
          listRate: 10,
          referralDiscountRate: 0.5,
          referralCount: 1,
          baseAmount: 100,
          label: "A manual referral fee",
          amount: 9.5,
        },
      ],
      ledgerRows: [],
      recipient,
    };

    const first = await billingReviewToken({
      ...common,
      referralTermId: "term-a",
    });
    const sameMathDifferentGrant = await billingReviewToken({
      ...common,
      referralTermId: "term-b",
    });

    expect(sameMathDifferentGrant).not.toBe(first);
  });

  it("changes when the immutable closing-counter evidence changes", async () => {
    const common = {
      clientId: "client-1",
      week,
      amount: 8,
      referralTermId: null,
      ledgerRows: [],
      recipient,
    };
    const line = {
      accountId: "store-a",
      kind: "fee" as const,
      store: "A",
      rate: 10,
      baseAmount: 80,
      sourceGrossAmount: 100,
      endDeductionAmount: 20,
      endingCapApplied: true as const,
      billingEndCounterAmount: 80,
      billingEndId: "end-a",
      billingEndDate: "2026-07-24",
      billingEndedAt: "2026-07-24T12:00:00.000Z",
      billingEndTimeZone: "Europe/Lisbon",
      label: "A final fee",
      amount: 8,
    };

    const reviewed = await billingReviewToken({ ...common, lines: [line] });
    const changed = await billingReviewToken({
      ...common,
      lines: [{ ...line, billingEndCounterAmount: 79 }],
    });

    expect(changed).not.toBe(reviewed);
  });

  it("changes when the reviewed Stripe recipient changes", async () => {
    const common = {
      clientId: "client-1",
      week,
      amount: 1,
      referralTermId: null,
      recipient,
      ledgerRows: [],
      lines: [
        {
          accountId: "store-a",
          kind: "fee" as const,
          store: "A",
          rate: 10,
          baseAmount: 10,
          label: "A fee",
          amount: 1,
        },
      ],
    };

    const reviewed = await billingReviewToken(common);
    const changedEmail = await billingReviewToken({
      ...common,
      recipient: { ...recipient, email: "new-billing@example.com" },
    });
    const changedLegalName = await billingReviewToken({
      ...common,
      recipient: { ...recipient, billingName: "Different Entity, Lda." },
    });

    expect(changedEmail).not.toBe(reviewed);
    expect(changedLegalName).not.toBe(reviewed);
  });
});
