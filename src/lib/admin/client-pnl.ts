import "server-only";

import { fetchManualReferralRateScheduleAsAdminOrNull } from "@/lib/billing/referral-rate-schedule";
import { manualReferralRateOnDay } from "@/lib/billing/referrals";
import { requireClientOnboardingAdmin } from "@/lib/client-onboarding/sessions";
import { fetchDailyMetrics, sumMetrics } from "@/lib/metrics/queries";
import { currencyScope, type CurrencyScope } from "@/lib/portal/currency";
import { workspaceAccounts, workspaceMetricScope } from "@/lib/portal/data";
import { buildPnlSheet, monthDays, type PnlSheet } from "@/lib/portal/pnl";
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

/** How many years back the picker offers. Beyond this there is no data anyway. */
export const PNL_YEARS_BACK = 2;

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : min;

export function clampPnlPeriod(
  year: number,
  month: number,
  now = new Date(),
): { year: number; month: number } {
  return {
    year: clamp(year, now.getFullYear() - PNL_YEARS_BACK, now.getFullYear()),
    month: clamp(month, 1, 12),
  };
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
