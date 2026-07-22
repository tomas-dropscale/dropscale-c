/**
 * The AGENCY's Google Ads access: a service account whose JSON key lives in
 * the environment (GOOGLE_ADS_SA_KEY_JSON), signed into short-lived access
 * tokens via a JWT (RFC 7523). This is the counterpart to the per-client
 * OAuth flow in oauth.ts/client.ts — one robot identity for the accounts the
 * agency itself is granted, no consent screens involved.
 *
 * Web Crypto only, so it runs on both Node and Cloudflare Workers. Which
 * accounts it can read is decided in Google Ads → Admin → Access and
 * security (add the service account's email as a user), never in code.
 */

const SCOPE = "https://www.googleapis.com/auth/adwords";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

/**
 * Validates a key file's content. Returns null instead of throwing: "not a
 * service account key" is an expected outcome for a mis-set env var.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const key = parsed as {
    type?: string;
    client_email?: string;
    private_key?: string;
    token_uri?: string;
  };
  if (
    key.type !== "service_account" ||
    !key.client_email ||
    !key.private_key?.includes("PRIVATE KEY")
  ) {
    return null;
  }
  return {
    client_email: key.client_email,
    private_key: key.private_key,
    token_uri: key.token_uri ?? DEFAULT_TOKEN_URI,
  };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeSegment(value: object): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function importPrivateKey(pem: string) {
  const der = Uint8Array.from(
    atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

// Cached per isolate, keyed by service-account email — same reasoning as the
// per-refresh-token cache in client.ts: tokens live ~1h, don't mint one per
// query. A cold isolate just mints a new one.
const tokenCache = new Map<string, { value: string; expiresAt: number }>();

/**
 * Access token for the service account, or a typed failure with Google's own
 * wording so routes can surface something actionable.
 */
export async function serviceAccountAccessToken(
  key: ServiceAccountKey,
): Promise<{ ok: true; token: string } | { ok: false; detail: string }> {
  const now = Date.now();
  const cached = tokenCache.get(key.client_email);
  if (cached && cached.expiresAt > now + 60_000) {
    return { ok: true, token: cached.value };
  }

  const iat = Math.floor(now / 1000);
  const unsigned =
    encodeSegment({ alg: "RS256", typ: "JWT" }) +
    "." +
    encodeSegment({
      iss: key.client_email,
      scope: SCOPE,
      aud: key.token_uri,
      iat,
      exp: iat + 3600,
    });

  let signature: ArrayBuffer;
  try {
    signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await importPrivateKey(key.private_key),
      new TextEncoder().encode(unsigned),
    );
  } catch {
    // Malformed PEM — the key was truncated or edited on its way into the env.
    return { ok: false, detail: "The private key could not be parsed." };
  }

  const response = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(new Uint8Array(signature))}`,
    }),
  });
  const body = (await response.json()) as TokenResponse;
  if (!body.access_token) {
    return { ok: false, detail: body.error_description ?? body.error ?? `HTTP ${response.status}` };
  }

  tokenCache.set(key.client_email, {
    value: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
  });
  return { ok: true, token: body.access_token };
}
