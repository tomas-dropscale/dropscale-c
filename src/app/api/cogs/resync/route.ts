import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
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

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: account } = await supabase
    .from("ad_accounts")
    .select("id")
    .eq("id", accountId)
    .eq("client_id", user.id)
    .maybeSingle();
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });

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
