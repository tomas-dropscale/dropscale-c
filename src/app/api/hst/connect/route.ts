import { NextResponse, type NextRequest } from "next/server";

import { activeWorkspaceId } from "@/lib/portal/workspace";
import { createServiceClient } from "@/lib/supabase/service";
import { connectClientHst, disconnectClientHst } from "@/lib/portal/client-hst";
import { HstError } from "@/lib/hst/erp";

/**
 * POST — a client connects their OWN supplier account.
 *
 * Theirs, not the agency's: the credentials go against the workspace on screen
 * and are used for nothing else. The agency's HST session lives in
 * hst_integration and reads a different thing entirely — the commission HST
 * pays the agency — and neither can be reached from the other.
 *
 * The service role does the writing because client_hst_credentials denies
 * everyone under RLS, including its owner. A browser never needs to hold a
 * credential to know that it is connected.
 *
 * `captchaCode` is passed through untouched and never invented. If HST is
 * checking the code, the person signing in reads it off the login page.
 *
 * DELETE — disconnect. Costs already written stay: they are dated facts, and
 * the client edits them by hand from then on, exactly as before.
 */
export async function POST(request: NextRequest) {
  const clientId = await activeWorkspaceId();
  if (!clientId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { username?: unknown; password?: unknown; captchaCode?: unknown }
    | null;

  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username.trim() || !password) {
    return NextResponse.json({ error: "Enter your HST username and password." }, { status: 422 });
  }
  // Blank means "nothing was typed", not "an empty answer was given".
  const captchaCode =
    typeof body?.captchaCode === "string" ? body.captchaCode.trim() || undefined : undefined;

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  try {
    await connectClientHst({ service, clientId, username, password, captchaCode });
    return NextResponse.json({ ok: true });
  } catch (error) {
    // HST's own refusal is a sentence the person can act on ("wrong password",
    // "captcha required"); anything else is ours and stays generic.
    return NextResponse.json(
      { error: error instanceof HstError ? error.message : "Couldn't sign in to HST." },
      { status: 400 },
    );
  }
}

export async function DELETE() {
  const clientId = await activeWorkspaceId();
  if (!clientId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  await disconnectClientHst(service, clientId);
  return NextResponse.json({ ok: true });
}
