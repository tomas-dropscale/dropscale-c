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

  const bindingsResult = (await service
    .from("client_reporting_bindings")
    .select("id, client_id, ad_account_id, shopify_connection_id, shopify_anchor_binding_id, status")
    .eq("client_id", clientId)
    .eq("status", "revoked")
    .is("shopify_connection_id", null)
    .in("shopify_anchor_binding_id", [...new Set(anchorBindingIds)])) as unknown as {
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
  const allowedAnchors = new Set(anchorBindingIds);
  const revokedChildren = (bindingsResult.data ?? []).filter(
    (row) =>
      row.client_id === clientId &&
      row.status === "revoked" &&
      row.shopify_connection_id === null &&
      row.shopify_anchor_binding_id !== null &&
      allowedAnchors.has(row.shopify_anchor_binding_id),
  );
  if (revokedChildren.length === 0) return new Map();

  const eventsResult = (await service
    .from("client_reporting_anchor_events")
    .select("prior_binding_id, event_type")
    .eq("event_type", "handed_over")
    .in(
      "prior_binding_id",
      revokedChildren.map((row) => row.id),
    )) as unknown as {
    data: { prior_binding_id: string | null; event_type: string }[] | null;
    error: { message: string } | null;
  };
  if (eventsResult.error) {
    throw new Error("The handover evidence is unavailable.");
  }
  const handedOver = new Set(
    (eventsResult.data ?? [])
      .filter((row) => row.event_type === "handed_over" && row.prior_binding_id !== null)
      .map((row) => row.prior_binding_id as string),
  );

  const byAnchorBinding = new Map<string, string[]>();
  for (const row of revokedChildren) {
    if (!handedOver.has(row.id)) continue;
    const anchorBindingId = row.shopify_anchor_binding_id!;
    const ids = byAnchorBinding.get(anchorBindingId) ?? [];
    if (!ids.includes(row.ad_account_id)) ids.push(row.ad_account_id);
    byAnchorBinding.set(anchorBindingId, ids);
  }
  return byAnchorBinding;
}
