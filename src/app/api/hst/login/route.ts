import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { connectHstWithCredentials, forgetHstCredentials, HstError } from "@/lib/admin/hst";

/**
 * POST — sign in to HST with the account's own username and password.
 *
 * The alternative this replaces is copying a login response out of the
 * browser's network tab, which works right up until the refresh token expires
 * too. Then the supplier's costs and commission simply stop, and nothing on
 * screen distinguishes that from a supplier with nothing to report — which is
 * exactly how the session died on 2026-08-02 and went unnoticed for weeks.
 *
 * `captchaCode` is passed through untouched, never invented. If HST is checking
 * the code, the person signing in can read it off the login page; if it is not,
 * an empty field is the honest thing to send.
 *
 * DELETE — forget the stored credentials, leaving any live session alone.
 */
export async function POST(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as
    | { username?: unknown; password?: unknown; captchaCode?: unknown }
    | null;

  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username.trim() || !password) {
    return NextResponse.json({ error: "Enter the HST username and password." }, { status: 422 });
  }
  // Blank means "nothing was typed", not "an empty answer was given" — the two
  // are the same on the wire, but only one of them is a claim.
  const captchaCode =
    typeof body?.captchaCode === "string" ? body.captchaCode.trim() || undefined : undefined;

  try {
    await connectHstWithCredentials({ username, password, captchaCode });
    return NextResponse.json({ ok: true });
  } catch (error) {
    // HST's own refusal is a sentence the operator can act on ("wrong
    // password", "captcha required"); anything else is ours and stays generic.
    const message =
      error instanceof HstError
        ? error.message
        : "Couldn't sign in to HST.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  await forgetHstCredentials();
  return NextResponse.json({ ok: true });
}
