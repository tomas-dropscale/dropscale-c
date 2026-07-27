import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { fetchClientOverview } from "@/lib/admin/client-overview";
import { parseRange } from "@/lib/portal/range";

/**
 * GET — one client's dashboard for the admin popup.
 *
 * Admin only, and checked HERE rather than relying on RLS: the reader below is
 * deliberately unscoped, so without this gate any signed-in client could ask
 * for another client's numbers. RLS would still refuse the rows, but a 403 is
 * the honest answer and it keeps the reader's contract in one place.
 */
export async function GET(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const clientId = params.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  }

  // The popup inherits whatever range the campaigns page is showing, so the
  // same parser runs on the same three params.
  const range = parseRange({
    range: params.get("range") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });

  try {
    const overview = await fetchClientOverview(clientId, range);
    if (!overview) {
      return NextResponse.json({ error: "Client not found." }, { status: 404 });
    }
    return NextResponse.json(overview);
  } catch (error) {
    console.error(`Client overview failed for ${clientId}:`, error);
    return NextResponse.json({ error: "Could not load this client." }, { status: 500 });
  }
}
