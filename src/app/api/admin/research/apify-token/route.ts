import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { storeApifyToken } from "@/lib/research/apify-token";

export const dynamic = "force-dynamic";

/** Save the Apify token the market comparison spends with. Never read back. */
export async function POST(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  // Apify personal tokens are opaque but always this shape; a pasted URL or a
  // truncated copy fails here instead of at the first paid run.
  if (!/^apify_api_[A-Za-z0-9]{20,}$/.test(token)) {
    return NextResponse.json(
      { error: "That does not look like an Apify token (apify_api_…)." },
      { status: 422 },
    );
  }

  try {
    const hint = await storeApifyToken(token, profile.id);
    return NextResponse.json({ ok: true, hint });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The token could not be saved." },
      { status: 500 },
    );
  }
}
