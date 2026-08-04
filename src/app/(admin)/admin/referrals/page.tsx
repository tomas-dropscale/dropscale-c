import type { Metadata } from "next";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ReferralsAdminView,
  type ReferralAdminDashboard,
  type ReferralAttributionEventSummary,
  type ReferralEvidenceSummary,
  type ReferralTermSummary,
} from "@/components/admin/referrals-admin-view";
import { PageContainer } from "@/components/ui/page-container";
import {
  billableMicrosSinceBaseline,
  decimalToMicros,
  microsToDecimal,
} from "@/lib/google-ads/billing-start";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Referral administration" };

const GOOGLE_SOURCE = "Google Ads Management";
const ACTIVITY_DAYS = 7;
const PAGE_SIZE = 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClientRow = {
  id: string;
  full_name: string;
  email: string;
  approval_status: string;
  referred_by: string | null;
};

type StaffProfileRow = { id: string };

type TermRow = {
  id: string;
  client_id: string;
  effective_from: string;
  revision: number | string;
  supersedes_id: string | null;
  decision_id: string;
  decision_action: string;
  decision_referred_client_id: string;
  expected_term_id: string | null;
  list_rate: number | string;
  referral_step_rate: number | string;
  referral_count: number | string;
  referral_discount_rate: number | string;
  fee_rate: number | string;
  reason: string;
  reviewed_by: string;
  created_at: string;
  sealed_at: string | null;
};

type TermItemRow = {
  id: string;
  term_id: string;
  referred_client_id: string;
  evidence_billing_start_id: string;
  evidence_commission_id: string;
  eligibility_checked_on: string;
  evidence_occurred_on: string;
  evidence_gross_amount: number | string;
  evidence_billable_amount: number | string;
  created_at: string;
};

type MemberRow = { client_id: string; member_id: string };
type AccountRow = {
  id: string;
  client_id: string;
  store_name: string;
  status: string;
  google_ads_customer_id: string | null;
};
type StartRow = {
  id: string;
  ad_account_id: string;
  google_ads_customer_id: string;
  google_local_date: string;
  baseline_cost_micros: number | string;
};
type EndRow = { ad_account_id: string };
type CommissionRow = {
  id: string;
  ad_account_id: string | null;
  occurred_on: string;
  gross_amount: number | string;
  currency: string;
  status: string;
};
type AttributionEventRow = {
  id: string;
  decision_id: string;
  referred_client_id: string;
  referrer_client_id: string;
  reason: string;
  reviewed_by: string;
  created_at: string;
  sealed_at: string | null;
};
type ClaimRequestRow = {
  id: string;
  referred_client_id: string;
  referrer_client_id: string;
  referral_code: string;
  claim_source: string;
  created_at: string;
};

type PageResult = {
  data: unknown[] | null;
  error: { message: string } | null;
  count: number | null;
};

/** Read every RLS-filtered row and fail if an exact count changes mid-audit. */
async function loadAllRows<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const rows: T[] = [];
  let expectedCount: number | null = null;
  let offset = 0;

  while (expectedCount === null || rows.length < expectedCount) {
    const result = await page(offset, offset + PAGE_SIZE - 1);
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
    if (result.count === null) {
      throw new Error(
        `${label}: PostgREST did not return an exact audit count.`,
      );
    }
    if (expectedCount === null) expectedCount = result.count;
    if (result.count !== expectedCount) {
      throw new Error(
        `${label}: rows changed while the audit was being paged.`,
      );
    }

    const batch = (result.data ?? []) as T[];
    rows.push(...batch);
    if (
      rows.length > expectedCount ||
      (batch.length === 0 && rows.length < expectedCount)
    ) {
      throw new Error(
        `${label}: PostgREST returned an incomplete or unstable page.`,
      );
    }
    offset += batch.length;
  }

  if (rows.length !== expectedCount) {
    throw new Error(
      `${label}: expected ${expectedCount} rows but received ${rows.length}.`,
    );
  }
  return rows;
}

function lisbonDay(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  if (!ISO_DAY.test(day))
    throw new Error("Could not resolve the Lisbon review date.");
  return day;
}

function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function isoWeekday(day: string) {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function toNumber(value: number | string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Invalid ${field} in referral evidence.`);
  return parsed;
}

function isTimestamp(value: string | null): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function termSummary(row: TermRow): ReferralTermSummary {
  const revision = toNumber(row.revision, "term revision");
  const referralCount = toNumber(row.referral_count, "referral count");
  const listRate = toNumber(row.list_rate, "list rate");
  const referralStepRate = toNumber(row.referral_step_rate, "referral step");
  const referralDiscountRate = toNumber(
    row.referral_discount_rate,
    "referral discount",
  );
  const feeRate = toNumber(row.fee_rate, "fee rate");
  const expectedDiscount = Math.min(listRate, referralStepRate * referralCount);
  if (
    !ISO_DAY.test(row.effective_from) ||
    isoWeekday(row.effective_from) !== 1 ||
    !Number.isInteger(revision) ||
    !Number.isInteger(referralCount) ||
    referralCount < 0 ||
    listRate !== 10 ||
    referralStepRate !== 0.5 ||
    referralDiscountRate !== expectedDiscount ||
    feeRate !== listRate - referralDiscountRate ||
    (row.decision_action !== "grant" && row.decision_action !== "revoke") ||
    !row.reason.trim() ||
    !row.sealed_at
  ) {
    throw new Error("A referral term is malformed or unsealed.");
  }

  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    revision,
    action: row.decision_action,
    decisionReferredClientId: row.decision_referred_client_id,
    expectedTermId: row.expected_term_id,
    listRate,
    referralStepRate,
    referralCount,
    referralDiscountRate,
    feeRate,
    reason: row.reason,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    sealedAt: row.sealed_at,
  };
}

function latestTerm(terms: ReferralTermSummary[], cutoff: string) {
  return terms.find((term) => term.effectiveFrom <= cutoff) ?? null;
}

function failureDashboard(
  generatedAt: string,
  lisbonToday: string,
  currentWeekStart: string,
  effectiveFrom: string,
  activityCutoff: string,
  loadError: string,
): ReferralAdminDashboard {
  return {
    generatedAt,
    lisbonToday,
    currentWeekStart,
    effectiveFrom,
    activityCutoff,
    loadError,
    unassignedClients: [],
    approvedReferrers: [],
    attributionEvents: [],
    referrers: [],
  };
}

/** Read-only evidence assembly. The service-only POST route owns all writes. */
export default async function ReferralsPage() {
  const now = new Date();
  const generatedAt = now.toISOString();
  const today = lisbonDay(now);
  const weekday = isoWeekday(today);
  const currentWeekStart = addDays(today, -(weekday - 1));
  const effectiveFrom = addDays(today, (8 - weekday) % 7);
  const activityCutoff = addDays(today, -ACTIVITY_DAYS);
  const session = (await createClient()) as unknown as SupabaseClient;

  let clients: ClientRow[];
  let staffProfiles: StaffProfileRow[];
  let termRows: TermRow[];
  let itemRows: TermItemRow[];
  let members: MemberRow[];
  let accounts: AccountRow[];
  let starts: StartRow[];
  let ends: EndRow[];
  let claimRequestRows: ClaimRequestRow[];
  let attributionEventRows: AttributionEventRow[];
  let commissions: CommissionRow[];
  try {
    const [
      loadedClients,
      loadedStaffProfiles,
      loadedTerms,
      loadedItems,
      loadedMembers,
      loadedAccounts,
      loadedStarts,
      loadedEnds,
      loadedClaimRequests,
      loadedAttributionEvents,
      sourceResult,
    ] = await Promise.all([
      loadAllRows<ClientRow>(
        "Clients",
        (from, to) =>
          session
            .from("portal_clients")
            .select("id, full_name, email, approval_status, referred_by", {
              count: "exact",
            })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<StaffProfileRow>(
        "Staff profiles",
        (from, to) =>
          session
            .from("profiles")
            .select("id", { count: "exact" })
            .eq("role", "admin")
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<TermRow>(
        "Referral terms",
        (from, to) =>
          session
            .from("referral_discount_terms")
            .select("*", { count: "exact" })
            .order("effective_from", { ascending: false })
            .order("revision", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<TermItemRow>(
        "Referral evidence items",
        (from, to) =>
          session
            .from("referral_discount_term_items")
            .select("*", { count: "exact" })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<MemberRow>(
        "Client memberships",
        (from, to) =>
          session
            .from("client_members")
            .select("client_id, member_id", { count: "exact" })
            .order("client_id", { ascending: true })
            .order("member_id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<AccountRow>(
        "Ad accounts",
        (from, to) =>
          session
            .from("ad_accounts")
            .select(
              "id, client_id, store_name, status, google_ads_customer_id",
              {
                count: "exact",
              },
            )
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<StartRow>(
        "Google billing starts",
        (from, to) =>
          session
            .from("ad_account_billing_starts")
            .select(
              "id, ad_account_id, google_ads_customer_id, google_local_date, baseline_cost_micros",
              { count: "exact" },
            )
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<EndRow>(
        "Google billing ends",
        (from, to) =>
          session
            .from("ad_account_billing_ends")
            .select("ad_account_id", { count: "exact" })
            .order("ad_account_id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<ClaimRequestRow>(
        "Referral claim requests",
        (from, to) =>
          session
            .from("referral_claim_requests")
            .select("*", { count: "exact" })
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      loadAllRows<AttributionEventRow>(
        "Referral attribution events",
        (from, to) =>
          session
            .from("referral_attribution_events")
            .select("*", { count: "exact" })
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<PageResult>,
      ),
      session
        .from("revenue_sources")
        .select("id")
        .eq("name", GOOGLE_SOURCE)
        .maybeSingle(),
    ]);

    if (sourceResult.error) {
      throw new Error(`Google revenue source: ${sourceResult.error.message}`);
    }
    if (!sourceResult.data) {
      throw new Error(`Revenue source “${GOOGLE_SOURCE}” is missing.`);
    }
    const sourceId = String(sourceResult.data.id);

    clients = loadedClients;
    staffProfiles = loadedStaffProfiles;
    termRows = loadedTerms;
    itemRows = loadedItems;
    members = loadedMembers;
    accounts = loadedAccounts;
    starts = loadedStarts;
    ends = loadedEnds;
    claimRequestRows = loadedClaimRequests;
    attributionEventRows = loadedAttributionEvents;
    const accountIds = accounts.map((account) => account.id);
    commissions =
      accountIds.length === 0
        ? []
        : await loadAllRows<CommissionRow>(
            "Recent Google commissions",
            (from, to) =>
              session
                .from("commissions")
                .select(
                  "id, ad_account_id, occurred_on, gross_amount, currency, status",
                  { count: "exact" },
                )
                .eq("source_id", sourceId)
                .eq("status", "confirmed")
                .gt("gross_amount", 0)
                .gte("occurred_on", activityCutoff)
                .lte("occurred_on", today)
                .order("occurred_on", { ascending: false })
                .order("id", { ascending: false })
                .range(from, to) as unknown as PromiseLike<PageResult>,
          );
  } catch (error) {
    return (
      <PageContainer
        title="Referral administration"
        description="Seal permanent referral attribution, then review commercial discounts as a separate Monday-effective decision."
      >
        <ReferralsAdminView
          dashboard={failureDashboard(
            generatedAt,
            today,
            currentWeekStart,
            effectiveFrom,
            activityCutoff,
            error instanceof Error
              ? error.message
              : "Referral evidence could not be loaded.",
          )}
        />
      </PageContainer>
    );
  }

  let dashboard: ReferralAdminDashboard;
  try {
    if (termRows.some((term) => !term.sealed_at)) {
      throw new Error(
        "An unsealed referral term was visible to the review session.",
      );
    }

    const clientById = new Map(clients.map((client) => [client.id, client]));
    const staffIds = new Set(staffProfiles.map((profile) => profile.id));
    const claimRequestByClient = new Map<string, ClaimRequestRow>();
    for (const request of claimRequestRows) {
      if (
        !UUID.test(request.id) ||
        !UUID.test(request.referred_client_id) ||
        !UUID.test(request.referrer_client_id) ||
        request.referred_client_id === request.referrer_client_id ||
        !clientById.has(request.referred_client_id) ||
        !clientById.has(request.referrer_client_id) ||
        !request.referral_code ||
        request.referral_code.length > 128 ||
        request.referral_code !== request.referral_code.trim().toUpperCase() ||
        (request.claim_source !== "signup" &&
          request.claim_source !== "client") ||
        !isTimestamp(request.created_at) ||
        claimRequestByClient.has(request.referred_client_id)
      ) {
        throw new Error("A pending referral claim request is malformed.");
      }
      claimRequestByClient.set(request.referred_client_id, request);
    }
    const attributionEvents: ReferralAttributionEventSummary[] =
      attributionEventRows.map((event) => {
        const referredClient = clientById.get(event.referred_client_id);
        const referrer = clientById.get(event.referrer_client_id);
        if (
          !UUID.test(event.id) ||
          !UUID.test(event.decision_id) ||
          !UUID.test(event.referred_client_id) ||
          !UUID.test(event.referrer_client_id) ||
          event.referred_client_id === event.referrer_client_id ||
          !referredClient ||
          !referrer ||
          !event.reason.trim() ||
          event.reason.length > 1000 ||
          !UUID.test(event.reviewed_by) ||
          !isTimestamp(event.created_at) ||
          !isTimestamp(event.sealed_at)
        ) {
          throw new Error(
            "A referral attribution event is malformed or unsealed.",
          );
        }
        return {
          id: event.id,
          decisionId: event.decision_id,
          referredClientId: event.referred_client_id,
          referredClientName: referredClient.full_name,
          referrerClientId: event.referrer_client_id,
          referrerName: referrer.full_name,
          reason: event.reason,
          reviewedBy: event.reviewed_by,
          createdAt: event.created_at,
          sealedAt: event.sealed_at,
        };
      });
    const accountById = new Map(
      accounts.map((account) => [account.id, account]),
    );
    const startsByAccount = new Map(
      starts.map((start) => [start.ad_account_id, start]),
    );
    const startById = new Map(starts.map((start) => [start.id, start]));
    const endedAccounts = new Set(ends.map((end) => end.ad_account_id));
    const workspacesByIdentity = new Map<string, Set<string>>(
      clients.map((client) => [client.id, new Set([client.id])]),
    );
    for (const membership of members) {
      const memberWorkspaces =
        workspacesByIdentity.get(membership.member_id) ?? new Set<string>();
      memberWorkspaces.add(membership.client_id);
      workspacesByIdentity.set(membership.member_id, memberWorkspaces);
    }
    const clientsShareWorkspace = (leftId: string, rightId: string) => {
      const left = workspacesByIdentity.get(leftId) ?? new Set([leftId]);
      const right = workspacesByIdentity.get(rightId) ?? new Set([rightId]);
      const [smaller, larger] =
        left.size <= right.size ? [left, right] : [right, left];
      return [...smaller].some((workspaceId) => larger.has(workspaceId));
    };

    const accountsByClient = new Map<string, AccountRow[]>();
    for (const account of accounts) {
      const rows = accountsByClient.get(account.client_id) ?? [];
      rows.push(account);
      accountsByClient.set(account.client_id, rows);
    }
    const commissionsByAccount = new Map<string, CommissionRow[]>();
    for (const commission of commissions) {
      if (!commission.ad_account_id) continue;
      const rows = commissionsByAccount.get(commission.ad_account_id) ?? [];
      rows.push(commission);
      commissionsByAccount.set(commission.ad_account_id, rows);
    }

    const summariesByClient = new Map<string, ReferralTermSummary[]>();
    for (const row of termRows) {
      const rows = summariesByClient.get(row.client_id) ?? [];
      rows.push(termSummary(row));
      summariesByClient.set(row.client_id, rows);
    }
    for (const rows of summariesByClient.values()) {
      rows.sort(
        (left, right) =>
          right.effectiveFrom.localeCompare(left.effectiveFrom) ||
          right.revision - left.revision ||
          right.createdAt.localeCompare(left.createdAt),
      );
    }

    const itemsByTerm = new Map<string, TermItemRow[]>();
    for (const item of itemRows) {
      const rows = itemsByTerm.get(item.term_id) ?? [];
      rows.push(item);
      itemsByTerm.set(item.term_id, rows);
    }
    const summaryById = new Map(
      [...summariesByClient.values()].flat().map((term) => [term.id, term]),
    );
    for (const item of itemRows) {
      if (!summaryById.has(item.term_id)) {
        throw new Error("A referral evidence item points to a missing term.");
      }
    }
    for (const term of summaryById.values()) {
      if ((itemsByTerm.get(term.id)?.length ?? 0) !== term.referralCount) {
        throw new Error(
          "A sealed referral term does not match its frozen evidence count.",
        );
      }
    }

    const evidenceFromItem = (item: TermItemRow): ReferralEvidenceSummary => {
      const start = startById.get(item.evidence_billing_start_id);
      const account = start ? accountById.get(start.ad_account_id) : undefined;
      if (
        !start ||
        !account ||
        !ISO_DAY.test(item.eligibility_checked_on) ||
        !ISO_DAY.test(item.evidence_occurred_on)
      ) {
        throw new Error("A frozen referral evidence item is incomplete.");
      }
      const grossAmount = toNumber(
        item.evidence_gross_amount,
        "frozen evidence amount",
      );
      const billableAmount = toNumber(
        item.evidence_billable_amount,
        "frozen billable evidence amount",
      );
      if (grossAmount <= 0 || billableAmount <= 0) {
        throw new Error("A frozen referral evidence item is not positive.");
      }
      return {
        billingStartId: item.evidence_billing_start_id,
        commissionId: item.evidence_commission_id,
        eligibilityCheckedOn: item.eligibility_checked_on,
        occurredOn: item.evidence_occurred_on,
        grossAmount,
        billableAmount,
        storeName: account.store_name,
      };
    };

    const referrerIds = new Set<string>();
    for (const client of clients) {
      if (client.referred_by) referrerIds.add(client.referred_by);
    }
    for (const term of termRows) referrerIds.add(term.client_id);

    const referrers = [...referrerIds].map((referrerId) => {
      const referrer = clientById.get(referrerId);
      if (!referrer)
        throw new Error("A referral points to a missing referrer client.");
      const history = summariesByClient.get(referrerId) ?? [];
      const currentTerm = latestTerm(history, currentWeekStart);
      const scheduledTerm = latestTerm(history, effectiveFrom);
      const currentItems = currentTerm
        ? (itemsByTerm.get(currentTerm.id) ?? [])
        : [];
      const scheduledItems = scheduledTerm
        ? (itemsByTerm.get(scheduledTerm.id) ?? [])
        : [];
      const currentItemByClient = new Map(
        currentItems.map((item) => [item.referred_client_id, item]),
      );
      const scheduledItemByClient = new Map(
        scheduledItems.map((item) => [item.referred_client_id, item]),
      );

      const candidateIds = new Set(
        clients
          .filter((client) => client.referred_by === referrerId)
          .map((client) => client.id),
      );
      for (const term of history)
        candidateIds.add(term.decisionReferredClientId);
      for (const item of [...currentItems, ...scheduledItems]) {
        candidateIds.add(item.referred_client_id);
      }

      const referrals = [...candidateIds].map((candidateId) => {
        const candidate = clientById.get(candidateId);
        if (!candidate)
          throw new Error(
            "A referral term points to a missing referred client.",
          );
        const workspaceConflict = clientsShareWorkspace(
          referrerId,
          candidateId,
        );
        const candidateAccounts = accountsByClient.get(candidateId) ?? [];
        const verifiedOpenAccounts = candidateAccounts.filter((account) => {
          const start = startsByAccount.get(account.id);
          return (
            (account.status === "active" || account.status === "suspended") &&
            Boolean(start) &&
            !endedAccounts.has(account.id) &&
            start?.google_ads_customer_id === account.google_ads_customer_id
          );
        });

        const evidenceCandidates = verifiedOpenAccounts.flatMap((account) => {
          const start = startsByAccount.get(account.id);
          if (!start) return [];
          return (commissionsByAccount.get(account.id) ?? []).flatMap(
            (commission) => {
              if (
                commission.status !== "confirmed" ||
                commission.currency.toUpperCase() !== "EUR" ||
                commission.occurred_on < activityCutoff ||
                commission.occurred_on > today ||
                commission.occurred_on < start.google_local_date
              ) {
                return [];
              }
              const rawMicros = decimalToMicros(commission.gross_amount);
              const billableMicros =
                commission.occurred_on === start.google_local_date
                  ? billableMicrosSinceBaseline(
                      rawMicros,
                      String(start.baseline_cost_micros),
                    )
                  : rawMicros;
              return billableMicros > BigInt(0)
                ? [{ account, start, commission, billableMicros }]
                : [];
            },
          );
        });
        evidenceCandidates.sort(
          (left, right) =>
            right.commission.occurred_on.localeCompare(
              left.commission.occurred_on,
            ) || right.commission.id.localeCompare(left.commission.id),
        );
        const evidence = evidenceCandidates[0];
        const recentEvidence: ReferralEvidenceSummary | null = evidence
          ? {
              billingStartId: evidence.start.id,
              commissionId: evidence.commission.id,
              eligibilityCheckedOn: today,
              occurredOn: evidence.commission.occurred_on,
              grossAmount: toNumber(
                evidence.commission.gross_amount,
                "recent Google spend",
              ),
              billableAmount: Number(microsToDecimal(evidence.billableMicros)),
              storeName: evidence.account.store_name,
            }
          : null;

        const scheduledItem = scheduledItemByClient.get(candidateId) ?? null;
        const currentGranted = currentItemByClient.has(candidateId);
        const scheduledGranted = Boolean(scheduledItem);
        let actionBlockedReason: string | null = null;
        if (staffIds.has(referrerId)) {
          actionBlockedReason =
            "Internal staff identities cannot receive referral discounts.";
        } else if (staffIds.has(candidate.id)) {
          actionBlockedReason =
            "Internal staff identities cannot earn referral discounts.";
        } else if (referrer.approval_status !== "approved") {
          actionBlockedReason = "The referrer is not an approved client.";
        } else if (candidate.id === referrerId) {
          actionBlockedReason = "A client cannot be their own referral.";
        } else if (candidate.approval_status !== "approved") {
          actionBlockedReason = "The referred client is not approved.";
        } else if (candidate.referred_by !== referrerId) {
          actionBlockedReason =
            "The permanent attribution does not belong to this referrer.";
        } else if (workspaceConflict) {
          actionBlockedReason =
            "The clients share a workspace and are not independent referrals.";
        } else if (verifiedOpenAccounts.length === 0) {
          const verifiedEnded = candidateAccounts.some(
            (account) =>
              startsByAccount.has(account.id) && endedAccounts.has(account.id),
          );
          actionBlockedReason = verifiedEnded
            ? "Every verified Google billing account has ended."
            : "No open, identity-matched Google billing start was found.";
        } else if (!recentEvidence) {
          actionBlockedReason = `No positive confirmed EUR Google spend was found since ${activityCutoff}.`;
        }

        return {
          clientId: candidate.id,
          name: candidate.full_name,
          email: candidate.email,
          approvalStatus: candidate.approval_status,
          attributedToReferrer: candidate.referred_by === referrerId,
          workspaceConflict,
          currentGranted,
          scheduledGranted,
          grantEligible: !actionBlockedReason,
          actionBlockedReason,
          recentEvidence,
          approvedEvidence: scheduledItem
            ? evidenceFromItem(scheduledItem)
            : null,
        };
      });
      referrals.sort((left, right) => {
        if (left.scheduledGranted !== right.scheduledGranted) {
          return left.scheduledGranted ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

      return {
        clientId: referrer.id,
        name: referrer.full_name,
        email: referrer.email,
        approvalStatus: referrer.approval_status,
        currentTerm,
        scheduledTerm,
        referrals,
        history,
      };
    });
    referrers.sort((left, right) => left.name.localeCompare(right.name));

    const unassignedClients = clients
      .filter(
        (client) =>
          !staffIds.has(client.id) &&
          client.referred_by === null &&
          client.approval_status !== "rejected",
      )
      .map((client) => ({
        clientId: client.id,
        name: client.full_name,
        email: client.email,
        approvalStatus: client.approval_status,
        claimSuggestion: (() => {
          const request = claimRequestByClient.get(client.id);
          if (!request) return null;
          const referrer = clientById.get(request.referrer_client_id);
          if (!referrer) {
            throw new Error(
              "A pending referral claim points to a missing referrer.",
            );
          }
          return {
            requestId: request.id,
            referrerClientId: referrer.id,
            referrerName: referrer.full_name,
            referrerEmail: referrer.email,
            referralCode: request.referral_code,
            claimSource: request.claim_source as "signup" | "client",
            createdAt: request.created_at,
          };
        })(),
      }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.email.localeCompare(right.email),
      );
    const approvedReferrers = clients
      .filter(
        (client) =>
          !staffIds.has(client.id) && client.approval_status === "approved",
      )
      .map((client) => ({
        clientId: client.id,
        name: client.full_name,
        email: client.email,
      }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.email.localeCompare(right.email),
      );

    dashboard = {
      generatedAt,
      lisbonToday: today,
      currentWeekStart,
      effectiveFrom,
      activityCutoff,
      loadError: null,
      unassignedClients,
      approvedReferrers,
      attributionEvents,
      referrers,
    };
  } catch (error) {
    dashboard = failureDashboard(
      generatedAt,
      today,
      currentWeekStart,
      effectiveFrom,
      activityCutoff,
      error instanceof Error
        ? error.message
        : "Referral evidence is malformed.",
    );
  }

  return (
    <PageContainer
      title="Referral administration"
      description="Seal permanent referral attribution, then review commercial discounts as a separate Monday-effective decision."
    >
      <ReferralsAdminView dashboard={dashboard} />
    </PageContainer>
  );
}
