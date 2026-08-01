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
import { HST_NOTE_PREFIX, noteClientName } from "@/lib/finance/config";
import { parseExpiry, tokenFault, tokenIsFresh } from "@/lib/admin/hst-token";
import { clientNameFromShop, normalizeDay } from "@/lib/admin/hst-parse";
import type { Database, HstPayment } from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

const COMMISSION_URL = "https://hsterp.com/commission-salesman-mingxi";
const REFRESH_URL = "https://hsterp.com/refresh-token";
const HST_SOURCE = "HST";
// HST commission currency. Change here if HST bills in another currency.
const HST_CURRENCY = "EUR";
const THROTTLE_MS = 60 * 60 * 1000;
const PAGE_LIMIT = 1000;
// A malformed response must not page forever. 50 × 1000 rows is far beyond
// anything HST has sent; hitting it is reported, never silently accepted.
const MAX_PAGES = 50;
/** Rows whose shop string carries no client name. Booked, but labelled. */
const UNNAMED_CLIENT = "Unattributed (no name in HST shop)";
// PostgREST takes one statement per request: a chunk that fails fails whole,
// and a delete filter travels in the URL, so ids go in smaller batches.
const INSERT_CHUNK = 500;
const DELETE_CHUNK = 200;

let lastRunAt = 0;

/**
 * How a sync gets at the database.
 *
 * A page load passes nothing and rides the admin's own session. The hourly cron
 * has no session at all, so it passes the service-role client — `commissions`,
 * `hst_integration` and `revenue_sources` are admin-only under RLS, and without
 * it every read would come back empty and the sync would "succeed" over nothing.
 */
export type HstSyncOpts = {
  /** Ignore both throttles — an explicit "do it now". */
  force?: boolean;
  client?: Supabase;
};

export class HstError extends Error {
  /**
   * HST refused the token (401/403).
   *
   * Separated from every other failure because it is the only one we can act
   * on: a refused token can be renewed and the request retried, whereas a 500
   * or a parser mismatch cannot. Before this flag existed, a refusal ended the
   * sync and the only way back was a human pasting a fresh login out of F12.
   */
  readonly unauthorized: boolean;

  constructor(message: string, unauthorized = false) {
    super(message);
    this.name = "HstError";
    this.unauthorized = unauthorized;
  }
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

/**
 * A valid access token, renewing from the refresh token when needed.
 *
 * "When needed" used to mean ONLY when `token_expires_at` said the token had
 * expired — and an expiry of 0 (the ERP's refresh response often carries no
 * `expires` field, so the column is stored null) was read as "never expires".
 * A token whose lifetime we could not see was therefore used forever, until
 * HST refused it and the sync simply failed. That is why the session had to be
 * re-pasted by hand: nothing ever tried to renew it.
 *
 * Now an unknown expiry means "assume it needs renewing". The cost is one
 * refresh call per sync in that case; the benefit is that the session keeps
 * itself alive. Renewal failure is NOT fatal — a stored token that still works
 * is better than a sync that refuses to run — except when `forceRenew` says
 * HST has already refused this token, where falling back would just repeat it.
 *
 * `forceRenew` is the 401 retry path: proof the current token is dead.
 */
async function ensureFreshToken(
  supabase: Supabase,
  opts?: { forceRenew?: boolean },
): Promise<string> {
  const forceRenew = opts?.forceRenew ?? false;

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
  // Only a KNOWN, future expiry counts as fresh — see hst-token.ts for why an
  // unknown one now falls through to renewal instead of being trusted forever.
  const fresh = tokenIsFresh(parseExpiry(data?.token_expires_at), Date.now());

  if (stored && !storedFault && fresh && !forceRenew) return stored;

  // Expired, unknown, unusable, or refused → renew from the refresh token.
  if (!data?.refresh_token) {
    // No renewal capability at all (a raw bearer token was pasted). Using it is
    // the only option left — unless HST has just refused it, in which case
    // there is genuinely nothing to do but ask for a fresh login.
    if (stored && !storedFault && !forceRenew) return stored;
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
    // The refresh endpoint is unreachable or shaped differently than expected.
    // If the stored token has not actually been refused, try it: renewal being
    // unavailable must not break setups that were working before this function
    // started attempting renewal on unknown expiries.
    if (stored && !storedFault && !forceRenew) return stored;
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
// Settlement — what HST has actually paid us
// ---------------------------------------------------------------------------

/**
 * The latest commission day covered by a payment, or null when nothing is
 * settled yet. Missing table (migration 0012 not run) reads as "nothing paid"
 * rather than taking the sync down.
 */
async function hstSettledThrough(supabase: Supabase): Promise<string | null> {
  const { data, error } = await supabase
    .from("hst_payments")
    .select("covers_through")
    .order("covers_through", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data?.covers_through ?? null;
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
    throw new HstError("HST rejected the token — the session likely expired.", true);
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
  /** How many rows HST said exist (`all.count`), or 0 when it didn't say. */
  expectedRows: number;
  droppedRows: number;
  /** Rows booked without a client name — the shop string had none. */
  unnamedRows: number;
  /** How many pages were actually read. */
  pages: number;
  /** MAX_PAGES was hit, so rows are certainly missing. */
  truncated: boolean;
  /** Key-only description of page 1, for when nothing parses out. */
  shape: string;
}> {
  const first = await fetchPage(token, 1);
  const rows = [...(first.data?.data ?? [])];

  /**
   * Keep paging while HST keeps filling pages.
   *
   * This used to trust `last_page` alone: `first.data?.last_page ?? 1`. When
   * that field is absent — or lives somewhere else in the payload, which is the
   * kind of thing an ERP changes without telling anyone — the fallback of 1
   * meant exactly one page was ever read. Everything past row 1000 was dropped
   * in silence, and since the grand total comes from the server's own `all`
   * block, the totals still looked right while whole clients were missing.
   *
   * So the stop condition is now evidence rather than metadata: a page that
   * comes back short is the last page. `last_page` is still honoured when it is
   * present and larger, and MAX_PAGES stops a malformed response from looping.
   */
  const lastPage = Number(first.data?.last_page ?? 0) || 0;
  // How many rows HST says exist in total. This is the reliable stop condition:
  // it does not care what page size the server actually used, which is the trap
  // the other two signals fall into. The ERP's own table paginates at 10 while
  // we ask for limit=1000 — so a "short" page proves nothing, and a `last_page`
  // that is absent used to end the read after a single page.
  const totalRows = Number(first.data?.all?.count ?? 0) || 0;

  let page = 1;
  let pageCount = rows.length;
  let truncated = false;

  for (;;) {
    const moreByCount = totalRows > 0 && rows.length < totalRows;
    const moreByMeta = page < lastPage;
    // Only trusted when HST has no better answer: a page filled exactly to the
    // limit we asked for suggests it was cut off there.
    const moreByFullPage = totalRows === 0 && lastPage === 0 && pageCount === PAGE_LIMIT;
    if (!moreByCount && !moreByMeta && !moreByFullPage) break;

    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }

    page += 1;
    const nextRows = (await fetchPage(token, page)).data?.data ?? [];
    rows.push(...nextRows);
    pageCount = nextRows.length;

    // An empty page means there is nothing further, whatever the metadata says.
    // Without this a wrong `count` would spin until MAX_PAGES.
    if (pageCount === 0) break;
  }

  // HST promised more rows than it delivered. Say so — this is the difference
  // between "that client has no commission" and "we failed to read it".
  if (totalRows > 0 && rows.length < totalRows) truncated = true;

  const grouped = new Map<string, HstEntry>();
  let droppedRows = 0;
  let unnamedRows = 0;
  for (const row of rows) {
    const day = row.express_date ? normalizeDay(row.express_date.toString()) : null;
    if (!day) {
      droppedRows += 1;
      continue;
    }

    // No usable name in the shop string. Counted and still booked — the money
    // is real even when the attribution isn't — but under a label that says so
    // rather than one that pretends to be a client.
    const parsed = clientNameFromShop(row.shopName?.toString());
    if (!parsed) unnamedRows += 1;
    const client = parsed ?? UNNAMED_CLIENT;

    const key = `${day}|${client}`;
    const entry = grouped.get(key) ?? { day, client, amount: 0 };
    entry.amount += Number(row.total ?? 0);
    grouped.set(key, entry);
  }

  return {
    entries: [...grouped.values()],
    grandTotal: Number(first.data?.all?.total ?? 0),
    rowCount: rows.length,
    expectedRows: totalRows,
    droppedRows,
    unnamedRows,
    pages: page,
    truncated,
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
  /** Rows booked with no client name in the HST shop string. */
  unnamedRows?: number;
  /** Pages read from HST, and whether the read came up short. */
  pages?: number;
  truncated?: boolean;
  /** Rows actually read vs. the count HST reported. Unequal = rows were lost. */
  rowsRead?: number;
  rowsExpected?: number;
  /** Distinct clients the sync attributed commission to. */
  clients?: number;
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
export async function syncHstCommission(opts?: HstSyncOpts): Promise<HstSyncResult> {
  if (!opts?.force && Date.now() - lastRunAt < THROTTLE_MS) return { ok: true, skipped: true };

  const supabase = opts?.client ?? (await createClient());

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

  const result = await runSync(supabase);
  await recordAttempt(supabase, result);
  return result;
}

/**
 * Write down that an attempt happened, and what came of it (migration 0017).
 *
 * The whole reason this exists: an expired ERP session made every sync fail
 * silently for weeks. The error was returned to the caller, and on a page load
 * the caller is nobody. An attempt that leaves no trace is indistinguishable
 * from a supplier who reported no commission.
 */
async function recordAttempt(supabase: Supabase, result: HstSyncResult): Promise<void> {
  if (result.skipped) return;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("hst_integration")
    .update({
      last_attempt_at: now,
      last_error: result.ok ? null : (result.error ?? "Unknown failure."),
      ...(result.ok ? { last_synced_at: now } : {}),
    })
    .eq("id", true);
  if (!error) return;

  // The health columns may not be there yet (0017 not applied). The success
  // stamp still has to land — it is what the cross-instance throttle reads, and
  // losing it would mean re-running the whole republish on every page view.
  if (result.ok) {
    const { error: stampError } = await supabase
      .from("hst_integration")
      .update({ last_synced_at: now })
      .eq("id", true);
    if (stampError) console.error("HST sync: last_synced_at not updated:", stampError.message);
    return;
  }
  console.error("HST sync: attempt not recorded:", error.message);
}

/** The sync itself. Every exit is a result the caller records — never a throw. */
async function runSync(supabase: Supabase): Promise<HstSyncResult> {
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
  let expectedRows: number;
  let droppedRows: number;
  let unnamedRows: number;
  let pages: number;
  let truncated: boolean;
  let shape: string;
  try {
    ({ entries, grandTotal, rowCount, expectedRows, droppedRows, unnamedRows, pages, truncated, shape } =
      await fetchHstCommissions(token));
  } catch (error) {
    // A refused token is the one failure worth a second attempt: renew and go
    // again. Everything else (a 500, HTML instead of JSON, a network fault)
    // would only fail the same way twice.
    //
    // Exactly one retry. If a freshly renewed token is also refused, the
    // refresh token itself is dead and no amount of retrying reaches HST —
    // that is the case that genuinely needs a human to paste a new login, and
    // the error below says so.
    if (!(error instanceof HstError) || !error.unauthorized) {
      return {
        ok: false,
        error:
          error instanceof HstError
            ? error.message
            : `HST fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      const renewedToken = await ensureFreshToken(supabase, { forceRenew: true });
      ({ entries, grandTotal, rowCount, expectedRows, droppedRows, unnamedRows, pages, truncated, shape } =
        await fetchHstCommissions(renewedToken));
    } catch (retryError) {
      return {
        ok: false,
        error:
          retryError instanceof HstError
            ? `${retryError.message} (renewal was attempted first)`
            : `HST fetch failed after renewing the token: ${
                retryError instanceof Error ? retryError.message : String(retryError)
              }`,
      };
    }
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

  // Settlement is re-derived, never carried: these rows are about to be
  // rewritten, so "paid" has to come from the payments table each time.
  const settledThrough = await hstSettledThrough(supabase);

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
    // Days HST has already settled show as paid everywhere the ledger is read.
    status:
      settledThrough && entry.day <= settledThrough ? ("paid" as const) : ("confirmed" as const),
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

  return {
    ok: true,
    total: grandTotal,
    days: new Set(entries.map((entry) => entry.day)).size,
    booked: written.length,
    ignoredRows: droppedRows,
    unnamedRows,
    pages,
    truncated,
    rowsRead: rowCount,
    rowsExpected: expectedRows,
    clients: new Set(entries.map((entry) => entry.client)).size,
  };
}

/**
 * Which clients HST already pays commission on.
 *
 * Two ways a booked HST row names its client, because the two systems disagree
 * about what a client is called:
 *
 *   crmIds  — rows whose `client_id` matched a CRM client by name at sync time.
 *             The reliable link: a portal login reaches it through crm_client_id.
 *   names   — the tag HST puts in the shop string ("…-Tomas"), lower-cased.
 *             Whatever the ERP calls them, which is often not their portal name.
 *
 * Both are returned rather than one merged answer: the caller matches on the
 * strong signal first and only falls back to the name, so a badge is never
 * shown on a guess.
 */
export async function fetchHstClientKeys(): Promise<{
  crmIds: Set<string>;
  names: Set<string>;
}> {
  const supabase = await createClient();

  const { data: source } = await supabase
    .from("revenue_sources")
    .select("id")
    .eq("name", HST_SOURCE)
    .maybeSingle();
  if (!source) return { crmIds: new Set(), names: new Set() };

  const { data: rows } = await supabase
    .from("commissions")
    .select("client_id, notes")
    .eq("source_id", source.id);

  const crmIds = new Set<string>();
  const names = new Set<string>();
  for (const row of rows ?? []) {
    if (row.client_id) crmIds.add(row.client_id);
    const name = noteClientName(row.notes);
    if (name) names.add(name.trim().toLowerCase());
  }
  return { crmIds, names };
}

// ---------------------------------------------------------------------------
// The HST page's read model
// ---------------------------------------------------------------------------

export type HstClientTotal = { name: string; amount: number; count: number; share: number };
export type HstDayTotal = { day: string; amount: number; clients: number };

export type HstOverview = {
  currency: string;
  /** Everything HST has reported, as booked in the ledger. */
  total: number;
  /** Sum of the payments we've received. */
  paid: number;
  /** total − paid: what HST still owes us. */
  outstanding: number;
  /** Latest commission day a payment covers — the settlement watermark. */
  settledThrough: string | null;
  clients: HstClientTotal[];
  days: HstDayTotal[];
  payments: HstPayment[];
  entryCount: number;
  firstDay: string | null;
  lastDay: string | null;
  lastSyncedAt: string | null;
  /**
   * Whole hours since the last successful sync, or null if there has never been
   * one. Derived here rather than in the view because the view is a client
   * component: `Date.now()` during render is impure, and a "is this stale"
   * answer that changes on every re-render is not one to build a warning on.
   */
  hoursSinceSync: number | null;
  /** When a sync was last ATTEMPTED, successful or not (migration 0017). */
  lastAttemptAt: string | null;
  /** Why the last attempt failed, or null when the last one worked. */
  lastError: string | null;
  /** migration 0012 hasn't been run — the page says so instead of half-working. */
  paymentsUnavailable: boolean;
};

/**
 * The config row's sync health, tolerating a database without migration 0017:
 * the health columns are read in the same round trip when they exist, and the
 * timestamp alone is re-read when they don't. Selecting them blindly would fail
 * the whole query and lose last_synced_at with it.
 */
async function fetchSyncHealth(supabase: Supabase): Promise<{
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
}> {
  const { data, error } = await supabase
    .from("hst_integration")
    .select("last_synced_at, last_attempt_at, last_error")
    .maybeSingle();

  if (!error) {
    return {
      lastSyncedAt: data?.last_synced_at ?? null,
      lastAttemptAt: data?.last_attempt_at ?? null,
      lastError: data?.last_error ?? null,
    };
  }

  const { data: fallback } = await supabase
    .from("hst_integration")
    .select("last_synced_at")
    .maybeSingle();
  return {
    lastSyncedAt: fallback?.last_synced_at ?? null,
    lastAttemptAt: null,
    lastError: null,
  };
}

/**
 * Everything the HST page shows, in one pass over the source's ledger rows.
 *
 * All-time on purpose: "what are they still to pay us" is meaningless inside a
 * 30-day window, and the ledger only ever holds what HST currently reports.
 */
export async function fetchHstOverview(): Promise<HstOverview> {
  const supabase = await createClient();

  const [{ data: source }, health, payments] = await Promise.all([
    supabase.from("revenue_sources").select("id").eq("name", HST_SOURCE).maybeSingle(),
    fetchSyncHealth(supabase),
    supabase.from("hst_payments").select("*").order("paid_on", { ascending: false }),
  ]);

  const { lastSyncedAt, lastAttemptAt, lastError } = health;
  const hoursSinceSync = lastSyncedAt
    ? Math.floor((Date.now() - new Date(lastSyncedAt).getTime()) / (60 * 60 * 1000))
    : null;

  const empty: HstOverview = {
    currency: HST_CURRENCY,
    total: 0,
    paid: 0,
    outstanding: 0,
    settledThrough: null,
    clients: [],
    days: [],
    payments: (payments.data ?? []) as HstPayment[],
    entryCount: 0,
    firstDay: null,
    lastDay: null,
    lastSyncedAt,
    hoursSinceSync,
    lastAttemptAt,
    lastError,
    paymentsUnavailable: Boolean(payments.error),
  };
  if (!source) return empty;

  const { data: rows } = await supabase
    .from("commissions")
    .select("occurred_on, amount, notes")
    .eq("source_id", source.id)
    .order("occurred_on", { ascending: false });
  if (!rows || rows.length === 0) return empty;

  const byClient = new Map<string, { amount: number; count: number }>();
  const byDay = new Map<string, { amount: number; clients: Set<string> }>();
  let total = 0;

  for (const row of rows) {
    const amount = Number(row.amount);
    const client = noteClientName(row.notes) ?? "Unknown";
    total += amount;

    const clientBucket = byClient.get(client) ?? { amount: 0, count: 0 };
    clientBucket.amount += amount;
    clientBucket.count += 1;
    byClient.set(client, clientBucket);

    const dayBucket = byDay.get(row.occurred_on) ?? { amount: 0, clients: new Set<string>() };
    dayBucket.amount += amount;
    dayBucket.clients.add(client);
    byDay.set(row.occurred_on, dayBucket);
  }

  const paidRows = (payments.data ?? []) as HstPayment[];
  const paid = paidRows.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const days = [...byDay.entries()]
    .map(([day, bucket]) => ({ day, amount: bucket.amount, clients: bucket.clients.size }))
    .sort((a, b) => b.day.localeCompare(a.day));

  return {
    currency: HST_CURRENCY,
    total,
    paid,
    outstanding: total - paid,
    settledThrough: paidRows.reduce<string | null>(
      (max, payment) => (max === null || payment.covers_through > max ? payment.covers_through : max),
      null,
    ),
    clients: [...byClient.entries()]
      .map(([name, bucket]) => ({
        name,
        amount: bucket.amount,
        count: bucket.count,
        share: total > 0 ? bucket.amount / total : 0,
      }))
      .sort((a, b) => b.amount - a.amount),
    days,
    payments: paidRows,
    entryCount: rows.length,
    firstDay: days.length > 0 ? days[days.length - 1].day : null,
    lastDay: days.length > 0 ? days[0].day : null,
    lastSyncedAt,
    hoursSinceSync,
    lastAttemptAt,
    lastError,
    paymentsUnavailable: Boolean(payments.error),
  };
}
