import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../google-ads/client", () => ({ searchGoogleAdsAsAgency: vi.fn() }));

import {
  buildBillingPositions,
  type BillingPositionAccount,
  type BillingPositionClient,
} from "./positions";

const client: BillingPositionClient = {
  id: "client-1",
  fullName: "Example Client",
  email: "client@example.com",
};

function account(
  over: Partial<BillingPositionAccount> = {},
): BillingPositionAccount {
  return {
    id: "account-1",
    clientId: client.id,
    storeName: "Example Store",
    createdAt: "2026-07-30T09:00:00.000Z",
    currency: "EUR",
    ...over,
  };
}

function position(
  over: Partial<Parameters<typeof buildBillingPositions>[0]> = {},
) {
  return buildBillingPositions({
    now: new Date("2026-08-04T14:00:00.000Z"),
    clients: [client],
    accounts: [account()],
    starts: [],
    ends: [],
    ledgerRows: [],
    metricRows: [],
    invoices: [],
    ...over,
  });
}

describe("billing positions", () => {
  it("keeps a Thursday signup's closed cycle separate from the current week", () => {
    const result = position({
      ledgerRows: [
        {
          accountId: "account-1",
          occurredOn: "2026-07-29",
          grossAmount: "999.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
        {
          accountId: "account-1",
          occurredOn: "2026-07-30",
          grossAmount: "100.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
        {
          accountId: "account-1",
          occurredOn: "2026-08-02",
          grossAmount: "50.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
        {
          accountId: "account-1",
          occurredOn: "2026-08-03",
          grossAmount: "200.000000",
          currency: "EUR",
          updatedAt: "2026-08-04T13:00:00.000Z",
        },
      ],
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
    // The pre-entry 29 July row and the current-week ledger row are excluded.
    expect(result.clients[0].closed.unissuedEstimate).toBe(15);
    expect(result.clients[0].closed.supportedUnissued).toBe(5);
    expect(result.clients[0].closed.needsEntryReview).toBe(10);
    expect(result.clients[0].current.grossSpend).toBe(225);
    expect(result.clients[0].current.accruedFee).toBe(22.5);
  });

  it("shows a positive Sunday entry day as a range instead of an exact debt", () => {
    const sundayAccount = account({
      createdAt: "2026-08-02T13:38:00.000Z",
    });
    const result = position({
      accounts: [sundayAccount],
      ledgerRows: [
        {
          accountId: sundayAccount.id,
          occurredOn: "2026-08-02",
          grossAmount: "96.200000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
      ],
    });

    expect(result.clients[0].closed).toMatchObject({
      unissuedEstimate: 9.62,
      supportedUnissued: 0,
      needsEntryReview: 9.62,
      supportedNotReceived: 0,
      maximumNotReceived: 9.62,
    });
    expect(result.summary.clientsNeedingEntryReview).toBe(1);
  });

  it("uses an immutable baseline when one exists and removes the ambiguity", () => {
    const result = position({
      starts: [
        {
          id: "start-1",
          accountId: "account-1",
          googleLocalDate: "2026-07-30",
          baselineCostMicros: "40000000",
        },
      ],
      ledgerRows: [
        {
          accountId: "account-1",
          occurredOn: "2026-07-30",
          grossAmount: "100.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
        {
          accountId: "account-1",
          occurredOn: "2026-07-31",
          grossAmount: "20.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
      ],
    });

    expect(result.clients[0].closed).toMatchObject({
      unissuedEstimate: 8,
      supportedUnissued: 8,
      needsEntryReview: 0,
      missingStartCount: 0,
    });
  });

  it("prices each closed/current account from its historical Monday term", () => {
    const result = position({
      starts: [
        {
          id: "start-1",
          accountId: "account-1",
          googleLocalDate: "2026-07-27",
          baselineCostMicros: "0",
        },
      ],
      ledgerRows: [
        {
          accountId: "account-1",
          occurredOn: "2026-07-31",
          grossAmount: "100.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
      ],
      metricRows: [
        {
          accountId: "account-1",
          day: "2026-08-03",
          adSpend: 100,
          computedAt: "2026-08-04T13:30:00.000Z",
        },
      ],
      commissionTermsByAccount: new Map([
        [
          "account-1",
          [
            {
              id: "term-12",
              effectiveFrom: "2026-08-03",
              revision: 1,
              listRate: 12,
            },
          ],
        ],
      ]),
    });

    expect(result.clients[0].closed.unissuedEstimate).toBe(10);
    expect(result.clients[0].current.accruedFee).toBe(12);
  });

  it("does not count a week twice once an active invoice exists", () => {
    const result = position({
      ledgerRows: [
        {
          accountId: "account-1",
          occurredOn: "2026-07-31",
          grossAmount: "100.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
      ],
      invoices: [
        {
          clientId: client.id,
          periodStart: "2026-07-27",
          status: "open",
          amount: 10,
          amountRemaining: 7.5,
          issuedAt: "2026-08-03T16:00:00.000Z",
          calculationVersion:
            "agency-fee-eur-v3-manual-referrals-google-boundaries",
        },
      ],
    });

    expect(result.clients[0].closed).toMatchObject({
      unissuedEstimate: 0,
      supportedUnissued: 0,
      issuedOutstanding: 7.5,
      supportedNotReceived: 7.5,
      maximumNotReceived: 7.5,
    });
  });

  it("shows a reviewed local draft as exact unissued money", () => {
    const result = position({
      ledgerRows: [
        {
          accountId: "account-1",
          occurredOn: "2026-07-31",
          grossAmount: "100.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
      ],
      invoices: [
        {
          clientId: client.id,
          periodStart: "2026-07-27",
          status: "draft",
          amount: 12,
          amountRemaining: null,
          issuedAt: null,
          calculationVersion:
            "agency-fee-eur-v4-account-rates-manual-referrals-google-boundaries",
        },
      ],
    });

    expect(result.clients[0].closed).toMatchObject({
      unissuedEstimate: 12,
      supportedUnissued: 12,
      needsEntryReview: 0,
      issuedOutstanding: 0,
      supportedNotReceived: 12,
      maximumNotReceived: 12,
      periodCount: 1,
    });
  });

  it("ignores archived never-issued legacy voids when computing unissued fees", () => {
    const result = position({
      ledgerRows: [
        {
          accountId: "account-1",
          occurredOn: "2026-07-31",
          grossAmount: "100.000000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
      ],
      invoices: [
        {
          clientId: client.id,
          periodStart: "2026-07-27",
          status: "void",
          amount: 110,
          amountRemaining: null,
          issuedAt: null,
          calculationVersion: "legacy",
        },
      ],
    });

    expect(result.clients[0].closed.unissuedEstimate).toBe(10);
  });

  it("keeps the audited live closed range and current estimate mathematically separate", () => {
    const secondClient = {
      id: "client-2",
      fullName: "Second Client",
      email: "second@example.com",
    };
    const supportedAccount = account({
      id: "supported-account",
      createdAt: "2026-07-30T09:00:00.000Z",
    });
    const sundayAccount = account({
      id: "sunday-account",
      clientId: secondClient.id,
      createdAt: "2026-08-02T13:38:00.000Z",
    });
    const result = position({
      clients: [client, secondClient],
      accounts: [supportedAccount, sundayAccount],
      ledgerRows: [
        {
          accountId: supportedAccount.id,
          occurredOn: "2026-07-31",
          grossAmount: "941.400000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
        {
          accountId: sundayAccount.id,
          occurredOn: "2026-08-02",
          grossAmount: "96.200000",
          currency: "EUR",
          updatedAt: "2026-08-03T15:00:00.000Z",
        },
      ],
      metricRows: [
        {
          accountId: supportedAccount.id,
          day: "2026-08-04",
          adSpend: 196.54,
          computedAt: "2026-08-04T14:10:00.000Z",
        },
        {
          accountId: sundayAccount.id,
          day: "2026-08-04",
          adSpend: 64.84,
          computedAt: "2026-08-04T14:10:00.000Z",
        },
      ],
    });

    expect(result.summary).toMatchObject({
      closedSupportedUnissued: 94.14,
      closedUnissuedEstimate: 103.76,
      closedNeedsEntryReview: 9.62,
      supportedNotReceived: 94.14,
      maximumNotReceived: 103.76,
      currentGrossSpend: 261.38,
      currentAccruedFee: 26.13,
    });
  });
});
