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
