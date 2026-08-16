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
};

export type AdminReportingRefreshResult =
  | {
      state: "refreshed";
      snapshotState: AdminReportingFamilyResult<unknown>["state"];
      refreshedAt: string;
    }
  | { state: "busy" }
  | { state: "failed"; errorCode: "provider_failed" | "topology_changed" | "snapshot_failed" };

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

/**
 * Claims, loads and atomically replaces one exact provider family. A failed
 * provider attempt records its error code but leaves the prior success intact.
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
      (["empty", "unavailable"].includes(result.state) && result.rows.length > 0)
    ) {
      throw new Error("The reporting provider returned an invalid snapshot family.");
    }
    const currentAuthority = await input.verifyAuthority();
    if (currentAuthority.key !== input.authority.key) {
      failure = { state: "failed", errorCode: "topology_changed" };
      throw new Error("Reporting authority changed during the refresh.");
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
        p_message: result.message?.trim() || null,
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
  } catch {
    await input.client.rpc("fail_admin_reporting_snapshot_refresh", {
      p_family: input.family,
      p_scope_account_id: input.accountId,
      p_from_day: input.from,
      p_to_day: input.to,
      p_authority_key: input.authority.key,
      p_lease_token: leaseToken,
      p_error_code: failure.errorCode,
    });
    return failure;
  }
}
