/**
 * HST supplier-commission sync — with self-renewing session.
 *
 * HST (the agency's partner/supplier) runs a vue-pure-admin ERP. Logging in
 * (past a captcha, done by a human once) returns an accessToken, a refreshToken
 * and an expiry. We store all three encrypted; before each sync we renew the
 * accessToken from the refreshToken (POST /refresh-token) when it's expired, so
 * the integration keeps running WITHOUT anyone re-pasting a token — no captcha
 * is ever automated. The commission (grand total in `data.all.total`, per-day
 * rows via `express_date` + `total`) is booked into the finance ledger as the
 * "HST" revenue source, so it shows up everywhere the admin reads revenue.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { decryptToken, encryptToken } from "@/lib/google-ads/crypto";
import type { Database } from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

const COMMISSION_URL = "https://hsterp.com/commission-salesman-mingxi";
const REFRESH_URL = "https://hsterp.com/refresh-token";
const HST_SOURCE = "HST";
// HST commission currency. Change here if HST bills in another currency.
const HST_CURRENCY = "EUR";
const THROTTLE_MS = 60 * 60 * 1000;
const PAGE_LIMIT = 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // refresh a bit before the token actually dies

let lastRunAt = 0;

export class HstError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HstError";
  }
}

/** "2026/07/26 20:57:52" (and ISO) → epoch ms, or 0 when unparseable. */
function parseExpiry(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value.includes("T") ? value : value.replace(/-/g, "/")).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// ---------------------------------------------------------------------------
// Session: save, refresh, ensure-fresh
// ---------------------------------------------------------------------------

type Session = { accessToken: string; refreshToken: string | null; expires: string | null };

/** Extract a session from the pasted login response JSON, or a raw bearer token. */
function parseSession(input: string): Session | null {
  const trimmed = input.trim();
  try {
    const parsed = JSON.parse(trimmed) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const data = (parsed.data ?? parsed) as Record<string, unknown>;
    const accessToken = (data.accessToken ?? data.token) as string | undefined;
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: (data.refreshToken as string) ?? null,
      expires: (data.expires as string) ?? null,
    };
  } catch {
    // Not JSON → a raw bearer token, no refresh capability.
    return trimmed ? { accessToken: trimmed, refreshToken: null, expires: null } : null;
  }
}

/** Persist the pasted login response (or bearer token), encrypted. */
export async function saveHstSession(input: string): Promise<void> {
  const session = parseSession(input);
  if (!session) throw new Error("Couldn't find an access token in what you pasted.");

  const supabase = await createClient();
  await supabase.from("hst_integration").upsert({
    id: true,
    access_token: await encryptToken(session.accessToken),
    refresh_token: session.refreshToken ? await encryptToken(session.refreshToken) : null,
    token_expires_at: session.expires
      ? new Date(parseExpiry(session.expires) || Date.now()).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  });
}

/** Swap the refresh token for a new session via POST /refresh-token. */
async function refreshSession(refreshToken: string): Promise<Session | null> {
  let res: Response;
  try {
    res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json().catch(() => null)) as
    | { data?: Record<string, unknown> }
    | null;
  const data = (body?.data ?? body) as Record<string, unknown> | null;
  const accessToken = data?.accessToken as string | undefined;
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken: (data?.refreshToken as string) ?? refreshToken,
    expires: (data?.expires as string) ?? null,
  };
}

/** A valid access token, renewing from the refresh token when expired. */
async function ensureFreshToken(supabase: Supabase): Promise<string> {
  const { data } = await supabase
    .from("hst_integration")
    .select("access_token, refresh_token, token_expires_at")
    .maybeSingle();

  if (!data?.access_token && !data?.refresh_token) {
    throw new HstError("No HST session saved yet — paste the login response.");
  }

  const expiresAt = parseExpiry(data?.token_expires_at);
  const stillValid = data?.access_token && (expiresAt === 0 || expiresAt - EXPIRY_MARGIN_MS > Date.now());
  if (stillValid) return decryptToken(data.access_token!);

  // Expired (or unknown) → renew from the refresh token.
  if (!data?.refresh_token) {
    if (data?.access_token) return decryptToken(data.access_token); // no refresh; try as-is
    throw new HstError("HST session expired and no refresh token — paste a fresh login.");
  }

  const renewed = await refreshSession(await decryptToken(data.refresh_token));
  if (!renewed) {
    throw new HstError(
      "Couldn't renew the HST token (the refresh endpoint may differ) — paste a fresh login.",
    );
  }

  await supabase
    .from("hst_integration")
    .update({
      access_token: await encryptToken(renewed.accessToken),
      refresh_token: renewed.refreshToken ? await encryptToken(renewed.refreshToken) : null,
      token_expires_at: renewed.expires
        ? new Date(parseExpiry(renewed.expires) || Date.now()).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);

  return renewed.accessToken;
}

export async function getHstStatus(): Promise<{
  hasSession: boolean;
  lastSyncedAt: string | null;
  tokenExpiresAt: string | null;
}> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("hst_integration")
    .select("access_token, refresh_token, last_synced_at, token_expires_at")
    .maybeSingle();
  return {
    hasSession: Boolean(data?.access_token || data?.refresh_token),
    lastSyncedAt: data?.last_synced_at ?? null,
    tokenExpiresAt: data?.token_expires_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Commission fetch + booking
// ---------------------------------------------------------------------------

type HstRow = {
  express_date?: string | null;
  total?: string | number | null;
  shopName?: string | null;
};
type HstResponse = {
  data?: { data?: HstRow[]; last_page?: number; all?: { count?: string; total?: string } };
};

/** One day's commission for one client. */
export type HstEntry = { day: string; client: string; amount: number };

/**
 * The client name is the last "-" segment of the HST shop name, e.g.
 * "AZL90266-РАЯ НИКОЛОВА-Tomas" → "Tomas", "AYW98711-椿工房-Caio" → "Caio".
 */
function clientNameFromShop(shopName: string): string {
  const parts = shopName
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : shopName.trim() || "Unknown";
}

async function fetchPage(token: string, page: number): Promise<HstResponse> {
  const res = await fetch(`${COMMISSION_URL}?shopIds=&page=${page}&limit=${PAGE_LIMIT}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new HstError("HST rejected the token — the session likely expired.");
  }
  if (!res.ok) throw new HstError(`HST returned ${res.status}.`);
  return (await res.json()) as HstResponse;
}

/** Commission summed per (day, client) plus the grand total across pages. */
export async function fetchHstCommissions(
  token: string,
): Promise<{ entries: HstEntry[]; grandTotal: number }> {
  const first = await fetchPage(token, 1);
  const rows = [...(first.data?.data ?? [])];
  const lastPage = first.data?.last_page ?? 1;
  for (let page = 2; page <= lastPage; page++) {
    const next = await fetchPage(token, page);
    rows.push(...(next.data?.data ?? []));
  }

  const grouped = new Map<string, HstEntry>();
  for (const row of rows) {
    const day = row.express_date;
    if (!day) continue;
    const client = clientNameFromShop((row.shopName ?? "").toString());
    const key = `${day}|${client}`;
    const entry = grouped.get(key) ?? { day, client, amount: 0 };
    entry.amount += Number(row.total ?? 0);
    grouped.set(key, entry);
  }
  return { entries: [...grouped.values()], grandTotal: Number(first.data?.all?.total ?? 0) };
}

export type HstSyncResult = {
  ok: boolean;
  error?: string;
  total?: number;
  days?: number;
  skipped?: boolean;
};

/**
 * Renew the token if needed, pull HST commission and book one row per day under
 * the HST source. Idempotent. `force` bypasses the hourly throttle (the button).
 */
export async function syncHstCommission(opts?: { force?: boolean }): Promise<HstSyncResult> {
  if (!opts?.force && Date.now() - lastRunAt < THROTTLE_MS) return { ok: true, skipped: true };

  const supabase = await createClient();

  let token: string;
  try {
    token = await ensureFreshToken(supabase);
  } catch (error) {
    return { ok: false, error: error instanceof HstError ? error.message : "No HST session." };
  }

  const { data: source } = await supabase
    .from("revenue_sources")
    .select("id")
    .eq("name", HST_SOURCE)
    .maybeSingle();
  if (!source) return { ok: false, error: "HST revenue source missing — run migration 0011." };

  let entries: HstEntry[];
  let grandTotal: number;
  try {
    ({ entries, grandTotal } = await fetchHstCommissions(token));
  } catch (error) {
    return { ok: false, error: error instanceof HstError ? error.message : "HST fetch failed." };
  }

  // Attribute to a CRM client by name (exact, case-insensitive) when one exists.
  const { data: crmClients } = await supabase.from("clients").select("id, name");
  const clientIdByName = new Map(
    (crmClients ?? []).map((row) => [row.name.trim().toLowerCase(), row.id]),
  );

  // The HST ledger is fully auto-synced: replace it wholesale so per-client
  // splits and amounts always match what HST currently reports.
  await supabase.from("commissions").delete().eq("source_id", source.id);

  if (entries.length > 0) {
    const rows = entries.map((entry) => ({
      source_id: source.id,
      client_id: clientIdByName.get(entry.client.toLowerCase()) ?? null,
      ad_account_id: null,
      occurred_on: entry.day,
      gross_amount: entry.amount,
      rate: 100,
      amount: entry.amount,
      currency: HST_CURRENCY,
      status: "confirmed" as const,
      notes: `HST · ${entry.client}`,
    }));
    await supabase.from("commissions").insert(rows);
  }

  await supabase
    .from("hst_integration")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", true);

  lastRunAt = Date.now();
  return { ok: true, total: grandTotal, days: new Set(entries.map((entry) => entry.day)).size };
}
