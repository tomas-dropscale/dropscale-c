import { describe, expect, it } from "vitest";

import {
  boundCommissionLedger,
  ledgerBoundaries,
  type LedgerBoundary,
} from "./queries";

type Row = {
  notes: string | null;
  ad_account_id: string | null;
  occurred_on: string;
};

function googleRow(over: Partial<Row> = {}): Row {
  return {
    notes: "Google Ads · Lumi Rovaniemi — lumirovaniemi",
    ad_account_id: "acc-1",
    occurred_on: "2026-08-02",
    ...over,
  };
}

function bound(rows: Row[], boundaries: [string, LedgerBoundary][] = []) {
  return boundCommissionLedger(rows, new Map(boundaries));
}

describe("boundCommissionLedger", () => {
  it("drops a Google row that carries no account binding", () => {
    // The 2026-07-31..08-02 onboarding artifacts: account-less rows that
    // duplicated spend the bound rows already recorded.
    expect(bound([googleRow({ ad_account_id: null })])).toEqual([]);
  });

  it("drops Google spend observed before the account's immutable start", () => {
    const preStart = googleRow({ occurred_on: "2026-07-31" });
    const entryDay = googleRow({ occurred_on: "2026-08-02" });

    expect(
      bound([preStart, entryDay], [["acc-1", { start: "2026-08-02" }]]),
    ).toEqual([entryDay]);
  });

  it("drops Google spend observed after the account's billing end", () => {
    const beforeEnd = googleRow({ occurred_on: "2026-08-01" });
    const afterEnd = googleRow({ occurred_on: "2026-08-03" });

    expect(
      bound(
        [beforeEnd, afterEnd],
        [["acc-1", { start: "2026-07-27", end: "2026-08-02" }]],
      ),
    ).toEqual([beforeEnd]);
  });

  it("keeps history for accounts that predate the boundary discipline", () => {
    const legacy = googleRow({ occurred_on: "2026-06-01" });

    expect(bound([legacy])).toEqual([legacy]);
  });

  it("never touches non-Google revenue sources", () => {
    const hst = {
      notes: "HST · РАЯ НИКОЛОВА",
      ad_account_id: null,
      occurred_on: "2026-08-01",
    };
    const revShare = {
      notes: "Revenue share · Lumi Rovaniemi — lumirovaniemi",
      ad_account_id: null,
      occurred_on: "2026-07-01",
    };

    expect(bound([hst, revShare])).toEqual([hst, revShare]);
  });
});

describe("ledgerBoundaries", () => {
  it("keeps the earliest start and the latest end per account", () => {
    const boundaries = ledgerBoundaries(
      [
        { ad_account_id: "acc-1", google_local_date: "2026-08-02" },
        { ad_account_id: "acc-1", google_local_date: "2026-07-27" },
      ],
      [
        { ad_account_id: "acc-1", google_local_date: "2026-08-01" },
        { ad_account_id: "acc-1", google_local_date: "2026-08-03" },
      ],
    );

    expect(boundaries.get("acc-1")).toEqual({
      start: "2026-07-27",
      end: "2026-08-03",
    });
  });
});
