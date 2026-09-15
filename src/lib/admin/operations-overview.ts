import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { presetSelection } from "@/lib/portal/range";

import { countActiveClients } from "./active-clients";
import { fetchPendingCounts } from "./approvals";

/**
 * What the Overview shows the moment it opens: what the team has to decide,
 * and whether the machine behind the numbers is still running.
 *
 * This loader is deliberately the cheapest read in the admin. The Overview is
 * the first page of every session, often on a phone, so it asks nothing of
 * Windsor, Shopify or Google, parses no snapshot payload, and stays on small
 * indexed counts. Everything here is a count or a timestamp, so the whole
 * result serialises into a client component without a single money figure
 * travelling with it.
 *
 * Two clients, because the tables answer to two different keys. What the
 * sidebar badge already counts rides the caller's own session under the admin
 * RLS policies. Connections, bindings and snapshot health are revoked from
 * `authenticated` at the GRANT level, so those four are read with the service
 * key after the caller is confirmed to be an admin, exactly as every other
 * reader of those tables in the admin does it.
 */

/** A snapshot counts as fresh while its last success is inside this window. */
const FRESH_WINDOW_MS = 90 * 60 * 1000;

/** The family the Overview watches: the store view the team opens all day. */
const SNAPSHOT_FAMILY = "store_campaign_performance";

const CONNECTED = "connected";

type SessionClient = Awaited<ReturnType<typeof createClient>>;
type ServiceClient = NonNullable<ReturnType<typeof createServiceClient>>;

export type AdminOperationsNeedsDecision = {
  pendingClients: number;
  pendingAccounts: number;
  accountRequests: number;
  newCreatives: number;
  /**
   * Live connections that answered with an error the last time we asked, and
   * null when that one count could not be read.
   *
   * It is nullable on its own so a health count nobody could answer never
   * takes the waiting clients down with it: those come from the same call the
   * sidebar badge uses, and a screen saying "we know nothing" beside a badge
   * saying "six clients waiting" is worse than either failure alone.
   */
  failingConnections: number | null;
};

export type AdminOperationsReporting = {
  storesBound: number;
  storesReportingToday: number;
  storesSilentToday: number;
  lastMetricAt: string | null;
};

export type AdminOperationsSnapshots = {
  fresh: number;
  total: number;
  oldestSuccessAt: string | null;
};

/**
 * Each group is nullable on purpose, and the page is allowed to be partly
 * blind rather than blank.
 *
 * These four reads answer four unrelated questions, and one of them failing
 * says nothing about the other three. A single rejected promise would replace
 * the whole landing page with an error screen and hide, say, six clients
 * waiting for approval because a snapshot table was briefly unreadable. So a
 * group that cannot be read returns null, the page says that one panel is
 * unavailable, and the rest of the operations picture still arrives. Null here
 * means "we could not ask", which the screen must never draw as a zero: "no
 * store is silent" and "we do not know" are different facts.
 */
export type AdminOperations = {
  needsDecision: AdminOperationsNeedsDecision | null;
  reporting: AdminOperationsReporting | null;
  snapshots: AdminOperationsSnapshots | null;
  activeClients: number | null;
};

const BLIND: AdminOperations = {
  needsDecision: null,
  reporting: null,
  snapshots: null,
  activeClients: null,
};

export async function fetchAdminOperations(): Promise<AdminOperations> {
  const supabase = await createClient().catch((error: unknown) => {
    console.error("Admin operations: the session client is unavailable:", error);
    return null;
  });
  if (!supabase) return BLIND;

  const service = await adminService();

  // One clock for the whole snapshot, so two panels of the same screen cannot
  // disagree about what "now" was.
  const now = Date.now();

  const [needsDecision, reporting, snapshots, activeClients] = await Promise.all([
    group("what needs a decision", () => readNeedsDecision(service)),
    group("the reporting pulse", () => readReporting(supabase, service)),
    group("snapshot health", () => readSnapshots(service, now)),
    group("the active client count", () => countActiveClients(supabase)),
  ]);

  return { needsDecision, reporting, snapshots, activeClients };
}

/**
 * The service key, and only for a signed-in admin.
 *
 * Connections, bindings and snapshot health are revoked from `authenticated`
 * (0044, 0054, 0062), and a table GRANT is checked before RLS, so asking for
 * them with the caller's session does not return an empty list, it returns
 * permission denied. The admin check happens here rather than at the table so
 * the service key is never reached for anyone who is not staff, and a page
 * that cannot prove that simply goes blind on those panels.
 */
async function adminService(): Promise<ServiceClient | null> {
  try {
    const { profile } = await getSessionProfile();
    if (profile?.role !== "admin") return null;
    return createServiceClient();
  } catch (error) {
    console.error("Admin operations: the admin session could not be read:", error);
    return null;
  }
}

/** One console.error per failed group, and null for that group alone. */
async function group<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`Admin operations: ${what} could not be read:`, error);
    return null;
  }
}

async function readNeedsDecision(
  service: ServiceClient | null,
): Promise<AdminOperationsNeedsDecision> {
  const [pending, failingConnections] = await Promise.all([
    fetchPendingCounts(),
    group("the connection health count", () => readFailingConnections(service)),
  ]);

  return {
    pendingClients: pending.clients,
    pendingAccounts: pending.accounts,
    accountRequests: pending.requests,
    newCreatives: pending.creatives,
    failingConnections,
  };
}

/**
 * A connection that is still connected but carries an error code is the quiet
 * failure the team most needs to see: nobody revoked anything, the store simply
 * stopped answering, and the numbers go stale in silence.
 */
async function readFailingConnections(service: ServiceClient | null): Promise<number> {
  if (!service) throw new Error("The connection health count is unavailable.");

  const [shopify, google] = await Promise.all([
    service
      .from("client_shopify_connections")
      .select("id", { count: "exact", head: true })
      .eq("status", CONNECTED)
      .not("last_error_code", "is", null),
    service
      .from("client_google_ads_connections")
      .select("id", { count: "exact", head: true })
      .eq("status", CONNECTED)
      .not("last_error_code", "is", null),
  ]);
  if (shopify.error || google.error) {
    throw new Error("The connection health count is unavailable.");
  }

  return (shopify.count ?? 0) + (google.count ?? 0);
}

async function readReporting(
  supabase: SessionClient,
  service: ServiceClient | null,
): Promise<AdminOperationsReporting> {
  if (!service) throw new Error("The reporting pulse is unavailable.");

  const today = presetSelection("today").to;

  const [bindings, metrics] = await Promise.all([
    service
      .from("client_reporting_bindings")
      .select("ad_account_id, shopify_connection_id")
      .eq("status", "active"),
    supabase
      .from("daily_metrics")
      .select("ad_account_id, computed_at")
      .eq("day", today)
      .or("revenue.gt.0,ad_spend.gt.0"),
  ]);
  if (bindings.error || metrics.error) {
    throw new Error("The reporting pulse is unavailable.");
  }

  // A store is its Shopify anchor. The other accounts of the same store are
  // Google children, each with a binding and an ad account of its own pointing
  // back at that anchor (0054), so counting every active binding would count
  // one store as two and call the second half a store as well.
  const bound = new Set(
    (bindings.data ?? [])
      .filter((row) => row.shopify_connection_id !== null)
      .map((row) => row.ad_account_id),
  );

  let lastMetricAt: string | null = null;
  const wrote = new Set<string>();
  for (const row of metrics.data ?? []) {
    wrote.add(row.ad_account_id);
    lastMetricAt = newer(lastMetricAt, row.computed_at);
  }

  // Counted inside the bound set rather than as one total minus another. The
  // two reads cover different populations: legacy accounts write metrics today
  // with no binding at all, and subtracting the totals would let one of them
  // cancel out a bound store that really did go quiet, printing a confident
  // "0 silent" on the morning the panel exists to catch.
  let reportingToday = 0;
  for (const account of bound) if (wrote.has(account)) reportingToday += 1;

  return {
    storesBound: bound.size,
    storesReportingToday: reportingToday,
    storesSilentToday: bound.size - reportingToday,
    lastMetricAt,
  };
}

async function readSnapshots(
  service: ServiceClient | null,
  now: number,
): Promise<AdminOperationsSnapshots> {
  if (!service) throw new Error("The reporting snapshot health is unavailable.");

  const today = presetSelection("today").to;

  const { data, error } = await service
    .from("admin_reporting_range_snapshots")
    .select("last_success_at, last_error_code")
    .eq("family", SNAPSHOT_FAMILY)
    .eq("from_day", today)
    .eq("to_day", today);
  if (error || !Array.isArray(data)) {
    throw new Error("The reporting snapshot health is unavailable.");
  }

  let fresh = 0;
  let oldestSuccessAt: string | null = null;
  for (const row of data) {
    const successAt = parsed(row.last_success_at);
    if (successAt === null) continue;
    // Errored rows are never fresh even when they succeeded recently: the last
    // attempt failed, so what they hold is already behind the screen.
    if (row.last_error_code === null && now - successAt <= FRESH_WINDOW_MS) fresh += 1;
    oldestSuccessAt = older(oldestSuccessAt, row.last_success_at);
  }

  return { fresh, total: data.length, oldestSuccessAt };
}

/** Timestamps are compared as instants, never as text: Postgres hands back
 *  offsets as well as "Z", and those two spellings do not sort alike. */
function parsed(value: string | null): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function newer(current: string | null, candidate: string | null): string | null {
  const at = parsed(candidate);
  if (at === null) return current;
  const held = parsed(current);
  return held === null || at > held ? candidate : current;
}

function older(current: string | null, candidate: string | null): string | null {
  const at = parsed(candidate);
  if (at === null) return current;
  const held = parsed(current);
  return held === null || at < held ? candidate : current;
}
