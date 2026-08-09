import "server-only";

import { decryptToken, encryptToken } from "@/lib/google-ads/crypto";
import { createServiceClient } from "@/lib/supabase/service";

export const APIFY_SECRET_KEY = "apify_token";

/**
 * The Apify token the market comparison spends money with.
 *
 * Stored encrypted with the same AES-GCM key that protects the stored Google
 * refresh tokens, so a database dump never yields a usable credential. An
 * environment variable still wins when present — that is how the deployment
 * carries the token before anyone saves one in the dashboard.
 */
export async function readApifyToken(): Promise<string | null> {
  // The saved token wins. The environment value is only a bootstrap for a
  // deployment that has never had one saved — reading it first made the
  // dashboard's "replace token" silently do nothing.
  const supabase = createServiceClient();
  if (!supabase) return process.env.APIFY_TOKEN?.trim() || null;

  const { data, error } = await supabase
    .from("app_secrets")
    .select("ciphertext")
    .eq("key", APIFY_SECRET_KEY)
    .maybeSingle();
  if (error || !data?.ciphertext) return process.env.APIFY_TOKEN?.trim() || null;

  try {
    return await decryptToken(data.ciphertext);
  } catch {
    // A token encrypted under a retired key is unusable, not a crash: the UI
    // reports "not configured" and the operator saves it again.
    console.error("The stored Apify token could not be decrypted.");
    return process.env.APIFY_TOKEN?.trim() || null;
  }
}

/** What the browser is allowed to know: whether it exists, and its last four. */
export async function fetchApifyTokenStatus(): Promise<{
  configured: boolean;
  hint: string | null;
}> {
  const envToken = process.env.APIFY_TOKEN?.trim();
  const supabase = createServiceClient();
  if (supabase) {
    const { data } = await supabase
      .from("app_secrets")
      .select("hint")
      .eq("key", APIFY_SECRET_KEY)
      .maybeSingle();
    // Mirrors readApifyToken's precedence, so the page never claims a token is
    // in use that the comparison would not actually spend with.
    if (data) return { configured: true, hint: data.hint ?? null };
  }
  return envToken
    ? { configured: true, hint: envToken.slice(-4) }
    : { configured: false, hint: null };
}

/** Encrypt and store a new token. Returns the hint the UI shows back. */
export async function storeApifyToken(
  token: string,
  adminId: string,
): Promise<string> {
  const supabase = createServiceClient();
  if (!supabase) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");

  const trimmed = token.trim();
  if (!trimmed) throw new Error("The token cannot be empty.");

  const hint = trimmed.slice(-4);
  const { error } = await supabase.rpc("set_app_secret", {
    p_key: APIFY_SECRET_KEY,
    p_ciphertext: await encryptToken(trimmed),
    p_hint: hint,
    p_updated_by: adminId,
  });
  if (error) throw new Error(error.message);
  return hint;
}
