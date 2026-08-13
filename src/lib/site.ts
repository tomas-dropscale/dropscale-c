/**
 * Absolute base URL for links that leave the app — notably the redirect
 * targets embedded in Supabase confirmation and password-reset emails.
 *
 * Prefer the explicit env var. Relying on window.location.origin means the
 * link points at whatever host happened to send the request, and Supabase
 * silently falls back to the project's Site URL when the redirect isn't in
 * the allow-list — which is how confirmation emails end up pointing at the
 * wrong domain entirely.
 */
export function siteUrl() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  if (typeof window !== "undefined") return window.location.origin;

  return "http://localhost:3000";
}

export function authRedirect(next: string) {
  return `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`;
}

/** Keep post-auth redirects on this application, including query/hash state. */
export function safeInternalPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;

  try {
    const base = new URL("https://internal.invalid");
    const target = new URL(value, base);
    if (target.origin !== base.origin || target.pathname.startsWith("//")) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

/**
 * Redirect target for "Continue with Google".
 *
 * The extra flag is the OAuth equivalent of the portal_signup metadata we set
 * on email/password signup: signInWithOAuth() cannot inject custom metadata,
 * so the callback has to be told that this sign-in came through the client
 * portal and should claim a portal identity. Password-reset links go through
 * the same route without it and are left alone.
 */
export function oauthRedirect(next = "/dashboard", referralCode?: string) {
  const base = `${authRedirect(next)}&portal_signup=1`;

  // The affiliate code typed on /register, carried through Google and applied
  // by the callback. It has to travel this way because signInWithOAuth() takes
  // no metadata, and the code is only ever collected at sign-up — the portal
  // deliberately offers no way to claim one later, so if it is lost here it is
  // lost for good. Not a secret: a referral code exists to be shared.
  const code = referralCode?.trim().toUpperCase();
  return code ? `${base}&ref=${encodeURIComponent(code)}` : base;
}
