import "server-only";

import { fetchManualReferralRateScheduleAsAdminOrNull } from "@/lib/billing/referral-rate-schedule";
import { manualReferralRateOnDay } from "@/lib/billing/referrals";
import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
import { fetchDailyMetrics, sumMetrics } from "@/lib/metrics/queries";
import { currencyScope, type CurrencyScope } from "@/lib/portal/currency";
import { workspaceAccounts, workspaceMetricScope } from "@/lib/portal/data";
import { buildPnlSheet, monthDays, type PnlSheet } from "@/lib/portal/pnl";
import { presetSelection } from "@/lib/portal/range";
import { createClient } from "@/lib/supabase/server";

/**
 * A client's P&L, exactly as the client sees it in their own portal - the same
 * stores, the same physical scope, the same daily rows, the same sheet
 * builder, the same fee rule - read by an admin for any client, one month at
 * a time.
 *
 * The point is to see how each client's money is doing from our side. So this
 * deliberately walks the portal's own path rather than reimplementing it: the
 * number the client reads and the number we read must be the same number.
 * What differs is only WHO is asking. The portal resolves the workspace from
 * the session; here the admin names the client, and the referral schedule is
 * read under the admin's own grant because the client's RPC answers members
 * only.
 *
 * The daily rows ride each viewer's RLS. An admin reads every row of the
 * scope; a member reads the same rows since 0102, which admitted the frozen
 * history of an account a handover retired - before it, the member's sheet
 * silently lacked that spend while this one carried it.
 */

export type AdminClientPnlStore = {
  accountId: string;
  storeName: string;
  currency: string;
};

export type AdminClientPnl = {
  clientId: string;
  clientName: string;
  /** The stores the client's portal offers in its own store selector. */
  stores: AdminClientPnlStore[];
  /** The store shown, or null for every store together. */
  storeId: string | null;
  year: number;
  month: number;
  sheet: PnlSheet;
  currencies: CurrencyScope;
  /**
   * Google spend no store owns - part of the all-store sheet only. The
   * portal's notice keys on such an account EXISTING, not on the amount, so
   * both are exposed.
   */
  hasUnallocatedGoogle: boolean;
  unallocatedSpend: number;
};

export type AdminPnlClient = {
  id: string;
  name: string;
  email: string;
  /**
   * Every ad_accounts row the client owns, whatever its status or role -
   * Google children and retired accounts included. A count of sources rather
   * than of shops; what matters here is that it is not zero.
   */
  storeCount: number;
  /** Not approved yet. Their portal opens all the same, so their P&L reads too. */
  pending: boolean;
};

/** How many years back the picker offers. Beyond this there is no data anyway. */
export const PNL_YEARS_BACK = 2;

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : min;

/**
 * The year and month of the reporting day: the business day in Lisbon, which
 * is the clock every daily row is keyed to. Not the runtime's clock - the
 * Worker runs on UTC, an hour behind Lisbon in summer, so for the first hour
 * of a month it would still open last month's sheet while the day's rows were
 * already landing in the new one.
 */
export function currentPnlPeriod(now = new Date()): { year: number; month: number } {
  const today = presetSelection("today", now).to;
  return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
}

export function clampPnlPeriod(
  year: number,
  month: number,
  now = new Date(),
): { year: number; month: number } {
  const current = currentPnlPeriod(now).year;
  return {
    year: clamp(year, current - PNL_YEARS_BACK, current),
    month: clamp(month, 1, 12),
  };
}

/**
 * Every client whose P&L there is to read: any workspace that is not archived
 * and owns at least one ad_accounts row, of any status and any reporting role.
 *
 * Deliberately wider than the Analytics catalogue, which wants an approved
 * client with reporting evidence and skips workspaces owned by an admin
 * profile. The portal itself admits any non-rejected workspace (0064), and a
 * store an admin owns has a P&L like any other. So a pending client is listed
 * and flagged; a workspace with no store is not, since its sheet could only be
 * empty.
 *
 * Read through the admin's own session, like the sheet: RLS shows an admin
 * every client and every account.
 */
export async function listAdminPnlClients(): Promise<AdminPnlClient[]> {
  await requireClientOnboardingAdmin();

  const supabase = await createClient();
  const [clientsResult, accountsResult] = await Promise.all([
    supabase
      .from("portal_clients")
      .select("id, full_name, email, approval_status")
      .neq("approval_status", "rejected"),
    supabase.from("ad_accounts").select("client_id"),
  ]);
  if (clientsResult.error || accountsResult.error) {
    throw new Error("The client list is unavailable.");
  }

  const storeCounts = new Map<string, number>();
  for (const account of accountsResult.data ?? []) {
    storeCounts.set(account.client_id, (storeCounts.get(account.client_id) ?? 0) + 1);
  }

  // Locale-aware so an accented name sorts among its letter, not after Z.
  const byName = new Intl.Collator("en");
  return (clientsResult.data ?? [])
    .filter((client) => storeCounts.has(client.id))
    .map((client) => ({
      id: client.id,
      name: client.full_name,
      email: client.email,
      storeCount: storeCounts.get(client.id) ?? 0,
      pending: client.approval_status !== "approved",
    }))
    .sort(
      (left, right) =>
        byName.compare(left.name, right.name) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
}

export async function fetchAdminClientPnl(input: {
  clientId: string;
  storeId: string | null;
  year: number;
  month: number;
}): Promise<AdminClientPnl | null> {
  // First, before any cross-client read is even constructed.
  await requireClientOnboardingAdmin();

  const days = monthDays(input.year, input.month);
  const from = days[0];
  const to = days[days.length - 1];
  if (!from || !to) return null;

  const supabase = await createClient();
  const { data: client, error } = await supabase
    .from("portal_clients")
    .select("id, full_name")
    .eq("id", input.clientId)
    .maybeSingle();
  if (error) throw new Error("The client is unavailable.");
  if (!client) return null;

  // The portal's store list and physical scope for this workspace: V2 anchors
  // with their Google children and every account a handover retired under
  // them, or the legacy accounts one-to-one - whichever surface serves the
  // client today. An all-store sheet carries the unallocated Google spend
  // bucket; a single store's never does.
  const accounts = await workspaceAccounts(client.id);
  const selected = input.storeId
    ? accounts.find((account) => account.id === input.storeId) ?? null
    : null;
  if (input.storeId && !selected) return null;
  const scope = selected ? [selected] : accounts;
  const metricsScope = await workspaceMetricScope(client.id, scope, {
    includeUnallocated: selected === null,
  });
  const physicalAccounts = [...metricsScope.metricAccountsById.values()];

  const [rows, referralRateSchedule] = await Promise.all([
    fetchDailyMetrics(metricsScope.metricAccountIds, from, to),
    scope[0]
      ? fetchManualReferralRateScheduleAsAdminOrNull(client.id)
      : Promise.resolve([]),
  ]);
  const unallocatedIds = new Set(metricsScope.unallocatedGoogleAccountIds);

  // The portal's fee rule, verbatim: a referred account on the 10% list rate
  // pays the manual referral rate of the day; every other account pays its
  // own rate. A schedule that could not be read prices the fee at nothing
  // rather than at the list rate.
  const sheet = buildPnlSheet(rows, days, (accountId, day) => {
    const account = metricsScope.metricAccountsById.get(accountId);
    return Number(account?.list_commission_rate) === 10 && !account?.revenue_share_enabled
      ? (referralRateSchedule ? manualReferralRateOnDay(day, referralRateSchedule) : 0)
      : Number(account?.commission_rate ?? 0);
  });

  return {
    clientId: client.id,
    clientName: client.full_name,
    stores: accounts.map((account) => ({
      accountId: account.id,
      storeName: account.store_name,
      currency: account.currency,
    })),
    storeId: selected?.id ?? null,
    year: input.year,
    month: input.month,
    sheet,
    currencies: currencyScope(physicalAccounts),
    hasUnallocatedGoogle: metricsScope.unallocatedGoogleAccountIds.length > 0,
    unallocatedSpend: sumMetrics(rows.filter((row) => unallocatedIds.has(row.ad_account_id)))
      .adSpend,
  };
}
