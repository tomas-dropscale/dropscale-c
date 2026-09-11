import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ad accounts a store handover retired, grouped by the anchor binding of the
 * store they last reported for.
 *
 * A handed-over CHILD source leaves its old account with no active binding at
 * all: the sync never writes it again and resolveReportingSources no longer
 * returns it, so its recorded history would silently vanish from the store
 * that spent the money. (A handed-over PAIR keeps its account visible through
 * the replacement Shopify-only binding, so pairs never appear here.)
 *
 * The discriminator is the handover's own immutable evidence: the RPC writes
 * a 'handed_over' anchor event whose prior_binding_id names the binding it
 * retired. Nothing else in the system can write that event, so this is the
 * same proof the cutover queue accepts as authority. Row SHAPE is not enough
 * here - an abandoned staged Google source also ends up revoked under an
 * anchor with a closed billing counter (0056 demands the counter be closed
 * before abandonment), and its 90-day staging rows must never be folded into
 * a client-facing total.
 *
 * A store can also be RE-ANCHORED. Handing a pair's Google account over, or
 * retiring it, revokes the pair binding and mints a replacement Shopify-only
 * binding with a NEW id for the same store on the same account. A child
 * retired earlier still names the old binding, and that column is immutable,
 * so matching on the caller's current anchor ids alone would drop that child's
 * spend out of the store's totals with no error anywhere. The replacement's
 * own event carries the link (binding_id = replacement, prior_binding_id = the
 * binding it replaced), so each anchor is expanded into its lineage before the
 * children are read, and every child found is reported under the anchor the
 * caller asked about.
 *
 * Display only: callers fold these ids into store TOTALS and history, never
 * into sync/recompute scopes or live-topology checks - a retired account has
 * no connection left to test and no new rows to expect.
 */
export async function retiredAccountIdsByAnchorBinding(
  service: SupabaseClient,
  clientId: string,
  anchorBindingIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (anchorBindingIds.length === 0) return new Map();

  const currentAnchorIds = [...new Set(anchorBindingIds)];
  const anchorLineage = await anchorBindingLineage(service, currentAnchorIds);

  const bindingsResult = (await service
    .from("client_reporting_bindings")
    .select("id, client_id, ad_account_id, shopify_connection_id, shopify_anchor_binding_id, status")
    .eq("client_id", clientId)
    .eq("status", "revoked")
    .is("shopify_connection_id", null)
    .in("shopify_anchor_binding_id", [...anchorLineage.keys()])) as unknown as {
    data:
      | {
          id: string;
          client_id: string;
          ad_account_id: string;
          shopify_connection_id: string | null;
          shopify_anchor_binding_id: string | null;
          status: string;
        }[]
      | null;
    error: { message: string } | null;
  };
  if (bindingsResult.error) {
    throw new Error("The retired reporting bindings are unavailable.");
  }
  const revokedChildren = (bindingsResult.data ?? []).filter(
    (row) =>
      row.client_id === clientId &&
      row.status === "revoked" &&
      row.shopify_connection_id === null &&
      row.shopify_anchor_binding_id !== null &&
      anchorLineage.has(row.shopify_anchor_binding_id),
  );
  if (revokedChildren.length === 0) return new Map();

  const childIds = revokedChildren.map((row) => row.id);
  // Two ways a child leaves for good, each with its own immutable evidence: a
  // handover names it as the source it moved (prior_binding_id), and a
  // retirement names the binding itself (binding_id) when the client closed
  // the Google account. Either way the store keeps what it already spent.
  const [handoverResult, retirementResult] = (await Promise.all([
    service
      .from("client_reporting_anchor_events")
      .select("prior_binding_id, event_type")
      .eq("event_type", "handed_over")
      .in("prior_binding_id", childIds),
    service
      .from("client_reporting_anchor_events")
      .select("binding_id, event_type")
      .eq("event_type", "source_retired")
      .in("binding_id", childIds),
  ])) as unknown as [
    {
      data: { prior_binding_id: string | null; event_type: string }[] | null;
      error: { message: string } | null;
    },
    {
      data: { binding_id: string; event_type: string }[] | null;
      error: { message: string } | null;
    },
  ];
  if (handoverResult.error || retirementResult.error) {
    throw new Error("The handover evidence is unavailable.");
  }
  const retiredChildren = new Set([
    ...(handoverResult.data ?? [])
      .filter((row) => row.event_type === "handed_over" && row.prior_binding_id !== null)
      .map((row) => row.prior_binding_id as string),
    ...(retirementResult.data ?? [])
      .filter((row) => row.event_type === "source_retired")
      .map((row) => row.binding_id),
  ]);

  const byAnchorBinding = new Map<string, string[]>();
  for (const row of revokedChildren) {
    if (!retiredChildren.has(row.id)) continue;
    // Report under the anchor the caller asked about, never a superseded one:
    // callers key strictly on the ids they passed in, so returning a retired
    // binding's id would drop the account again, silently.
    const anchorBindingId = anchorLineage.get(row.shopify_anchor_binding_id!)!;
    const ids = byAnchorBinding.get(anchorBindingId) ?? [];
    if (!ids.includes(row.ad_account_id)) ids.push(row.ad_account_id);
    byAnchorBinding.set(anchorBindingId, ids);
  }
  return byAnchorBinding;
}

/** A store may be re-anchored more than once; the walk is bounded regardless. */
const MAX_ANCHOR_SUPERSESSIONS = 16;

/**
 * Every binding id a store has reported through, mapped to the one it reports
 * through now. Seeded with the caller's own ids, so a store that was never
 * re-anchored costs one query that returns nothing.
 *
 * Three RPCs mint a replacement binding for a store that already had one, and
 * all three record the same edge - binding_id = the new binding,
 * prior_binding_id = the one it supersedes: a store handover (0095/0096), a
 * pair's Google retirement (0100), and a RESTAGE (0056) of an identity a store
 * retirement (0097) deliberately left reusable. Follow one and not the others
 * and a child retired under the old binding drops out of the store's totals.
 */
const SUPERSESSION_EVENTS = ["handed_over", "source_retired", "restaged"];
async function anchorBindingLineage(
  service: SupabaseClient,
  currentAnchorIds: readonly string[],
): Promise<Map<string, string>> {
  const lineage = new Map(currentAnchorIds.map((id) => [id, id]));
  let frontier = [...currentAnchorIds];
  for (let hop = 0; hop < MAX_ANCHOR_SUPERSESSIONS && frontier.length > 0; hop += 1) {
    const result = (await service
      .from("client_reporting_anchor_events")
      .select("binding_id, prior_binding_id, event_type")
      .in("event_type", SUPERSESSION_EVENTS)
      .in("binding_id", frontier)) as unknown as {
      data:
        | { binding_id: string; prior_binding_id: string | null; event_type: string }[]
        | null;
      error: { message: string } | null;
    };
    if (result.error) {
      throw new Error("The reporting anchor lineage is unavailable.");
    }
    const next: string[] = [];
    for (const row of result.data ?? []) {
      const prior = row.prior_binding_id;
      // A retirement also writes an event on the binding it RETIRED, with no
      // prior; only the replacement's event carries the link backwards.
      if (!prior || lineage.has(prior)) continue;
      const current = lineage.get(row.binding_id);
      if (!current) continue;
      lineage.set(prior, current);
      next.push(prior);
    }
    frontier = next;
  }
  return lineage;
}
