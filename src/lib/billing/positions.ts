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
  googleLocalDate: string;
  baselineCostMicros: string | number;
};

export type BillingPositionEnd = {
  accountId: string;
  googleLocalDate: string;
  endCostMicros: string | number;
};

export type BillingPositionLedgerRow = {
  accountId: string;
  occurredOn: string;
  grossAmount: string | number;
  currency: string;
  updatedAt: string;
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
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | "waived";
  amount: string | number;
  amountRemaining: string | number | null;
  issuedAt: string | null;
  calculationVersion: string;
};

export type BillingClientPosition = {
  clientId: string;
  clientName: string;
  email: string;
  currency: typeof BILLING_CURRENCY;
  closed: {
    through: string;
    /** Full-day upper estimate for every account whose opening counter is missing. */
    unissuedEstimate: number;
    /** Portion that does not depend on an unresolved positive entry day. */
    supportedUnissued: number;
    /** Difference between the full-day estimate and the supported lower bound. */
    needsEntryReview: number;
    issuedOutstanding: number;
    supportedNotReceived: number;
    maximumNotReceived: number;
    periodCount: number;
    missingStartCount: number;
    lastLedgerUpdate: string | null;
  };
  current: {
    periodStart: string;
    periodEnd: string;
    through: string | null;
    grossSpend: number;
    accruedFee: number;
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
  supportedNotReceived: number;
  maximumNotReceived: number;
  currentGrossSpend: number;
  currentAccruedFee: number;
  clientsNeedingEntryReview: number;
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
  ends: BillingPositionEnd[];
  ledgerRows: BillingPositionLedgerRow[];
  metricRows: BillingPositionMetricRow[];
  invoices: BillingPositionInvoice[];
  referralTermsByClient?: Map<string, BillingPositionReferralTerm[]>;
};

type AccountWeek = {
  clientId: string;
  accountId: string;
  weekStart: string;
  totalMicros: bigint;
  unresolvedEntryDayMicros: bigint;
  lastLedgerUpdate: string | null;
};

function newest(left: string | null, right: string): string {
  return !left || right > left ? right : left;
}

function euroNumber(micros: bigint): number {
  const whole = micros / MICROS;
  const fraction = (micros % MICROS).toString().padStart(6, "0");
  return Number(`${whole}.${fraction}`);
}

function activeCommercialInvoice(invoice: BillingPositionInvoice): boolean {
  // The v3 cutover deliberately kept never-issued legacy drafts as void audit
  // rows. They are not settlements and must not hide a still-unbilled week.
  return !(
    invoice.status === "void" &&
    invoice.calculationVersion === "legacy" &&
    invoice.issuedAt === null
  );
}

function currentWeek(now: Date): { start: string; end: string } {
  const start = mondayOf(now);
  return { start, end: addDays(start, 6) };
}

/**
 * Build the admin's financial position without turning estimates into debts.
 *
 * Closed, unissued weeks use the six-decimal Google commission ledger. When a
 * historic account has no immutable opening counter, `createdAt` is only a
 * proposal: the whole first day is included in the upper estimate and split
 * out as `needsEntryReview`. Current-week values come from the dashboard's
 * latest daily Google read model and remain visibly provisional.
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
  const endsByAccount = new Map(input.ends.map((end) => [end.accountId, end]));
  const termsByClient = input.referralTermsByClient ?? new Map();

  const activeInvoiceWeeks = new Set(
    input.invoices
      .filter(activeCommercialInvoice)
      .map((invoice) => `${invoice.clientId}:${invoice.periodStart}`),
  );

  const accountWeeks = new Map<string, AccountWeek>();
  for (const row of input.ledgerRows) {
    const account = accountById.get(row.accountId);
    if (
      !account ||
      account.currency.toUpperCase() !== BILLING_CURRENCY ||
      row.currency.toUpperCase() !== BILLING_CURRENCY
    ) {
      continue;
    }
    if (row.occurredOn > closedThrough) continue;

    const start = startsByAccount.get(account.id);
    const candidateStart = start?.googleLocalDate ?? isoDay(new Date(account.createdAt));
    const end = endsByAccount.get(account.id);
    if (
      row.occurredOn < candidateStart ||
      (end && row.occurredOn > end.googleLocalDate)
    ) {
      continue;
    }

    const rawMicros = decimalToMicros(row.grossAmount);
    const billableMicros = billableGoogleMicros(
      rawMicros,
      row.occurredOn,
      candidateStart,
      start?.baselineCostMicros ?? "0",
      end
        ? {
            googleLocalDate: end.googleLocalDate,
            endCostMicros: end.endCostMicros,
          }
        : undefined,
    );
    if (billableMicros <= ZERO) continue;

    const weekStart = mondayOf(new Date(`${row.occurredOn}T12:00:00.000Z`));
    const key = `${account.clientId}:${account.id}:${weekStart}`;
    const aggregate = accountWeeks.get(key) ?? {
      clientId: account.clientId,
      accountId: account.id,
      weekStart,
      totalMicros: ZERO,
      unresolvedEntryDayMicros: ZERO,
      lastLedgerUpdate: null,
    };
    aggregate.totalMicros += billableMicros;
    if (!start && row.occurredOn === candidateStart) {
      aggregate.unresolvedEntryDayMicros += billableMicros;
    }
    aggregate.lastLedgerUpdate = newest(
      aggregate.lastLedgerUpdate,
      row.updatedAt,
    );
    accountWeeks.set(key, aggregate);
  }

  type MutablePosition = BillingClientPosition & {
    closedPeriodStarts: Set<string>;
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
        supportedNotReceived: 0,
        maximumNotReceived: 0,
        periodCount: 0,
        missingStartCount: 0,
        lastLedgerUpdate: null,
      },
      current: {
        periodStart: currentPeriod.start,
        periodEnd: currentPeriod.end,
        through: null,
        grossSpend: 0,
        accruedFee: 0,
        needsEntryReview: 0,
        missingStartCount: 0,
        updatedAt: null,
      },
      closedPeriodStarts: new Set(),
    });
  }

  for (const account of input.accounts) {
    const position = positions.get(account.clientId);
    if (!position) continue;
    const start = startsByAccount.get(account.id);
    const candidateStart = start?.googleLocalDate ?? isoDay(new Date(account.createdAt));
    if (!start && candidateStart <= closedThrough) {
      position.closed.missingStartCount += 1;
    }
    if (!start && candidateStart <= today) {
      position.current.missingStartCount += 1;
    }
  }

  for (const week of accountWeeks.values()) {
    const position = positions.get(week.clientId);
    if (!position) continue;
    if (activeInvoiceWeeks.has(`${week.clientId}:${week.weekStart}`)) continue;

    const rate = manualReferralRateForDate(
      week.weekStart,
      termsByClient.get(week.clientId) ?? [],
    );
    const fullFee = agencyFee(euroNumber(week.totalMicros), rate);
    const supportedFee = agencyFee(
      euroNumber(week.totalMicros - week.unresolvedEntryDayMicros),
      rate,
    );
    position.closed.unissuedEstimate = round2(
      position.closed.unissuedEstimate + fullFee,
    );
    position.closed.supportedUnissued = round2(
      position.closed.supportedUnissued + supportedFee,
    );
    position.closed.needsEntryReview = round2(
      position.closed.needsEntryReview + fullFee - supportedFee,
    );
    position.closedPeriodStarts.add(week.weekStart);
    if (week.lastLedgerUpdate) {
      position.closed.lastLedgerUpdate = newest(
        position.closed.lastLedgerUpdate,
        week.lastLedgerUpdate,
      );
    }
  }

  for (const invoice of input.invoices) {
    const position = positions.get(invoice.clientId);
    if (!position || invoice.status !== "open" || !invoice.issuedAt) continue;
    const remaining = Number(invoice.amountRemaining ?? invoice.amount);
    if (!Number.isFinite(remaining) || remaining < 0) continue;
    position.closed.issuedOutstanding = round2(
      position.closed.issuedOutstanding + remaining,
    );
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
    const start = startsByAccount.get(account.id);
    const candidateStart = start?.googleLocalDate ?? isoDay(new Date(account.createdAt));
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
      start?.baselineCostMicros ?? "0",
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
    if (!start && row.day === candidateStart) {
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
    .map(({ closedPeriodStarts, ...position }) => {
      position.closed.periodCount = closedPeriodStarts.size;
      position.closed.supportedNotReceived = round2(
        position.closed.supportedUnissued + position.closed.issuedOutstanding,
      );
      position.closed.maximumNotReceived = round2(
        position.closed.unissuedEstimate + position.closed.issuedOutstanding,
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
    },
    clients,
  };
}
