import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import { saveHstSession } from "@/lib/admin/hst";

/**
 * POST { session } — save the pasted HST login response (JSON with the access +
 * refresh tokens) or a raw bearer token, encrypted. Admin only.
 */
export async function POST(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: { session?: string };
  try {
    body = (await request.json()) as { session?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const session = body.session?.trim();
  if (!session) return NextResponse.json({ error: "Paste the login response first." }, { status: 400 });

  try {
    await saveHstSession(session);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save session." },
      { status: 500 },
    );
  }
}
