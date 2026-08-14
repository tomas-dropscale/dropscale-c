import { createClient } from "@/lib/supabase/server";
import { hasAgencyServiceAccount } from "@/lib/google-ads/env";
import {
  addIsoDays,
  decimalToMicros,
  fetchGoogleBillingMetadataAsAgency,
  fetchGoogleDailyCostMicrosAsAgency,
  googleLocalDate,
  googlePeriodIsClosed,
  microsToDecimal,
  parseGoogleMicros,
  percentageOfMicrosToDecimal,
} from "@/lib/google-ads/billing-start";
import {
  GOOGLE_ADS_NOTE_PREFIX,
  NOTE_DETAIL_SEPARATOR,
  REV_SHARE_NOTE_PREFIX,
} from "@/lib/finance/config";
import {
  accountCommissionTermsForDate,
  billableGoogleSpendWindow,
  matchesAuthoritativeGoogleSpend,
  needsGoogleLedgerRewrite,
  type AccountCommissionRateTerm,
  type ManualReferralRateTerm,
} from "@/lib/admin/commission-sync-logic";
import type { AdAccount } from "@/lib/supabase/types";

/**
 * Turns agency-readable Google Ads spend into real finance rows: one
 * commissions entry per account per day. `gross_amount` preserves Google's
 * raw daily counter; `amount` applies the immutable manual-referral term for
 * that Google day to the billable portion (the first-day delta above the
 * opening counter, then full daily spend until the closing counter), tagged
 * with ad_account_id so synced rows never mix with hand-entered ones.
 *
 * Two things run it:
 *   · the "Sync now" button — forced, for an exact match with what
 *     /admin/campaigns computes live from Google;
 *   · the hourly cron — forced, with the service-role client, so the ledger
 *     stays current even in a week nobody opens the panel.
 *
 * A 7-day window per run heals gaps. Both entry points authenticate first and
 * then use a server-role client; browser sessions can read the resulting
 * evidence but cannot manufacture a completed Google sync window.
 */

const SOURCE_NAME = "Google Ads Management";

/**
 * How many days back each run re-reads from Google, today included.
 *
 * It is a healing window, not just a fetch: Google restates recent days (fraud
 * filtering, late conversions), and the ledger updates any day whose spend has
 * moved. Widen it and the overview covers more history at the cost of a larger
 * response per account per sync.
 */
const SPEND_WINDOW_DAYS = 7;
/**
 * How stale a non-forced caller will tolerate the ledger being.
 *
 * Was an hour, which is why the overview's commission could sit €0.75 below
 * what /admin/campaigns computed live: campaigns asks Google on every render,
 * the ledger was a snapshot up to 60 minutes old. Two minutes keeps ordinary
 * navigation cheap while making the two figures agree in practice. `force` —
 * the Sync now button and the cron — skips it entirely for an exact match.
 */
const THROTTLE_MS = 2 * 60 * 1000;

type Supa = Awaited<ReturnType<typeof createClient>>;

/** Options every ledger sync takes. */
type SyncOpts = {
  /** Ignore both throttles — an explicit "do it now". */
  force?: boolean;
  /**
   * Supabase to work through. Production callers pass the service-role client
   * after either admin-session or cron-secret authentication.
   */
  client?: Supa;
  /** Exact closed week requested by the billing review screen. */
  period?: { start: string; end: string };
};

type BillingStartRow = {
  id: string;
  ad_account_id: string;
  google_ads_customer_id: string;
  google_local_date: string;
  google_time_zone: string;
  currency: string;
  baseline_cost_micros: string | number;
  captured_at: string;
};

type BillingEndRow = {
  id: string;
  ad_account_id: string;
  billing_start_id: string;
  google_ads_customer_id: string;
  google_local_date: string;
  google_time_zone: string;
  currency: string;
  end_cost_micros: string | number;
  captured_at: string;
};

/**
 * The note a synced row carries: "<source> · <client>" and then the store.
 *
 * The client's NAME goes in because the id cannot. `commissions.client_id`
 * references the CRM `clients` table, and a portal client is linked to one only
 * through `crm_client_id` — a column nothing in this product ever writes. Until
 * that link exists, the note is the only place the finance pages can learn who
 * earned the money, and without it every synced euro reads as "Unattributed".
 */
function noteFor(
  prefix: string,
  clientName: string | undefined,
  storeName: string,
): string {
  const detail = `${NOTE_DETAIL_SEPARATOR}${storeName}`;

  // With no name, deliberately DROP the attributing prefix rather than writing
  // it with a hole after it: a note that parses to an empty client would put
  // the STORE's name where the client's belongs, which is worse than admitting
  // the row is unattributed.
  if (!clientName) return `Auto-synced${detail}`;

  return `${prefix}${clientName}${detail}`;
}

/**
 * Client-login ids that belong to staff-admins. Their OWN ad accounts are
 * internal/test — the agency doesn't bill itself, so those accounts must never
 * book agency revenue.
 */
async function adminClientIds(supabase: Supa): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "admin");
  if (error)
    throw new Error(`Could not identify admin accounts: ${error.message}`);
  return new Set((data ?? []).map((row) => row.id));
}

async function manualReferralTermsByClient(
  supabase: Supa,
  clientIds: string[],
): Promise<Map<string, ManualReferralRateTerm[]>> {
  type Row = {
    id: string;
    client_id: string;
    effective_from: string;
    revision: number;
    referral_count: number;
    list_rate: string | number;
    referral_step_rate: string | number;
    referral_discount_rate: string | number;
    fee_rate: string | number;
  };

  const byClient = new Map<string, ManualReferralRateTerm[]>();
  const pageSize = 1_000;
  let afterId: string | null = null;
  for (;;) {
    let query = supabase
      .from("referral_discount_terms")
      .select(
        "id, client_id, effective_from, revision, referral_count, list_rate, " +
          "referral_step_rate, referral_discount_rate, fee_rate",
      )
      .in("client_id", clientIds)
      .not("sealed_at", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error)
      throw new Error(`Could not load manual referral rates: ${error.message}`);
    const page = (data ?? []) as unknown as Row[];
    for (const row of page) {
      const current = byClient.get(row.client_id) ?? [];
      current.push({
        effectiveFrom: row.effective_from,
        revision: row.revision,
        referralCount: row.referral_count,
        listRate: Number(row.list_rate),
        stepRate: Number(row.referral_step_rate),
        discountRate: Number(row.referral_discount_rate),
        feeRate: Number(row.fee_rate),
      });
      byClient.set(row.client_id, current);
    }
    if (page.length < pageSize) break;
    afterId = page.at(-1)?.id ?? null;
    if (!afterId) break;
  }
  return byClient;
}

async function accountCommissionTermsByAccount(
  supabase: Supa,
  accountIds: string[],
): Promise<Map<string, AccountCommissionRateTerm[]>> {
  type Row = {
    id: string;
    ad_account_id: string;
    effective_from: string;
    revision: number;
    list_rate: string | number;
  };
  const byAccount = new Map<string, AccountCommissionRateTerm[]>();
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
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error)
      throw new Error(
        `Could not load account commission terms: ${error.message}`,
      );
    const page = (data ?? []) as unknown as Row[];
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

let lastPurgeAt = 0;

/**
 * Delete EVERY synced commission booked for an admin-owned ad account — past
 * and present, any source, any connection status. Admin accounts are internal,
 * so their revenue must not exist in the ledger at all. Throttled; after the
 * first pass there is nothing left to remove (the ledgers stop booking them).
 */
export async function purgeAdminAccountRevenue(opts?: SyncOpts): Promise<void> {
  if (!opts?.force && Date.now() - lastPurgeAt < THROTTLE_MS) return;

  try {
    const supabase = opts?.client ?? (await createClient());
    const adminIds = await adminClientIds(supabase);
    if (adminIds.size === 0) {
      lastPurgeAt = Date.now();
      return;
    }

    const { data: adminAccounts, error: accountsError } = await supabase
      .from("ad_accounts")
      .select("id")
      .in("client_id", [...adminIds]);
    if (accountsError) throw accountsError;
    const ids = (adminAccounts ?? []).map((row) => row.id);
    if (ids.length > 0) {
      const { error: deleteError } = await supabase
        .from("commissions")
        .delete()
        .in("ad_account_id", ids);
      if (deleteError) throw deleteError;
    }
    lastPurgeAt = Date.now();
  } catch (error) {
    console.error("Admin-account revenue purge failed:", error);
  }
}

// Per-isolate memo so a burst of admin navigation doesn't even hit the
// database to discover it has nothing to do.
let lastRunAt = 0;

export async function syncCommissionLedger(opts?: SyncOpts): Promise<void> {
  if (!hasAgencyServiceAccount()) {
    if (opts?.force)
      throw new Error("Agency Google Ads is not configured on this server.");
    return;
  }
  if (!opts?.force && Date.now() - lastRunAt < THROTTLE_MS) return;

  try {
    const supabase = opts?.client ?? (await createClient());

    // Cross-instance throttle: the newest synced row's updated_at tells us
    // when ANY admin's isolate last ran this.
    const { data: newest, error: newestError } = await supabase
      .from("commissions")
      .select("updated_at")
      .not("ad_account_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (newestError) throw newestError;

    if (
      !opts?.force &&
      newest &&
      Date.now() - new Date(newest.updated_at).getTime() < THROTTLE_MS
    ) {
      lastRunAt = Date.now();
      return;
    }

    const { data: source, error: sourceError } = await supabase
      .from("revenue_sources")
      .select("id")
      .eq("name", SOURCE_NAME)
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) {
      // Migration 0007 seeds it; without the seed there is nowhere to book to.
      const error = new Error(
        "Commission sync: revenue source missing — run migration 0007.",
      );
      if (opts?.force) throw error;
      console.error(error.message);
      return;
    }

    const { data: accountRows, error: accountRowsError } = await supabase
      .from("ad_accounts")
      .select("id, client_id, store_name, google_ads_customer_id, currency")
      // Pending rows are unapproved requests. Suspended rows remain eligible:
      // a client can still owe the final closed week from before suspension.
      .in("status", ["active", "suspended"])
      .not("google_ads_customer_id", "is", null);
    if (accountRowsError) throw accountRowsError;

    // The typed client cannot parse a concatenated column string, so it types
    // the rows as an error sentinel; the columns above match this Pick exactly.
    const accounts = (accountRows ?? []) as unknown as Pick<
      AdAccount,
      "id" | "client_id" | "store_name" | "google_ads_customer_id" | "currency"
    >[];
    if (accounts.length === 0) {
      lastRunAt = Date.now();
      return;
    }

    // Admins' own ad accounts are internal — never agency revenue. Exclude
    // them from billing here; past rows are removed by purgeAdminAccountRevenue.
    const adminIds = await adminClientIds(supabase);
    const billable = accounts.filter(
      (account) => !adminIds.has(account.client_id),
    );
    if (billable.length === 0) {
      lastRunAt = Date.now();
      return;
    }

    // The immutable counter is the commercial boundary. Status/created_at are
    // not substitutes: without this row there is no defensible way to know how
    // much of the first Google-local day belongs to the agency service.
    const { data: billingStartRows, error: billingStartsError } = await supabase
      .from("ad_account_billing_starts")
      .select(
        "id, ad_account_id, google_ads_customer_id, google_local_date, google_time_zone, " +
          "currency, baseline_cost_micros, captured_at",
      )
      .in(
        "ad_account_id",
        billable.map((account) => account.id),
      );
    if (billingStartsError) throw billingStartsError;
    const billingStartByAccount = new Map(
      ((billingStartRows ?? []) as unknown as BillingStartRow[]).map((row) => [
        row.ad_account_id,
        row,
      ]),
    );

    const { data: billingEndRows, error: billingEndsError } = await supabase
      .from("ad_account_billing_ends")
      .select(
        "id, ad_account_id, billing_start_id, google_ads_customer_id, google_local_date, " +
          "google_time_zone, currency, end_cost_micros, captured_at",
      )
      .in(
        "ad_account_id",
        billable.map((account) => account.id),
      );
    if (billingEndsError) throw billingEndsError;
    const billingEndByAccount = new Map(
      ((billingEndRows ?? []) as unknown as BillingEndRow[]).map((row) => [
        row.ad_account_id,
        row,
      ]),
    );

    // Portal login → CRM record, for the finance rows' client attribution.
    //
    // `crm_client_id` is nearly always null: nothing in the product writes it,
    // so a synced row usually has no client_id at all and the finance pages
    // showed every euro of it as "Unattributed". The NAME is carried in the
    // note as well, which is what the finance reader falls back to.
    const { data: portalClients, error: portalClientsError } = await supabase
      .from("portal_clients")
      .select("id, crm_client_id, full_name")
      .in("id", [...new Set(billable.map((account) => account.client_id))]);
    if (portalClientsError) throw portalClientsError;
    const crmByLogin = new Map(
      (portalClients ?? []).map((row) => [row.id, row.crm_client_id]),
    );
    const nameByLogin = new Map(
      (portalClients ?? []).map((row) => [row.id, row.full_name]),
    );
    const [referralTermsByClient, commissionTermsByAccount] = await Promise.all(
      [
        manualReferralTermsByClient(supabase, [
          ...new Set(billable.map((account) => account.client_id)),
        ]),
        accountCommissionTermsByAccount(
          supabase,
          billable.map((account) => account.id),
        ),
      ],
    );

    const failures: string[] = [];
    await Promise.all(
      billable.map(async (account) => {
        let marker:
          | {
              runId: string;
              from: string;
              to: string;
              billingStartId: string;
              billingEndId: string | null;
            }
          | undefined;
        try {
          const start = billingStartByAccount.get(account.id);
          if (!start) {
            throw new Error(
              "Billing has not started: no immutable Google spend baseline exists.",
            );
          }
          // The activation migration stores the canonical ten digits. Do not
          // silently strip arbitrary characters here: a corrupted identity
          // must fail closed instead of being treated as the baseline owner.
          const accountCustomerId = account.google_ads_customer_id ?? "";
          if (
            !/^\d{10}$/.test(accountCustomerId) ||
            start.google_ads_customer_id !== accountCustomerId
          ) {
            throw new Error(
              "The billing baseline belongs to a different Google customer.",
            );
          }
          if (
            account.currency.toUpperCase() !== "EUR" ||
            start.currency.toUpperCase() !== "EUR"
          ) {
            throw new Error(
              "Agency billing supports EUR Google Ads accounts only.",
            );
          }
          // PostgREST may represent an int8 as either string or number. Reject
          // an unsafe numeric value instead of stringifying an already-rounded
          // baseline and silently moving the commercial boundary.
          const baselineCostMicros = parseGoogleMicros(
            start.baseline_cost_micros,
          );
          const end = billingEndByAccount.get(account.id);
          let endCostMicros: bigint | null = null;
          if (end) {
            if (
              end.billing_start_id !== start.id ||
              end.google_ads_customer_id !== start.google_ads_customer_id ||
              end.google_time_zone !== start.google_time_zone ||
              end.currency.toUpperCase() !== start.currency.toUpperCase() ||
              end.google_local_date < start.google_local_date
            ) {
              throw new Error(
                "The billing end does not match the immutable Google start.",
              );
            }
            endCostMicros = parseGoogleMicros(end.end_cost_micros);
          }

          // Rolling windows follow each Google customer's immutable local day,
          // not the Worker's UTC date. Exact admin periods keep their explicit
          // Monday/Sunday labels, but are not certifiable until local Monday.
          const runStartedAt = new Date();
          const localToday = googleLocalDate(
            runStartedAt,
            start.google_time_zone,
          );
          const to = opts?.period?.end ?? localToday;
          const from =
            opts?.period?.start ?? addIsoDays(to, -(SPEND_WINDOW_DAYS - 1));
          // A closed account has no evidence in a wholly later window. Keeping
          // it out of the marker table also keeps hourly syncs from touching
          // Google forever after its final billable week has healed.
          if (end && end.google_local_date < from) return;
          const queryTo =
            end && end.google_local_date < to ? end.google_local_date : to;
          const syncRunId = crypto.randomUUID();
          marker = {
            runId: syncRunId,
            from,
            to,
            billingStartId: start.id,
            billingEndId: end?.id ?? null,
          };

          // Supersede the previous proof BEFORE the first Google network read.
          // A crash or partial failure can then leave only an explicit failed or
          // in-progress generation, never a stale green marker.
          const syncStartedAt = runStartedAt.toISOString();
          const { error: beginWindowError } = await supabase
            .from("google_ledger_sync_windows")
            .upsert(
              {
                ad_account_id: account.id,
                period_start: from,
                period_end: to,
                billing_start_id: start.id,
                billing_end_id: end?.id ?? null,
                run_id: syncRunId,
                status: "in_progress" as const,
                started_at: syncStartedAt,
                synced_at: syncStartedAt,
                ledger_snapshot: [],
              },
              { onConflict: "ad_account_id,period_start,period_end" },
            );
          if (beginWindowError) throw beginWindowError;

          if (
            opts?.period &&
            !googlePeriodIsClosed(
              opts.period.end,
              runStartedAt,
              start.google_time_zone,
            )
          ) {
            throw new Error(
              `The ${opts.period.end} Google-local day is not closed in ${start.google_time_zone}.`,
            );
          }

          const metadata =
            await fetchGoogleBillingMetadataAsAgency(accountCustomerId);
          if (
            metadata.customerId !== start.google_ads_customer_id ||
            metadata.currency !== start.currency.toUpperCase() ||
            metadata.timeZone !== start.google_time_zone
          ) {
            throw new Error(
              "Live Google account metadata does not match the billing baseline.",
            );
          }
          if (metadata.currency !== "EUR") {
            throw new Error(
              `Google Ads account currency is ${metadata.currency}, not EUR.`,
            );
          }

          const queryFrom =
            start.google_local_date > from ? start.google_local_date : from;
          const reportedDays =
            queryFrom <= queryTo
              ? await fetchGoogleDailyCostMicrosAsAgency(
                  accountCustomerId,
                  queryFrom,
                  queryTo,
                )
              : [];
          const days = billableGoogleSpendWindow(
            from,
            to,
            reportedDays,
            {
              googleLocalDate: start.google_local_date,
              baselineCostMicros: baselineCostMicros.toString(),
            },
            end && endCostMicros !== null
              ? {
                  googleLocalDate: end.google_local_date,
                  endCostMicros: endCostMicros.toString(),
                }
              : undefined,
          );

          let existingRows: {
            id: string;
            occurred_on: string;
            gross_amount: string | number;
            amount: string | number;
            rate: string | number;
            currency: string;
            status: string;
          }[] = [];
          if (days.length > 0) {
            const { data, error: existingRowsError } = await supabase
              .from("commissions")
              .select(
                "id, occurred_on, gross_amount, amount, rate, currency, status",
              )
              .eq("ad_account_id", account.id)
              .eq("source_id", source.id)
              .in(
                "occurred_on",
                days.map((day) => day.date),
              );
            if (existingRowsError) throw existingRowsError;
            existingRows = (data ?? []) as unknown as typeof existingRows;
          }
          const existing = new Map(
            existingRows.map((row) => [row.occurred_on, row]),
          );

          for (const day of days) {
            const current = existing.get(day.date);
            const rawMicros = BigInt(day.rawCostMicros);
            const billableMicros = BigInt(day.billableCostMicros);
            const grossAmount = microsToDecimal(rawMicros);
            const rate = accountCommissionTermsForDate(
              day.date,
              commissionTermsByAccount.get(account.id) ?? [],
              referralTermsByClient.get(account.client_id) ?? [],
            ).feeRate;
            const amount = percentageOfMicrosToDecimal(billableMicros, rate);

            // Do not manufacture empty financial rows. A zero is written only
            // when it corrects a value that used to be positive. A positive raw
            // first-day counter is retained even when its net delta is zero.
            if (!current && rawMicros === BigInt(0)) continue;

            if (!current) {
              // Unique index (ad_account_id, occurred_on) makes a concurrent
              // duplicate insert fail loudly instead of double-booking — that
              // error is safe to swallow.
              const { error: insertError } = await supabase
                .from("commissions")
                .insert({
                  source_id: source.id,
                  client_id: crmByLogin.get(account.client_id) ?? null,
                  ad_account_id: account.id,
                  occurred_on: day.date,
                  gross_amount: grossAmount,
                  rate,
                  amount,
                  currency: "EUR",
                  status: "confirmed",
                  notes: noteFor(
                    GOOGLE_ADS_NOTE_PREFIX,
                    nameByLogin.get(account.client_id),
                    account.store_name,
                  ),
                });
              // A concurrent writer can win the unique account/day race, but
              // this attempt did not verify the winning value. Fail closed and
              // let the explicit admin retry produce an authoritative marker.
              if (insertError) throw insertError;
            } else if (
              needsGoogleLedgerRewrite(
                {
                  grossAmount: current.gross_amount,
                  amount: current.amount,
                  rate: current.rate,
                  currency: current.currency,
                  status: current.status,
                },
                {
                  grossAmount,
                  amount,
                  rate,
                  currency: "EUR",
                },
              )
            ) {
              // Google can restate a day all the way to zero. Rate/currency
              // changes also need to refresh the ledger even when spend did
              // not move, so the admin preview never reads a stale fee basis.
              const { data: updatedRow, error: updateError } = await supabase
                .from("commissions")
                .update({
                  gross_amount: grossAmount,
                  rate,
                  amount,
                  currency: "EUR",
                  // Heal rows manually moved out of the authoritative set.
                  status: "confirmed",
                  // Rewritten so rows booked before the note carried a client
                  // name stop reading as "Unattributed" once they refresh.
                  notes: noteFor(
                    GOOGLE_ADS_NOTE_PREFIX,
                    nameByLogin.get(account.client_id),
                    account.store_name,
                  ),
                  updated_at: new Date().toISOString(),
                })
                .eq("id", current.id)
                .select("id")
                .maybeSingle();
              if (updateError) throw updateError;
              if (!updatedRow) {
                throw new Error(
                  `Google ledger row ${current.id} changed during refresh.`,
                );
              }
            }
          }

          // Snapshot exactly the fields the invoice RPC treats as
          // authoritative. SQL compares this JSONB under table locks before
          // allowing issue, which closes the last mutation/completion race.
          let snapshotRows: {
            id: string;
            occurred_on: string;
            gross_amount: string | number;
            currency: string;
            status: string;
          }[] = [];
          if (days.length > 0) {
            const { data, error: snapshotRowsError } = await supabase
              .from("commissions")
              .select("id, occurred_on, gross_amount, currency, status")
              .eq("ad_account_id", account.id)
              .eq("source_id", source.id)
              .eq("status", "confirmed")
              .gte("occurred_on", queryFrom)
              .lte("occurred_on", queryTo)
              .order("id", { ascending: true });
            if (snapshotRowsError) throw snapshotRowsError;
            snapshotRows = (data ?? []) as unknown as typeof snapshotRows;
          }
          if (
            !matchesAuthoritativeGoogleSpend(
              days,
              snapshotRows.map((row) => ({
                occurred_on: row.occurred_on,
                gross_amount: row.gross_amount,
                currency: row.currency,
              })),
              "EUR",
            )
          ) {
            throw new Error(
              "The ledger changed while Google spend was being refreshed.",
            );
          }
          const ledgerSnapshot = snapshotRows.map((row) => ({
            id: row.id,
            occurred_on: row.occurred_on,
            gross_amount: microsToDecimal(decimalToMicros(row.gross_amount)),
            currency: row.currency.toUpperCase(),
            status: "confirmed" as const,
          }));

          let completeWindow = supabase
            .from("google_ledger_sync_windows")
            .update({
              status: "complete",
              synced_at: new Date().toISOString(),
              billing_start_id: start.id,
              billing_end_id: end?.id ?? null,
              ledger_snapshot: ledgerSnapshot,
            })
            .eq("ad_account_id", account.id)
            .eq("period_start", marker.from)
            .eq("period_end", marker.to)
            .eq("run_id", syncRunId)
            .eq("billing_start_id", start.id)
            .eq("status", "in_progress");
          completeWindow = end
            ? completeWindow.eq("billing_end_id", end.id)
            : completeWindow.is("billing_end_id", null);
          const { data: completedWindow, error: syncWindowError } =
            await completeWindow.select("ad_account_id").maybeSingle();
          if (syncWindowError) throw syncWindowError;
          if (!completedWindow) {
            throw new Error(
              "This refresh was superseded by a newer account or sync change.",
            );
          }
        } catch (error) {
          if (marker) {
            let failWindow = supabase
              .from("google_ledger_sync_windows")
              .update({ status: "failed" })
              .eq("ad_account_id", account.id)
              .eq("period_start", marker.from)
              .eq("period_end", marker.to)
              .eq("run_id", marker.runId)
              .eq("billing_start_id", marker.billingStartId)
              .eq("status", "in_progress");
            failWindow = marker.billingEndId
              ? failWindow.eq("billing_end_id", marker.billingEndId)
              : failWindow.is("billing_end_id", null);
            const { error: failedWindowError } = await failWindow;
            if (failedWindowError) {
              console.error(
                `Could not fail Google sync marker for ${account.id}:`,
                failedWindowError,
              );
            }
          }

          failures.push(
            `${account.store_name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          console.error(`Commission sync failed for ${account.id}:`, error);
        }
      }),
    );

    // Explicit refreshes are promises to the operator, not best-effort page
    // decoration. Surface partial failure so the billing screen cannot say
    // "updated" while one client's Google account stayed stale.
    if (opts?.force && failures.length > 0) {
      throw new Error(`Google Ads sync incomplete — ${failures.join(" | ")}`);
    }

    lastRunAt = Date.now();
  } catch (error) {
    // The ledger must never take a finance page down with it.
    if (opts?.force) throw error;
    console.error("Commission sync failed:", error);
  }
}

// ---------------------------------------------------------------------------
// Revenue-share ledger
// ---------------------------------------------------------------------------

const REV_SHARE_SOURCE = "Revenue Share";
const REV_SHARE_WINDOW_DAYS = 90;
let lastRevShareRunAt = 0;

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Books the collection-based revenue share into the finance ledger: one
 * commissions row per rev-share account per day, read straight from the
 * daily_metrics the sync already computed (revenue_share_amount). No external
 * calls — attribution happened at sync time — so this is a cheap DB pass that
 * rides the admin's session, throttled and idempotent like the ad-spend ledger.
 */
export async function syncRevenueShareLedger(opts?: SyncOpts): Promise<void> {
  if (!opts?.force && Date.now() - lastRevShareRunAt < THROTTLE_MS) return;

  try {
    const supabase = opts?.client ?? (await createClient());

    const { data: source } = await supabase
      .from("revenue_sources")
      .select("id")
      .eq("name", REV_SHARE_SOURCE)
      .maybeSingle();
    if (!source) {
      console.error(
        "Rev-share sync: revenue source missing — run migration 0010.",
      );
      return;
    }

    const { data: accountRows } = await supabase
      .from("ad_accounts")
      .select("id, client_id, store_name, currency, revenue_share_enabled")
      .eq("revenue_share_enabled", true);
    const accounts = (accountRows ?? []) as unknown as Pick<
      AdAccount,
      "id" | "client_id" | "store_name" | "currency" | "revenue_share_enabled"
    >[];
    if (accounts.length === 0) {
      lastRevShareRunAt = Date.now();
      return;
    }

    // Admins' own accounts don't book agency revenue — exclude here (past rows
    // are removed by purgeAdminAccountRevenue).
    const adminIds = await adminClientIds(supabase);
    const billable = accounts.filter(
      (account) => !adminIds.has(account.client_id),
    );
    if (billable.length === 0) {
      lastRevShareRunAt = Date.now();
      return;
    }

    const { data: portalClients } = await supabase
      .from("portal_clients")
      .select("id, crm_client_id, full_name")
      .in("id", [...new Set(billable.map((account) => account.client_id))]);
    const crmByLogin = new Map(
      (portalClients ?? []).map((row) => [row.id, row.crm_client_id]),
    );
    // Same reason as the ad-spend ledger: the note is where attribution lives.
    const nameByLogin = new Map(
      (portalClients ?? []).map((row) => [row.id, row.full_name]),
    );

    const from = isoDay(-REV_SHARE_WINDOW_DAYS);
    const accountIds = billable.map((account) => account.id);

    // The days that actually carry a rev-share amount, straight from the rollup.
    const { data: metricRows } = await supabase
      .from("daily_metrics")
      .select("ad_account_id, day, revenue_share_base, revenue_share_amount")
      .in("ad_account_id", accountIds)
      .gte("day", from)
      .gt("revenue_share_amount", 0);
    if (!metricRows || metricRows.length === 0) {
      lastRevShareRunAt = Date.now();
      return;
    }

    // Existing rev-share rows in the window, keyed (account|day), to update in place.
    const { data: existingRows } = await supabase
      .from("commissions")
      .select("id, ad_account_id, occurred_on, amount")
      .eq("source_id", source.id)
      .in("ad_account_id", accountIds)
      .gte("occurred_on", from);
    const existing = new Map(
      (existingRows ?? []).map((row) => [
        `${row.ad_account_id}|${row.occurred_on}`,
        row,
      ]),
    );

    const accountById = new Map(
      billable.map((account) => [account.id, account]),
    );

    await Promise.all(
      metricRows.map(async (metric) => {
        const account = accountById.get(metric.ad_account_id);
        if (!account) return;

        const base = Number(metric.revenue_share_base);
        const amount = Number(metric.revenue_share_amount);
        const rate = base > 0 ? (amount / base) * 100 : 0; // blended, for display
        const current = existing.get(`${metric.ad_account_id}|${metric.day}`);

        try {
          if (!current) {
            await supabase.from("commissions").insert({
              source_id: source.id,
              client_id: crmByLogin.get(account.client_id) ?? null,
              ad_account_id: account.id,
              occurred_on: metric.day,
              gross_amount: base,
              rate,
              amount,
              currency: account.currency,
              status: "confirmed",
              notes: noteFor(
                REV_SHARE_NOTE_PREFIX,
                nameByLogin.get(account.client_id),
                account.store_name,
              ),
            });
          } else if (Math.abs(Number(current.amount) - amount) > 0.01) {
            await supabase
              .from("commissions")
              .update({
                gross_amount: base,
                rate,
                amount,
                updated_at: new Date().toISOString(),
              })
              .eq("id", current.id);
          }
        } catch (error) {
          console.error(
            `Rev-share book failed for ${account.id} ${metric.day}:`,
            error,
          );
        }
      }),
    );

    lastRevShareRunAt = Date.now();
  } catch (error) {
    console.error("Rev-share sync failed:", error);
  }
}
