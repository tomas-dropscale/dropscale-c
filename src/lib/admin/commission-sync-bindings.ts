import type { SupabaseClient } from "@supabase/supabase-js";

import { storeDomainsForSource } from "../reporting/store-domain-match";
import {
  storeBindingsForLedger,
  type ReportingBindingDomainRow,
} from "./commission-sync-logic";
import type { Database } from "../supabase/types";

type Supa = SupabaseClient<Database>;

/**
 * Read every row a filtered query matches, one page at a time.
 *
 * PostgREST caps a response at db-max-rows - 1000 on hosted Supabase - and
 * reports it only in a Content-Range header: a query that matches more gets the
 * first page, no error, and no promise about WHICH rows those are. Until
 * retirement made revoked bindings meaningful, the reads below were bounded by
 * a partial unique index to one row per account. They now scale with lifetime
 * history, which never shrinks: binding rows are refused deletion and anchor
 * events are append-only. A silent cap here does not merely lose a row - it
 * drops an account's live binding, and an account whose store cannot be
 * resolved is read WHOLE, billing one client for another store's campaigns.
 */
async function readEveryRow<T extends { id: string }>(
  page: (
    afterId: string | null,
    pageSize: number,
  ) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const pageSize = 1_000;
  const rows: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await page(afterId, pageSize);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    const last = batch.at(-1);
    if (!last) break;
    afterId = last.id;
  }
  return rows;
}

/**
 * Of these revoked bindings, the ones a sanctioned lifecycle RPC took out of
 * service: a store retirement (0097) and a Google source retirement (0100) name
 * the binding itself, a store handover (0095/0096) names the one it superseded,
 * and abandoning a staged source (0056) names it too - that one also leaves a
 * metered account with a closed meter and no successor. An ordinary unbind
 * writes no event at all, which is exactly the line this draws. Asked only for
 * accounts with no live binding left, so an ordinary client costs no query.
 */
async function retirementEvidencedBindingIds(
  supabase: Supa,
  rows: readonly ReportingBindingDomainRow[],
): Promise<Set<string>> {
  const liveAccountIds = new Set(
    rows
      .filter((row) => row.status === "active" || row.status === "staged")
      .map((row) => row.ad_account_id),
  );
  const candidateIds = rows
    .filter(
      (row) =>
        row.status === "revoked" &&
        !liveAccountIds.has(row.ad_account_id) &&
        (row.shopify_connection_id !== null || row.shopify_anchor_binding_id !== null),
    )
    .map((row) => row.id);
  return evidencedRetiredBindingIds(supabase, candidateIds);
}

/**
 * Of these revoked bindings, the ones a sanctioned lifecycle RPC named in the
 * append-only anchor events.
 *
 * Exported because more than one reader has to tell a retirement from an
 * ordinary unbind, and they disagree about which bindings are even candidates:
 * the ledger asks about bindings that named a STORE, the billing positions
 * about bindings that carried a GOOGLE source. The evidence itself is the same
 * either way, so it is read in one place.
 */
export async function evidencedRetiredBindingIds(
  supabase: Supa,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();

  const [retiredRows, handedOverRows] = await Promise.all([
    readEveryRow<{ id: string; binding_id: string }>((afterId, pageSize) => {
      let query = supabase
        .from("client_reporting_anchor_events")
        .select("id, binding_id")
        .in("event_type", ["store_retired", "source_retired", "source_abandoned"])
        .in("binding_id", candidateIds)
        .order("id", { ascending: true })
        .limit(pageSize);
      if (afterId) query = query.gt("id", afterId);
      return query;
    }),
    readEveryRow<{ id: string; prior_binding_id: string | null }>((afterId, pageSize) => {
      let query = supabase
        .from("client_reporting_anchor_events")
        .select("id, prior_binding_id")
        .eq("event_type", "handed_over")
        .in("prior_binding_id", candidateIds)
        .order("id", { ascending: true })
        .limit(pageSize);
      if (afterId) query = query.gt("id", afterId);
      return query;
    }),
  ]);
  return new Set([
    ...retiredRows.map((row) => row.binding_id),
    ...handedOverRows.flatMap((row) => (row.prior_binding_id ? [row.prior_binding_id] : [])),
  ]);
}

/**
 * Each billable account's store domains, and the accounts that have lost the
 * store they had.
 *
 * Exported so it can be driven directly: this is where the ledger decides WHOSE
 * spend a shared Google account carries, and a wrong answer here bills one
 * client for another store's campaigns. The pure rules live in
 * storeBindingsForLedger; what lives here is the part only a real query shape
 * can get wrong - which binding statuses are read, which anchor events count as
 * evidence and under which column, and that neither read can be silently capped.
 */
export async function ledgerStoreDomainsByAccount(
  supabase: Supa,
  billableAccountIds: string[],
): Promise<{
  storeDomainsByAccount: Map<string, string[]>;
  retiredBoundAccountIds: Set<string>;
}> {
  // Owner rule (2026-08-18): a shared Google account can host another
  // store's campaigns, so Windsor ledger evidence only counts campaigns
  // whose final URLs point at this store's domain. The domain comes from
  // the account's own active binding — or, for a Google spend child, from
  // the anchor that binding names: the child exists to hold that store's
  // spend, and leaving it unfiltered would bill the whole shared account to
  // one store, another store's campaigns included. That is the same
  // coalesce(binding, anchor) reading the database guards already use.
  //
  // A RETIRED source has no live binding, and its account is deliberately
  // left readable so its own history can still be certified - so the revoked
  // binding it left behind has to answer for the store too, or a shared
  // account gets billed whole to the store that remains. Which revoked
  // bindings may answer is decided by the immutable anchor events, never by
  // row shape: an ordinary unbind leaves the same row on an account that is
  // still under contract.
  const allBindingRows = await readEveryRow<ReportingBindingDomainRow>(
    (afterId, pageSize) => {
      let query = supabase
        .from("client_reporting_bindings")
        .select(
          "id, ad_account_id, shopify_connection_id, shopify_anchor_binding_id, status, bound_at, revoked_at",
        )
        .in("status", ["active", "staged", "revoked"])
        .in("ad_account_id", billableAccountIds)
        .order("id", { ascending: true })
        .limit(pageSize);
      if (afterId) query = query.gt("id", afterId);
      return query;
    },
  );
  const retiredBindingIds = await retirementEvidencedBindingIds(supabase, allBindingRows);
  const { bindings: accountBindings, retiredBoundAccountIds } = storeBindingsForLedger(
    allBindingRows,
    retiredBindingIds,
  );
  const anchorBindingIds = [
    ...new Set(
      accountBindings
        .filter((row) => !row.shopify_connection_id && row.shopify_anchor_binding_id)
        .map((row) => row.shopify_anchor_binding_id as string),
    ),
  ];
  const anchorShopifyByBinding = new Map<string, string>();
  if (anchorBindingIds.length > 0) {
    // The anchor may itself be revoked by now: its store was retired, or its
    // pair handed its Google account on and was replaced. Its Shopify id is
    // still the store the spend belonged to.
    const anchorRows = await readEveryRow<{
      id: string;
      shopify_connection_id: string | null;
    }>((afterId, pageSize) => {
      let query = supabase
        .from("client_reporting_bindings")
        .select("id, shopify_connection_id")
        .in("status", ["active", "staged", "revoked"])
        .in("id", anchorBindingIds)
        .order("id", { ascending: true })
        .limit(pageSize);
      if (afterId) query = query.gt("id", afterId);
      return query;
    });
    for (const row of anchorRows) {
      if (row.shopify_connection_id) anchorShopifyByBinding.set(row.id, row.shopify_connection_id);
    }
  }
  const boundShopifyConnections = accountBindings.flatMap((row) => {
    const connectionId =
      row.shopify_connection_id ??
      (row.shopify_anchor_binding_id
        ? anchorShopifyByBinding.get(row.shopify_anchor_binding_id) ?? null
        : null);
    return connectionId
      ? [{ ad_account_id: row.ad_account_id, shopify_connection_id: connectionId }]
      : [];
  });
  const shopifyConnectionIds = [
    ...new Set(boundShopifyConnections.map((row) => row.shopify_connection_id)),
  ];
  const storeDomainsByAccount = new Map<string, string[]>();
  if (shopifyConnectionIds.length > 0) {
    const { data: shopifyRows, error: shopifyRowsError } = await supabase
      .from("client_shopify_connections")
      .select("id, shopify_domain, primary_domain")
      .in("id", shopifyConnectionIds);
    if (shopifyRowsError) throw shopifyRowsError;
    type ShopifyDomainRow = {
      id: string;
      shopify_domain: string;
      primary_domain: string | null;
    };
    const domainsByConnection = new Map(
      ((shopifyRows ?? []) as unknown as ShopifyDomainRow[]).map((row) => [
        row.id,
        storeDomainsForSource({
          shopify: { domain: row.shopify_domain, primaryDomain: row.primary_domain },
        }),
      ]),
    );
    for (const row of boundShopifyConnections) {
      const domains = domainsByConnection.get(row.shopify_connection_id) ?? [];
      if (domains.length > 0) storeDomainsByAccount.set(row.ad_account_id, domains);
    }
  }

  return { storeDomainsByAccount, retiredBoundAccountIds };
}

/**
 * The Google source binding that answers for each of these accounts.
 *
 * Same rule as the ledger's, on the other axis: a live (active or staged)
 * binding always decides, and only an account with none may be answered for by
 * a revoked binding the anchor events name. It exists for the billing gate that
 * suppresses accrual on a non-EUR Google source - the spend is ECB-converted
 * for reporting, and the EUR-only invoice chain can never book it. Read from
 * live bindings alone, retiring such a source would drop the account out of the
 * gate and start showing a commission nobody can ever issue.
 */
export async function googleSourceBindingsForAccounts(
  supabase: Supa,
  accountIds: readonly string[],
): Promise<{ ad_account_id: string; google_ads_connection_id: string }[]> {
  if (accountIds.length === 0) return [];
  const rows = await readEveryRow<{
    id: string;
    ad_account_id: string;
    google_ads_connection_id: string;
    status: string;
  }>((afterId, pageSize) => {
    let query = supabase
      .from("client_reporting_bindings")
      .select("id, ad_account_id, google_ads_connection_id, status")
      .in("ad_account_id", accountIds)
      .in("status", ["active", "staged", "revoked"])
      .not("google_ads_connection_id", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    return query;
  });

  const live = rows.filter((row) => row.status === "active" || row.status === "staged");
  const liveAccountIds = new Set(live.map((row) => row.ad_account_id));
  const candidates = rows.filter(
    (row) => row.status === "revoked" && !liveAccountIds.has(row.ad_account_id),
  );
  const evidenced = await evidencedRetiredBindingIds(
    supabase,
    candidates.map((row) => row.id),
  );
  return [...live, ...candidates.filter((row) => evidenced.has(row.id))].map((row) => ({
    ad_account_id: row.ad_account_id,
    google_ads_connection_id: row.google_ads_connection_id,
  }));
}
