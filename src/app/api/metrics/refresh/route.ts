import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { refreshAccountsNow } from "@/lib/metrics/recompute";

/**
 * POST { accountIds?: string[] } — force-refresh the caller's dashboard now,
 * bypassing the 15-minute throttle. The account list is ALWAYS re-scoped to the
 * caller's own accounts server-side; a client-supplied list only narrows it,
 * never widens it.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { accountIds?: string[] } = {};
  try {
    body = (await request.json()) as { accountIds?: string[] };
  } catch {
    // No body is fine — refresh all of the caller's accounts.
  }

  const { data: owned } = await supabase.from("ad_accounts").select("id").eq("client_id", user.id);
  let ids = (owned ?? []).map((row) => row.id);
  if (Array.isArray(body.accountIds) && body.accountIds.length > 0) {
    const requested = new Set(body.accountIds);
    ids = ids.filter((id) => requested.has(id));
  }
  if (ids.length === 0) return NextResponse.json({ ok: true });

  try {
    await refreshAccountsNow(ids);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("metrics refresh failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Refresh failed." },
      { status: 500 },
    );
  }
}
