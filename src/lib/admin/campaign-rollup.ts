import type { SupabaseClient } from "@supabase/supabase-js";

import { refreshAccountsNow } from "@/lib/metrics/recompute";
import {
  fetchDailyMetrics,
  type DailyMetricRow,
} from "@/lib/metrics/queries";
import type { RangeSelection } from "@/lib/portal/range";
import type { Database } from "@/lib/supabase/types";

export type AdminCampaignRollupScope = {
  id: string;
  accountIds: string[];
  revenueAccountIds: string[];
};

export type AdminCampaignRollupCoverage = {
  rows: DailyMetricRow[];
  completeScopeIds: Set<string>;
  refreshed: boolean;
};

type Service = SupabaseClient<Database>;

function selectedDays(range: Pick<RangeSelection, "from" | "to">): string[] {
  const days: string[] = [];
  const cursor = new Date(`${range.from}T00:00:00.000Z`);
  const end = new Date(`${range.to}T00:00:00.000Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function finiteNonNegative(value: unknown): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

function completeScopes(
  rows: DailyMetricRow[],
  scopes: AdminCampaignRollupScope[],
  days: string[],
): Set<string> {
  const daySet = new Set(days);
  const expectedAccounts = new Set<string>();
  const revenueAccounts = new Set<string>();
  for (const scope of scopes) {
    if (!scope.id || new Set(scope.accountIds).size !== scope.accountIds.length) {
      throw new Error("Admin campaign rollup scope is invalid.");
    }
    const accountSet = new Set(scope.accountIds);
    if (scope.revenueAccountIds.some((id) => !accountSet.has(id))) {
      throw new Error("Admin campaign rollup scope is invalid.");
    }
    for (const id of scope.accountIds) {
      if (expectedAccounts.has(id)) {
        throw new Error("Admin campaign rollup scopes overlap.");
      }
      expectedAccounts.add(id);
    }
    scope.revenueAccountIds.forEach((id) => revenueAccounts.add(id));
  }

  const seen = new Map<string, Set<string>>();
  const invalid = new Set<string>();
  for (const row of rows) {
    if (!expectedAccounts.has(row.ad_account_id)) {
      throw new Error("Daily metrics escaped the campaign rollup scope.");
    }
    const accountDays = seen.get(row.ad_account_id) ?? new Set<string>();
    if (
      !daySet.has(row.day) ||
      accountDays.has(row.day) ||
      !finiteNonNegative(row.ad_spend) ||
      !finiteNonNegative(row.revenue) ||
      !finiteNonNegative(row.refunds_amount) ||
      !finiteNonNegative(row.product_cost) ||
      !finiteNonNegative(row.payment_fees) ||
      !finiteNonNegative(row.shipping_cost) ||
      !row.computed_at ||
      !Number.isFinite(Date.parse(row.computed_at))
    ) {
      invalid.add(row.ad_account_id);
    }
    if (
      revenueAccounts.has(row.ad_account_id) &&
      (row.attributed_revenue === null ||
        row.attributed_orders === null ||
        !finiteNonNegative(row.attributed_revenue) ||
        !Number.isSafeInteger(Number(row.attributed_orders)) ||
        Number(row.attributed_orders) < 0)
    ) {
      invalid.add(row.ad_account_id);
    }
    accountDays.add(row.day);
    seen.set(row.ad_account_id, accountDays);
  }

  const completeAccounts = new Set(
    [...expectedAccounts].filter(
      (id) => !invalid.has(id) && seen.get(id)?.size === days.length,
    ),
  );
  return new Set(
    scopes
      .filter(
        (scope) =>
          scope.accountIds.length > 0 &&
          scope.accountIds.every((id) => completeAccounts.has(id)),
      )
      .map((scope) => scope.id),
  );
}

/**
 * Proves the exact account × day grid used by Campaigns. Authentication must
 * already have succeeded before the caller supplies this service-role client.
 * One bounded refresh is attempted; an upstream failure remains an incomplete
 * scope so the UI can hide that scope's financial rollup without losing the
 * live campaign roster.
 */
export async function ensureAdminCampaignRollups(
  service: Service,
  scopes: AdminCampaignRollupScope[],
  range: Pick<RangeSelection, "from" | "to">,
): Promise<AdminCampaignRollupCoverage> {
  const days = selectedDays(range);
  if (days.length === 0 || days.length > 366 || days.at(-1) !== range.to) {
    throw new Error("Admin campaign rollup range is invalid.");
  }
  const accountIds = [...new Set(scopes.flatMap((scope) => scope.accountIds))];
  if (accountIds.length === 0) {
    return { rows: [], completeScopeIds: new Set(), refreshed: false };
  }

  let rows = await fetchDailyMetrics(accountIds, range.from, range.to);
  let completeScopeIds = completeScopes(rows, scopes, days);
  if (completeScopeIds.size === scopes.filter((scope) => scope.accountIds.length > 0).length) {
    return { rows, completeScopeIds, refreshed: false };
  }

  await refreshAccountsNow(accountIds, {
    client: service,
    reportingClient: service,
    from: range.from,
    to: range.to,
  });
  rows = await fetchDailyMetrics(accountIds, range.from, range.to);
  completeScopeIds = completeScopes(rows, scopes, days);
  return { rows, completeScopeIds, refreshed: true };
}
