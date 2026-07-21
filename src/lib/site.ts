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

/**
 * Redirect target for "Continue with Google".
 *
 * The extra flag is the OAuth equivalent of the portal_signup metadata we set
 * on email/password signup: signInWithOAuth() cannot inject custom metadata,
 * so the callback has to be told that this sign-in came through the client
 * portal and should claim a portal identity. Password-reset links go through
 * the same route without it and are left alone.
 */
export function oauthRedirect(next = "/dashboard") {
  return `${authRedirect(next)}&portal_signup=1`;
}
