import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeInternalPath } from "@/lib/site";

/**
 * Landing page for emailed links (password reset, invites). Supports both
 * shapes Supabase may use depending on the project's templates:
 *
 *   ?code=...                  → PKCE flow (exchangeCodeForSession)
 *   ?token_hash=...&type=...   → OTP flow  (verifyOtp)
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const next = safeInternalPath(searchParams.get("next")) ?? "/dashboard";

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return redirectWithError(origin, error.message);

    // Only set by the portal's own OAuth button. Google sign-ins carry no
    // metadata we control, so the portal_clients row that migration 0002's
    // trigger creates for email signups has to be claimed here instead.
    // Failure is non-fatal: the user still lands on the gate, which will show
    // them the "no client account" screen rather than a broken redirect.
    if (searchParams.get("portal_signup") === "1") {
      await supabase.rpc("claim_portal_client");

      // The affiliate code typed on /register, which could not ride through
      // Google as metadata (lib/site.ts). Applied only here, at sign-up: the
      // portal offers no way to claim a code afterwards, on purpose, so that
      // clients cannot go around crediting each other later.
      //
      // Never fatal, and the outcome is deliberately not surfaced — a bad code
      // must not block somebody from reaching their dashboard.
      const referral = searchParams.get("ref");
      if (referral) {
        const { error: referralError } = await supabase.rpc("claim_referral_code", {
          p_code: referral,
        });
        if (referralError) console.error("Referral claim failed:", referralError.message);
      }
    }

    return NextResponse.redirect(new URL(next, origin));
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, origin));
    return redirectWithError(origin, error.message);
  }

  return redirectWithError(origin, "This link is invalid or has expired.");
}

function redirectWithError(origin: string, message: string) {
  const url = new URL("/login", origin);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}
