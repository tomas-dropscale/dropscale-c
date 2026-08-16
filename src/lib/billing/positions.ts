import {
  addDays,
  agencyFee,
  BILLING_CURRENCY,
  isReviewedAgencyCalculationVersion,
  isoDay,
  mondayOf,
  round2,
} from "./weekly";
import {
  accountCommissionTermsForDate,
  type AccountCommissionRateTerm,
} from "../admin/commission-sync-logic";

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
  if (!match)
    throw new RangeError("Billing money must have at most six decimals.");
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
  const capped =
    end && date === end.googleLocalDate && rawMicros > endMicros
      ? endMicros
      : rawMicros;
  if (date !== startDate) return capped;
  const baseline = integerMicros(baselineMicros);
  return capped > baseline ? capped - baseline : ZERO;
}

export type BillingPositionAccountTerm = AccountCommissionRateTerm;

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
  baselineCostMicros: string | number | null;
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
  id?: string;
  clientId: string;
  periodStart: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | "waived";
  amount: string | number;
  amountRemaining: string | number | null;
  issuedAt: string | null;
  currency?: string;
  paidAt?: string | null;
  calculationVersion: string;
};

export type BillingPositionSkip = {
  id: string;
  clientId: string;
  periodStart: string;
  periodEnd: string;
};

export type BillingPositionRange = {
  start: string;
  end: string;
};

export type BillingOverviewClientStatus =
  | "paid"
  | "payable"
  | "overdue"
  | "skip_cycle"
  | "paused";

export type BillingOverviewClient = {
  clientId: string;
  clientName: string;
  email: string;
  currency: typeof BILLING_CURRENCY;
  /** Current Monday-to-Sunday estimate; it is never presented as closed evidence. */
  currentSpend: number;
  currentAccrued: number;
  currentRate: number | null;
  currentThrough: string | null;
  currentNeedsEntryReview: number;
  payable: number | null;
  payableCount: number;
  payableInvoiceIds: string[];
  overdue: number | null;
  overdueCount: number;
  overdueInvoiceIds: string[];
  status: BillingOverviewClientStatus;
  currentSkipId: string | null;
  capabilities: {
    canForgive: false;
    canSkip: boolean;
    canPause: false;
    canResume: false;
  };
};

export type BillingOverview = {
  currency: typeof BILLING_CURRENCY;
  range: BillingPositionRange;
  currentPeriod: { start: string; end: string; through: string | null };
  previousPeriod: { start: string; end: string };
  capabilities: {
    /** Available only after persisted billing_cycle_skips were supplied. */
    skipEvidence: "available" | "unavailable";
    /** No persisted billing-pause authority exists yet. */
    pauseEvidence: "unavailable";
  };
  summary: {
    currentAccrued: number;
    payable: number | null;
    payableCount: number;
    overdue: number | null;
    overdueCount: number;
    billed: number | null;
    billedCount: number | null;
    received: number | null;
    receivedCount: number | null;
  };
  clients: BillingOverviewClient[];
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
  overview: BillingOverview;
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
  range?: BillingPositionRange;
  skips?: BillingPositionSkip[];
  referralTermsByClient?: Map<string, BillingPositionReferralTerm[]>;
  commissionTermsByAccount?: Map<string, BillingPositionAccountTerm[]>;
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

function validIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function invoiceAmount(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function timestampDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? isoDay(parsed) : null;
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
  const previousPeriod = {
    start: addDays(currentPeriod.start, -7),
    end: closedThrough,
  };
  const range = input.range ?? { start: currentPeriod.start, end: today };
  if (
    !validIsoDay(range.start) ||
    !validIsoDay(range.end) ||
    range.start > range.end
  ) {
    throw new RangeError("Billing overview requires a valid date range.");
  }
  const accountById = new Map(
    input.accounts.map((account) => [account.id, account]),
  );
  const startsByAccount = new Map(
    input.starts.map((start) => [start.accountId, start]),
  );
  const endsByAccount = new Map(input.ends.map((end) => [end.accountId, end]));
  const termsByClient = input.referralTermsByClient ?? new Map();
  const termsByAccount = input.commissionTermsByAccount ?? new Map();

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
    const candidateStart =
      start?.googleLocalDate ?? isoDay(new Date(account.createdAt));
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

  const currentAccountIdsByClient = new Map<string, string[]>();
  const currentRatesByClient = new Map<string, Set<number>>();
  for (const account of input.accounts) {
    const position = positions.get(account.clientId);
    if (!position) continue;
    const start = startsByAccount.get(account.id);
    const candidateStart =
      start?.googleLocalDate ?? isoDay(new Date(account.createdAt));
    const end = endsByAccount.get(account.id);
    if (!start && candidateStart <= closedThrough) {
      position.closed.missingStartCount += 1;
    }
    if (!start && candidateStart <= today) {
      position.current.missingStartCount += 1;
    }
    if (
      account.currency.toUpperCase() !== BILLING_CURRENCY ||
      candidateStart > today ||
      (end && end.googleLocalDate < currentPeriod.start)
    ) {
      continue;
    }
    const accountIds = currentAccountIdsByClient.get(account.clientId) ?? [];
    accountIds.push(account.id);
    currentAccountIdsByClient.set(account.clientId, accountIds);
    const rates = currentRatesByClient.get(account.clientId) ?? new Set();
    rates.add(
      accountCommissionTermsForDate(
        currentPeriod.start,
        termsByAccount.get(account.id) ?? [],
        termsByClient.get(account.clientId) ?? [],
      ).feeRate,
    );
    currentRatesByClient.set(account.clientId, rates);
  }

  for (const week of accountWeeks.values()) {
    const position = positions.get(week.clientId);
    if (!position) continue;
    if (activeInvoiceWeeks.has(`${week.clientId}:${week.weekStart}`)) continue;

    const rate = accountCommissionTermsForDate(
      week.weekStart,
      termsByAccount.get(week.accountId) ?? [],
      termsByClient.get(week.clientId) ?? [],
    ).feeRate;
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
    if (!position) continue;

    if (
      invoice.status === "draft" &&
      invoice.issuedAt === null &&
      isReviewedAgencyCalculationVersion(invoice.calculationVersion)
    ) {
      const amount = Number(invoice.amount);
      if (!Number.isFinite(amount) || amount < 0) continue;
      position.closed.unissuedEstimate = round2(
        position.closed.unissuedEstimate + amount,
      );
      position.closed.supportedUnissued = round2(
        position.closed.supportedUnissued + amount,
      );
      position.closedPeriodStarts.add(invoice.periodStart);
      continue;
    }

    if (invoice.status !== "open" || !invoice.issuedAt) continue;
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
    const candidateStart =
      start?.googleLocalDate ?? isoDay(new Date(account.createdAt));
    const end = endsByAccount.get(account.id);
    if (row.day < candidateStart || (end && row.day > end.googleLocalDate)) {
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
    aggregate.through =
      !aggregate.through || row.day > aggregate.through
        ? row.day
        : aggregate.through;
    aggregate.updatedAt = newest(aggregate.updatedAt, row.computedAt);
    currentByAccount.set(account.id, aggregate);
  }

  for (const aggregate of currentByAccount.values()) {
    const position = positions.get(aggregate.clientId);
    if (!position) continue;
    const rate = accountCommissionTermsForDate(
      currentPeriod.start,
      termsByAccount.get(aggregate.accountId) ?? [],
      termsByClient.get(aggregate.clientId) ?? [],
    ).feeRate;
    const fullFee = agencyFee(euroNumber(aggregate.totalMicros), rate);
    const supportedFee = agencyFee(
      euroNumber(aggregate.totalMicros - aggregate.unresolvedEntryDayMicros),
      rate,
    );
    position.current.grossSpend = round2(
      position.current.grossSpend + euroNumber(aggregate.totalMicros),
    );
    position.current.accruedFee = round2(position.current.accruedFee + fullFee);
    position.current.needsEntryReview = round2(
      position.current.needsEntryReview + fullFee - supportedFee,
    );
    if (
      aggregate.through &&
      (!position.current.through ||
        aggregate.through > position.current.through)
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

  const currentSkipByClient = new Map(
    (input.skips ?? [])
      .filter(
        (skip) =>
          skip.periodStart === currentPeriod.start &&
          skip.periodEnd === currentPeriod.end,
      )
      .map((skip) => [skip.clientId, skip]),
  );
  const eurInvoicesByClient = new Map<string, BillingPositionInvoice[]>();
  for (const invoice of input.invoices) {
    if (invoice.currency?.toUpperCase() !== BILLING_CURRENCY) continue;
    const invoices = eurInvoicesByClient.get(invoice.clientId) ?? [];
    invoices.push(invoice);
    eurInvoicesByClient.set(invoice.clientId, invoices);
  }

  const receivable = (invoices: BillingPositionInvoice[]) => {
    let amount = 0;
    let complete = true;
    for (const invoice of invoices) {
      const remaining = invoiceAmount(invoice.amountRemaining);
      if (!invoice.issuedAt || remaining === null) {
        complete = false;
      } else {
        amount += remaining;
      }
    }
    return {
      amount: complete ? round2(amount) : null,
      count: invoices.length,
      invoiceIds: invoices.flatMap((invoice) =>
        invoice.id ? [invoice.id] : [],
      ),
    };
  };
  const conservativeThrough = (accountIds: string[]): string | null => {
    if (accountIds.length === 0) return null;
    let through: string | null = null;
    for (const accountId of accountIds) {
      const accountThrough = currentByAccount.get(accountId)?.through;
      if (!accountThrough) return null;
      if (!through || accountThrough < through) through = accountThrough;
    }
    return through;
  };

  const overviewClients: BillingOverviewClient[] = clients.map((position) => {
    const invoices = eurInvoicesByClient.get(position.clientId) ?? [];
    const payable = receivable(
      invoices.filter(
        (invoice) =>
          invoice.status === "open" &&
          invoice.periodStart === previousPeriod.start,
      ),
    );
    const overdue = receivable(
      invoices.filter(
        (invoice) =>
          invoice.status === "open" &&
          invoice.periodStart < previousPeriod.start,
      ),
    );
    const skip = currentSkipByClient.get(position.clientId);
    const currentInvoiceExists = input.invoices.some(
      (invoice) =>
        invoice.clientId === position.clientId &&
        invoice.periodStart === currentPeriod.start &&
        invoice.status !== "void" &&
        invoice.status !== "waived",
    );
    const status: BillingOverviewClientStatus =
      overdue.count > 0
        ? "overdue"
        : payable.count > 0
          ? "payable"
          : skip
            ? "skip_cycle"
            : "paid";
    const rates = currentRatesByClient.get(position.clientId) ?? new Set();

    return {
      clientId: position.clientId,
      clientName: position.clientName,
      email: position.email,
      currency: BILLING_CURRENCY,
      currentSpend: position.current.grossSpend,
      currentAccrued: position.current.accruedFee,
      currentRate: rates.size === 1 ? [...rates][0] : null,
      currentThrough: conservativeThrough(
        currentAccountIdsByClient.get(position.clientId) ?? [],
      ),
      currentNeedsEntryReview: position.current.needsEntryReview,
      payable: payable.amount,
      payableCount: payable.count,
      payableInvoiceIds: payable.invoiceIds,
      overdue: overdue.amount,
      overdueCount: overdue.count,
      overdueInvoiceIds: overdue.invoiceIds,
      status,
      currentSkipId: skip?.id ?? null,
      capabilities: {
        canForgive: false,
        canSkip:
          input.skips !== undefined && !skip && !currentInvoiceExists,
        canPause: false,
        canResume: false,
      },
    };
  });

  let billed = 0;
  let billedCount = 0;
  let billedComplete = true;
  let received = 0;
  let receivedCount = 0;
  let receivedComplete = true;
  for (const invoice of input.invoices) {
    if (invoice.currency?.toUpperCase() !== BILLING_CURRENCY) continue;
    if (
      invoice.status === "open" ||
      invoice.status === "paid" ||
      invoice.status === "uncollectible"
    ) {
      const day = timestampDay(invoice.issuedAt);
      if (!day) {
        billedComplete = false;
      } else if (day >= range.start && day <= range.end) {
        const amount = invoiceAmount(invoice.amount);
        if (amount === null) {
          billedComplete = false;
        } else {
          billed += amount;
          billedCount += 1;
        }
      }
    }
    if (invoice.status === "paid") {
      const day = timestampDay(invoice.paidAt);
      if (!day) {
        receivedComplete = false;
      } else if (day >= range.start && day <= range.end) {
        const amount = invoiceAmount(invoice.amount);
        if (amount === null) {
          receivedComplete = false;
        } else {
          received += amount;
          receivedCount += 1;
        }
      }
    }
  }
  const nullableSum = (
    select: (position: BillingOverviewClient) => number | null,
  ): number | null => {
    let total = 0;
    for (const position of overviewClients) {
      const value = select(position);
      if (value === null) return null;
      total += value;
    }
    return round2(total);
  };
  const currentAccountIds = [...currentAccountIdsByClient.values()].flat();

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
      issuedOutstanding: sum((position) => position.closed.issuedOutstanding),
      supportedNotReceived: sum(
        (position) => position.closed.supportedNotReceived,
      ),
      maximumNotReceived: sum((position) => position.closed.maximumNotReceived),
      currentGrossSpend: sum((position) => position.current.grossSpend),
      currentAccruedFee: sum((position) => position.current.accruedFee),
      clientsNeedingEntryReview: clients.filter(
        (position) => position.closed.needsEntryReview > 0,
      ).length,
    },
    clients,
    overview: {
      currency: BILLING_CURRENCY,
      range,
      currentPeriod: {
        ...currentPeriod,
        through: conservativeThrough(currentAccountIds),
      },
      previousPeriod,
      capabilities: {
        skipEvidence:
          input.skips === undefined ? "unavailable" : "available",
        pauseEvidence: "unavailable",
      },
      summary: {
        currentAccrued: round2(
          overviewClients.reduce(
            (total, position) =>
              total +
              (position.currentSkipId === null ? position.currentAccrued : 0),
            0,
          ),
        ),
        payable: nullableSum((position) => position.payable),
        payableCount: overviewClients.reduce(
          (total, position) => total + position.payableCount,
          0,
        ),
        overdue: nullableSum((position) => position.overdue),
        overdueCount: overviewClients.reduce(
          (total, position) => total + position.overdueCount,
          0,
        ),
        billed: billedComplete ? round2(billed) : null,
        billedCount: billedComplete ? billedCount : null,
        received: receivedComplete ? round2(received) : null,
        receivedCount: receivedComplete ? receivedCount : null,
      },
      clients: overviewClients,
    },
  };
}
