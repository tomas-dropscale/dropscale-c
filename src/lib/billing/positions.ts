import {
  addDays,
  agencyFee,
  BILLING_CURRENCY,
  isoDay,
  mondayOf,
  round2,
} from "./weekly";

export type BillingPositionReferralTerm = {
  effectiveFrom: string;
  revision: number;
  referralCount: number;
  listRate: number;
  stepRate: number;
  discountRate: number;
  feeRate: number;
};

const ZERO = BigInt(0);
const MICROS = BigInt(1_000_000);

function decimalToMicros(value: string | number): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value).trim());
  if (!match) throw new RangeError("Billing money must have at most six decimals.");
  return BigInt(match[1]) * MICROS + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function integerMicros(value: string | number): bigint {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new RangeError("Google boundary must be integer micros.");
  }
  return BigInt(text);
}

function billableGoogleMicros(
  rawMicros: bigint,
  date: string,
  startDate: string,
  baselineMicros: string | number,
  end?: { googleLocalDate: string; endCostMicros: string | number },
): bigint {
  if (date < startDate || (end && date > end.googleLocalDate)) return ZERO;
  const endMicros = end ? integerMicros(end.endCostMicros) : ZERO;
  const capped = end && date === end.googleLocalDate && rawMicros > endMicros
    ? endMicros
    : rawMicros;
  if (date !== startDate) return capped;
  const baseline = integerMicros(baselineMicros);
  return capped > baseline ? capped - baseline : ZERO;
}

function manualReferralRateForDate(
  date: string,
  terms: BillingPositionReferralTerm[],
): number {
  const term = terms
    .filter((candidate) => candidate.effectiveFrom <= date)
    .sort((left, right) =>
      left.effectiveFrom === right.effectiveFrom
        ? right.revision - left.revision
        : right.effectiveFrom.localeCompare(left.effectiveFrom),
    )[0];
  if (!term) return 10;
  const expectedDiscount = Math.min(10, term.referralCount * 0.5);
  if (
    !Number.isSafeInteger(term.referralCount) ||
    term.referralCount < 0 ||
    term.listRate !== 10 ||
    term.stepRate !== 0.5 ||
    term.discountRate !== expectedDiscount ||
    term.feeRate !== 10 - expectedDiscount
  ) {
    throw new RangeError("Invalid sealed manual referral term.");
  }
  return term.feeRate;
}

export type BillingPositionClient = {
  id: string;
  fullName: string;
  email: string;
};

export type BillingPositionAccount = {
  id: string;
  clientId: string;
  storeName: string;
  createdAt: string;
  currency: string;
};

export type BillingPositionStart = {
  id: string;
  accountId: string;
  basis: "observed_google_counter" | "reviewed_full_day";
  googleLocalDate: string;
  /** Null only for a reviewed full-day start, which has no Google counter. */
  baselineCostMicros: string | number | null;
};

/** Immutable account-level proof from an approved historical rollover. */
export type BillingPositionReviewedEntry = {
  accountId: string;
  entryDay: string;
};

export type BillingPositionEnd = {
  accountId: string;
  googleLocalDate: string;
  endCostMicros: string | number;
};

export type BillingPositionMetricRow = {
  accountId: string;
  day: string;
  adSpend: string | number;
  computedAt: string;
};

export type BillingPositionInvoice = {
  clientId: string;
  periodStart: string;
  periodEnd?: string | null;
  currency: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | "waived";
  amount: string | number;
  amountRemaining: string | number | null;
  issuedAt: string | null;
  dueDate?: string | null;
  calculationVersion: string;
  issueError?: string | null;
  paymentFailedAt?: string | null;
};

/**
 * One pending closed week in a client's position — the per-week answer to
 * "which cycles does this client still owe". Settled weeks (paid, waived,
 * legitimately void) never appear here.
 */
export type BillingClosedWeekEntry = {
  periodStart: string;
  periodEnd: string;
  amount: number;
  state: "unissued" | "draft" | "open" | "failed" | "skipped";
  /** Whole days past the invoice due date; 0 unless state is "open". */
  overdueDays: number;
};

/**
 * One exact, positive client/week receivable that passed its own immutable
 * evidence contract. Raw Google ledger rows are deliberately not accepted by
 * the position builder: a confirmed row can still belong to a partial sync.
 */
export type BillingPositionCertifiedClosedAmount = {
  clientId: string;
  periodStart: string;
  periodEnd: string;
  amount: string | number;
  currency: string;
  source: "automatic_v3" | "historical_rollover_v1";
  certifiedAt: string;
};

export type BillingClientPosition = {
  clientId: string;
  clientName: string;
  email: string;
  currency: typeof BILLING_CURRENCY;
  closed: {
    through: string;
    /** Compatibility field; now equal to the exact certified unissued amount. */
    unissuedEstimate: number;
    /** Exact certified closed amount not yet represented by an issued invoice. */
    supportedUnissued: number;
    /** Compatibility field; unresolved rows never enter the closed balance. */
    needsEntryReview: number;
    issuedOutstanding: number;
    /** Portion of issuedOutstanding whose invoice is past its due date. */
    overdueOutstanding: number;
    /** Compatibility field; written-off balances are not collectible. */
    failedNotReceived: number;
    supportedNotReceived: number;
    maximumNotReceived: number;
    periodCount: number;
    missingStartCount: number;
    needsAttentionCount: number;
    lastLedgerUpdate: string | null;
    /** Pending closed weeks, oldest first. */
    weeks: BillingClosedWeekEntry[];
  };
  current: {
    periodStart: string;
    periodEnd: string;
    through: string | null;
    grossSpend: number;
    accruedFee: number;
    /** The team decided this in-flight cycle will not be billed. */
    skipped: boolean;
    needsEntryReview: number;
    missingStartCount: number;
    updatedAt: string | null;
  };
};

export type BillingPositionSummary = {
  closedUnissuedEstimate: number;
  closedSupportedUnissued: number;
  closedNeedsEntryReview: number;
  issuedOutstanding: number;
  overdueOutstanding: number;
  failedNotReceived: number;
  supportedNotReceived: number;
  maximumNotReceived: number;
  currentGrossSpend: number;
  currentAccruedFee: number;
  clientsNeedingEntryReview: number;
  clientsNeedingAttention: number;
  clientsOverdue: number;
};

export type BillingPositions = {
  closedThrough: string;
  currentPeriod: { start: string; end: string };
  summary: BillingPositionSummary;
  clients: BillingClientPosition[];
};

type PositionInput = {
  now: Date;
  clients: BillingPositionClient[];
  accounts: BillingPositionAccount[];
  starts: BillingPositionStart[];
  reviewedFullDayEntries?: BillingPositionReviewedEntry[];
  ends: BillingPositionEnd[];
  certifiedClosedAmounts: BillingPositionCertifiedClosedAmount[];
  metricRows: BillingPositionMetricRow[];
  invoices: BillingPositionInvoice[];
  referralTermsByClient?: Map<string, BillingPositionReferralTerm[]>;
  /** Durable non-terminal automatic client/week work, reduced to client scope. */
  automationAttentionClientIds?: Iterable<string>;
  /** `clientId:periodStart` weeks an admin decided are not owed. */
  skippedWeeks?: Iterable<string>;
};

function newest(left: string | null, right: string): string {
  return !left || right > left ? right : left;
}

function euroNumber(micros: bigint): number {
  const whole = micros / MICROS;
  const fraction = (micros % MICROS).toString().padStart(6, "0");
  return Number(`${whole}.${fraction}`);
}

function validPositionStart(
  start: BillingPositionStart | undefined,
): BillingPositionStart | null {
  if (!start) return null;
  if (start.basis === "reviewed_full_day") {
    return start.baselineCostMicros === null ? start : null;
  }
  return start.baselineCostMicros !== null ? start : null;
}

function openingBaseline(start: BillingPositionStart | null): string | number {
  return start?.basis === "observed_google_counter"
    ? start.baselineCostMicros!
    : 0;
}

function invoiceOccupiesCertifiedWeek(
  invoice: BillingPositionInvoice,
): boolean {
  // The v3 cutover deliberately preserved never-issued legacy voids as audit
  // rows. They neither settle nor suppress the one certified historical rollover.
  if (
    invoice.status === "void" &&
    invoice.calculationVersion === "legacy" &&
    invoice.issuedAt === null
  ) {
    return false;
  }
  return (
    (invoice.status === "open" && invoice.issuedAt !== null) ||
    invoice.status === "paid" ||
    invoice.status === "void" ||
    invoice.status === "uncollectible" ||
    invoice.status === "waived"
  );
}

function exactClosedWeek(
  periodStart: string,
  periodEnd: string,
  closedThrough: string,
): boolean {
  const parsed = new Date(`${periodStart}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(periodStart) &&
    /^\d{4}-\d{2}-\d{2}$/.test(periodEnd) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === periodStart &&
    parsed.getUTCDay() === 1 &&
    periodEnd === addDays(periodStart, 6) &&
    periodEnd <= closedThrough
  );
}

function currentWeek(now: Date): { start: string; end: string } {
  const start = mondayOf(now);
  return { start, end: addDays(start, 6) };
}

/**
 * Build the admin's financial position without turning estimates into debts.
 *
 * Closed money enters only as a client/week snapshot certified by the exact
 * automatic v3 proof or the isolated historical rollover. Confirmed Google rows are
 * never sufficient by themselves. Current-week values still come from the
 * dashboard's latest daily Google read model and remain visibly provisional.
 */
export function buildBillingPositions(input: PositionInput): BillingPositions {
  if (!Number.isFinite(input.now.getTime())) {
    throw new RangeError("Billing position requires a valid current time.");
  }

  const currentPeriod = currentWeek(input.now);
  const today = isoDay(input.now);
  const closedThrough = addDays(currentPeriod.start, -1);
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const startsByAccount = new Map(input.starts.map((start) => [start.accountId, start]));
  const reviewedEntryByAccount = new Map(
    (input.reviewedFullDayEntries ?? []).map((entry) => [entry.accountId, entry]),
  );
  const endsByAccount = new Map(input.ends.map((end) => [end.accountId, end]));
  const termsByClient = input.referralTermsByClient ?? new Map();
  const skippedWeeks = new Set(input.skippedWeeks ?? []);
  const occupiedInvoiceWeeks = new Set(
    input.invoices
      .filter(invoiceOccupiesCertifiedWeek)
      .map((invoice) => `${invoice.clientId}:${invoice.periodStart}`),
  );

  type MutablePosition = BillingClientPosition & {
    closedPeriodStarts: Set<string>;
    /** Weeks materialised by an invoice; wins over the certified entry. */
    invoiceWeeks: Map<string, BillingClosedWeekEntry>;
    /** Certified weeks no invoice occupies yet. */
    unissuedWeeks: Map<string, BillingClosedWeekEntry>;
  };
  const positions = new Map<string, MutablePosition>();
  for (const client of input.clients) {
    positions.set(client.id, {
      clientId: client.id,
      clientName: client.fullName,
      email: client.email,
      currency: BILLING_CURRENCY,
      closed: {
        through: closedThrough,
        unissuedEstimate: 0,
        supportedUnissued: 0,
        needsEntryReview: 0,
        issuedOutstanding: 0,
        overdueOutstanding: 0,
        failedNotReceived: 0,
        supportedNotReceived: 0,
        maximumNotReceived: 0,
        periodCount: 0,
        missingStartCount: 0,
        needsAttentionCount: 0,
        lastLedgerUpdate: null,
        weeks: [],
      },
      current: {
        periodStart: currentPeriod.start,
        periodEnd: currentPeriod.end,
        through: null,
        grossSpend: 0,
        accruedFee: 0,
        skipped: false,
        needsEntryReview: 0,
        missingStartCount: 0,
        updatedAt: null,
      },
      closedPeriodStarts: new Set(),
      invoiceWeeks: new Map(),
      unissuedWeeks: new Map(),
    });
  }

  for (const account of input.accounts) {
    const position = positions.get(account.clientId);
    if (!position) continue;
    const storedStart = startsByAccount.get(account.id);
    const start = validPositionStart(storedStart);
    const candidateStart = start?.googleLocalDate ?? isoDay(new Date(account.createdAt));
    const reviewedEntry = reviewedEntryByAccount.get(account.id);
    const hasReviewedFullDay =
      !storedStart && reviewedEntry?.entryDay === candidateStart;
    if (
      !start &&
      !hasReviewedFullDay &&
      candidateStart <= closedThrough
    ) {
      position.closed.missingStartCount += 1;
    }
    if (
      !start &&
      !hasReviewedFullDay &&
      candidateStart <= today
    ) {
      position.current.missingStartCount += 1;
    }
  }

  for (const position of positions.values()) {
    if (
      position.closed.missingStartCount > 0 ||
      position.current.missingStartCount > 0
    ) {
      // The compact dashboard needs one client-level attention signal, not a
      // duplicate warning for every account and every period.
      position.closed.needsAttentionCount = Math.max(
        1,
        position.closed.needsAttentionCount,
      );
    }
  }

  for (const clientId of new Set(input.automationAttentionClientIds ?? [])) {
    const position = positions.get(clientId);
    if (position) {
      position.closed.needsAttentionCount = Math.max(
        1,
        position.closed.needsAttentionCount,
      );
    }
  }

  const certifiedWeeks = new Set<string>();
  for (const certified of input.certifiedClosedAmounts) {
    const position = positions.get(certified.clientId);
    if (!position) continue;
    const key = `${certified.clientId}:${certified.periodStart}`;
    if (certifiedWeeks.has(key)) {
      throw new RangeError(
        "A client/week cannot have more than one certified closed amount.",
      );
    }
    certifiedWeeks.add(key);

    const amount = Number(certified.amount);
    if (
      !["automatic_v3", "historical_rollover_v1"].includes(certified.source) ||
      certified.currency.toUpperCase() !== BILLING_CURRENCY ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      round2(amount) !== amount ||
      !exactClosedWeek(
        certified.periodStart,
        certified.periodEnd,
        closedThrough,
      ) ||
      !Number.isFinite(new Date(certified.certifiedAt).getTime())
    ) {
      throw new RangeError("Invalid certified closed billing amount.");
    }
    if (occupiedInvoiceWeeks.has(key)) continue;

    // Skipped: the certified amount stays visible as evidence of what the
    // week was worth, but it is not money anyone still owes.
    if (skippedWeeks.has(key)) {
      position.unissuedWeeks.set(certified.periodStart, {
        periodStart: certified.periodStart,
        periodEnd: certified.periodEnd,
        amount: round2(
          (position.unissuedWeeks.get(certified.periodStart)?.amount ?? 0) +
            amount,
        ),
        state: "skipped",
        overdueDays: 0,
      });
      position.closedPeriodStarts.add(certified.periodStart);
      continue;
    }

    position.closed.unissuedEstimate = round2(
      position.closed.unissuedEstimate + amount,
    );
    position.closed.supportedUnissued = round2(
      position.closed.supportedUnissued + amount,
    );
    position.unissuedWeeks.set(certified.periodStart, {
      periodStart: certified.periodStart,
      periodEnd: certified.periodEnd,
      amount: round2(
        (position.unissuedWeeks.get(certified.periodStart)?.amount ?? 0) +
          amount,
      ),
      state: "unissued",
      overdueDays: 0,
    });
    position.closedPeriodStarts.add(certified.periodStart);
    position.closed.lastLedgerUpdate = newest(
      position.closed.lastLedgerUpdate,
      certified.certifiedAt,
    );
  }

  for (const invoice of input.invoices) {
    const position = positions.get(invoice.clientId);
    if (!position) continue;
    const remaining = Number(invoice.amountRemaining ?? invoice.amount);
    const isEur = invoice.currency.toUpperCase() === BILLING_CURRENCY;
    if (!Number.isFinite(remaining) || remaining < 0) {
      position.closed.needsAttentionCount = Math.max(
        1,
        position.closed.needsAttentionCount,
      );
      continue;
    }

    const weekEnd = invoice.periodEnd ?? addDays(invoice.periodStart, 6);
    if (invoice.status === "open" && invoice.issuedAt && isEur) {
      position.closed.issuedOutstanding = round2(
        position.closed.issuedOutstanding + remaining,
      );
      const overdueDays =
        invoice.dueDate && invoice.dueDate < today
          ? Math.floor(
              (Date.parse(`${today}T00:00:00.000Z`) -
                Date.parse(`${invoice.dueDate}T00:00:00.000Z`)) /
                86_400_000,
            )
          : 0;
      if (overdueDays > 0) {
        position.closed.overdueOutstanding = round2(
          position.closed.overdueOutstanding + remaining,
        );
      }
      position.invoiceWeeks.set(invoice.periodStart, {
        periodStart: invoice.periodStart,
        periodEnd: weekEnd,
        amount: remaining,
        state: "open",
        overdueDays,
      });
    }

    if (invoice.status === "draft" && isEur) {
      position.invoiceWeeks.set(invoice.periodStart, {
        periodStart: invoice.periodStart,
        periodEnd: weekEnd,
        amount: round2(Number(invoice.amount)),
        state: "draft",
        overdueDays: 0,
      });
    }

    // A written-off invoice occupies its certified week, which suppresses the
    // unissued amount, and it is deliberately excluded from the collectible
    // headline. Without this separate bucket the failed balance would vanish
    // from the per-client position entirely.
    if (invoice.status === "uncollectible" && isEur) {
      position.closed.failedNotReceived = round2(
        position.closed.failedNotReceived + remaining,
      );
      position.invoiceWeeks.set(invoice.periodStart, {
        periodStart: invoice.periodStart,
        periodEnd: weekEnd,
        amount: remaining,
        state: "failed",
        overdueDays: 0,
      });
    }

    if (
      invoice.status === "draft" ||
      invoice.status === "uncollectible" ||
      (invoice.status === "open" && !isEur) ||
      Boolean(invoice.issueError) ||
      Boolean(invoice.paymentFailedAt) ||
      (invoice.status === "open" && !invoice.issuedAt)
    ) {
      position.closed.needsAttentionCount = Math.max(
        1,
        position.closed.needsAttentionCount,
      );
    }
  }

  type CurrentAccount = {
    clientId: string;
    accountId: string;
    totalMicros: bigint;
    unresolvedEntryDayMicros: bigint;
    through: string | null;
    updatedAt: string | null;
  };
  const currentByAccount = new Map<string, CurrentAccount>();
  for (const row of input.metricRows) {
    const account = accountById.get(row.accountId);
    if (
      !account ||
      account.currency.toUpperCase() !== BILLING_CURRENCY ||
      row.day < currentPeriod.start ||
      row.day > today ||
      row.day > currentPeriod.end
    ) {
      continue;
    }
    const storedStart = startsByAccount.get(account.id);
    const start = validPositionStart(storedStart);
    const candidateStart = start?.googleLocalDate ?? isoDay(new Date(account.createdAt));
    const reviewedEntry = reviewedEntryByAccount.get(account.id);
    const hasReviewedFullDay =
      !storedStart && reviewedEntry?.entryDay === candidateStart;
    const end = endsByAccount.get(account.id);
    if (
      row.day < candidateStart ||
      (end && row.day > end.googleLocalDate)
    ) {
      continue;
    }
    const rawMicros = decimalToMicros(row.adSpend);
    const billableMicros = billableGoogleMicros(
      rawMicros,
      row.day,
      candidateStart,
      openingBaseline(start),
      end
        ? {
            googleLocalDate: end.googleLocalDate,
            endCostMicros: end.endCostMicros,
          }
        : undefined,
    );
    const aggregate = currentByAccount.get(account.id) ?? {
      clientId: account.clientId,
      accountId: account.id,
      totalMicros: ZERO,
      unresolvedEntryDayMicros: ZERO,
      through: null,
      updatedAt: null,
    };
    aggregate.totalMicros += billableMicros;
    if (
      !start &&
      !hasReviewedFullDay &&
      row.day === candidateStart
    ) {
      aggregate.unresolvedEntryDayMicros += billableMicros;
    }
    aggregate.through = !aggregate.through || row.day > aggregate.through
      ? row.day
      : aggregate.through;
    aggregate.updatedAt = newest(aggregate.updatedAt, row.computedAt);
    currentByAccount.set(account.id, aggregate);
  }

  for (const aggregate of currentByAccount.values()) {
    const position = positions.get(aggregate.clientId);
    if (!position) continue;
    const rate = manualReferralRateForDate(
      currentPeriod.start,
      termsByClient.get(aggregate.clientId) ?? [],
    );
    const fullFee = agencyFee(euroNumber(aggregate.totalMicros), rate);
    const supportedFee = agencyFee(
      euroNumber(aggregate.totalMicros - aggregate.unresolvedEntryDayMicros),
      rate,
    );
    position.current.grossSpend = round2(
      position.current.grossSpend + euroNumber(aggregate.totalMicros),
    );
    position.current.accruedFee = round2(
      position.current.accruedFee + fullFee,
    );
    position.current.needsEntryReview = round2(
      position.current.needsEntryReview + fullFee - supportedFee,
    );
    if (
      aggregate.through &&
      (!position.current.through || aggregate.through > position.current.through)
    ) {
      position.current.through = aggregate.through;
    }
    if (aggregate.updatedAt) {
      position.current.updatedAt = newest(
        position.current.updatedAt,
        aggregate.updatedAt,
      );
    }
  }

  const clients = [...positions.values()]
    .map(({ closedPeriodStarts, invoiceWeeks, unissuedWeeks, ...position }) => {
      // A skipped in-flight cycle accrues nothing: the Google spend stays
      // visible because it really happened, but there is no fee to bill.
      if (skippedWeeks.has(`${position.clientId}:${currentPeriod.start}`)) {
        position.current.skipped = true;
        position.current.accruedFee = 0;
        position.current.needsEntryReview = 0;
      }
      position.closed.periodCount = closedPeriodStarts.size;
      position.closed.supportedNotReceived = round2(
        position.closed.supportedUnissued +
          position.closed.issuedOutstanding,
      );
      position.closed.maximumNotReceived = round2(
        position.closed.unissuedEstimate +
          position.closed.issuedOutstanding,
      );
      // An invoice-backed entry supersedes the certified one for the same
      // week: the money is the same receivable, now materialised.
      position.closed.weeks = [
        ...[...unissuedWeeks.entries()]
          .filter(([periodStart]) => !invoiceWeeks.has(periodStart))
          .map(([, entry]) => entry),
        ...invoiceWeeks.values(),
      ].sort((left, right) =>
        left.periodStart.localeCompare(right.periodStart),
      );
      return position;
    })
    .sort((left, right) =>
      left.clientName.localeCompare(right.clientName, "en", {
        sensitivity: "base",
      }),
    );

  const sum = (select: (position: BillingClientPosition) => number) =>
    round2(clients.reduce((total, position) => total + select(position), 0));

  return {
    closedThrough,
    currentPeriod,
    summary: {
      closedUnissuedEstimate: sum(
        (position) => position.closed.unissuedEstimate,
      ),
      closedSupportedUnissued: sum(
        (position) => position.closed.supportedUnissued,
      ),
      closedNeedsEntryReview: sum(
        (position) => position.closed.needsEntryReview,
      ),
      issuedOutstanding: sum(
        (position) => position.closed.issuedOutstanding,
      ),
      overdueOutstanding: sum(
        (position) => position.closed.overdueOutstanding,
      ),
      failedNotReceived: sum(
        (position) => position.closed.failedNotReceived,
      ),
      supportedNotReceived: sum(
        (position) => position.closed.supportedNotReceived,
      ),
      maximumNotReceived: sum(
        (position) => position.closed.maximumNotReceived,
      ),
      currentGrossSpend: sum((position) => position.current.grossSpend),
      currentAccruedFee: sum((position) => position.current.accruedFee),
      clientsNeedingEntryReview: clients.filter(
        (position) => position.closed.needsEntryReview > 0,
      ).length,
      clientsNeedingAttention: clients.filter(
        (position) => position.closed.needsAttentionCount > 0,
      ).length,
      clientsOverdue: clients.filter(
        (position) => position.closed.overdueOutstanding > 0,
      ).length,
    },
    clients,
  };
}
