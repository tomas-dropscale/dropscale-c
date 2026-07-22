import { NextResponse, type NextRequest } from "next/server";
import { createClient, getSessionClient } from "@/lib/supabase/server";
import { exchangeGoogleAdsCode } from "@/lib/google-ads/oauth";
import { encryptToken } from "@/lib/google-ads/crypto";

/**
 * Where Google returns after the client consents. Verifies the CSRF state,
 * exchanges the code for a refresh token, encrypts it and stores it against
 * the account.
 *
 * The write rides RLS: the update only lands if the signed-in client owns the
 * account (ad_accounts_update_own), so a forged account id in the state cannot
 * attach a token to someone else's row.
 */
export const dynamic = "force-dynamic";

const SETTINGS = "/dashboard/settings/accounts";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const back = (params: string) => NextResponse.redirect(new URL(`${SETTINGS}?${params}`, origin));

  const error = searchParams.get("error");
  if (error) return back(`gads=denied`);

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const cookie = request.cookies.get("gads_oauth")?.value;

  // State must match the cookie set when the flow started — CSRF guard.
  if (!code || !state || !cookie || state !== cookie) {
    return back("gads=error");
  }

  const accountId = state.split(":")[0];

  const { user, client } = await getSessionClient();
  if (!user || !client) return NextResponse.redirect(new URL("/login", origin));

  let email: string | null = null;
  let cipher: string;
  try {
    const exchanged = await exchangeGoogleAdsCode(code);
    email = exchanged.email;
    cipher = await encryptToken(exchanged.refreshToken);
  } catch (cause) {
    console.error("Google Ads connect failed:", cause);
    return back("gads=error");
  }

  const supabase = await createClient();
  const { error: updateError } = await supabase
    .from("ad_accounts")
    .update({
      google_ads_refresh_token: cipher,
      google_ads_connected_email: email,
      google_ads_connected: true,
    })
    .eq("id", accountId);

  const res = updateError ? back("gads=error") : back("gads=connected");
  // One-shot cookie — clear it whatever the outcome.
  res.cookies.set("gads_oauth", "", { path: "/", maxAge: 0 });
  return res;
}
