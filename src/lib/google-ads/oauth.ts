import { googleAdsEnv } from "@/lib/google-ads/env";
import { siteUrl } from "@/lib/site";

/**
 * The client-facing OAuth flow: a client authorises their own Google Ads
 * account and we keep their refresh token (encrypted, per ad_account).
 *
 * `adwords` is the read/write Ads scope; the portal only reads. `openid email`
 * are added so the token response carries an id_token we can read the
 * connected Google address from. offline + consent forces a refresh_token
 * every time, even on re-connect.
 */
const SCOPE = "openid email https://www.googleapis.com/auth/adwords";

/** Must exactly match an Authorized redirect URI on the OAuth client. */
export function googleAdsRedirectUri() {
  return `${siteUrl()}/api/google-ads/callback`;
}

export function googleAdsConsentUrl(state: string) {
  const env = googleAdsEnv();
  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: env.clientId,
      redirect_uri: googleAdsRedirectUri(),
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
      include_granted_scopes: "true",
    })
  );
}

/** Exchanges the authorization code for a refresh token + the Google email. */
export async function exchangeGoogleAdsCode(
  code: string,
): Promise<{ refreshToken: string; email: string | null }> {
  const env = googleAdsEnv();

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: googleAdsRedirectUri(),
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as { refresh_token?: string; id_token?: string };
  if (!json.refresh_token) {
    // Happens if the user previously consented and Google withheld a new
    // refresh token; prompt=consent above is meant to prevent this.
    throw new Error("Google did not return a refresh token. Try connecting again.");
  }

  return { refreshToken: json.refresh_token, email: emailFromIdToken(json.id_token) };
}

/** Best-effort read of the email from the id_token payload (no verification). */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1];
    const json = JSON.parse(
      decodeURIComponent(
        atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
          .split("")
          .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join(""),
      ),
    ) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}
