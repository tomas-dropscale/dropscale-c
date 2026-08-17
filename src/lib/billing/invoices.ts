/**
 * Review-first agency billing.
 *
 * This module never issues invoices on a page load. It calculates a closed
 * week's agency fee from exact Google-spend ledger rows, then sends both the
 * reviewed admin path and the separately armed automation path through the
 * same idempotent issueClientWeek() implementation.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  allowedLocalStatusesForStripeUpdate,
  assertStripeInvoiceMatchesLocal,
  createAndFinalizeInvoice,
  createCustomer,
  getInvoice,
  localInvoiceStatus,
  stripeConfigured,
  StripeError,
  stripeInvoiceStatusDecision,
  type StripeInvoiceRecipientExpectation,
  updateCustomerBilling,
} from "@/lib/stripe/client";
import {
  acquireBillingIssueLease,
  BillingIssueLeaseLostError,
  BillingIssueLeaseServiceError,
  recordBillingIssueError,
  releaseBillingIssueLease,
  renewBillingIssueLease,
  type BillingIssueLeaseHandle,
} from "@/lib/billing/issue-lease";
import type {
  AdAccountBillingEnd,
  AdAccountBillingStart,
  AdAccount,
  BillingProfile,
  BillingCycleSkip,
  Client,
  Commission,
  Database,
  GoogleLedgerSnapshotRow,
  Invoice,
  InvoiceLine,
  ReviewedFullDayBillingBoundary,
  ReferralDiscountTerm,
} from "@/lib/supabase/types";
import {
  decimalToMicros,
  googleLocalDate,
  microsToDecimal,
  parseGoogleMicros,
} from "@/lib/google-ads/billing-start";
import {
  accountCommissionTermsForDate,
  billingBoundaryMicros,
  type AccountCommissionRateTerm,
} from "@/lib/admin/commission-sync-logic";
import {
  addDays,
  AGENCY_FEE_RATE,
  BILLING_CURRENCY,
  billingEvidenceIsReady,
  billingEvidenceReadyAt,
  CALCULATION_VERSION,
  closedWeeks,
  closedWeekStarting,
  DAYS_UNTIL_DUE,
  isoDay,
  isManualAgencyCalculationVersion,
  isReviewedAgencyCalculationVersion,
  mondayOf,
  referralFeeTerms,
  round2,
  storeLines,
} from "@/lib/billing/weekly";
import {
  billingReviewToken,
  parseBillingRecipientSnapshot,
  requireBillingRecipientSnapshot,
  type BillingRecipientSnapshot,
} from "@/lib/billing/review-token";
import {
  loadManualReferralCutoverGate,
  manualReferralCutoverPreviewBlocker,
} from "@/lib/billing/manual-referral-cutover";
import {
  billingReviewQueue,
  stripeInvoiceRecoveryMode,
} from "@/lib/billing/invoice-delivery";
import {
  buildBillingPositions,
  type BillingPositionAccount,
  type BillingPositionAccountTerm,
  type BillingPositionClient,
  type BillingPositionEnd,
  type BillingPositionInvoice,
  type BillingPositionLedgerRow,
  type BillingPositionMetricRow,
  type BillingPositionReferralTerm,
  type BillingPositionSkip,
  type BillingPositions,
  type BillingPositionStart,
} from "@/lib/billing/positions";

type Supabase = SupabaseClient<Database>;

export {
  AGENCY_FEE_RATE,
  BILLING_CURRENCY,
  CALCULATION_VERSION,
  closedWeeks,
  DAYS_UNTIL_DUE,
} from "@/lib/billing/weekly";

const SPEND_SOURCE = "Google Ads Management";
const ISSUE_LOCK_MS = 5 * 60 * 1000;

export type BillingBlockerCode =
  | "period_not_closed"
  | "client_not_found"
  | "no_accounts"
  | "no_spend"
  | "billing_not_started"
  | "billing_start_mismatch"
  | "billing_end_mismatch"
  | "account_not_eur"
  | "ledger_not_eur"
  | "google_disconnected"
  | "ledger_missing"
  | "ledger_stale"
  | "evidence_settling"
  | "recipient_invalid"
  | "referral_term_mismatch"
  | "pre_v3_cutover"
  | "referral_cutover_unavailable"
  | "legacy_commercial_terms"
  | "already_issued"
  | "issue_in_progress"
  | "stripe_not_configured";

export type BillingBlocker = {
  code: BillingBlockerCode;
  message: string;
  severity: "error" | "warning";
  accountId?: string;
};

export type BillingStorePreview = {
  accountId: string;
  storeName: string;
  accountCurrency: string;
  pricingMode: "manual" | "referral";
  commissionTermId: string | null;
  listRate: number;
  referralCount: number;
  referralDiscountRate: number;
  feeRate: number;
  /** Raw Google spend in the eligible part of the selected week. */
  grossSpend: number;
  /** Opening same-day counter excluded from the first partial week. */
  baselineDeduction: number;
  /** Spend after the immutable closing counter, excluded from the final partial week. */
  endDeduction: number;
  /** Google spend on which the 10% fee is actually calculated. */
  billableSpend: number;
  billingStart: {
    id: string;
    date: string;
    basis: "observed_google_counter" | "reviewed_full_day";
    capturedAt: string | null;
    timeZone: string;
    baselineAmount: number | null;
  } | null;
  billingEnd: {
    id: string;
    date: string;
    capturedAt: string;
    timeZone: string;
    endAmount: number;
  } | null;
  fee: number;
  sourceDays: number;
  lastLedgerUpdate: string | null;
  connected: boolean;
  blockers: BillingBlocker[];
};

export type BillingClientPreview = {
  clientId: string;
  clientName: string;
  email: string;
  grossSpend: number;
  baselineDeduction: number;
  endDeduction: number;
  billableSpend: number;
  fee: number;
  amount: number;
  currency: typeof BILLING_CURRENCY;
  /** Immutable manual-referral snapshot effective for this exact Monday. */
  referralTermId: string | null;
  referralTermEffectiveFrom: string | null;
  referralCount: number;
  referralDiscountRate: number;
  feeRate: number;
  listRate: number;
  mixedRates: boolean;
  /** Exact email/legal identity bound into the admin confirmation. */
  recipient: BillingRecipientSnapshot;
  sourceDays: number;
  lastLedgerUpdate: string | null;
  stores: BillingStorePreview[];
  blockers: BillingBlocker[];
  canIssue: boolean;
  /** SHA-256 of the exact commercial snapshot shown to the admin. */
  reviewToken: string;
  existingInvoice: Invoice | null;
};

export type BillingInvoiceHistoryRow = Invoice & {
  clientName: string;
  clientEmail: string;
  outstandingAmount: number;
};

export type BillingAdminSummary = {
  selectedWeekBilled: number;
  selectedWeekPaid: number;
  currentMonthBilled: number;
  currentMonthPaid: number;
  outstanding: number;
  failed: number;
  /** Issued invoices for the selected billing week. */
  invoiceCount: number;
  /** Paid invoices issued in the current calendar month. */
  paidCount: number;
  outstandingCount: number;
  failedCount: number;
};

export type BillingAdminDashboard = {
  generatedAt: string;
  currency: typeof BILLING_CURRENCY;
  feeRate: typeof AGENCY_FEE_RATE;
  weeks: { start: string; end: string }[];
  selectedWeek: { start: string; end: string };
  summary: BillingAdminSummary;
  /** Closed receivables and the current in-progress cycle, never mixed. */
  positions: BillingPositions;
  clients: BillingClientPreview[];
  invoices: BillingInvoiceHistoryRow[];
};

type LedgerRow = Pick<
  Commission,
  | "id"
  | "ad_account_id"
  | "gross_amount"
  | "currency"
  | "occurred_on"
  | "updated_at"
>;

type BillingAccount = Pick<
  AdAccount,
  | "id"
  | "client_id"
  | "store_name"
  | "currency"
  | "google_ads_customer_id"
  | "commission_rate"
  | "list_commission_rate"
  | "revenue_share_enabled"
>;

type BillingStart = AdAccountBillingStart;
type BillingEnd = AdAccountBillingEnd;
type ReviewedBillingStart = Pick<
  ReviewedFullDayBillingBoundary,
  | "id"
  | "ad_account_id"
  | "client_id"
  | "google_ads_customer_id"
  | "entry_day"
  | "entry_time_zone"
  | "google_local_date"
  | "google_time_zone"
  | "entry_day_treatment"
  | "currency"
  | "policy_version"
>;

type BillingProfileRow = Pick<
  BillingProfile,
  | "client_id"
  | "billing_name"
  | "tax_id"
  | "address_line1"
  | "address_line2"
  | "address_city"
  | "address_postal_code"
  | "address_state"
  | "address_country"
>;

type CalculatedClient = {
  preview: BillingClientPreview;
  lines: InvoiceLine[];
  ledgerRows: LedgerRow[];
  referralTermId: string | null;
  recipient: BillingRecipientSnapshot;
};

type ResolvedReferralTerm = {
  termId: string | null;
  effectiveFrom: string | null;
  revision: number;
  listRate: number;
  stepRate: number;
  referralCount: number;
  discountRate: number;
  feeRate: number;
  valid: boolean;
};

type LedgerSyncWindow = {
  ad_account_id: string;
  billing_start_id: string;
  billing_end_id: string | null;
  synced_at: string;
  status: "in_progress" | "complete" | "failed";
  ledger_snapshot: GoogleLedgerSnapshotRow[];
};

function ledgerSnapshot(rows: LedgerRow[]): GoogleLedgerSnapshotRow[] {
  return rows
    .map((row) => ({
      id: row.id,
      occurred_on: row.occurred_on,
      gross_amount: microsToDecimal(decimalToMicros(row.gross_amount)),
      currency: row.currency.toUpperCase(),
      status: "confirmed" as const,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sameLedgerSnapshot(
  expected: GoogleLedgerSnapshotRow[],
  current: GoogleLedgerSnapshotRow[],
): boolean {
  if (!Array.isArray(expected) || expected.length !== current.length)
    return false;
  const orderedExpected = [...expected].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return orderedExpected.every((row, index) => {
    const candidate = current[index];
    return (
      Boolean(candidate) &&
      row.id === candidate.id &&
      row.occurred_on === candidate.occurred_on &&
      row.gross_amount === candidate.gross_amount &&
      row.currency.toUpperCase() === candidate.currency.toUpperCase() &&
      row.status === candidate.status
    );
  });
}

function blocker(
  code: BillingBlockerCode,
  message: string,
  severity: BillingBlocker["severity"],
  accountId?: string,
): BillingBlocker {
  return { code, message, severity, ...(accountId ? { accountId } : {}) };
}

function newestTimestamp(values: (string | null)[]): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  );
}

function outstandingAmount(invoice: Invoice): number {
  return invoice.status === "open"
    ? Number(invoice.amount_remaining ?? invoice.amount)
    : 0;
}

function resolvedReferralTerm(
  term?: ReferralDiscountTerm,
): ResolvedReferralTerm {
  if (!term) {
    return {
      termId: null,
      effectiveFrom: null,
      revision: 0,
      listRate: AGENCY_FEE_RATE,
      stepRate: 0.5,
      referralCount: 0,
      discountRate: 0,
      feeRate: AGENCY_FEE_RATE,
      valid: true,
    };
  }

  const countIsValid =
    Number.isSafeInteger(term.referral_count) && term.referral_count >= 0;
  const expected = countIsValid ? referralFeeTerms(term.referral_count) : null;
  const listRate = Number(term.list_rate);
  const stepRate = Number(term.referral_step_rate);
  const discountRate = Number(term.referral_discount_rate);
  const feeRate = Number(term.fee_rate);
  const valid =
    Boolean(term.sealed_at) &&
    listRate === AGENCY_FEE_RATE &&
    stepRate === 0.5 &&
    Number.isSafeInteger(term.revision) &&
    term.revision >= 1 &&
    expected !== null &&
    discountRate === expected.referralDiscountRate &&
    feeRate === expected.feeRate;

  return {
    termId: term.id,
    effectiveFrom: term.effective_from,
    revision: term.revision,
    listRate,
    stepRate,
    referralCount: term.referral_count,
    discountRate,
    feeRate,
    valid,
  };
}

/** Load without a hidden 1,000-row truncation, then resolve per client/week. */
async function fetchEffectiveReferralTerms(
  supabase: Supabase,
  clientIds: string[],
  periodStart: string,
): Promise<Map<string, ReferralDiscountTerm>> {
  const rows: ReferralDiscountTerm[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;

  for (;;) {
    let query = supabase
      .from("referral_discount_terms")
      .select("*")
      .in("client_id", clientIds)
      .lte("effective_from", periodStart)
      .not("sealed_at", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) {
      throw new Error(`Could not load manual referral terms: ${error.message}`);
    }
    const page = (data ?? []) as ReferralDiscountTerm[];
    rows.push(...page);
    if (page.length < pageSize) break;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) break;
  }

  const latest = new Map<string, ReferralDiscountTerm>();
  for (const term of rows) {
    const current = latest.get(term.client_id);
    if (
      !current ||
      term.effective_from > current.effective_from ||
      (term.effective_from === current.effective_from &&
        term.revision > current.revision)
    ) {
      latest.set(term.client_id, term);
    }
  }
  return latest;
}

async function fetchAccountCommissionTerms(
  supabase: Supabase,
  accountIds: string[],
  through?: string,
): Promise<Map<string, AccountCommissionRateTerm[]>> {
  const byAccount = new Map<string, AccountCommissionRateTerm[]>();
  if (accountIds.length === 0) return byAccount;
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("ad_account_commission_terms")
      .select("id, ad_account_id, effective_from, revision, list_rate")
      .in("ad_account_id", accountIds)
      .not("sealed_at", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (through) query = query.lte("effective_from", through);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) {
      throw new Error(
        `Could not load account commission terms: ${error.message}`,
      );
    }
    const page = (data ?? []) as unknown as Array<{
      id: string;
      ad_account_id: string;
      effective_from: string;
      revision: number;
      list_rate: string | number;
    }>;
    for (const row of page) {
      const current = byAccount.get(row.ad_account_id) ?? [];
      current.push({
        id: row.id,
        effectiveFrom: row.effective_from,
        revision: row.revision,
        listRate: Number(row.list_rate),
      });
      byAccount.set(row.ad_account_id, current);
    }
    if (page.length < pageSize) break;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return byAccount;
}

async function calculateWeek(
  supabase: Supabase,
  week: { start: string; end: string },
  onlyClientId?: string,
): Promise<CalculatedClient[]> {
  const { data: adminRows, error: adminsError } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "admin");
  if (adminsError)
    throw new Error(`Could not load billing owners: ${adminsError.message}`);
  const adminIds = new Set((adminRows ?? []).map((row) => row.id));

  let clientsQuery = supabase
    .from("portal_clients")
    .select("id, full_name, email, approval_status")
    // Rejected means portal access was revoked, not that the final closed week
    // stopped being owed. Pending sign-ups have never been billable.
    .in("approval_status", ["approved", "rejected"]);
  if (onlyClientId) clientsQuery = clientsQuery.eq("id", onlyClientId);
  const { data: clientRows, error: clientsError } = await clientsQuery;
  if (clientsError)
    throw new Error(`Could not load billing clients: ${clientsError.message}`);
  const clients = (
    (clientRows ?? []) as Pick<
      Client,
      "id" | "full_name" | "email" | "approval_status"
    >[]
  ).filter((client) => !adminIds.has(client.id));
  if (clients.length === 0) return [];

  const clientIds = clients.map((client) => client.id);
  const { data: billingProfileRows, error: billingProfilesError } =
    await supabase
      .from("billing_profiles")
      .select(
        "client_id, billing_name, tax_id, address_line1, address_line2, address_city, address_postal_code, address_state, address_country",
      )
      .in("client_id", clientIds);
  if (billingProfilesError) {
    throw new Error(
      `Could not load invoice recipients: ${billingProfilesError.message}`,
    );
  }
  const billingProfileByClient = new Map(
    ((billingProfileRows ?? []) as BillingProfileRow[]).map((profile) => [
      profile.client_id,
      profile,
    ]),
  );
  const effectiveTermByClient = await fetchEffectiveReferralTerms(
    supabase,
    clientIds,
    week.start,
  );
  const referralCutover = await loadManualReferralCutoverGate(
    supabase,
    week.start,
  );
  const { data: accountRows, error: accountsError } = await supabase
    .from("ad_accounts")
    .select(
      "id, client_id, store_name, currency, google_ads_customer_id, commission_rate, list_commission_rate, revenue_share_enabled",
    )
    .in("client_id", clientIds)
    // A suspended account can still owe its last approved week. Pending rows
    // have never passed team approval and are the only ones excluded.
    .in("status", ["active", "suspended"]);
  if (accountsError)
    throw new Error(
      `Could not load billing accounts: ${accountsError.message}`,
    );
  const allAccounts = (accountRows ?? []) as unknown as BillingAccount[];
  const commissionTermsByAccount = await fetchAccountCommissionTerms(
    supabase,
    allAccounts.map((account) => account.id),
    week.start,
  );

  let billingStarts: BillingStart[] = [];
  if (allAccounts.length > 0) {
    const { data, error } = await supabase
      .from("ad_account_billing_starts")
      .select("*")
      .in(
        "ad_account_id",
        allAccounts.map((account) => account.id),
      );
    if (error)
      throw new Error(`Could not load Google billing starts: ${error.message}`);
    billingStarts = (data ?? []) as BillingStart[];
  }
  const startByAccount = new Map(
    billingStarts.map((start) => [start.ad_account_id, start]),
  );

  const reviewedBoundaryIds = billingStarts
    .map((start) => start.reviewed_full_day_boundary_id)
    .filter((id): id is string => Boolean(id));
  let reviewedBillingStarts: ReviewedBillingStart[] = [];
  if (reviewedBoundaryIds.length > 0) {
    const { data, error } = await supabase
      .from("reviewed_full_day_billing_boundaries")
      .select(
        "id, ad_account_id, client_id, google_ads_customer_id, entry_day, entry_time_zone, google_local_date, google_time_zone, entry_day_treatment, currency, policy_version",
      )
      .in("id", reviewedBoundaryIds);
    if (error) {
      throw new Error(
        `Could not load reviewed Google billing starts: ${error.message}`,
      );
    }
    reviewedBillingStarts = (data ?? []) as ReviewedBillingStart[];
  }
  const reviewedStartById = new Map(
    reviewedBillingStarts.map((boundary) => [boundary.id, boundary]),
  );

  let billingEnds: BillingEnd[] = [];
  if (allAccounts.length > 0) {
    const { data, error } = await supabase
      .from("ad_account_billing_ends")
      .select("*")
      .in(
        "ad_account_id",
        allAccounts.map((account) => account.id),
      );
    if (error)
      throw new Error(`Could not load Google billing ends: ${error.message}`);
    billingEnds = (data ?? []) as BillingEnd[];
  }
  const endByAccount = new Map(
    billingEnds.map((end) => [end.ad_account_id, end]),
  );
  // A known start after the selected week means this account did not yet
  // belong to that bill. A legacy active account with no start must remain in
  // view and block the client rather than being silently omitted.
  const accounts = allAccounts.filter((account) => {
    const start = startByAccount.get(account.id);
    const end = endByAccount.get(account.id);
    return (
      (!start || start.google_local_date <= week.end) &&
      (!end || end.google_local_date >= week.start)
    );
  });

  let syncWindows: LedgerSyncWindow[] = [];
  if (accounts.length > 0) {
    const { data, error } = await supabase
      .from("google_ledger_sync_windows")
      .select(
        "ad_account_id, billing_start_id, billing_end_id, synced_at, status, ledger_snapshot",
      )
      .eq("period_start", week.start)
      .eq("period_end", week.end)
      .in(
        "ad_account_id",
        accounts.map((account) => account.id),
      );
    if (error)
      throw new Error(
        `Could not load Google billing refreshes: ${error.message}`,
      );
    syncWindows = (data ?? []) as LedgerSyncWindow[];
  }
  const syncByAccount = new Map(
    syncWindows.map((row) => [row.ad_account_id, row]),
  );

  const { data: source, error: sourceError } = await supabase
    .from("revenue_sources")
    .select("id")
    .eq("name", SPEND_SOURCE)
    .maybeSingle();
  if (sourceError)
    throw new Error(
      `Could not load Google spend source: ${sourceError.message}`,
    );
  if (!source) throw new Error(`Revenue source "${SPEND_SOURCE}" is missing.`);

  let ledgerRows: LedgerRow[] = [];
  if (accounts.length > 0) {
    const { data, error } = await supabase
      .from("commissions")
      .select(
        "id, ad_account_id, gross_amount, currency, occurred_on, updated_at",
      )
      .eq("source_id", source.id)
      .eq("status", "confirmed")
      .gte("occurred_on", week.start)
      .lte("occurred_on", week.end)
      .in(
        "ad_account_id",
        accounts.map((account) => account.id),
      );
    if (error)
      throw new Error(
        `Could not load the Google spend ledger: ${error.message}`,
      );
    ledgerRows = (data ?? []) as LedgerRow[];
  }

  const { data: existingRows, error: invoicesError } = await supabase
    .from("invoices")
    .select("*")
    .eq("period_start", week.start)
    .in("client_id", clientIds);
  if (invoicesError)
    throw new Error(
      `Could not load existing invoices: ${invoicesError.message}`,
    );
  const existingByClient = new Map(
    ((existingRows ?? []) as Invoice[]).map((invoice) => [
      invoice.client_id,
      invoice,
    ]),
  );

  const accountsByClient = new Map<string, BillingAccount[]>();
  for (const account of accounts) {
    const current = accountsByClient.get(account.client_id) ?? [];
    current.push(account);
    accountsByClient.set(account.client_id, current);
  }
  const rowsByAccount = new Map<string, LedgerRow[]>();
  for (const row of ledgerRows) {
    if (!row.ad_account_id) continue;
    const current = rowsByAccount.get(row.ad_account_id) ?? [];
    current.push(row);
    rowsByAccount.set(row.ad_account_id, current);
  }

  const calculated = clients.map((client) => {
    const profile = billingProfileByClient.get(client.id);
    let recipient: BillingRecipientSnapshot = {
      email: client.email,
      fallbackName: client.full_name,
      billingName: profile?.billing_name ?? null,
      taxId: profile?.tax_id ?? null,
      addressLine1: profile?.address_line1 ?? null,
      addressLine2: profile?.address_line2 ?? null,
      addressCity: profile?.address_city ?? null,
      addressPostalCode: profile?.address_postal_code ?? null,
      addressState: profile?.address_state ?? null,
      addressCountry: profile?.address_country ?? null,
    };
    const currentRecipientValid =
      parseBillingRecipientSnapshot(recipient) !== null;
    const referralTerm = resolvedReferralTerm(
      effectiveTermByClient.get(client.id),
    );
    const referralRateTerms =
      referralTerm.valid && referralTerm.termId
        ? [
            {
              effectiveFrom: referralTerm.effectiveFrom!,
              revision: referralTerm.revision,
              referralCount: referralTerm.referralCount,
              listRate: referralTerm.listRate,
              stepRate: referralTerm.stepRate,
              discountRate: referralTerm.discountRate,
              feeRate: referralTerm.feeRate,
            },
          ]
        : [];
    const clientAccounts = accountsByClient.get(client.id) ?? [];
    const stores: BillingStorePreview[] = [];
    const lines: InvoiceLine[] = [];
    const claimedRows: LedgerRow[] = [];

    for (const account of clientAccounts) {
      const commercialTerms = accountCommissionTermsForDate(
        week.start,
        commissionTermsByAccount.get(account.id) ?? [],
        referralRateTerms,
      );
      const start = startByAccount.get(account.id) ?? null;
      const reviewedStart = start?.reviewed_full_day_boundary_id
        ? (reviewedStartById.get(start.reviewed_full_day_boundary_id) ?? null)
        : null;
      const end = endByAccount.get(account.id) ?? null;
      const rows = (rowsByAccount.get(account.id) ?? []).filter(
        (row) =>
          start &&
          row.occurred_on >= start.google_local_date &&
          (!end || row.occurred_on <= end.google_local_date),
      );
      const storeBlockers: BillingBlocker[] = [];
      const accountCurrency = account.currency.toUpperCase();
      const ledgerCurrencies = new Set(
        rows.map((row) => row.currency.toUpperCase()),
      );
      const syncWindow = syncByAccount.get(account.id);
      // A boundary captured after this historical week must not invalidate the
      // proof that existed before termination. A later re-sync may bind the
      // same historical window to the now-known end, so both null and the exact
      // immutable end id are valid until the week containing that end.
      const endBindingMatches = Boolean(
        syncWindow &&
        (!end
          ? syncWindow.billing_end_id === null
          : end.google_local_date <= week.end
            ? syncWindow.billing_end_id === end.id
            : syncWindow.billing_end_id === null ||
              syncWindow.billing_end_id === end.id),
      );
      const refreshedAfterClose = Boolean(
        start &&
        syncWindow &&
        syncWindow.billing_start_id === start.id &&
        endBindingMatches &&
        syncWindow.status === "complete" &&
        googleLocalDate(
          new Date(syncWindow.synced_at),
          start.google_time_zone,
        ) > week.end &&
        sameLedgerSnapshot(syncWindow.ledger_snapshot, ledgerSnapshot(rows)),
      );

      if (!start) {
        storeBlockers.push(
          blocker(
            "billing_not_started",
            `${account.store_name} has no verified Google opening counter. Start tracking before invoicing.`,
            "error",
            account.id,
          ),
        );
      } else if (
        start.google_ads_customer_id !== account.google_ads_customer_id ||
        start.currency.toUpperCase() !== accountCurrency ||
        (start.start_basis === "observed_google_counter"
          ? start.reviewed_full_day_boundary_id !== null ||
            start.baseline_cost_micros === null ||
            start.captured_at === null
          : !reviewedStart ||
            reviewedStart.ad_account_id !== account.id ||
            reviewedStart.client_id !== account.client_id ||
            reviewedStart.google_ads_customer_id !==
              start.google_ads_customer_id ||
            reviewedStart.google_local_date !== start.google_local_date ||
            reviewedStart.google_time_zone !== start.google_time_zone ||
            reviewedStart.currency.toUpperCase() !==
              start.currency.toUpperCase())
      ) {
        storeBlockers.push(
          blocker(
            "billing_start_mismatch",
            `${account.store_name}'s Google identity or currency no longer matches its billing start.`,
            "error",
            account.id,
          ),
        );
      }

      if (
        end &&
        (!start ||
          end.billing_start_id !== start.id ||
          end.google_ads_customer_id !== start.google_ads_customer_id ||
          end.google_time_zone !== start.google_time_zone ||
          end.currency.toUpperCase() !== start.currency.toUpperCase() ||
          end.google_local_date < start.google_local_date)
      ) {
        storeBlockers.push(
          blocker(
            "billing_end_mismatch",
            `${account.store_name}'s Google billing end does not match its immutable start.`,
            "error",
            account.id,
          ),
        );
      }

      if (accountCurrency !== BILLING_CURRENCY) {
        storeBlockers.push(
          blocker(
            "account_not_eur",
            `${account.store_name} is configured in ${accountCurrency}, not EUR.`,
            "error",
            account.id,
          ),
        );
      }
      if (account.revenue_share_enabled) {
        storeBlockers.push(
          blocker(
            "legacy_commercial_terms",
            `${account.store_name} has a legacy revenue-share contract that is incompatible with reviewed agency billing.`,
            "error",
            account.id,
          ),
        );
      }
      if (
        [...ledgerCurrencies].some((currency) => currency !== BILLING_CURRENCY)
      ) {
        storeBlockers.push(
          blocker(
            "ledger_not_eur",
            `${account.store_name} contains non-EUR Google spend rows.`,
            "error",
            account.id,
          ),
        );
      }
      // Billing is read through the agency service account. The client's
      // optional portal OAuth may be disconnected without erasing a valid
      // agency-owned closed-week proof.
      const connected = Boolean(start && account.google_ads_customer_id);
      if (!refreshedAfterClose) {
        storeBlockers.push(
          blocker(
            "ledger_missing",
            `${account.store_name} has not been refreshed from Google for this exact closed week.`,
            "error",
            account.id,
          ),
        );
      }

      const lastLedgerUpdate =
        syncWindow?.synced_at ??
        newestTimestamp(rows.map((row) => row.updated_at));

      // Keep the complete raw Google day in the audit snapshot. The closing
      // counter is a separate deduction over the final day's TOTAL, never a
      // cap applied independently to each ledger row.
      const sourceMicros = rows.reduce(
        (sum, row) => sum + decimalToMicros(row.gross_amount),
        BigInt(0),
      );
      const endBoundaryApplied = Boolean(
        end &&
        end.google_local_date >= week.start &&
        end.google_local_date <= week.end,
      );
      const endDayMicros = endBoundaryApplied
        ? rows
            .filter((row) => row.occurred_on === end?.google_local_date)
            .reduce(
              (sum, row) => sum + decimalToMicros(row.gross_amount),
              BigInt(0),
            )
        : BigInt(0);
      const endCostMicros =
        endBoundaryApplied && end
          ? parseGoogleMicros(end.end_cost_micros)
          : BigInt(0);
      const rawStartDayMicros = start
        ? rows
            .filter((row) => row.occurred_on === start.google_local_date)
            .reduce(
              (sum, row) => sum + decimalToMicros(row.gross_amount),
              BigInt(0),
            )
        : BigInt(0);
      const openingBaselineApplied = Boolean(
        start &&
        start.start_basis === "observed_google_counter" &&
        start.google_local_date >= week.start &&
        start.google_local_date <= week.end,
      );
      const {
        openingDeductionMicros: deductionMicros,
        endDeductionMicros,
        billableMicros,
      } = billingBoundaryMicros({
        sourceMicros,
        startDayMicros: rawStartDayMicros,
        baselineMicros: String(start?.baseline_cost_micros ?? 0),
        openingApplied: Boolean(start && openingBaselineApplied),
        endDayMicros,
        endCostMicros,
        endingApplied: endBoundaryApplied,
        sameBoundaryDay: Boolean(
          start && end && start.google_local_date === end.google_local_date,
        ),
      });
      const sourceSpendExact = Number(microsToDecimal(sourceMicros));
      const baselineDeductionExact = Number(microsToDecimal(deductionMicros));
      const endDeductionExact = Number(microsToDecimal(endDeductionMicros));
      const billableSpendExact = Number(microsToDecimal(billableMicros));
      const grossSpend = round2(sourceSpendExact);
      const baselineDeduction = round2(baselineDeductionExact);
      const endDeduction = round2(endDeductionExact);
      const billableSpend = round2(billableSpendExact);
      const storeInvoiceLines =
        accountCurrency === BILLING_CURRENCY &&
        (commercialTerms.pricingMode === "manual" || referralTerm.valid)
          ? storeLines(account.id, account.store_name, {
              spend: billableSpendExact,
              sourceSpend: sourceSpendExact,
              baselineDeduction: baselineDeductionExact,
              openingBaselineApplied,
              endDeduction: endDeductionExact,
              endingCapApplied: endBoundaryApplied,
              periodStart: week.start,
              periodEnd: week.end,
              referralCount: referralTerm.referralCount,
              commercialTerms,
              ...(start
                ? {
                    billingStart: {
                      id: start.id,
                      date: start.google_local_date,
                      basis: start.start_basis,
                      capturedAt: start.captured_at,
                      timeZone: start.google_time_zone,
                      baselineAmount:
                        start.start_basis === "observed_google_counter"
                          ? Number(
                              microsToDecimal(
                                String(start.baseline_cost_micros ?? 0),
                              ),
                            )
                          : null,
                      ...(start.start_basis === "reviewed_full_day" &&
                      reviewedStart
                        ? {
                            reviewedFullDayBoundaryId: reviewedStart.id,
                            billingPolicyVersion: reviewedStart.policy_version,
                            entryDate: reviewedStart.entry_day,
                            entryTimeZone: reviewedStart.entry_time_zone,
                            entryDayTreatment:
                              reviewedStart.entry_day_treatment,
                          }
                        : {}),
                    },
                  }
                : {}),
              ...(endBoundaryApplied && end
                ? {
                    billingEnd: {
                      id: end.id,
                      date: end.google_local_date,
                      capturedAt: end.captured_at,
                      timeZone: end.google_time_zone,
                      counterAmount: Number(
                        microsToDecimal(String(end.end_cost_micros)),
                      ),
                    },
                  }
                : {}),
              currency: accountCurrency,
            })
          : [];
      lines.push(...storeInvoiceLines);
      claimedRows.push(...rows);

      stores.push({
        accountId: account.id,
        storeName: account.store_name,
        accountCurrency,
        pricingMode: commercialTerms.pricingMode,
        commissionTermId: commercialTerms.commissionTermId,
        listRate: commercialTerms.listRate,
        referralCount: commercialTerms.referralCount,
        referralDiscountRate: commercialTerms.referralDiscountRate,
        feeRate: commercialTerms.feeRate,
        grossSpend,
        baselineDeduction,
        endDeduction,
        billableSpend,
        billingStart: start
          ? {
              id: start.id,
              date: start.google_local_date,
              basis: start.start_basis,
              capturedAt: start.captured_at,
              timeZone: start.google_time_zone,
              baselineAmount:
                start.start_basis === "observed_google_counter"
                  ? Number(
                      microsToDecimal(String(start.baseline_cost_micros ?? 0)),
                    )
                  : null,
            }
          : null,
        billingEnd:
          endBoundaryApplied && end
            ? {
                id: end.id,
                date: end.google_local_date,
                capturedAt: end.captured_at,
                timeZone: end.google_time_zone,
                endAmount: Number(microsToDecimal(String(end.end_cost_micros))),
              }
            : null,
        fee: round2(
          storeInvoiceLines.reduce((sum, line) => sum + line.amount, 0),
        ),
        sourceDays: new Set(rows.map((row) => row.occurred_on)).size,
        lastLedgerUpdate,
        connected,
        blockers: storeBlockers,
      });
    }

    const existingInvoice = existingByClient.get(client.id) ?? null;
    const recoveryMode = existingInvoice
      ? stripeInvoiceRecoveryMode(existingInvoice)
      : null;
    const existingDraft = recoveryMode === "draft";
    const pendingStripeDelivery = Boolean(
      recoveryMode === "send_only" &&
      existingInvoice &&
      isReviewedAgencyCalculationVersion(existingInvoice.calculation_version) &&
      existingInvoice.currency.toUpperCase() === BILLING_CURRENCY,
    );
    const retryableInvoice = existingDraft || pendingStripeDelivery;
    const alreadyIssued = Boolean(existingInvoice && !retryableInvoice);

    let displayStores = stores;
    let amount = round2(lines.reduce((sum, line) => sum + line.amount, 0));
    // Keep every positive-spend store in the immutable local snapshot, even
    // when its fee rounds below one cent. pushToStripe strips only those zero
    // items from the remote draft; the database/portal retains the full proof.
    let displayLines = lines;
    let displayReferralTerm = referralTerm;

    // A retry and an already-issued week must display the immutable snapshot,
    // not a later Google restatement. That makes the confirmation describe the
    // exact object createAndFinalizeInvoice() will resume in Stripe.
    if (existingInvoice) {
      if (
        isReviewedAgencyCalculationVersion(existingInvoice.calculation_version)
      ) {
        recipient = requireBillingRecipientSnapshot(
          existingInvoice.billing_recipient,
        );
      }
      displayLines = existingInvoice.line_items;
      amount = Number(existingInvoice.amount);
      const referralLine = existingInvoice.line_items.find(
        (line) => line.kind === "fee",
      );
      if (
        referralLine &&
        isManualAgencyCalculationVersion(existingInvoice.calculation_version)
      ) {
        // V2 predates referral terms and is permanently the 10% list fee. It
        // must not inherit a later referral. V3 and V4 both seal the applied
        // referral values into immutable line snapshots.
        const isReviewed = isReviewedAgencyCalculationVersion(
          existingInvoice.calculation_version,
        );
        const count = isReviewed ? Number(referralLine.referralCount ?? 0) : 0;
        const terms = referralFeeTerms(count);
        displayReferralTerm = {
          ...referralTerm,
          termId: isReviewed ? existingInvoice.referral_discount_term_id : null,
          effectiveFrom: isReviewed ? referralTerm.effectiveFrom : null,
          revision: isReviewed ? referralTerm.revision : 0,
          referralCount: count,
          listRate: isReviewed
            ? Number(referralLine.listRate ?? AGENCY_FEE_RATE)
            : AGENCY_FEE_RATE,
          discountRate: isReviewed
            ? Number(
                referralLine.referralDiscountRate ?? terms.referralDiscountRate,
              )
            : 0,
          feeRate: isReviewed
            ? Number(referralLine.rate ?? terms.feeRate)
            : AGENCY_FEE_RATE,
          valid: true,
        };
      }
      const currentStoreByAccount = new Map(
        stores.map((store) => [store.accountId, store]),
      );
      displayStores = existingInvoice.line_items
        .filter((line) => line.kind === "fee")
        .map((line, index) => {
          const accountId = line.accountId ?? `invoice-line-${index}`;
          const current = line.accountId
            ? currentStoreByAccount.get(line.accountId)
            : undefined;
          const reviewed = isReviewedAgencyCalculationVersion(
            existingInvoice.calculation_version,
          );
          const pricingMode =
            existingInvoice.calculation_version === CALCULATION_VERSION
              ? (line.pricingMode ??
                (Number(line.listRate ?? AGENCY_FEE_RATE) === AGENCY_FEE_RATE
                  ? "referral"
                  : "manual"))
              : reviewed
                ? "referral"
                : "manual";
          const listRate = reviewed
            ? Number(line.listRate ?? AGENCY_FEE_RATE)
            : AGENCY_FEE_RATE;
          const referralCount =
            pricingMode === "referral" ? Number(line.referralCount ?? 0) : 0;
          const referralDiscountRate =
            pricingMode === "referral"
              ? Number(
                  line.referralDiscountRate ??
                    referralFeeTerms(referralCount).referralDiscountRate,
                )
              : 0;
          const feeRate = Number(
            line.rate ??
              (pricingMode === "referral"
                ? listRate - referralDiscountRate
                : listRate),
          );
          return {
            accountId,
            storeName: line.store ?? current?.storeName ?? line.label,
            accountCurrency: existingInvoice.currency,
            pricingMode,
            commissionTermId:
              existingInvoice.calculation_version === CALCULATION_VERSION
                ? (line.commissionTermId ?? null)
                : null,
            listRate,
            referralCount,
            referralDiscountRate,
            feeRate,
            grossSpend: Number(line.sourceGrossAmount ?? line.baseAmount ?? 0),
            baselineDeduction: Number(line.baselineDeductionAmount ?? 0),
            endDeduction: Number(line.endDeductionAmount ?? 0),
            billableSpend: Number(line.baseAmount ?? 0),
            billingStart:
              line.billingStartId &&
              line.billingStartDate &&
              line.billingTimeZone
                ? {
                    id: line.billingStartId,
                    date: line.billingStartDate,
                    basis:
                      line.billingStartBasis ?? "observed_google_counter",
                    capturedAt: line.billingStartedAt ?? null,
                    timeZone: line.billingTimeZone,
                    baselineAmount:
                      line.billingStartBasis === "reviewed_full_day"
                        ? null
                        : Number(line.billingStartBaselineAmount ?? 0),
                  }
                : null,
            billingEnd:
              line.endingCapApplied === true &&
              line.billingEndId &&
              line.billingEndDate &&
              line.billingEndedAt &&
              line.billingEndTimeZone &&
              line.billingEndCounterAmount !== undefined
                ? {
                    id: line.billingEndId,
                    date: line.billingEndDate,
                    capturedAt: line.billingEndedAt,
                    timeZone: line.billingEndTimeZone,
                    endAmount: Number(line.billingEndCounterAmount),
                  }
                : null,
            fee: Number(line.amount),
            sourceDays: current?.sourceDays ?? 0,
            lastLedgerUpdate:
              current?.lastLedgerUpdate ??
              existingInvoice.issue_attempted_at ??
              existingInvoice.issued_at,
            connected: current?.connected ?? true,
            blockers: [],
          } satisfies BillingStorePreview;
        });
    }

    const blockers = alreadyIssued
      ? []
      : retryableInvoice
        ? []
        : stores.flatMap((store) => store.blockers);
    if (!alreadyIssued && !billingEvidenceIsReady(week.end)) {
      blockers.push(
        blocker(
          "evidence_settling",
          `Google's Sunday spend is still settling. This week can be certified after ${billingEvidenceReadyAt(
            week.end,
          ).toISOString()}.`,
          "error",
        ),
      );
    }
    const cutoverBlocker = manualReferralCutoverPreviewBlocker(referralCutover);
    if (!alreadyIssued && cutoverBlocker) {
      blockers.push(cutoverBlocker);
    }
    if (!existingInvoice && !currentRecipientValid) {
      blockers.push(
        blocker(
          "recipient_invalid",
          "The client's invoice email, legal name, VAT ID or address is invalid. Correct the billing profile before issuing.",
          "error",
        ),
      );
    }
    if (
      !existingInvoice &&
      stores.some((store) => store.pricingMode === "referral") &&
      !referralTerm.valid
    ) {
      blockers.push(
        blocker(
          "referral_term_mismatch",
          "The sealed manual referral term is internally inconsistent. Do not issue this week until it is reviewed.",
          "error",
        ),
      );
    }
    if (!existingInvoice && clientAccounts.length === 0) {
      blockers.push(
        blocker(
          "no_accounts",
          "This client has no billable Google Ads accounts.",
          "error",
        ),
      );
    }
    const hasBillableSpend = existingInvoice
      ? displayLines.length > 0
      : lines.length > 0;
    if (!hasBillableSpend) {
      blockers.push(
        blocker(
          "no_spend",
          "There is no positive billable Google spend to settle for this week.",
          "warning",
        ),
      );
    }
    if (amount > 0 && !stripeConfigured() && !alreadyIssued) {
      blockers.push(
        blocker("stripe_not_configured", "Stripe is not configured.", "error"),
      );
    }
    if (
      retryableInvoice &&
      !existingInvoice?.issue_error &&
      existingInvoice?.issue_attempted_at &&
      Date.now() - new Date(existingInvoice.issue_attempted_at).getTime() <
        ISSUE_LOCK_MS
    ) {
      blockers.push(
        blocker(
          "issue_in_progress",
          "This invoice is already being issued.",
          "error",
        ),
      );
    }
    if (
      existingDraft &&
      existingInvoice &&
      (!isReviewedAgencyCalculationVersion(
        existingInvoice.calculation_version,
      ) ||
        existingInvoice.currency.toUpperCase() !== BILLING_CURRENCY)
    ) {
      blockers.push(
        blocker(
          "already_issued",
          "This legacy draft cannot be retried by the reviewed EUR agency-fee flow.",
          "error",
        ),
      );
    }

    const uniqueDays = new Set(claimedRows.map((row) => row.occurred_on));
    const commercialSignatures = new Set(
      displayStores.map((store) =>
        [
          store.pricingMode,
          store.listRate,
          store.referralCount,
          store.referralDiscountRate,
          store.feeRate,
        ].join(":"),
      ),
    );
    const mixedRates = commercialSignatures.size > 1;
    const summaryTerms = displayStores[0] ?? {
      listRate: AGENCY_FEE_RATE,
      referralCount: displayReferralTerm.referralCount,
      referralDiscountRate: displayReferralTerm.discountRate,
      feeRate: displayReferralTerm.feeRate,
    };
    const usesReferralPricing = displayStores.some(
      (store) => store.pricingMode === "referral",
    );
    const appliedReferralTermId = existingInvoice
      ? existingInvoice.referral_discount_term_id
      : usesReferralPricing
        ? displayReferralTerm.termId
        : null;
    const preview: BillingClientPreview = {
      clientId: client.id,
      clientName: client.full_name,
      email: client.email,
      grossSpend: round2(
        displayStores.reduce((sum, store) => sum + store.grossSpend, 0),
      ),
      baselineDeduction: round2(
        displayStores.reduce((sum, store) => sum + store.baselineDeduction, 0),
      ),
      endDeduction: round2(
        displayStores.reduce((sum, store) => sum + store.endDeduction, 0),
      ),
      billableSpend: round2(
        displayStores.reduce((sum, store) => sum + store.billableSpend, 0),
      ),
      fee: amount,
      amount,
      currency: BILLING_CURRENCY,
      referralTermId: appliedReferralTermId,
      referralTermEffectiveFrom: usesReferralPricing
        ? displayReferralTerm.effectiveFrom
        : null,
      referralCount: summaryTerms.referralCount,
      referralDiscountRate: summaryTerms.referralDiscountRate,
      feeRate: summaryTerms.feeRate,
      listRate: summaryTerms.listRate,
      mixedRates,
      recipient,
      sourceDays: uniqueDays.size,
      lastLedgerUpdate: newestTimestamp(
        displayStores.map((store) => store.lastLedgerUpdate),
      ),
      stores: displayStores,
      blockers,
      canIssue:
        !alreadyIssued &&
        hasBillableSpend &&
        !blockers.some((item) => item.severity === "error"),
      reviewToken: "",
      existingInvoice,
    };

    return {
      preview,
      lines: displayLines,
      ledgerRows: claimedRows,
      referralTermId: appliedReferralTermId,
      recipient,
    };
  });

  return Promise.all(
    calculated.map(async (entry) => {
      const immutableInvoice =
        entry.preview.existingInvoice &&
        stripeInvoiceRecoveryMode(entry.preview.existingInvoice) !== null
          ? entry.preview.existingInvoice
          : null;
      const reviewToken = await billingReviewToken({
        clientId: entry.preview.clientId,
        week,
        amount: entry.preview.amount,
        lines: entry.lines,
        ledgerRows: entry.ledgerRows,
        referralTermId: entry.referralTermId,
        recipient: entry.recipient,
        invoiceId: immutableInvoice?.id,
      });
      return { ...entry, preview: { ...entry.preview, reviewToken } };
    }),
  );
}

type SummaryInvoice = Pick<
  Invoice,
  | "id"
  | "amount"
  | "amount_remaining"
  | "currency"
  | "status"
  | "period_start"
  | "issued_at"
  | "paid_at"
  | "payment_failed_at"
>;

/** Paginate every payable invoice for client-level outstanding summaries. */
async function fetchAllOpenInvoices(supabase: Supabase): Promise<Invoice[]> {
  const rows: Invoice[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("invoices")
      .select("*")
      .eq("status", "open")
      .not("issued_at", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error)
      throw new Error(
        `Could not load outstanding invoice history: ${error.message}`,
      );
    const page = (data ?? []) as Invoice[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) return rows;
  }
}

/** The admin audit trail is paginated at the data source, not silently truncated. */
async function fetchAllIssuedInvoices(supabase: Supabase): Promise<Invoice[]> {
  const rows: Invoice[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("invoices")
      .select("*")
      .not("issued_at", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error)
      throw new Error(`Could not load invoice history: ${error.message}`);
    const page = (data ?? []) as Invoice[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) return rows;
  }
}

type PositionLedgerDatabaseRow = BillingPositionLedgerRow & { id: string };
type PositionInvoiceDatabaseRow = BillingPositionInvoice & { id: string };
type PositionReferralDatabaseRow = BillingPositionReferralTerm & {
  id: string;
  clientId: string;
};

async function fetchPositionLedgerRows(
  supabase: Supabase,
  sourceId: string,
  accountIds: string[],
): Promise<BillingPositionLedgerRow[]> {
  if (accountIds.length === 0) return [];
  const rows: PositionLedgerDatabaseRow[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("commissions")
      .select(
        "id, ad_account_id, occurred_on, gross_amount, currency, updated_at",
      )
      .eq("source_id", sourceId)
      .eq("status", "confirmed")
      .in("ad_account_id", accountIds)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) {
      throw new Error(
        `Could not load billing position ledger: ${error.message}`,
      );
    }
    const page = (data ?? []).map((row) => ({
      id: row.id,
      accountId: row.ad_account_id!,
      occurredOn: row.occurred_on,
      grossAmount: row.gross_amount,
      currency: row.currency,
      updatedAt: row.updated_at,
    })) as PositionLedgerDatabaseRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return rows.map((row) => ({
    accountId: row.accountId,
    occurredOn: row.occurredOn,
    grossAmount: row.grossAmount,
    currency: row.currency,
    updatedAt: row.updatedAt,
  }));
}

async function fetchPositionInvoices(
  supabase: Supabase,
  clientIds: string[],
): Promise<BillingPositionInvoice[]> {
  if (clientIds.length === 0) return [];
  const rows: PositionInvoiceDatabaseRow[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("invoices")
      .select(
        "id, client_id, period_start, status, amount, amount_remaining, currency, issued_at, paid_at, calculation_version",
      )
      .in("client_id", clientIds)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) {
      throw new Error(
        `Could not load billing position invoices: ${error.message}`,
      );
    }
    const page = (data ?? []).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      periodStart: row.period_start,
      status: row.status,
      amount: row.amount,
      amountRemaining: row.amount_remaining,
      currency: row.currency,
      issuedAt: row.issued_at,
      paidAt: row.paid_at,
      calculationVersion: row.calculation_version,
    })) as PositionInvoiceDatabaseRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    periodStart: row.periodStart,
    status: row.status,
    amount: row.amount,
    amountRemaining: row.amountRemaining,
    currency: row.currency,
    issuedAt: row.issuedAt,
    paidAt: row.paidAt,
    calculationVersion: row.calculationVersion,
  }));
}

async function fetchPositionSkips(
  supabase: Supabase,
  clientIds: string[],
  periodStart: string,
): Promise<BillingPositionSkip[]> {
  if (clientIds.length === 0) return [];
  type PositionSkipRow = Pick<
    BillingCycleSkip,
    "id" | "client_id" | "period_start" | "period_end"
  >;
  const rows: PositionSkipRow[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("billing_cycle_skips")
      .select("id, client_id, period_start, period_end")
      .in("client_id", clientIds)
      .eq("period_start", periodStart)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) {
      throw new Error(
        `Could not load billing cycle skips: ${error.message}`,
      );
    }
    const page = (data ?? []) as PositionSkipRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  }));
}

async function fetchPositionMetrics(
  supabase: Supabase,
  accountIds: string[],
  periodStart: string,
  periodEnd: string,
): Promise<BillingPositionMetricRow[]> {
  if (accountIds.length === 0) return [];
  const rows: BillingPositionMetricRow[] = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("daily_metrics")
      .select("ad_account_id, day, ad_spend, computed_at")
      .in("ad_account_id", accountIds)
      .gte("day", periodStart)
      .lte("day", periodEnd)
      .order("day", { ascending: true })
      .order("ad_account_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(
        `Could not load current Google estimates: ${error.message}`,
      );
    }
    const page = (data ?? []).map((row) => ({
      accountId: row.ad_account_id,
      day: row.day,
      adSpend: row.ad_spend,
      computedAt: row.computed_at,
    })) as BillingPositionMetricRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchPositionReferralTerms(
  supabase: Supabase,
  clientIds: string[],
): Promise<Map<string, BillingPositionReferralTerm[]>> {
  const byClient = new Map<string, BillingPositionReferralTerm[]>();
  if (clientIds.length === 0) return byClient;
  const rows: PositionReferralDatabaseRow[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("referral_discount_terms")
      .select(
        "id, client_id, effective_from, revision, referral_count, list_rate, referral_step_rate, referral_discount_rate, fee_rate",
      )
      .in("client_id", clientIds)
      .not("sealed_at", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) {
      throw new Error(
        `Could not load billing position terms: ${error.message}`,
      );
    }
    const page = (data ?? []).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      effectiveFrom: row.effective_from,
      revision: row.revision,
      referralCount: row.referral_count,
      listRate: Number(row.list_rate),
      stepRate: Number(row.referral_step_rate),
      discountRate: Number(row.referral_discount_rate),
      feeRate: Number(row.fee_rate),
    })) as PositionReferralDatabaseRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  for (const row of rows) {
    const current = byClient.get(row.clientId) ?? [];
    current.push({
      effectiveFrom: row.effectiveFrom,
      revision: row.revision,
      referralCount: row.referralCount,
      listRate: row.listRate,
      stepRate: row.stepRate,
      discountRate: row.discountRate,
      feeRate: row.feeRate,
    });
    byClient.set(row.clientId, current);
  }
  return byClient;
}

async function fetchAdminBillingPositions(
  supabase: Supabase,
  now: Date,
): Promise<BillingPositions> {
  const currentStart = mondayOf(now);
  const currentEnd = addDays(currentStart, 6);
  const [
    { data: adminRows, error: adminsError },
    { data: clientRows, error: clientsError },
  ] = await Promise.all([
    supabase.from("profiles").select("id").eq("role", "admin"),
    supabase
      .from("portal_clients")
      .select("id, full_name, email, approval_status")
      .in("approval_status", ["approved", "rejected"]),
  ]);
  if (adminsError) {
    throw new Error(
      `Could not load billing position owners: ${adminsError.message}`,
    );
  }
  if (clientsError) {
    throw new Error(
      `Could not load billing position clients: ${clientsError.message}`,
    );
  }
  const adminIds = new Set((adminRows ?? []).map((row) => row.id));
  const clients: BillingPositionClient[] = (clientRows ?? [])
    .filter((client) => !adminIds.has(client.id))
    .map((client) => ({
      id: client.id,
      fullName: client.full_name,
      email: client.email,
    }));
  const clientIds = clients.map((client) => client.id);

  let accounts: BillingPositionAccount[] = [];
  if (clientIds.length > 0) {
    const { data, error } = await supabase
      .from("ad_accounts")
      .select("id, client_id, store_name, created_at, currency")
      .in("client_id", clientIds)
      .in("status", ["active", "suspended"]);
    if (error) {
      throw new Error(
        `Could not load billing position accounts: ${error.message}`,
      );
    }
    accounts = (data ?? []).map((account) => ({
      id: account.id,
      clientId: account.client_id,
      storeName: account.store_name,
      createdAt: account.created_at,
      currency: account.currency,
    }));
  }
  const accountIds = accounts.map((account) => account.id);

  let starts: BillingPositionStart[] = [];
  let ends: BillingPositionEnd[] = [];
  if (accountIds.length > 0) {
    const [startsResult, endsResult] = await Promise.all([
      supabase
        .from("ad_account_billing_starts")
        .select("id, ad_account_id, google_local_date, baseline_cost_micros")
        .in("ad_account_id", accountIds),
      supabase
        .from("ad_account_billing_ends")
        .select("ad_account_id, google_local_date, end_cost_micros")
        .in("ad_account_id", accountIds),
    ]);
    if (startsResult.error) {
      throw new Error(
        `Could not load billing position starts: ${startsResult.error.message}`,
      );
    }
    if (endsResult.error) {
      throw new Error(
        `Could not load billing position ends: ${endsResult.error.message}`,
      );
    }
    starts = (startsResult.data ?? []).map((start) => ({
      id: start.id,
      accountId: start.ad_account_id,
      googleLocalDate: start.google_local_date,
      baselineCostMicros: start.baseline_cost_micros,
    }));
    ends = (endsResult.data ?? []).map((end) => ({
      accountId: end.ad_account_id,
      googleLocalDate: end.google_local_date,
      endCostMicros: end.end_cost_micros,
    }));
  }

  const { data: source, error: sourceError } = await supabase
    .from("revenue_sources")
    .select("id")
    .eq("name", SPEND_SOURCE)
    .maybeSingle();
  if (sourceError) {
    throw new Error(
      `Could not load billing position source: ${sourceError.message}`,
    );
  }
  if (!source) throw new Error(`Revenue source "${SPEND_SOURCE}" is missing.`);

  const [
    ledgerRows,
    metricRows,
    invoices,
    skips,
    referralTermsByClient,
    commissionTermsByAccount,
  ] = await Promise.all([
    fetchPositionLedgerRows(supabase, source.id, accountIds),
    fetchPositionMetrics(supabase, accountIds, currentStart, currentEnd),
    fetchPositionInvoices(supabase, clientIds),
    fetchPositionSkips(supabase, clientIds, currentStart),
    fetchPositionReferralTerms(supabase, clientIds),
    fetchAccountCommissionTerms(supabase, accountIds) as Promise<
      Map<string, BillingPositionAccountTerm[]>
    >,
  ]);

  return buildBillingPositions({
    now,
    clients,
    accounts,
    starts,
    ends,
    ledgerRows,
    metricRows,
    invoices,
    skips,
    referralTermsByClient,
    commissionTermsByAccount,
  });
}

/** Full serialisable model consumed by /admin/billing. */
export async function fetchAdminBillingDashboard(
  periodStart?: string,
): Promise<BillingAdminDashboard> {
  const supabase = await createClient();
  const recentWeeks = closedWeeks();
  const requestedWeek = periodStart ? closedWeekStarting(periodStart) : null;
  const selectedWeek = requestedWeek ?? recentWeeks[0];
  const weeks = recentWeeks.some((week) => week.start === selectedWeek.start)
    ? recentWeeks
    : [selectedWeek, ...recentWeeks].sort((left, right) =>
        right.start.localeCompare(left.start),
      );
  const generatedAt = new Date();
  const [calculated, positions] = await Promise.all([
    calculateWeek(supabase, selectedWeek),
    fetchAdminBillingPositions(supabase, generatedAt),
  ]);

  const [invoiceRows, { data: clientRows, error: clientsError }] =
    await Promise.all([
      fetchAllIssuedInvoices(supabase),
      supabase.from("portal_clients").select("id, full_name, email"),
    ]);
  if (clientsError)
    throw new Error(`Could not load invoice clients: ${clientsError.message}`);

  const clientById = new Map(
    (clientRows ?? []).map((client) => [client.id, client]),
  );
  const historyRows = invoiceRows.sort((a, b) =>
    (b.issued_at ?? b.created_at).localeCompare(a.issued_at ?? a.created_at),
  );
  const invoices: BillingInvoiceHistoryRow[] = historyRows.map((invoice) => {
    const client = clientById.get(invoice.client_id);
    return {
      ...invoice,
      clientName: client?.full_name ?? "Unknown client",
      clientEmail: client?.email ?? "",
      outstandingAmount: outstandingAmount(invoice),
    };
  });

  // New billing is EUR-only. Keep legacy foreign-currency rows visible in the
  // history, but never add unlike currencies and label the result as euros.
  const issued = (invoiceRows as SummaryInvoice[]).filter(
    (invoice) => invoice.currency.toUpperCase() === BILLING_CURRENCY,
  );
  // A void Stripe invoice has been cancelled and must not inflate billed
  // revenue. Uncollectible invoices remain issued history, but no longer count
  // as outstanding because only Stripe `open` balances are payable.
  const billed = issued.filter(
    (invoice) => invoice.status !== "void" && invoice.status !== "waived",
  );
  const selected = billed.filter(
    (invoice) => invoice.period_start === selectedWeek.start,
  );
  const selectedSettlements = issued.filter(
    (invoice) => invoice.period_start === selectedWeek.start,
  );
  const month = isoDay(new Date()).slice(0, 7);
  const issuedThisMonth = billed.filter(
    (invoice) => isoDay(new Date(invoice.issued_at!)).slice(0, 7) === month,
  );
  const paidThisMonth = issued.filter(
    (invoice) =>
      invoice.status === "paid" &&
      Boolean(invoice.paid_at) &&
      isoDay(new Date(invoice.paid_at!)).slice(0, 7) === month,
  );
  const open = issued.filter((invoice) => invoice.status === "open");
  const failed = issued.filter(
    (invoice) =>
      invoice.status === "uncollectible" ||
      (invoice.status === "open" && Boolean(invoice.payment_failed_at)),
  );
  const balance = (invoice: SummaryInvoice) =>
    invoice.status === "open"
      ? Number(invoice.amount_remaining ?? invoice.amount)
      : 0;
  const failedBalance = (invoice: SummaryInvoice) =>
    Number(invoice.amount_remaining ?? invoice.amount);
  const sum = (
    rows: SummaryInvoice[],
    value: (invoice: SummaryInvoice) => number,
  ) => round2(rows.reduce((total, invoice) => total + value(invoice), 0));

  return {
    generatedAt: generatedAt.toISOString(),
    currency: BILLING_CURRENCY,
    feeRate: AGENCY_FEE_RATE,
    weeks,
    selectedWeek,
    summary: {
      selectedWeekBilled: sum(selected, (invoice) => Number(invoice.amount)),
      selectedWeekPaid: sum(
        selected.filter((invoice) => invoice.status === "paid"),
        (invoice) => Number(invoice.amount),
      ),
      currentMonthBilled: sum(issuedThisMonth, (invoice) =>
        Number(invoice.amount),
      ),
      currentMonthPaid: sum(paidThisMonth, (invoice) => Number(invoice.amount)),
      outstanding: sum(open, balance),
      failed: sum(failed, failedBalance),
      invoiceCount: selectedSettlements.length,
      paidCount: paidThisMonth.length,
      outstandingCount: open.length,
      failedCount: failed.length,
    },
    positions,
    // This is an action queue. Sent/settled invoices remain visible in the
    // position and immutable history; only new or safely recoverable issues
    // belong here.
    clients: billingReviewQueue(calculated.map((entry) => entry.preview)),
    invoices,
  };
}

export class BillingIssueError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly preview?: BillingClientPreview,
  ) {
    super(message);
    this.name = "BillingIssueError";
  }
}

export type AutomaticBillingIssueResult =
  | {
      state: "issued";
      invoice: Invoice;
      amount: number;
      billableSpend: number;
      evidenceAccountCount: number;
    }
  | {
      state: "no_charge";
      invoice: null;
      amount: 0;
      billableSpend: 0;
      evidenceAccountCount: number;
    };

export type BillingBatchIssued = {
  clientId: string;
  clientName: string;
  invoiceId: string;
  amount: number;
  alreadyIssued: boolean;
};

export type BillingBatchNoCharge = {
  clientId: string;
  clientName: string;
  billableSpend: number;
  reason: "exact_zero" | "cycle_skipped";
};

export type BillingBatchBlocked = {
  clientId: string;
  clientName: string;
  code: string;
  message: string;
};

export type BillingBatchResult = {
  period: { start: string; end: string };
  issued: BillingBatchIssued[];
  noCharge: BillingBatchNoCharge[];
  blocked: BillingBatchBlocked[];
};

function hasDurableIssueReceipt(invoice: Invoice): boolean {
  return invoice.status === "waived"
    ? invoice.issued_at !== null
    : invoice.stripe_sent_at !== null ||
        invoice.stripe_delivery_assumed_at !== null;
}

function stripeRecipientExpectation(
  value: unknown,
): StripeInvoiceRecipientExpectation {
  const recipient = requireBillingRecipientSnapshot(value);
  return {
    email: recipient.email,
    name: recipient.billingName ?? recipient.fallbackName,
    address: {
      line1: recipient.addressLine1,
      line2: recipient.addressLine2,
      city: recipient.addressCity,
      postal_code: recipient.addressPostalCode,
      state: recipient.addressState,
      country: recipient.addressCountry,
    },
    taxId: recipient.taxId,
  };
}

async function pushToStripe(
  supabase: Supabase,
  invoice: Invoice,
  assertLeaseOwnership: () => Promise<void>,
): Promise<Invoice> {
  const recoveryMode = stripeInvoiceRecoveryMode(invoice);
  const sendOnlyRecovery = recoveryMode === "send_only";
  if (recoveryMode === null || Number(invoice.amount) < 0.01) {
    throw new Error(
      "Only a positive payable draft or an explicitly unsent open invoice can be sent to Stripe.",
    );
  }
  const stripeLines = invoice.line_items.filter((line) => line.amount >= 0.01);
  if (stripeLines.length === 0) {
    throw new Error(
      "A Stripe invoice must contain at least one payable fee line.",
    );
  }
  const recipient = requireBillingRecipientSnapshot(invoice.billing_recipient);
  const stripeRecipient = stripeRecipientExpectation(recipient);

  const { data: client, error: clientError } = await supabase
    .from("portal_clients")
    .select("id, stripe_customer_id")
    .eq("id", invoice.client_id)
    .maybeSingle();
  if (clientError)
    throw new Error(`Could not load invoice client: ${clientError.message}`);
  if (!client) throw new Error("Invoice client no longer exists.");

  const identity = {
    name: recipient.billingName,
    address: {
      line1: recipient.addressLine1,
      line2: recipient.addressLine2,
      city: recipient.addressCity,
      postal_code: recipient.addressPostalCode,
      state: recipient.addressState,
      country: recipient.addressCountry,
    },
  };

  let customerId = client.stripe_customer_id;
  if (sendOnlyRecovery && !customerId) {
    throw new Error(
      "The unsent Stripe invoice has no customer binding to verify.",
    );
  } else if (!customerId) {
    customerId = await createCustomer({
      email: recipient.email,
      name: recipient.fallbackName,
      clientId: client.id,
      identity,
      assertLeaseOwnership,
    });
    const { error } = await supabase
      .from("portal_clients")
      .update({ stripe_customer_id: customerId })
      .eq("id", client.id);
    if (error)
      throw new Error(`Could not bind the Stripe customer: ${error.message}`);
  } else if (!sendOnlyRecovery) {
    await updateCustomerBilling(customerId, {
      clientId: client.id,
      email: recipient.email,
      fallbackName: recipient.fallbackName,
      identity,
      assertLeaseOwnership,
    });
  }

  const remote = await createAndFinalizeInvoice({
    customerId,
    currency: BILLING_CURRENCY,
    lines: stripeLines,
    daysUntilDue: DAYS_UNTIL_DUE,
    description: `Dropscale Google Ads agency fee - ${invoice.period_start} to ${invoice.period_end}`,
    invoiceId: invoice.id,
    autoCharge: false,
    recipient: stripeRecipient,
    assertLeaseOwnership,
    existingStripeInvoiceId: invoice.stripe_invoice_id ?? undefined,
    onDraftCreated: async (stripeInvoiceId: string) => {
      const { data: current, error: readError } = await supabase
        .from("invoices")
        .select("stripe_invoice_id")
        .eq("id", invoice.id)
        .maybeSingle();
      if (readError)
        throw new Error(
          `Could not read the local Stripe draft id: ${readError.message}`,
        );
      if (!current)
        throw new Error(
          "The local invoice disappeared before its Stripe draft was saved.",
        );
      if (
        current.stripe_invoice_id &&
        current.stripe_invoice_id !== stripeInvoiceId
      ) {
        throw new Error(
          "The local invoice is already linked to a different Stripe draft.",
        );
      }
      if (current.stripe_invoice_id === stripeInvoiceId) return;

      const { error } = await supabase
        .from("invoices")
        .update({
          stripe_invoice_id: stripeInvoiceId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", invoice.id);
      if (error)
        throw new Error(
          `Could not persist the Stripe draft id: ${error.message}`,
        );
    },
    onSent: async (remoteInvoice) => {
      const sentAt = new Date().toISOString();
      const { data: stored, error } = await supabase
        .from("invoices")
        .update({
          stripe_sent_at: sentAt,
          stripe_delivery_assumed_at: null,
          issue_error: null,
          updated_at: sentAt,
        })
        .eq("id", invoice.id)
        .eq("stripe_invoice_id", remoteInvoice.id)
        .is("stripe_sent_at", null)
        .is("stripe_delivery_assumed_at", null)
        .select(
          "id, stripe_invoice_id, stripe_sent_at, stripe_delivery_assumed_at",
        )
        .maybeSingle();
      if (error) {
        throw new Error(
          `Could not persist Stripe delivery evidence: ${error.message}`,
        );
      }
      if (stored) return;

      // invoice.sent may win the race and persist the same fact first. A zero
      // row update is acceptable only after proving that exact remote invoice
      // already has real sent evidence; every other mismatch fails closed.
      const { data: current, error: readError } = await supabase
        .from("invoices")
        .select(
          "id, stripe_invoice_id, stripe_sent_at, stripe_delivery_assumed_at",
        )
        .eq("id", invoice.id)
        .maybeSingle();
      if (readError) {
        throw new Error(
          `Could not verify Stripe delivery evidence: ${readError.message}`,
        );
      }
      if (
        !current ||
        current.stripe_invoice_id !== remoteInvoice.id ||
        current.stripe_sent_at === null
      ) {
        throw new Error(
          "Stripe accepted delivery, but its durable local evidence could not be verified.",
        );
      }
    },
  });

  await assertLeaseOwnership();
  assertStripeInvoiceMatchesLocal(remote, {
    localInvoiceId: invoice.id,
    stripeInvoiceId: invoice.stripe_invoice_id ?? remote.id,
    customerId,
    currency: invoice.currency,
    amount: Number(invoice.amount),
    requireMetadata: true,
    requireManualCollection: true,
    recipient: stripeRecipient,
  });
  const status = localInvoiceStatus(remote.status);
  if (status !== "open" && status !== "paid") {
    throw new StripeError(
      `Stripe invoice ${remote.id} did not finish issuance in an open or paid state.`,
      409,
    );
  }
  const issuedAt = remote.status_transitions?.finalized_at
    ? new Date(remote.status_transitions.finalized_at * 1000).toISOString()
    : new Date().toISOString();
  const paidAt = remote.status_transitions?.paid_at
    ? new Date(remote.status_transitions.paid_at * 1000).toISOString()
    : status === "paid"
      ? issuedAt
      : null;
  const { data: updated, error: updateError } = await supabase
    .from("invoices")
    .update({
      status,
      stripe_invoice_id: remote.id,
      stripe_hosted_url: remote.hosted_invoice_url,
      stripe_invoice_number: remote.number ?? null,
      stripe_invoice_pdf: remote.invoice_pdf ?? null,
      amount_remaining:
        typeof remote.amount_remaining === "number"
          ? round2(remote.amount_remaining / 100)
          : status === "paid"
            ? 0
            : invoice.amount,
      due_date: remote.due_date
        ? isoDay(new Date(remote.due_date * 1000))
        : addDays(isoDay(new Date()), DAYS_UNTIL_DUE),
      issued_at: issuedAt,
      paid_at: paidAt,
      issue_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoice.id)
    .eq("stripe_invoice_id", remote.id)
    .in("status", [...allowedLocalStatusesForStripeUpdate(status)])
    .select("*")
    .maybeSingle();
  if (updateError)
    throw new Error(
      `Could not save the issued invoice: ${updateError.message}`,
    );
  if (!updated) {
    // The Stripe GET/finalise result may have raced a paid/void webhook. Read
    // after the failed compare-and-set and never let the older snapshot reopen
    // a terminal invoice.
    const { data: current, error: currentError } = await supabase
      .from("invoices")
      .select("*")
      .eq("id", invoice.id)
      .maybeSingle();
    if (currentError) {
      throw new Error(
        `Could not re-read the issued invoice: ${currentError.message}`,
      );
    }
    if (!current) throw new Error("The issued invoice row disappeared.");
    if (current.status === "waived") {
      throw new Error(
        `Waived invoice ${invoice.id} cannot be updated from Stripe.`,
      );
    }

    const decision = stripeInvoiceStatusDecision(current.status, status);
    if (decision === "ignore_stale") return current as Invoice;
    if (decision === "conflict") {
      throw new Error(
        `Local invoice ${invoice.id} is ${current.status}, but Stripe returned incompatible status ${status}.`,
      );
    }
    throw new Error(
      "The issued invoice changed concurrently and was not overwritten.",
    );
  }
  return updated as Invoice;
}

export async function issueClientWeek(input: {
  clientId: string;
  periodStart: string;
  expectedAmount: number;
  expectedReviewToken: string;
  /** Admin UUID for reviewed issue; null is the database's automation issuer. */
  issuedBy: string | null;
  client?: Supabase;
}): Promise<Invoice> {
  const week = closedWeekStarting(input.periodStart);
  if (!week) {
    throw new BillingIssueError(
      "Select a fully closed Monday-to-Sunday week.",
      422,
      "period_not_closed",
    );
  }
  if (
    !input.clientId ||
    !Number.isFinite(input.expectedAmount) ||
    !/^[0-9a-f]{64}$/.test(input.expectedReviewToken)
  ) {
    throw new BillingIssueError(
      "Client, expected amount and review token are required.",
      422,
      "invalid_request",
    );
  }

  const supabase = input.client ?? (await createClient());
  const calculated = (await calculateWeek(supabase, week, input.clientId))[0];
  if (!calculated) {
    throw new BillingIssueError(
      "Approved billing client not found.",
      404,
      "client_not_found",
    );
  }
  const { preview } = calculated;
  if (input.expectedReviewToken !== preview.reviewToken) {
    throw new BillingIssueError(
      "The reviewed invoice composition changed. Review it again before issuing.",
      409,
      "stale_preview",
      preview,
    );
  }
  if (round2(input.expectedAmount) !== preview.amount) {
    throw new BillingIssueError(
      `The preview changed from EUR ${round2(input.expectedAmount).toFixed(2)} to EUR ${preview.amount.toFixed(2)}. Review it again.`,
      409,
      "stale_preview",
      preview,
    );
  }

  const blocking = preview.blockers.find((item) => item.severity === "error");
  if (blocking && blocking.code !== "issue_in_progress") {
    throw new BillingIssueError(blocking.message, 422, blocking.code, preview);
  }

  let issueLease: BillingIssueLeaseHandle | null = null;
  if (preview.amount >= 0.01) {
    try {
      issueLease = await acquireBillingIssueLease(supabase, {
        clientId: input.clientId,
        periodStart: week.start,
        issuedBy: input.issuedBy,
      });
    } catch (error) {
      throw new BillingIssueError(
        error instanceof BillingIssueLeaseServiceError
          ? error.message
          : "Could not reserve this client for Stripe invoice issuance.",
        503,
        "issue_lease_failed",
        preview,
      );
    }
    if (!issueLease) {
      throw new BillingIssueError(
        "Another invoice for this client is already being issued.",
        409,
        "issue_in_progress",
        preview,
      );
    }
  }

  try {
    let invoice = preview.existingInvoice;
    if (invoice) {
      const recoveryMode = stripeInvoiceRecoveryMode(invoice);
      const sendOnlyRecovery = recoveryMode === "send_only";
      if (recoveryMode === null) {
        throw new BillingIssueError(
          "This invoice has already been issued.",
          409,
          "already_issued",
          preview,
        );
      }
      if (
        Number(invoice.amount) !== preview.amount ||
        !isReviewedAgencyCalculationVersion(invoice.calculation_version) ||
        invoice.referral_discount_term_id !== calculated.referralTermId
      ) {
        throw new BillingIssueError(
          "The saved draft no longer matches the current preview. It was not sent.",
          409,
          "stale_draft",
          preview,
        );
      }
      if (
        !invoice.issue_error &&
        invoice.issue_attempted_at &&
        Date.now() - new Date(invoice.issue_attempted_at).getTime() <
          ISSUE_LOCK_MS
      ) {
        throw new BillingIssueError(
          "This invoice is already being issued.",
          409,
          "issue_in_progress",
          preview,
        );
      }

      let claim = supabase
        .from("invoices")
        .update({
          issue_attempted_at: new Date().toISOString(),
          issue_error: null,
        })
        .eq("id", invoice.id)
        .eq("status", invoice.status);
      claim = invoice.issue_attempted_at
        ? claim.eq("issue_attempted_at", invoice.issue_attempted_at)
        : claim.is("issue_attempted_at", null);
      if (sendOnlyRecovery) {
        claim = claim
          .is("stripe_sent_at", null)
          .is("stripe_delivery_assumed_at", null);
      }
      const { data: claimed, error } = await claim.select("*").maybeSingle();
      if (error)
        throw new BillingIssueError(
          error.message,
          500,
          "draft_claim_failed",
          preview,
        );
      if (!claimed) {
        throw new BillingIssueError(
          "Another issue attempt has already started.",
          409,
          "issue_in_progress",
          preview,
        );
      }
      invoice = claimed as Invoice;
    } else {
      const { data, error } = await supabase.rpc(
        "create_manual_referral_invoice",
        {
          p_client_id: input.clientId,
          p_period_start: week.start,
          p_period_end: week.end,
          p_amount: preview.amount,
          p_line_items: calculated.lines,
          p_ledger_rows: calculated.ledgerRows.map((row) => ({
            commission_id: row.id,
            gross_amount: microsToDecimal(decimalToMicros(row.gross_amount)),
            currency: row.currency,
          })),
          p_billing_recipient: calculated.recipient,
          p_referral_term_id: calculated.referralTermId,
          p_issued_by: input.issuedBy,
          p_calculation_version: CALCULATION_VERSION,
        },
      );
      if (error) {
        const duplicate =
          error.code === "23505" || error.message.includes("duplicate key");
        const staleCommercialSnapshot = error.code === "40001";
        throw new BillingIssueError(
          staleCommercialSnapshot
            ? "The manual referral term or billing recipient changed while this week was being issued. Review the invoice again."
            : duplicate
              ? "This week or one of its ledger rows is already being invoiced."
              : error.message,
          duplicate || staleCommercialSnapshot ? 409 : 422,
          staleCommercialSnapshot
            ? "stale_preview"
            : duplicate
              ? "already_issued"
              : "invoice_create_failed",
          preview,
        );
      }
      invoice = (data as Invoice[] | null)?.[0] ?? null;
      if (!invoice)
        throw new BillingIssueError(
          "Invoice creation returned no row.",
          500,
          "invoice_create_failed",
        );
    }

    // A 0% referral term or a sub-cent total is an immutable, locally issued
    // waived settlement. It deliberately has no Stripe customer or invoice.
    if (invoice.status === "waived") return invoice;

    const stripeLease = issueLease;
    if (!stripeLease) {
      throw new BillingIssueError(
        "A payable invoice cannot reach Stripe without an issue lease.",
        503,
        "issue_lease_failed",
        preview,
      );
    }
    const assertLeaseOwnership = () =>
      renewBillingIssueLease(supabase, stripeLease);

    try {
      return await pushToStripe(supabase, invoice, assertLeaseOwnership);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Stripe invoice issue failed.";
      if (!(error instanceof BillingIssueLeaseLostError)) {
        try {
          await recordBillingIssueError(
            supabase,
            stripeLease,
            invoice.id,
            message,
          );
        } catch (recordError) {
          // The original Stripe failure remains the operator-facing error. A
          // failed fenced annotation must never mask it or fall back to an
          // unfenced update that could overwrite a newer worker's evidence.
          console.error(
            "Could not record fenced billing issue error:",
            recordError,
          );
        }
      }
      throw new BillingIssueError(
        error instanceof BillingIssueLeaseLostError
          ? "Invoice issuance ownership was lost. Refresh the review before retrying."
          : error instanceof StripeError
            ? `Stripe: ${message}`
            : message,
        error instanceof BillingIssueLeaseLostError
          ? 409
          : error instanceof StripeError &&
              error.status >= 400 &&
              error.status < 500
            ? 422
            : 503,
        error instanceof BillingIssueLeaseLostError
          ? "issue_lease_lost"
          : "stripe_issue_failed",
        preview,
      );
    }
  } finally {
    if (issueLease) {
      try {
        await releaseBillingIssueLease(supabase, issueLease);
      } catch (error) {
        console.error("Could not release billing issue lease:", error);
      }
    }
  }
}

/**
 * Reuse the reviewed calculation and issue contract with an explicit admin
 * issuer, or null for the legacy automation caller. The first preview supplies
 * a short-lived integrity token; issueClientWeek recalculates it immediately
 * before the database/Stripe mutation, so a changed ledger, boundary,
 * recipient or rate fails closed.
 */
export async function issueClientWeekFromCurrentPreview(input: {
  clientId: string;
  periodStart: string;
  issuedBy: string | null;
  client: Supabase;
}): Promise<AutomaticBillingIssueResult> {
  const week = closedWeekStarting(input.periodStart);
  if (!week) {
    throw new BillingIssueError(
      "Select a fully closed Monday-to-Sunday week.",
      422,
      "period_not_closed",
    );
  }
  if (!input.clientId) {
    throw new BillingIssueError(
      "Client is required.",
      422,
      "invalid_request",
    );
  }

  const calculated = (await calculateWeek(input.client, week, input.clientId))[0];
  if (!calculated) {
    throw new BillingIssueError(
      "Approved billing client not found.",
      404,
      "client_not_found",
    );
  }
  const { preview } = calculated;
  const evidenceAccountCount = preview.stores.length;

  // A Stripe delivery may have committed while its queue receipt response was
  // lost. Treat only durable local delivery evidence as success; never send it
  // again merely to repair the automation receipt.
  if (
    preview.existingInvoice &&
    stripeInvoiceRecoveryMode(preview.existingInvoice) === null &&
    hasDurableIssueReceipt(preview.existingInvoice)
  ) {
    return {
      state: "issued",
      invoice: preview.existingInvoice,
      amount: Number(preview.existingInvoice.amount),
      billableSpend: preview.billableSpend,
      evidenceAccountCount,
    };
  }

  const blocking = preview.blockers.find((item) => item.severity === "error");
  if (blocking) {
    throw new BillingIssueError(blocking.message, 422, blocking.code, preview);
  }

  // An exact-zero week has evidence but no line to persist in an invoice.
  // The receipt RPC independently rechecks the complete Google snapshot under
  // table locks before accepting this as terminal no-charge work.
  if (calculated.lines.length === 0) {
    return {
      state: "no_charge",
      invoice: null,
      amount: 0,
      billableSpend: 0,
      evidenceAccountCount,
    };
  }

  const invoice = await issueClientWeek({
    clientId: input.clientId,
    periodStart: week.start,
    expectedAmount: preview.amount,
    expectedReviewToken: preview.reviewToken,
    issuedBy: input.issuedBy,
    client: input.client,
  });
  return {
    state: "issued",
    invoice,
    amount: Number(invoice.amount),
    billableSpend: preview.billableSpend,
    evidenceAccountCount,
  };
}

/** Automatic callers have no admin issuer; reviewed bulk actions do. */
export function issueClientWeekAutomatically(input: {
  clientId: string;
  periodStart: string;
  client: Supabase;
}): Promise<AutomaticBillingIssueResult> {
  return issueClientWeekFromCurrentPreview({ ...input, issuedBy: null });
}

/**
 * Issue one exact closed week for every billing client. Each client is its own
 * result so one disconnected account cannot stop invoices whose evidence is
 * complete. `issueClientWeek` remains the sole Stripe mutation and rechecks
 * the preview immediately before every write.
 */
export async function issueClosedBillingWeekBatch(input: {
  periodStart: string;
  issuedBy: string;
  client: Supabase;
}): Promise<BillingBatchResult> {
  const week = closedWeekStarting(input.periodStart);
  if (!week) {
    throw new BillingIssueError(
      "Select a fully closed Monday-to-Sunday week.",
      422,
      "period_not_closed",
    );
  }
  if (!input.issuedBy) {
    throw new BillingIssueError(
      "An admin issuer is required.",
      422,
      "invalid_request",
    );
  }

  const calculated = await calculateWeek(input.client, week);
  const skips = await fetchPositionSkips(
    input.client,
    calculated.map((entry) => entry.preview.clientId),
    week.start,
  );
  const skippedClients = new Set(
    skips
      .filter((skip) => skip.periodEnd === week.end)
      .map((skip) => skip.clientId),
  );
  const result: BillingBatchResult = {
    period: week,
    issued: [],
    noCharge: [],
    blocked: [],
  };

  // Match the proven queue fan-out without making one client's failure fatal.
  for (let offset = 0; offset < calculated.length; offset += 3) {
    const outcomes = await Promise.all(
      calculated.slice(offset, offset + 3).map(async (entry) => {
        const { preview } = entry;
        if (skippedClients.has(preview.clientId)) {
          return {
            state: "no_charge" as const,
            value: {
              clientId: preview.clientId,
              clientName: preview.clientName,
              billableSpend: preview.billableSpend,
              reason: "cycle_skipped" as const,
            },
          };
        }

        const alreadyIssued = Boolean(
          preview.existingInvoice &&
            hasDurableIssueReceipt(preview.existingInvoice),
        );
        try {
          const issued = await issueClientWeekFromCurrentPreview({
            clientId: preview.clientId,
            periodStart: week.start,
            issuedBy: input.issuedBy,
            client: input.client,
          });
          if (issued.state === "no_charge") {
            return {
              state: "no_charge" as const,
              value: {
                clientId: preview.clientId,
                clientName: preview.clientName,
                billableSpend: issued.billableSpend,
                reason: "exact_zero" as const,
              },
            };
          }
          return {
            state: "issued" as const,
            value: {
              clientId: preview.clientId,
              clientName: preview.clientName,
              invoiceId: issued.invoice.id,
              amount: issued.amount,
              alreadyIssued,
            },
          };
        } catch (error) {
          if (!(error instanceof BillingIssueError)) {
            console.error("Bulk invoice issue failed for one client:", error);
          }
          return {
            state: "blocked" as const,
            value: {
              clientId: preview.clientId,
              clientName: preview.clientName,
              code:
                error instanceof BillingIssueError
                  ? error.code
                  : "unexpected_error",
              message:
                error instanceof BillingIssueError
                  ? error.message
                  : "This invoice could not be issued.",
            },
          };
        }
      }),
    );

    for (const outcome of outcomes) {
      if (outcome.state === "issued") result.issued.push(outcome.value);
      else if (outcome.state === "no_charge")
        result.noCharge.push(outcome.value);
      else result.blocked.push(outcome.value);
    }
  }

  return result;
}

export type ReconcileResult = {
  checked: number;
  updated: number;
  errors: string[];
};

/** Stripe webhook safety net. This synchronises state; it never issues money. */
export async function reconcileInvoices(
  client?: Supabase,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, updated: 0, errors: [] };
  if (!stripeConfigured()) {
    result.errors.push("Stripe is not configured.");
    return result;
  }
  const supabase = client ?? (await createClient());

  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("invoices")
      .select(
        "id, client_id, stripe_invoice_id, status, amount, currency, calculation_version, billing_recipient",
      )
      .in("status", ["open", "draft", "uncollectible"])
      .not("stripe_invoice_id", "is", null)
      .order("id", { ascending: true })
      .limit(100);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) {
      result.errors.push(error.message);
      break;
    }
    const rows = data ?? [];
    for (const row of rows) {
      if (!row.stripe_invoice_id) continue;
      result.checked += 1;
      try {
        const remote = await getInvoice(row.stripe_invoice_id);
        const { data: owner, error: ownerError } = await supabase
          .from("portal_clients")
          .select("stripe_customer_id")
          .eq("id", row.client_id)
          .maybeSingle();
        if (ownerError) throw ownerError;
        if (!owner?.stripe_customer_id) {
          throw new Error(
            `Local invoice ${row.id} has no safely bound Stripe customer.`,
          );
        }

        const manualAgencyInvoice = isManualAgencyCalculationVersion(
          row.calculation_version,
        );
        assertStripeInvoiceMatchesLocal(remote, {
          localInvoiceId: row.id,
          stripeInvoiceId: row.stripe_invoice_id,
          customerId: owner.stripe_customer_id,
          currency: row.currency,
          amount: Number(row.amount),
          requireMetadata: manualAgencyInvoice,
          requireManualCollection: manualAgencyInvoice,
          ...(isReviewedAgencyCalculationVersion(row.calculation_version)
            ? { recipient: stripeRecipientExpectation(row.billing_recipient) }
            : {}),
        });
        const status = localInvoiceStatus(remote.status);
        if (!status) {
          throw new Error(
            `Unsupported Stripe invoice status: ${remote.status}`,
          );
        }
        const update = {
          status,
          stripe_hosted_url: remote.hosted_invoice_url,
          stripe_invoice_number: remote.number ?? null,
          stripe_invoice_pdf: remote.invoice_pdf ?? null,
          amount_remaining:
            typeof remote.amount_remaining === "number"
              ? round2(remote.amount_remaining / 100)
              : status === "paid"
                ? 0
                : Number(row.amount),
          ...(remote.due_date
            ? { due_date: isoDay(new Date(remote.due_date * 1000)) }
            : {}),
          ...(remote.status_transitions?.finalized_at
            ? {
                issued_at: new Date(
                  remote.status_transitions.finalized_at * 1000,
                ).toISOString(),
              }
            : {}),
          ...(remote.status_transitions?.paid_at
            ? {
                paid_at: new Date(
                  remote.status_transitions.paid_at * 1000,
                ).toISOString(),
              }
            : {}),
          ...(["paid", "void", "uncollectible"].includes(status)
            ? { payment_failed_at: null }
            : {}),
          updated_at: new Date().toISOString(),
        };
        const { data: updated, error: updateError } = await supabase
          .from("invoices")
          .update(update)
          .eq("id", row.id)
          .eq("stripe_invoice_id", row.stripe_invoice_id)
          .in("status", [...allowedLocalStatusesForStripeUpdate(status)])
          .select("id")
          .maybeSingle();
        if (updateError) throw updateError;
        if (!updated) {
          const { data: current, error: currentError } = await supabase
            .from("invoices")
            .select("status")
            .eq("id", row.id)
            .maybeSingle();
          if (currentError) throw currentError;
          if (!current)
            throw new Error(
              `Local invoice ${row.id} disappeared during reconcile.`,
            );
          if (current.status === "waived") {
            throw new Error(
              `Waived invoice ${row.id} cannot be reconciled from Stripe.`,
            );
          }

          const decision = stripeInvoiceStatusDecision(current.status, status);
          if (decision === "ignore_stale") continue;
          if (decision === "conflict") {
            throw new Error(
              `Local status ${current.status} conflicts with Stripe status ${status}.`,
            );
          }
          throw new Error(
            `Local invoice ${row.id} changed concurrently during reconcile.`,
          );
        }
        result.updated += 1;
      } catch (error) {
        result.errors.push(
          `${row.stripe_invoice_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (rows.length < 100) break;
    afterId = rows.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return result;
}

/** An invoice is late when it is payable, past due and still unpaid. */
export function isOverdue(
  invoice: Pick<Invoice, "status" | "due_date">,
  today = isoDay(new Date()),
) {
  return (
    invoice.status === "open" &&
    Boolean(invoice.due_date) &&
    invoice.due_date! < today
  );
}

export async function fetchClientInvoices(
  clientId: string,
): Promise<Invoice[]> {
  const supabase = await createClient();
  const rows: Invoice[] = [];
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("invoices")
      .select("*")
      .eq("client_id", clientId)
      .not("issued_at", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw new Error(`Could not load invoices: ${error.message}`);
    const page = (data ?? []) as Invoice[];
    rows.push(...page);
    if (page.length < pageSize) {
      return rows.sort((a, b) => b.period_start.localeCompare(a.period_start));
    }
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) return rows;
  }
}

export type ClientBillingSummary = {
  clientId: string;
  overdue: number;
  overdueAmount: number;
  open: number;
  openAmount: number;
};

export async function fetchBillingSummaries(): Promise<
  Map<string, ClientBillingSummary>
> {
  const supabase = await createClient();
  let rows: Invoice[];
  try {
    rows = await fetchAllOpenInvoices(supabase);
  } catch {
    return new Map();
  }

  const today = isoDay(new Date());
  const byClient = new Map<string, ClientBillingSummary>();
  for (const row of rows) {
    const amount = Number(row.amount_remaining ?? row.amount);
    const summary = byClient.get(row.client_id) ?? {
      clientId: row.client_id,
      overdue: 0,
      overdueAmount: 0,
      open: 0,
      openAmount: 0,
    };
    summary.open += 1;
    summary.openAmount = round2(summary.openAmount + amount);
    if (isOverdue(row, today)) {
      summary.overdue += 1;
      summary.overdueAmount = round2(summary.overdueAmount + amount);
    }
    byClient.set(row.client_id, summary);
  }
  return byClient;
}
