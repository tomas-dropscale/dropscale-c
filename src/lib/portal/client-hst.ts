import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptToken, encryptToken } from "@/lib/google-ads/crypto";
import { parseExpiry, tokenFault, tokenIsFresh } from "@/lib/admin/hst-token";
import { HstError, hstLogin, hstRefresh, type HstSession } from "@/lib/hst/erp";
import type { Database } from "@/lib/supabase/types";

/**
 * One client's own HST session.
 *
 * Their supplier account is theirs: it sees their shop and nobody else's, and
 * it is the only credential that may be used to price their products. The
 * agency's session (lib/admin/hst.ts) stays where it is and does a different
 * job — reading the commission HST pays the agency.
 *
 * Every function here takes a SERVICE client on purpose. client_hst_credentials
 * has row-level security enabled and no policies at all, so nothing reaches it
 * except server code; a browser cannot read a stored credential even in
 * ciphertext, and does not need to.
 */

type Service = SupabaseClient<Database>;

export type ClientHstStatus = {
  connected: boolean;
  /** HST's own words about the last failure, or null. */
  lastError: string | null;
  connectedAt: string | null;
  /**
   * False until migration 0089 has been applied.
   *
   * Code and migrations do not land at the same instant, and the panel this
   * feeds is on every client's cost page. Offering a "Connect" button whose
   * only possible outcome is a database error is worse than not offering it,
   * so the surface hides itself until the table it needs exists.
   */
  available: boolean;
};

type Row = {
  client_id: string;
  username_enc: string;
  password_enc: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  last_error: string | null;
  connected_at: string;
};

async function storeSession(
  service: Service,
  clientId: string,
  session: HstSession,
): Promise<void> {
  await service
    .from("client_hst_credentials")
    .update({
      access_token_enc: await encryptToken(session.accessToken),
      refresh_token_enc: session.refreshToken ? await encryptToken(session.refreshToken) : null,
      token_expires_at: session.expires
        ? new Date(parseExpiry(session.expires) || Date.now()).toISOString()
        : null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("client_id", clientId);
}

/**
 * Connect a client to HST, proving the credentials before keeping them.
 *
 * A pair that cannot sign in is refused rather than stored, so "connected"
 * never means "we wrote down something that has never worked".
 */
export async function connectClientHst(input: {
  service: Service;
  clientId: string;
  username: string;
  password: string;
  captchaCode?: string;
}): Promise<void> {
  const username = input.username.trim();
  if (!username || !input.password) {
    throw new HstError("Enter your HST username and password.");
  }

  const session = await hstLogin({
    username,
    password: input.password,
    captchaCode: input.captchaCode,
  });

  const { error } = await input.service.from("client_hst_credentials").upsert({
    client_id: input.clientId,
    username_enc: await encryptToken(username),
    password_enc: await encryptToken(input.password),
    access_token_enc: await encryptToken(session.accessToken),
    refresh_token_enc: session.refreshToken ? await encryptToken(session.refreshToken) : null,
    token_expires_at: session.expires
      ? new Date(parseExpiry(session.expires) || Date.now()).toISOString()
      : null,
    last_error: null,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new HstError(error.message);
}

/** Forget a client's HST credentials entirely. */
export async function disconnectClientHst(service: Service, clientId: string): Promise<void> {
  const { error } = await service
    .from("client_hst_credentials")
    .delete()
    .eq("client_id", clientId);
  if (error) throw new HstError(error.message);
}

/** Whether this client is connected, and what last went wrong. */
export async function clientHstStatus(
  service: Service,
  clientId: string,
): Promise<ClientHstStatus> {
  const { data, error } = await service
    .from("client_hst_credentials")
    .select("last_error, connected_at")
    .eq("client_id", clientId)
    .maybeSingle();

  // 42P01 is "relation does not exist" — 0089 has not been applied here yet.
  // Any other error is a real failure and still leaves the surface available,
  // so it can say so rather than vanish.
  if (error?.code === "42P01") {
    return { connected: false, lastError: null, connectedAt: null, available: false };
  }

  const row = data as { last_error: string | null; connected_at: string } | null;
  return {
    connected: Boolean(row),
    lastError: row?.last_error ?? null,
    connectedAt: row?.connected_at ?? null,
    available: true,
  };
}

/** One HST shop this login can see — the cached form of hst-orders' HstShop. */
export type CachedHstShop = { id: string; name: string };

/**
 * The last shop list we successfully read for this client, or [] when none is
 * cached — including before migration 0090 exists.
 *
 * Read-only and forgiving: a missing column or any read error is simply "no
 * cache", never a thrown page. The dropdown renders from this instantly; the
 * live supplier call is only for repopulating it.
 */
export async function cachedHstShops(
  service: Service,
  clientId: string,
): Promise<CachedHstShop[]> {
  const { data, error } = await service
    .from("client_hst_credentials")
    .select("shops")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) return [];
  const raw = (data as { shops?: unknown } | null)?.shops;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const shop = (entry ?? {}) as { id?: unknown; name?: unknown };
      return { id: String(shop.id ?? ""), name: String(shop.name ?? "") };
    })
    .filter((shop) => shop.id !== "");
}

/**
 * Remember this client's HST shop list so the dropdown can render without
 * waiting on the supplier. Best-effort: a missing column (before 0090) or any
 * write error is swallowed — the cache is an optimisation, never a requirement.
 */
export async function storeHstShops(
  service: Service,
  clientId: string,
  shops: CachedHstShop[],
): Promise<void> {
  try {
    await service
      .from("client_hst_credentials")
      .update({ shops: shops as unknown as Database["public"]["Tables"]["client_hst_credentials"]["Row"]["shops"] })
      .eq("client_id", clientId);
  } catch {
    // no-op
  }
}

/** Record why a sync failed, so a client sees a reason rather than silence. */
export async function noteClientHstError(
  service: Service,
  clientId: string,
  message: string | null,
): Promise<void> {
  await service
    .from("client_hst_credentials")
    .update({ last_error: message })
    .eq("client_id", clientId);
}

/**
 * A usable access token for one client.
 *
 * Three ways, in order: the stored token while it is known-fresh, the refresh
 * token, and finally signing in again from the stored credentials. That last
 * step is what makes this unattended — every earlier design ended at "ask a
 * human to paste a new session", and the asking is invisible: it surfaces as a
 * supplier who quietly stopped reporting.
 *
 * An UNKNOWN expiry counts as stale, not as "never expires". HST often returns
 * no `expires`, and trusting that cost the agency its own session for weeks.
 */
export async function clientHstToken(
  service: Service,
  clientId: string,
  opts?: { forceRenew?: boolean },
): Promise<string> {
  const { data } = await service
    .from("client_hst_credentials")
    .select(
      "client_id, username_enc, password_enc, access_token_enc, refresh_token_enc, token_expires_at, last_error, connected_at",
    )
    .eq("client_id", clientId)
    .maybeSingle();

  const row = data as Row | null;
  if (!row) throw new HstError("This store's supplier account is not connected.");

  const forceRenew = opts?.forceRenew ?? false;
  const stored = row.access_token_enc ? await decryptToken(row.access_token_enc) : null;
  const storedFault = stored ? tokenFault(stored) : null;
  const fresh = tokenIsFresh(parseExpiry(row.token_expires_at), Date.now());
  if (stored && !storedFault && fresh && !forceRenew) return stored;

  if (row.refresh_token_enc) {
    const refreshToken = await decryptToken(row.refresh_token_enc);
    if (!tokenFault(refreshToken)) {
      const renewed = await hstRefresh(refreshToken);
      if (renewed && !tokenFault(renewed.accessToken)) {
        await storeSession(service, clientId, renewed);
        return renewed.accessToken;
      }
    }
  }

  const session = await hstLogin({
    username: await decryptToken(row.username_enc),
    password: await decryptToken(row.password_enc),
  });
  await storeSession(service, clientId, session);
  return session.accessToken;
}
