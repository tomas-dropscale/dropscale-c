import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../google-ads/client", () => ({ searchGoogleAdsAsAgency: vi.fn() }));

import {
  accountCommissionTermsForDate,
  billableGoogleMicros,
  billableGoogleSpendWindow,
  billingBoundaryMicros,
  canonicalEuroMicros,
  completeGoogleMicrosWindow,
  eurosToMicros,
  matchesAuthoritativeGoogleSpend,
  manualReferralRateForDate,
  microsToEuroNumber,
  needsGoogleLedgerRewrite,
  storeBindingsForLedger,
} from "./commission-sync-logic";

describe("manual referral rates", () => {
  const base = {
    effectiveFrom: "2026-08-03",
    revision: 1,
    referralCount: 2,
    listRate: 10,
    stepRate: 0.5,
    discountRate: 1,
    feeRate: 9,
  };

  it("uses 10% before the effective Monday and the manual rate from Monday onward", () => {
    expect(manualReferralRateForDate("2026-08-02", [base])).toBe(10);
    expect(manualReferralRateForDate("2026-08-03", [base])).toBe(9);
    expect(manualReferralRateForDate("2026-08-09", [base])).toBe(9);
  });

  it("uses the latest revision without applying a future Monday early", () => {
    const revision = {
      ...base,
      revision: 2,
      referralCount: 3,
      discountRate: 1.5,
      feeRate: 8.5,
    };
    const future = {
      ...base,
      effectiveFrom: "2026-08-10",
      referralCount: 4,
      discountRate: 2,
      feeRate: 8,
    };

    expect(
      manualReferralRateForDate("2026-08-09", [base, revision, future]),
    ).toBe(8.5);
    expect(
      manualReferralRateForDate("2026-08-10", [base, revision, future]),
    ).toBe(8);
  });

  it("fails closed on a term whose stored arithmetic is inconsistent", () => {
    expect(() =>
      manualReferralRateForDate("2026-08-03", [{ ...base, feeRate: 8.99 }]),
    ).toThrow("Invalid sealed manual referral term");
  });
});

describe("account commission terms", () => {
  const referral = {
    effectiveFrom: "2026-08-03",
    revision: 1,
    referralCount: 2,
    listRate: 10,
    stepRate: 0.5,
    discountRate: 1,
    feeRate: 9,
  };
  const manual = {
    id: "term-12",
    effectiveFrom: "2026-08-10",
    revision: 1,
    listRate: 12,
  };

  it("keeps the audited 10% default, then treats a custom list rate as an override", () => {
    expect(
      accountCommissionTermsForDate("2026-08-09", [manual], [referral]),
    ).toEqual({
      commissionTermId: null,
      pricingMode: "referral",
      listRate: 10,
      referralCount: 2,
      referralDiscountRate: 1,
      feeRate: 9,
    });
    expect(
      accountCommissionTermsForDate("2026-08-10", [manual], [referral]),
    ).toEqual({
      commissionTermId: "term-12",
      pricingMode: "manual",
      listRate: 12,
      referralCount: 0,
      referralDiscountRate: 0,
      feeRate: 12,
    });
  });

  it("uses the latest Monday revision and reactivates referrals after a reset to 10%", () => {
    const reset = { ...manual, id: "term-reset", revision: 2, listRate: 10 };
    expect(
      accountCommissionTermsForDate("2026-08-10", [manual, reset], [referral]),
    ).toMatchObject({
      commissionTermId: "term-reset",
      pricingMode: "referral",
      referralCount: 2,
      feeRate: 9,
    });
  });

  it("keeps the sealed count after the referral discount reaches its floor", () => {
    expect(
      accountCommissionTermsForDate(
        "2026-08-10",
        [],
        [
          {
            ...referral,
            referralCount: 25,
            discountRate: 10,
            feeRate: 0,
          },
        ],
      ),
    ).toMatchObject({
      pricingMode: "referral",
      referralCount: 25,
      referralDiscountRate: 10,
      feeRate: 0,
    });
  });

  it("accepts an exact hundredth that is inexact in binary floating point", () => {
    expect(
      accountCommissionTermsForDate(
        "2026-08-10",
        [{ ...manual, id: "term-995", listRate: 9.95 }],
        [referral],
      ),
    ).toMatchObject({ pricingMode: "manual", feeRate: 9.95 });
  });

  it("fails closed on malformed account terms", () => {
    expect(() =>
      accountCommissionTermsForDate(
        "2026-08-10",
        [{ ...manual, listRate: 12.345 }],
        [],
      ),
    ).toThrow("Invalid sealed account commission term");
  });
});

describe("completeGoogleMicrosWindow", () => {
  it("fills omitted Google Ads days with an exact zero", () => {
    expect(
      completeGoogleMicrosWindow("2026-07-20", "2026-07-22", [
        { date: "2026-07-20", costMicros: "125400000" },
        { date: "2026-07-22", costMicros: "90000000" },
      ]),
    ).toEqual([
      { date: "2026-07-20", costMicros: "125400000" },
      { date: "2026-07-21", costMicros: "0" },
      { date: "2026-07-22", costMicros: "90000000" },
    ]);
  });

  it("crosses month boundaries without the server timezone", () => {
    expect(completeGoogleMicrosWindow("2026-07-31", "2026-08-01", [])).toEqual([
      { date: "2026-07-31", costMicros: "0" },
      { date: "2026-08-01", costMicros: "0" },
    ]);
  });
});

describe("immutable billing baseline", () => {
  const start = {
    googleLocalDate: "2026-07-21",
    baselineCostMicros: "100000001",
  };

  it("bills only Thursday's post-signup delta, then Friday through Sunday in full", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-08-03",
        "2026-08-09",
        [
          { date: "2026-08-03", costMicros: "11000000" },
          { date: "2026-08-04", costMicros: "22000000" },
          { date: "2026-08-05", costMicros: "33000000" },
          { date: "2026-08-06", costMicros: "125000000" },
          { date: "2026-08-07", costMicros: "41000000" },
          { date: "2026-08-08", costMicros: "52000000" },
          { date: "2026-08-09", costMicros: "63000000" },
        ],
        {
          googleLocalDate: "2026-08-06",
          baselineCostMicros: "100000000",
        },
      ),
    ).toEqual([
      {
        date: "2026-08-06",
        rawCostMicros: "125000000",
        billableCostMicros: "25000000",
      },
      {
        date: "2026-08-07",
        rawCostMicros: "41000000",
        billableCostMicros: "41000000",
      },
      {
        date: "2026-08-08",
        rawCostMicros: "52000000",
        billableCostMicros: "52000000",
      },
      {
        date: "2026-08-09",
        rawCostMicros: "63000000",
        billableCostMicros: "63000000",
      },
    ]);
  });

  it("bills only Sunday's post-signup delta when tracking starts on Sunday", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-08-03",
        "2026-08-09",
        [
          { date: "2026-08-03", costMicros: "11000000" },
          { date: "2026-08-08", costMicros: "52000000" },
          { date: "2026-08-09", costMicros: "63000000" },
        ],
        {
          googleLocalDate: "2026-08-09",
          baselineCostMicros: "58000000",
        },
      ),
    ).toEqual([
      {
        date: "2026-08-09",
        rawCostMicros: "63000000",
        billableCostMicros: "5000000",
      },
    ]);
  });

  it("excludes earlier days, subtracts only the first day and keeps later days whole", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-07-20",
        "2026-07-23",
        [
          { date: "2026-07-20", costMicros: "90000000" },
          { date: "2026-07-21", costMicros: "125000003" },
          { date: "2026-07-22", costMicros: "50000007" },
        ],
        start,
      ),
    ).toEqual([
      {
        date: "2026-07-21",
        rawCostMicros: "125000003",
        billableCostMicros: "25000002",
      },
      {
        date: "2026-07-22",
        rawCostMicros: "50000007",
        billableCostMicros: "50000007",
      },
      { date: "2026-07-23", rawCostMicros: "0", billableCostMicros: "0" },
    ]);
  });

  it("keeps the raw restated counter but floors a below-baseline fee base at zero", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-07-21",
        "2026-07-21",
        [{ date: "2026-07-21", costMicros: "99000000" }],
        start,
      ),
    ).toEqual([
      {
        date: "2026-07-21",
        rawCostMicros: "99000000",
        billableCostMicros: "0",
      },
    ]);
  });

  it("returns no financial days for a period wholly before the start", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-07-13",
        "2026-07-19",
        [{ date: "2026-07-19", costMicros: "1000000" }],
        start,
      ),
    ).toEqual([]);
  });

  it("preserves a huge raw counter and delta without floating-point loss", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-07-21",
        "2026-07-21",
        [{ date: "2026-07-21", costMicros: "9007199254740993123" }],
        {
          googleLocalDate: "2026-07-21",
          baselineCostMicros: "9007199254740993000",
        },
      ),
    ).toEqual([
      {
        date: "2026-07-21",
        rawCostMicros: "9007199254740993123",
        billableCostMicros: "123",
      },
    ]);
  });

  it("keeps the raw final-day spend but caps its billable base at the end counter", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-08-03",
        "2026-08-09",
        [
          { date: "2026-08-05", costMicros: "30000000" },
          { date: "2026-08-06", costMicros: "150000000" },
          { date: "2026-08-07", costMicros: "90000000" },
        ],
        { googleLocalDate: "2026-08-05", baselineCostMicros: "10000000" },
        { googleLocalDate: "2026-08-06", endCostMicros: "100000000" },
      ),
    ).toEqual([
      {
        date: "2026-08-05",
        rawCostMicros: "30000000",
        billableCostMicros: "20000000",
      },
      {
        date: "2026-08-06",
        rawCostMicros: "150000000",
        billableCostMicros: "100000000",
      },
    ]);
  });

  it("subtracts the opening counter after applying a same-day end cap", () => {
    expect(
      billableGoogleSpendWindow(
        "2026-08-06",
        "2026-08-09",
        [{ date: "2026-08-06", costMicros: "150000000" }],
        { googleLocalDate: "2026-08-06", baselineCostMicros: "40000000" },
        { googleLocalDate: "2026-08-06", endCostMicros: "100000000" },
      ),
    ).toEqual([
      {
        date: "2026-08-06",
        rawCostMicros: "150000000",
        billableCostMicros: "60000000",
      },
    ]);
  });

  it("keeps raw weekly spend and records the closing cap as a separate deduction", () => {
    expect(
      billingBoundaryMicros({
        sourceMicros: BigInt(180_000_000),
        startDayMicros: BigInt(30_000_000),
        baselineMicros: "10000000",
        openingApplied: true,
        endDayMicros: BigInt(150_000_000),
        endCostMicros: "100000000",
        endingApplied: true,
      }),
    ).toEqual({
      openingDeductionMicros: BigInt(10_000_000),
      endDeductionMicros: BigInt(50_000_000),
      billableMicros: BigInt(120_000_000),
    });
  });

  it("uses the capped value before the baseline when start and end share a day", () => {
    expect(
      billingBoundaryMicros({
        sourceMicros: BigInt(150_000_000),
        startDayMicros: BigInt(150_000_000),
        baselineMicros: "40000000",
        openingApplied: true,
        endDayMicros: BigInt(150_000_000),
        endCostMicros: "100000000",
        endingApplied: true,
        sameBoundaryDay: true,
      }),
    ).toEqual({
      openingDeductionMicros: BigInt(40_000_000),
      endDeductionMicros: BigInt(50_000_000),
      billableMicros: BigInt(60_000_000),
    });
  });

  it("exposes stable exact helpers to the invoice path", () => {
    expect(eurosToMicros("1.045001")).toBe(BigInt(1_045_001));
    expect(canonicalEuroMicros(1.045)).toBe("1.045000");
    expect(microsToEuroNumber("1045000")).toBe(1.045);
    expect(billableGoogleMicros("90", "2026-07-20", "2026-07-21", "100")).toBe(
      BigInt(0),
    );
    expect(billableGoogleMicros("125", "2026-07-21", "2026-07-21", "100")).toBe(
      BigInt(25),
    );
    expect(billableGoogleMicros("125", "2026-07-22", "2026-07-21", "100")).toBe(
      BigInt(125),
    );
  });
});

describe("needsGoogleLedgerRewrite", () => {
  const next = {
    grossAmount: "100.000001",
    amount: "10.000000",
    rate: 10,
    currency: "EUR",
  };

  it("re-confirms a row even when its arithmetic is unchanged", () => {
    expect(needsGoogleLedgerRewrite({ ...next, status: "pending" }, next)).toBe(
      true,
    );
  });

  it("leaves an already-confirmed exact row untouched", () => {
    expect(
      needsGoogleLedgerRewrite({ ...next, status: "confirmed" }, next),
    ).toBe(false);
  });

  it("detects a one-micro raw restatement or a first-day fee-base change", () => {
    expect(
      needsGoogleLedgerRewrite(
        { ...next, status: "confirmed" },
        { ...next, grossAmount: "100.000002" },
      ),
    ).toBe(true);
    expect(
      needsGoogleLedgerRewrite(
        { ...next, status: "confirmed" },
        { ...next, amount: "0.000000" },
      ),
    ).toBe(true);
  });
});

describe("matchesAuthoritativeGoogleSpend", () => {
  const google = [
    {
      date: "2026-07-20",
      rawCostMicros: "1045001",
      billableCostMicros: "1",
    },
    { date: "2026-07-21", rawCostMicros: "0", billableCostMicros: "0" },
  ];

  it("compares the raw first-day counter, not its much smaller billable delta", () => {
    expect(
      matchesAuthoritativeGoogleSpend(
        google,
        [
          {
            occurred_on: "2026-07-20",
            gross_amount: "1.045001",
            currency: "EUR",
          },
        ],
        "EUR",
      ),
    ).toBe(true);
  });

  it("allows an omitted zero day but requires every positive raw day", () => {
    expect(matchesAuthoritativeGoogleSpend(google, [], "EUR")).toBe(false);
    expect(
      matchesAuthoritativeGoogleSpend(
        [{ date: "2026-07-21", rawCostMicros: "0", billableCostMicros: "0" }],
        [],
        "EUR",
      ),
    ).toBe(true);
  });

  it("rejects a one-micro stale value, foreign currency or unexpected day", () => {
    expect(
      matchesAuthoritativeGoogleSpend(
        google,
        [
          {
            occurred_on: "2026-07-20",
            gross_amount: "1.045000",
            currency: "EUR",
          },
        ],
        "EUR",
      ),
    ).toBe(false);
    expect(
      matchesAuthoritativeGoogleSpend(
        google,
        [
          {
            occurred_on: "2026-07-20",
            gross_amount: "1.045001",
            currency: "USD",
          },
        ],
        "EUR",
      ),
    ).toBe(false);
    expect(
      matchesAuthoritativeGoogleSpend(
        google,
        [
          {
            occurred_on: "2026-07-22",
            gross_amount: "1.045001",
            currency: "EUR",
          },
        ],
        "EUR",
      ),
    ).toBe(false);
  });
});

describe("which binding says whose spend this is", () => {
  let nextId = 0;
  const row = (over = {}) => ({
    id: `binding-${(nextId += 1)}`,
    ad_account_id: "acct-1",
    shopify_connection_id: null,
    shopify_anchor_binding_id: null,
    status: "active",
    bound_at: "2026-08-01T00:00:00.000Z",
    revoked_at: null,
    ...over,
  });
  /** Every revoked row in the fixture carries retirement evidence. */
  const evidenced = (rows: { id: string; status: string }[]) =>
    new Set(rows.filter((r) => r.status === "revoked").map((r) => r.id));

  it("keeps a retired child attributed to the store it spent for", () => {
    // The account stays readable after retirement so its own weeks can still
    // be certified. Reading it with no store would bill a shared Google
    // account whole to the one store that remains.
    const rows = [
      row({ status: "revoked", shopify_anchor_binding_id: "anchor-1", revoked_at: "2026-09-01T00:00:00.000Z" }),
    ];
    const { bindings, retiredBoundAccountIds } = storeBindingsForLedger(rows, evidenced(rows));
    expect(bindings[0]!.shopify_anchor_binding_id).toBe("anchor-1");
    expect(retiredBoundAccountIds.has("acct-1")).toBe(true);
  });

  it("leaves a plainly UNBOUND account exactly as it was", () => {
    // A pre-cutover unbind leaves the same revoked row on an account still
    // under contract and still billing. Reading its dead store would rewrite
    // live commissions down to campaigns that store no longer runs, so only a
    // lifecycle RPC's own immutable evidence may speak for a revoked binding.
    const rows = [
      row({ status: "revoked", shopify_connection_id: "shop-gone", revoked_at: "2026-09-01T00:00:00.000Z" }),
    ];
    const { bindings, retiredBoundAccountIds } = storeBindingsForLedger(rows, new Set());
    expect(bindings).toEqual([]);
    expect(retiredBoundAccountIds.has("acct-1")).toBe(false);
  });

  it("treats a STAGED binding as live, so its account is not read as retired", () => {
    const rows = [
      row({ status: "revoked", shopify_anchor_binding_id: "anchor-old", revoked_at: "2026-08-10T00:00:00.000Z" }),
      row({ status: "staged", shopify_anchor_binding_id: "anchor-new" }),
    ];
    const { bindings, retiredBoundAccountIds } = storeBindingsForLedger(rows, evidenced(rows));
    expect(bindings[0]!.shopify_anchor_binding_id).toBe("anchor-new");
    expect(retiredBoundAccountIds.has("acct-1")).toBe(false);
  });

  it("lets a LIVE binding with no store beat a dead one that names a store", () => {
    // An account deliberately bound to no store reads whole. A binding it left
    // behind must not filter live spend to a store it no longer reports for,
    // whichever order the rows arrive in.
    const dead = row({
      status: "revoked",
      shopify_anchor_binding_id: "old-anchor",
      bound_at: "2026-07-01T00:00:00.000Z",
      revoked_at: "2026-08-01T00:00:00.000Z",
    });
    const live = row({ status: "active", bound_at: "2026-08-01T00:00:00.000Z" });
    for (const rows of [[dead, live], [live, dead]]) {
      const { bindings, retiredBoundAccountIds } = storeBindingsForLedger(rows, evidenced(rows));
      expect(bindings).toEqual([]);
      expect(retiredBoundAccountIds.has("acct-1")).toBe(false);
    }
  });

  it("picks the LAST store a retired account reported for, whatever the row order", () => {
    // An account can be rebound from one store to another before it is
    // retired. Row arrival order decides which store gets billed and it is not
    // stable between runs, so it must decide nothing.
    const older = row({
      status: "revoked",
      shopify_anchor_binding_id: "anchor-old",
      bound_at: "2026-06-01T00:00:00.000Z",
      revoked_at: "2026-07-01T00:00:00.000Z",
    });
    const newer = row({
      status: "revoked",
      shopify_anchor_binding_id: "anchor-new",
      bound_at: "2026-07-01T00:00:00.000Z",
      revoked_at: "2026-09-01T00:00:00.000Z",
    });
    for (const rows of [[older, newer], [newer, older]]) {
      const { bindings } = storeBindingsForLedger(rows, evidenced(rows));
      expect(bindings[0]!.shopify_anchor_binding_id).toBe("anchor-new");
    }
  });

  it("orders by the instant, not by the text of the timestamp", () => {
    // Postgres does not promise one spelling: fractional digits vary and an
    // offset may be written "+00:00", "Z" or a real zone. Read as text the
    // pair below inverts - "11:00" sorts before "12:00" - and the fee lands on
    // the store the account had LEFT.
    const older = row({
      status: "revoked",
      shopify_anchor_binding_id: "anchor-old",
      bound_at: "2026-07-01T12:00:00+02:00",
      revoked_at: null,
    });
    const newer = row({
      status: "revoked",
      shopify_anchor_binding_id: "anchor-new",
      bound_at: "2026-07-01T11:00:00Z",
      revoked_at: null,
    });
    for (const rows of [[older, newer], [newer, older]]) {
      const { bindings } = storeBindingsForLedger(rows, evidenced(rows));
      expect(bindings[0]!.shopify_anchor_binding_id).toBe("anchor-new");
    }
  });

  it("leaves an account bound to no store alone, live or not", () => {
    // An unallocated account has no store to filter to and never had one, so
    // it still reads whole and is not treated as retired. A legacy account,
    // with no binding row at all, lands the same way.
    const rows = [row()];
    const { bindings, retiredBoundAccountIds } = storeBindingsForLedger(rows, evidenced(rows));
    expect(bindings).toEqual([]);
    expect(retiredBoundAccountIds.has("acct-1")).toBe(false);
    expect(storeBindingsForLedger([], new Set()).retiredBoundAccountIds.size).toBe(0);
  });

  it("keeps accounts apart", () => {
    const rows = [
      row({ shopify_connection_id: "shop-1" }),
      row({ ad_account_id: "acct-2", status: "revoked", shopify_anchor_binding_id: "anchor-2" }),
    ];
    const { bindings } = storeBindingsForLedger(rows, evidenced(rows));
    expect(bindings.map((b) => b.ad_account_id).sort()).toEqual(["acct-1", "acct-2"]);
  });
});
