import { NextResponse, type NextRequest } from "next/server";
import { activeWorkspaceId } from "@/lib/portal/workspace";
import { fetchAccounts, reportingMetricScope } from "@/lib/portal/data";
import { refreshAccountsNow } from "@/lib/metrics/recompute";

/**
 * POST { accountIds?: string[] } — force-refresh the caller's dashboard now,
 * bypassing the 15-minute throttle. The account list is ALWAYS re-scoped to the
 * active workspace's accounts server-side; a client-supplied list only narrows
 * it, never widens it.
 */
export async function POST(request: NextRequest) {
  const clientId = await activeWorkspaceId();
  if (!clientId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { accountIds?: string[]; includeUnallocated?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // No body is fine — refresh all of the caller's accounts.
  }

  const allAccounts = await fetchAccounts();
  let accounts = allAccounts;
  const narrowed = Array.isArray(body.accountIds) && body.accountIds.length > 0;
  if (narrowed) {
    const requested = new Set(body.accountIds);
    accounts = accounts.filter((account) => requested.has(account.id));
  }
  const fullClient =
    (!narrowed || body.includeUnallocated === true) &&
    accounts.length === allAccounts.length &&
    allAccounts.every((account) => accounts.some((candidate) => candidate.id === account.id));
  const ids = (
    await reportingMetricScope(accounts, { includeUnallocated: fullClient })
  ).metricAccountIds;
  if (ids.length === 0) return NextResponse.json({ ok: true });

  try {
    await refreshAccountsNow(ids);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("metrics refresh failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Refresh failed." }, { status: 500 });
  }
}
