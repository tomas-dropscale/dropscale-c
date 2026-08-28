import { NextResponse, type NextRequest } from "next/server";
import { activeWorkspaceId } from "@/lib/portal/workspace";
import { fetchAccounts } from "@/lib/portal/data";
import { resyncAccountNow } from "@/lib/metrics/recompute";

/**
 * POST { accountId } — recompute the rollup for one account, now.
 *
 * Called after cost/tier/collection edits (spec §6: an edit recalculates the
 * last 90 days) and by the "sync products" button. Thanks to effective-dated
 * costs, recomputing the window only changes the days it should change.
 * Rides the caller's session; RLS scopes everything to their own account.
 */
export async function POST(request: NextRequest) {
  let body: { accountId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const accountId = body.accountId?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required." }, { status: 400 });
  }

  const clientId = await activeWorkspaceId();
  if (!clientId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // Which stores this viewer may act on is a question fetchAccounts already
  // answers, and it is the ONLY thing that answers it correctly for a V2 store:
  // its anchor row is hidden from its own owner by the policies in 0055, so
  // reading ad_accounts directly returned nothing and the client's own store
  // came back as "Account not found" on every cost edit.
  const accounts = await fetchAccounts();
  if (!accounts.some((account) => account.id === accountId)) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  try {
    await resyncAccountNow(accountId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`COGS resync failed for ${accountId}:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Resync failed." },
      { status: 500 },
    );
  }
}
