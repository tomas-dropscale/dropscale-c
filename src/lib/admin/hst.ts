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
import { HST_NOTE_PREFIX } from "@/lib/finance/config";
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
// PostgREST takes one statement per request: a chunk that fails fails whole,
// and a delete filter travels in the URL, so ids go in smaller batches.
const INSERT_CHUNK = 500;
const DELETE_CHUNK = 200;

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

/**
 * Why a token can't be used, or null when it's fine.
 *
 * HTTP header values are ByteStrings: every character must fit in one byte.
 * A token carrying anything above U+00FF was copied from a view that elided
 * it — DevTools' Preview tab truncates long strings with "…" — and `fetch`
 * would only reject it much later, with an opaque message about a character
 * value of 8230. Catching it at paste time is the difference between a
 * one-line fix and an afternoon.
 */
function tokenFault(token: string): string | null {
  const chars = [...token];
  const index = chars.findIndex((char) => (char.codePointAt(0) ?? 0) > 255);
  if (index === -1) return null;

  return chars[index] === "…"
    ? `it is truncated — there's a "…" at position ${index}. Copy the raw Response tab in F12, not Preview (Preview shortens long values).`
    : `it has a character that can't travel in an HTTP header ("${chars[index]}" at position ${index}). Copy the raw Response tab in F12.`;
}

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

  // Refuse a token that could never be sent, instead of storing it and failing
  // at the next sync with an error nobody can read.
  const accessFault = tokenFault(session.accessToken);
  if (accessFault) throw new Error(`That access token won't work: ${accessFault}`);
  const refreshFault = session.refreshToken ? tokenFault(session.refreshToken) : null;
  if (refreshFault) throw new Error(`That refresh token won't work: ${refreshFault}`);

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

  // A token stored before the paste-time check may still be unusable; treat
  // that exactly like an expired one and try to renew past it.
  const stored = data?.access_token ? await decryptToken(data.access_token) : null;
  const storedFault = stored ? tokenFault(stored) : null;
  const expiresAt = parseExpiry(data?.token_expires_at);
  const unexpired = expiresAt === 0 || expiresAt - EXPIRY_MARGIN_MS > Date.now();

  if (stored && !storedFault && unexpired) return stored;

  // Expired, unknown or unusable → renew from the refresh token.
  if (!data?.refresh_token) {
    if (stored && !storedFault) return stored; // no refresh; try as-is
    throw new HstError(
      storedFault
        ? `The saved HST access token can't be used: ${storedFault}`
        : "HST session expired and no refresh token — paste a fresh login.",
    );
  }

  const refreshToken = await decryptToken(data.refresh_token);
  const refreshFault = tokenFault(refreshToken);
  if (refreshFault) {
    throw new HstError(`The saved HST refresh token can't be used: ${refreshFault}`);
  }

  const renewed = await refreshSession(refreshToken);
  if (!renewed) {
    throw new HstError(
      "Couldn't renew the HST token (the refresh endpoint may differ) — paste a fresh login.",
    );
  }

  const renewedFault = tokenFault(renewed.accessToken);
  if (renewedFault) {
    throw new HstError(`HST returned an access token we can't use: ${renewedFault}`);
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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `express_date` → a date Postgres will accept, or null.
 *
 * The ERP has been seen sending "2026-07-25", "2026/07/25" and values with a
 * time part. Anything else is dropped rather than sent to the database: one
 * unparseable day used to be enough to make the whole booking fail.
 */
function normalizeDay(value: string): string | null {
  const day = value.trim().replace(/\//g, "-").slice(0, 10);
  return ISO_DAY.test(day) ? day : null;
}

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

/**
 * The SHAPE of a payload — key names, array lengths — never the values. When a
 * sync finds nothing to book, this is what says whether HST sent an empty list
 * or a structure we're reading wrong, without leaking commission figures into
 * an error message.
 */
function describeShape(payload: unknown): string {
  if (!payload || typeof payload !== "object") return `payload is ${typeof payload}`;

  const top = Object.keys(payload as object);
  const data = (payload as { data?: unknown }).data;
  const inner = data && typeof data === "object" ? Object.keys(data as object) : [];
  const rows = (data as { data?: unknown } | undefined)?.data;
  const firstRow =
    Array.isArray(rows) && rows[0] && typeof rows[0] === "object"
      ? Object.keys(rows[0] as object)
      : [];

  return `top keys [${top.join(", ")}]; data keys [${inner.join(", ")}]; rows ${
    Array.isArray(rows) ? rows.length : "not an array"
  }; first row keys [${firstRow.join(", ")}]`;
}

async function fetchPage(token: string, page: number): Promise<HstResponse> {
  const res = await fetch(`${COMMISSION_URL}?shopIds=&page=${page}&limit=${PAGE_LIMIT}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new HstError("HST rejected the token — the session likely expired.");
  }
  if (!res.ok) throw new HstError(`HST returned ${res.status}.`);

  // A 200 carrying HTML means the URL is the ERP's own page, not its API —
  // res.json() would fail on "<" and say nothing useful about why.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new HstError(
      `HST answered ${COMMISSION_URL} with "${contentType || "no content-type"}" instead of JSON — that URL looks like the ERP page, not its API endpoint.`,
    );
  }
  return (await res.json()) as HstResponse;
}

/**
 * Commission summed per (day, client), the grand total across pages, and how
 * many raw rows carried no usable date — the caller reports that number rather
 * than letting rows vanish quietly.
 */
export async function fetchHstCommissions(token: string): Promise<{
  entries: HstEntry[];
  grandTotal: number;
  rowCount: number;
  droppedRows: number;
  /** Key-only description of page 1, for when nothing parses out. */
  shape: string;
}> {
  const first = await fetchPage(token, 1);
  const rows = [...(first.data?.data ?? [])];
  const lastPage = first.data?.last_page ?? 1;
  for (let page = 2; page <= lastPage; page++) {
    const next = await fetchPage(token, page);
    rows.push(...(next.data?.data ?? []));
  }

  const grouped = new Map<string, HstEntry>();
  let droppedRows = 0;
  for (const row of rows) {
    const day = row.express_date ? normalizeDay(row.express_date.toString()) : null;
    if (!day) {
      droppedRows += 1;
      continue;
    }
    const client = clientNameFromShop((row.shopName ?? "").toString());
    const key = `${day}|${client}`;
    const entry = grouped.get(key) ?? { day, client, amount: 0 };
    entry.amount += Number(row.total ?? 0);
    grouped.set(key, entry);
  }
  return {
    entries: [...grouped.values()],
    grandTotal: Number(first.data?.all?.total ?? 0),
    rowCount: rows.length,
    droppedRows,
    shape: describeShape(first),
  };
}

export type HstSyncResult = {
  ok: boolean;
  error?: string;
  total?: number;
  days?: number;
  /** Ledger rows actually written — the number that proves the sync landed. */
  booked?: number;
  /** Raw HST rows thrown away for having no usable date. */
  ignoredRows?: number;
  skipped?: boolean;
};

/** Delete commission rows by id, in URL-sized batches. Returns the first error. */
async function deleteRowsById(
  supabase: Supabase,
  ids: string[],
): Promise<{ message: string } | null> {
  for (let index = 0; index < ids.length; index += DELETE_CHUNK) {
    const { error } = await supabase
      .from("commissions")
      .delete()
      .in("id", ids.slice(index, index + DELETE_CHUNK));
    if (error) return error;
  }
  return null;
}

/**
 * Renew the token if needed, pull the HST commission and republish it under the
 * HST source: one row per (day, client). `force` bypasses the throttle (the
 * button).
 *
 * The republish is a SWAP, never a wipe-then-refill. The rows currently in the
 * ledger stay live until the new set is fully written; only then are they
 * retired. A failure at any point therefore leaves the previous numbers
 * standing instead of emptying the admin's revenue — and it is reported, not
 * swallowed: every write here is checked, because a sync that says "ok" over an
 * empty ledger is worse than one that says why it stopped.
 */
export async function syncHstCommission(opts?: { force?: boolean }): Promise<HstSyncResult> {
  if (!opts?.force && Date.now() - lastRunAt < THROTTLE_MS) return { ok: true, skipped: true };

  const supabase = await createClient();

  // Cross-instance throttle. The per-isolate memo above is useless on a
  // serverless runtime, where a fresh isolate starts with lastRunAt = 0 and
  // would re-run the whole republish on essentially every page view.
  if (!opts?.force) {
    const { data: config } = await supabase
      .from("hst_integration")
      .select("last_synced_at")
      .maybeSingle();
    const last = config?.last_synced_at ? new Date(config.last_synced_at).getTime() : 0;
    if (last && Date.now() - last < THROTTLE_MS) {
      lastRunAt = Date.now();
      return { ok: true, skipped: true };
    }
  }

  // From here on the isolate has attempted a run: throttle failures too, so a
  // broken upstream can't mean an HST fetch on every single page load.
  lastRunAt = Date.now();

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
  let rowCount: number;
  let droppedRows: number;
  let shape: string;
  try {
    ({ entries, grandTotal, rowCount, droppedRows, shape } = await fetchHstCommissions(token));
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof HstError
          ? error.message
          : `HST fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Nothing usable came back — leave the ledger exactly as it is and say so,
  // with the response's shape so a parser mismatch is one glance away.
  if (entries.length === 0) {
    return {
      ok: false,
      error:
        (rowCount === 0
          ? "HST returned no commission rows — ledger left untouched."
          : `HST returned ${rowCount} row(s) but none had a usable date — ledger left untouched.`) +
        ` Response: ${shape}`,
      ignoredRows: droppedRows,
    };
  }

  // Attribute to a CRM client by name (exact, case-insensitive) when one exists.
  const { data: crmClients } = await supabase.from("clients").select("id, name");
  const clientIdByName = new Map(
    (crmClients ?? []).map((row) => [row.name.trim().toLowerCase(), row.id]),
  );

  // The set to retire, captured BEFORE anything new is written.
  const { data: previousRows, error: previousError } = await supabase
    .from("commissions")
    .select("id")
    .eq("source_id", source.id);
  if (previousError) {
    return { ok: false, error: `Couldn't read the HST ledger: ${previousError.message}` };
  }

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
    // The name from the HST shop string — the finance tables read it back from
    // here whenever there's no CRM client to link to.
    notes: `${HST_NOTE_PREFIX}${entry.client}`,
  }));

  const written: string[] = [];
  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    const { data, error } = await supabase
      .from("commissions")
      .insert(rows.slice(index, index + INSERT_CHUNK))
      .select("id");

    if (error) {
      // Undo this run's partial work; the previous ledger is still intact.
      await deleteRowsById(supabase, written);
      return { ok: false, error: `HST booking rejected: ${error.message}` };
    }
    written.push(...(data ?? []).map((row) => row.id));
  }

  // The new set is in — now, and only now, retire the old one.
  const retireError = await deleteRowsById(
    supabase,
    (previousRows ?? []).map((row) => row.id),
  );
  if (retireError) {
    return {
      ok: false,
      error: `Booked ${written.length} row(s) but couldn't clear the previous ones (${retireError.message}) — HST totals are doubled until the next sync.`,
      booked: written.length,
    };
  }

  const { error: stampError } = await supabase
    .from("hst_integration")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", true);
  if (stampError) console.error("HST sync: last_synced_at not updated:", stampError.message);

  return {
    ok: true,
    total: grandTotal,
    days: new Set(entries.map((entry) => entry.day)).size,
    booked: written.length,
    ignoredRows: droppedRows,
  };
}
