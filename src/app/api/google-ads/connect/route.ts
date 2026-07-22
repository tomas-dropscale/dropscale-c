import { NextResponse, type NextRequest } from "next/server";
import { getSessionClient } from "@/lib/supabase/server";
import { hasGoogleAdsEnv } from "@/lib/google-ads/env";
import { googleAdsConsentUrl } from "@/lib/google-ads/oauth";

/**
 * Starts the per-client Google Ads connection: sends the client to Google's
 * consent screen. The account id is carried in a signed-ish state pair (a
 * random nonce in an httpOnly cookie, matched on the way back) so the callback
 * can tie the returned token to the right account and reject CSRF.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("account");
  const origin = request.nextUrl.origin;

  if (!hasGoogleAdsEnv()) {
    return NextResponse.redirect(new URL("/dashboard/settings/accounts?gads=unconfigured", origin));
  }
  if (!accountId) {
    return NextResponse.redirect(new URL("/dashboard/settings/accounts", origin));
  }

  // Must be a signed-in portal client. RLS still guards the write later; this
  // just avoids bouncing anonymous users through Google first.
  const { user, client } = await getSessionClient();
  if (!user || !client) {
    return NextResponse.redirect(new URL("/login", origin));
  }

  const nonce = crypto.randomUUID();
  const state = `${accountId}:${nonce}`;

  const res = NextResponse.redirect(googleAdsConsentUrl(state));
  res.cookies.set("gads_oauth", `${accountId}:${nonce}`, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete consent
  });
  return res;
}
