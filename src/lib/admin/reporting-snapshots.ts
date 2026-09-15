import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AdminReportingRangeSnapshot,
  AdminReportingSnapshotFamily,
  Database,
  Json,
} from "@/lib/supabase/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const LISBON_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const ADMIN_REPORTING_CURRENT_RANGE_TTL_MS = 90 * 60 * 1_000;
/**
 * How long a ready snapshot outranks a degraded reload. A partial family means
 * a provider failed mid-way (a Shopify throttle, a timeout, an uninstalled
 * app); the Google-only sheet it produces is worse than the complete one the
 * row already holds, so for a day the row keeps the complete one and records
 * the failure instead. Past a day the old sheet is stale enough that partial
 * data is the better offer.
 */
export const ADMIN_REPORTING_KEEP_LAST_GOOD_MS = 24 * 60 * 60 * 1_000;
/** The stored message column allows 1..1000 characters; longer text is fenced. */
const SNAPSHOT_MESSAGE_LIMIT = 1_000;
const ERROR_CODE = /^[a-z0-9_]{1,80}$/;
/**
 * The families whose snapshot is a campaign sheet with a spend total, the
 * only figure the today guard below can compare between two reads.
 */
const TODAY_GUARDED_FAMILIES = new Set<AdminReportingSnapshotFamily>([
  "google_campaigns",
  "store_campaign_performance",
]);

type Supabase = SupabaseClient<Database>;

export type AdminReportingAuthority = {
  key: string;
  manifest: Record<string, Json>;
};

export type AdminReportingSnapshotValue<T> =
  | {
      state: "not_synced";
      rows: [];
      message: string;
      refreshedAt: null;
      lastAttemptAt: string | null;
      lastErrorCode: string | null;
      revision: 0;
    }
  | {
      state: "ready" | "partial" | "empty" | "unavailable";
      rows: T[];
      message: string | null;
      refreshedAt: string;
      lastAttemptAt: string;
      lastErrorCode: string | null;
      revision: number;
    };

export type AdminReportingSnapshotSelection<T> = {
  snapshot: AdminReportingSnapshotValue<T>;
  sourceFrom: string;
  sourceTo: string;
  availableFrom: string;
  availableTo: string;
  exact: boolean;
};

export type AdminReportingFamilyResult<T> = {
  state: "ready" | "partial" | "empty" | "unavailable";
  rows: T[];
  message?: string | null;
  /**
   * Set when a partial result is the product of a provider failure rather
   * than of the data itself. The code is what the row records when a recent
   * ready snapshot is kept in preference to this result.
   */
  degraded?: { code: string };
};

export type AdminReportingRefreshResult =
  | {
      state: "refreshed";
      snapshotState: AdminReportingFamilyResult<unknown>["state"];
      refreshedAt: string;
      /**
       * True when today's ready sheet was kept over a reload that is behind
       * it: the row was completed again with the sheet it already held, so
       * it reads as refreshed and records nothing to alert on.
       */
      kept?: true;
    }
  | { state: "busy" }
  | {
      state: "failed";
      /**
       * provider_failed, topology_changed or snapshot_failed from this module;
       * otherwise the family's own degraded code (provider_partial) when a
       * recent ready snapshot was kept instead of the degraded reload.
       */
      errorCode: string;
    };

function validDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function lisbonDay(timestamp: number): string {
  const parts = new Map(
    LISBON_DAY.formatToParts(timestamp).map((part) => [part.type, part.value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

/** Historical snapshots are immutable; only a range ending today ages out. */
export function adminReportingSnapshotIsStale(input: {
  to: string;
  refreshedAt: string | null;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  if (input.to !== lisbonDay(now)) return false;
  const refreshedAt = input.refreshedAt ? Date.parse(input.refreshedAt) : Number.NaN;
  return (
    !Number.isFinite(refreshedAt) ||
    now - refreshedAt > ADMIN_REPORTING_CURRENT_RANGE_TTL_MS
  );
}

function assertScope(accountId: string, from: string, to: string): void {
  if (!UUID.test(accountId) || !validDay(from) || !validDay(to) || from > to) {
    throw new Error("The reporting snapshot scope is invalid.");
  }
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

/** A secret-free, deterministic fingerprint of the exact reporting authority. */
export async function adminReportingAuthority(
  manifest: Record<string, Json>,
): Promise<AdminReportingAuthority> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(manifest)),
  );
  return {
    key: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    manifest,
  };
}

function notSynced<T>(
  row?: Pick<AdminReportingRangeSnapshot, "last_attempt_at" | "last_error_code">,
): AdminReportingSnapshotValue<T> {
  return {
    state: "not_synced",
    rows: [],
    message: "This exact reporting period has not been synced yet.",
    refreshedAt: null,
    lastAttemptAt: row?.last_attempt_at ?? null,
    lastErrorCode: row?.last_error_code ?? null,
    revision: 0,
  };
}

function snapshotValue<T>(row: AdminReportingRangeSnapshot): AdminReportingSnapshotValue<T> {
  if (
    row.state === null ||
    row.payload === null ||
    !Array.isArray(row.payload) ||
    row.last_success_at === null ||
    row.revision < 1
  ) {
    return notSynced(row);
  }
  return {
    state: row.state,
    rows: row.payload as T[],
    message: row.message,
    refreshedAt: row.last_success_at,
    lastAttemptAt: row.last_attempt_at,
    lastErrorCode: row.last_error_code,
    revision: row.revision,
  };
}

/** One Supabase round trip for the same family/range across many accounts. */
export async function readAdminReportingSnapshots<T>(input: {
  client: Supabase;
  family: AdminReportingSnapshotFamily;
  scopes: Array<{ accountId: string; authorityKey: string }>;
  from: string;
  to: string;
}): Promise<Map<string, AdminReportingSnapshotValue<T>>> {
  const unique = new Map(input.scopes.map((scope) => [scope.accountId, scope]));
  for (const scope of unique.values()) {
    assertScope(scope.accountId, input.from, input.to);
    if (!/^[0-9a-f]{64}$/.test(scope.authorityKey)) {
      throw new Error("The reporting snapshot authority is invalid.");
    }
  }
  if (unique.size === 0) return new Map();

  const { data, error } = await input.client
    .from("admin_reporting_range_snapshots")
    .select("*")
    .eq("family", input.family)
    .eq("from_day", input.from)
    .eq("to_day", input.to)
    .in("scope_account_id", [...unique.keys()]);
  if (error || !Array.isArray(data)) {
    throw new Error("The reporting snapshots could not be read.");
  }

  const byAccount = new Map(
    (data as AdminReportingRangeSnapshot[]).map((row) => [row.scope_account_id, row]),
  );
  return new Map(
    [...unique.values()].map((scope) => {
      const row = byAccount.get(scope.accountId);
      return [
        scope.accountId,
        row && row.authority_key === scope.authorityKey
          ? snapshotValue<T>(row)
          : notSynced<T>(),
      ];
    }),
  );
}

export async function readAdminReportingSnapshot<T>(input: {
  client: Supabase;
  family: AdminReportingSnapshotFamily;
  accountId: string;
  authorityKey: string;
  from: string;
  to: string;
}): Promise<AdminReportingSnapshotValue<T>> {
  const snapshots = await readAdminReportingSnapshots<T>({
    ...input,
    scopes: [{ accountId: input.accountId, authorityKey: input.authorityKey }],
  });
  return snapshots.get(input.accountId) ?? notSynced<T>();
}

/** One account and exact range, with every requested family in one DB read. */
export async function readAdminReportingSnapshotFamilies(input: {
  client: Supabase;
  families: AdminReportingSnapshotFamily[];
  accountId: string;
  authorityKey: string;
  from: string;
  to: string;
}): Promise<Map<AdminReportingSnapshotFamily, AdminReportingSnapshotValue<unknown>>> {
  assertScope(input.accountId, input.from, input.to);
  if (!/^[0-9a-f]{64}$/.test(input.authorityKey)) {
    throw new Error("The reporting snapshot authority is invalid.");
  }
  const families = [...new Set(input.families)];
  if (families.length === 0) return new Map();
  const { data, error } = await input.client
    .from("admin_reporting_range_snapshots")
    .select("*")
    .eq("scope_account_id", input.accountId)
    .eq("from_day", input.from)
    .eq("to_day", input.to)
    .in("family", families);
  if (error || !Array.isArray(data)) {
    throw new Error("The reporting snapshots could not be read.");
  }
  const byFamily = new Map(
    (data as AdminReportingRangeSnapshot[]).map((row) => [row.family, row]),
  );
  return new Map(
    families.map((family) => {
      const row = byFamily.get(family);
      return [
        family,
        row && row.authority_key === input.authorityKey
          ? snapshotValue<unknown>(row)
          : notSynced<unknown>(),
      ];
    }),
  );
}

function dayNumber(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

/**
 * Exact range first; when absent, select the overlapping materialized snapshot
 * with the largest usable day window. The caller owns slicing its typed payload.
 */
export async function readAdminReportingSnapshotFamilySelections(input: {
  client: Supabase;
  families: AdminReportingSnapshotFamily[];
  accountId: string;
  authorityKey: string;
  from: string;
  to: string;
}): Promise<Map<AdminReportingSnapshotFamily, AdminReportingSnapshotSelection<unknown>>> {
  const exact = await readAdminReportingSnapshotFamilies(input);
  const families = [...new Set(input.families)];
  const missing = families.filter((family) => exact.get(family)?.state === "not_synced");
  let candidates: AdminReportingRangeSnapshot[] = [];
  if (missing.length > 0) {
    const { data, error } = await input.client
      .from("admin_reporting_range_snapshots")
      .select("*")
      .eq("scope_account_id", input.accountId)
      .eq("authority_key", input.authorityKey)
      .lte("from_day", input.to)
      .gte("to_day", input.from)
      .in("family", missing);
    if (error || !Array.isArray(data)) {
      throw new Error("The reporting snapshot fallback could not be read.");
    }
    candidates = data as AdminReportingRangeSnapshot[];
  }

  return new Map<AdminReportingSnapshotFamily, AdminReportingSnapshotSelection<unknown>>(
    families.map((family): [AdminReportingSnapshotFamily, AdminReportingSnapshotSelection<unknown>] => {
    const exactSnapshot = exact.get(family) ?? notSynced<unknown>();
    if (exactSnapshot.state !== "not_synced") {
      return [family, {
        snapshot: exactSnapshot,
        sourceFrom: input.from,
        sourceTo: input.to,
        availableFrom: input.from,
        availableTo: input.to,
        exact: true,
      }];
    }
    const row = candidates
      .filter((candidate) => {
        const value = snapshotValue<unknown>(candidate);
        return candidate.family === family &&
          (value.state === "ready" || value.state === "partial") &&
          value.rows.length > 0;
      })
      .sort((left, right) => {
        const leftOverlap = dayNumber(
          left.to_day < input.to ? left.to_day : input.to,
        ) - dayNumber(left.from_day > input.from ? left.from_day : input.from);
        const rightOverlap = dayNumber(
          right.to_day < input.to ? right.to_day : input.to,
        ) - dayNumber(right.from_day > input.from ? right.from_day : input.from);
        const overlapOrder = rightOverlap - leftOverlap;
        if (overlapOrder !== 0) return overlapOrder;
        const spanOrder = (dayNumber(left.to_day) - dayNumber(left.from_day)) -
          (dayNumber(right.to_day) - dayNumber(right.from_day));
        if (spanOrder !== 0) return spanOrder;
        return (right.last_success_at ?? "").localeCompare(left.last_success_at ?? "");
      })[0];
    if (!row) {
      return [family, {
        snapshot: exactSnapshot,
        sourceFrom: input.from,
        sourceTo: input.to,
        availableFrom: input.from,
        availableTo: input.to,
        exact: true,
      }];
    }
    return [family, {
      snapshot: snapshotValue<unknown>(row),
      sourceFrom: row.from_day,
      sourceTo: row.to_day,
      availableFrom: row.from_day > input.from ? row.from_day : input.from,
      availableTo: row.to_day < input.to ? row.to_day : input.to,
      exact: false,
    }];
    }),
  );
}

type StoredSnapshotRow = Pick<AdminReportingRangeSnapshot, "state" | "last_success_at"> &
  Partial<Pick<AdminReportingRangeSnapshot, "payload" | "message" | "last_error_code">>;

/**
 * The row this refresh would replace, under the same authority. The claim
 * above already blanked the row when the authority changed, so a ready state
 * here belongs to the same topology. A read that fails is no evidence of a
 * good snapshot: the caller then completes as it always did, because
 * Google-only data still beats nothing. The payload, message and failure
 * code ride along only for the today guard, which compares the sheet and
 * may complete it again; the keep-last-good rule reads two columns as it
 * always did.
 */
async function storedSnapshot(input: {
  client: Supabase;
  family: AdminReportingSnapshotFamily;
  accountId: string;
  from: string;
  to: string;
  authorityKey: string;
  withPayload: boolean;
}): Promise<StoredSnapshotRow | null> {
  const { data, error } = await input.client
    .from("admin_reporting_range_snapshots")
    .select(
      input.withPayload
        ? "state, last_success_at, payload, message, last_error_code"
        : "state, last_success_at",
    )
    .eq("family", input.family)
    .eq("scope_account_id", input.accountId)
    .eq("from_day", input.from)
    .eq("to_day", input.to)
    .eq("authority_key", input.authorityKey)
    .maybeSingle();
  if (error || !data) return null;
  // The column list is chosen at runtime, which the client's select parser
  // cannot type; the row is exactly the columns asked for above.
  return data as unknown as StoredSnapshotRow;
}

/**
 * Whether the row still holds a ready snapshot recent enough to outrank a
 * degraded reload.
 */
function recentReady(row: StoredSnapshotRow, now: number): boolean {
  const succeededAt = row.last_success_at ? Date.parse(row.last_success_at) : Number.NaN;
  return (
    row.state === "ready" &&
    Number.isFinite(succeededAt) &&
    now - succeededAt <= ADMIN_REPORTING_KEEP_LAST_GOOD_MS
  );
}

type SheetTotals = { spend: number; clicks: number; conversions: number };

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * What a campaign sheet totals, in the shape each guarded family stores:
 * google_campaigns is one campaign per payload entry, store_campaign_performance
 * one sheet whose rows are the campaigns. An empty payload is a sheet with no
 * campaigns, so it totals zero. Null when the payload is not that shape or a
 * spend is not a number, so a malformed row never decides what is kept; a
 * click or conversion count the sheet does not carry counts as zero, because
 * the two counts only break a tie on spend. Spend is rounded to the
 * six-decimal money contract: the same campaigns summed in another order must
 * not read as a regression.
 */
function snapshotTotals(
  family: AdminReportingSnapshotFamily,
  payload: unknown,
): SheetTotals | null {
  if (!Array.isArray(payload)) return null;
  if (payload.length === 0) return { spend: 0, clicks: 0, conversions: 0 };
  const rows =
    family === "google_campaigns"
      ? payload
      : (payload[0] as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return null;
  const totals: SheetTotals = { spend: 0, clicks: 0, conversions: 0 };
  for (const row of rows) {
    const fields = row as { spend?: unknown; clicks?: unknown; conversions?: unknown } | null;
    if (typeof fields?.spend !== "number" || !Number.isFinite(fields.spend)) return null;
    totals.spend += fields.spend;
    totals.clicks += count(fields.clicks);
    totals.conversions += count(fields.conversions);
  }
  totals.spend = Math.round(totals.spend * 1e6) / 1e6;
  return totals;
}

/**
 * Whether a reload is behind the sheet the row holds: less spend, or the same
 * spend with fewer clicks or conversions. Spend plateaus once a day's budget
 * is spent while Google keeps attributing conversions hours after their
 * clicks, so two replicas answer the same spend from different ingestion
 * points and only the counts tell the older one apart.
 */
function sheetRegressed(reload: SheetTotals, stored: SheetTotals): boolean {
  if (reload.spend !== stored.spend) return reload.spend < stored.spend;
  return reload.clicks < stored.clicks || reload.conversions < stored.conversions;
}

/**
 * Claims, loads and atomically replaces one exact provider family. A failed
 * provider attempt records its error code but leaves the prior success intact.
 * So does a degraded partial reload while the row holds a ready snapshot from
 * the last day: the failure is recorded, the good sheet stays. A reload of
 * today's campaign sheet that is behind the ready one the row holds is not
 * written either, but that is no failure: the row is completed again with the
 * sheet it holds (the today guard, explained where it runs).
 */
export async function refreshAdminReportingSnapshot<T>(input: {
  client: Supabase;
  family: AdminReportingSnapshotFamily;
  accountId: string;
  from: string;
  to: string;
  authority: AdminReportingAuthority;
  verifyAuthority: () => Promise<AdminReportingAuthority>;
  load: () => Promise<AdminReportingFamilyResult<T>>;
}): Promise<AdminReportingRefreshResult> {
  assertScope(input.accountId, input.from, input.to);
  const claimArgs = {
    p_family: input.family,
    p_scope_account_id: input.accountId,
    p_from_day: input.from,
    p_to_day: input.to,
    p_authority_key: input.authority.key,
    p_authority_manifest: input.authority.manifest,
    p_lease_seconds: 300,
  } as const;
  const { data: leaseToken, error: claimError } = await input.client.rpc(
    "claim_admin_reporting_snapshot_refresh",
    claimArgs,
  );
  if (claimError) throw new Error("The reporting snapshot could not be claimed.");
  if (!leaseToken) return { state: "busy" };

  let failure: AdminReportingRefreshResult & { state: "failed" } = {
    state: "failed",
    errorCode: "provider_failed",
  };
  try {
    const result = await input.load();
    if (
      !["ready", "partial", "empty", "unavailable"].includes(result.state) ||
      !Array.isArray(result.rows) ||
      (result.state === "ready" && result.rows.length === 0) ||
      (["empty", "unavailable"].includes(result.state) && result.rows.length > 0) ||
      (result.degraded !== undefined && !ERROR_CODE.test(result.degraded.code))
    ) {
      throw new Error("The reporting provider returned an invalid snapshot family.");
    }
    const currentAuthority = await input.verifyAuthority();
    if (currentAuthority.key !== input.authority.key) {
      failure = { state: "failed", errorCode: "topology_changed" };
      throw new Error("Reporting authority changed during the refresh.");
    }
    const message = result.message?.trim().slice(0, SNAPSHOT_MESSAGE_LIMIT) || null;
    const now = Date.now();
    // The today guard: a single-day range on the current Lisbon day is the
    // day in progress, and Windsor answers that day from replicas at
    // different ingestion points, so two reads seconds apart disagree
    // (measured 2026-09-15: 118.99 at 10:04:30, nothing at 10:05:30, 118.99
    // again from 10:06:43; the cron leg in between rewrote the sheet with a
    // total of 0.00). Truth for that day only grows and neither Windsor
    // table overshoots, so the larger total is at least as true, and on
    // equal spend the sheet with more clicks or conversions is the later
    // state (sheetRegressed). Only the two campaign families carry those
    // totals to compare, and only an answer that measures spend enters: an
    // unavailable reload says the connection is gone, which no kept sheet
    // should hide.
    const guardsToday =
      input.from === input.to &&
      input.to === lisbonDay(now) &&
      TODAY_GUARDED_FAMILIES.has(input.family) &&
      result.state !== "unavailable";
    const stored =
      (result.state === "partial" && result.degraded !== undefined) || guardsToday
        ? await storedSnapshot({
            client: input.client,
            family: input.family,
            accountId: input.accountId,
            from: input.from,
            to: input.to,
            authorityKey: input.authority.key,
            withPayload: guardsToday,
          })
        : null;
    if (result.state === "partial" && result.degraded && stored && recentReady(stored, now)) {
      // Completing here would replace a complete sheet with a dashed one
      // until the next successful leg. Recording the failure instead keeps
      // the ready payload and makes the row read "Last failure: ..." (0073).
      console.warn(
        `Reporting snapshot kept last good: ${input.family} ${input.accountId} ` +
          `${input.from}..${input.to} (${result.degraded.code}): ${message ?? "no message"}`,
      );
      await input.client.rpc("fail_admin_reporting_snapshot_refresh", {
        p_family: input.family,
        p_scope_account_id: input.accountId,
        p_from_day: input.from,
        p_to_day: input.to,
        p_authority_key: input.authority.key,
        p_lease_token: leaseToken,
        p_error_code: result.degraded.code,
        p_error_message: message?.slice(0, 500) ?? null,
      });
      return { state: "failed", errorCode: result.degraded.code };
    }
    if (guardsToday && stored?.state === "ready") {
      const storedTotals = snapshotTotals(input.family, stored.payload);
      const reloadTotals = snapshotTotals(input.family, result.rows);
      if (storedTotals && reloadTotals && sheetRegressed(reloadTotals, storedTotals)) {
        // Completing the reload would print a smaller day over a larger one
        // until the next leg happened to hit a fresher replica. The stored
        // sheet is completed again instead, under this lease: the row keeps
        // its payload, reads as succeeded now and records no failure. Nothing
        // failed here (the provider answered, from behind), and recording
        // one, as the keep-last-good rule above does for a degraded reload,
        // made a routine kept sheet read as a degraded account everywhere a
        // failure is read: the campaigns page marked the account partial,
        // the analytics page dropped it from the stores running activity,
        // the hourly leg answered 502 and the freshness gate re-read the
        // store on every run. The message travels with the sheet unless it
        // is a recorded failure's text, which this completion supersedes the
        // way any completion does.
        console.warn(
          `Reporting snapshot kept today: ${input.family} ${input.accountId} ` +
            `${input.from}..${input.to}: the stored sheet totals ` +
            `${storedTotals.spend.toFixed(2)} spend and the reload ${reloadTotals.spend.toFixed(2)}.`,
        );
        const { data: kept, error: keptError } = await input.client.rpc(
          "complete_admin_reporting_snapshot_refresh",
          {
            p_family: input.family,
            p_scope_account_id: input.accountId,
            p_from_day: input.from,
            p_to_day: input.to,
            p_authority_key: input.authority.key,
            p_lease_token: leaseToken,
            p_state: "ready",
            p_payload: stored.payload as Json,
            p_message: stored.last_error_code ? null : (stored.message ?? null),
          },
        );
        if (keptError || kept !== true) {
          failure = { state: "failed", errorCode: "snapshot_failed" };
          throw new Error("The reporting snapshot completion was fenced.");
        }
        return {
          state: "refreshed",
          snapshotState: "ready",
          refreshedAt: new Date().toISOString(),
          kept: true,
        };
      }
    }
    const payload = JSON.parse(JSON.stringify(result.rows)) as Json;
    const { data: completed, error: completionError } = await input.client.rpc(
      "complete_admin_reporting_snapshot_refresh",
      {
        p_family: input.family,
        p_scope_account_id: input.accountId,
        p_from_day: input.from,
        p_to_day: input.to,
        p_authority_key: input.authority.key,
        p_lease_token: leaseToken,
        p_state: result.state,
        p_payload: payload,
        p_message: message,
      },
    );
    if (completionError || completed !== true) {
      failure = { state: "failed", errorCode: "snapshot_failed" };
      throw new Error("The reporting snapshot completion was fenced.");
    }
    return {
      state: "refreshed",
      snapshotState: result.state,
      refreshedAt: new Date().toISOString(),
    };
  } catch (error) {
    // The stored row only keeps an error code; without this line the actual
    // provider failure is unobservable anywhere (no logs, no message, no
    // trace) and every diagnosis starts from zero.
    console.error(
      `Reporting snapshot refresh failed: ${input.family} ${input.accountId} ` +
        `${input.from}..${input.to} (${failure.errorCode})`,
      error,
    );
    await input.client.rpc("fail_admin_reporting_snapshot_refresh", {
      p_family: input.family,
      p_scope_account_id: input.accountId,
      p_from_day: input.from,
      p_to_day: input.to,
      p_authority_key: input.authority.key,
      p_lease_token: leaseToken,
      p_error_code: failure.errorCode,
      p_error_message:
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    });
    return failure;
  }
}
