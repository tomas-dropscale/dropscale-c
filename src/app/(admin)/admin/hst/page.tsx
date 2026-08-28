import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { HstView } from "@/components/finance/hst-view";
import {
  HstCogsCard,
  type HstMappedStore,
  type HstShopOption,
} from "@/components/admin/hst-cogs-card";
import { getSessionProfile } from "@/lib/supabase/server";
import { fetchHstOverview, syncHstCommission } from "@/lib/admin/hst";
import { fetchHstShops } from "@/lib/admin/hst-cost-sync";
import { createServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = { title: "HST" };

/**
 * Which stores buy through HST, and which shop each one is.
 *
 * The shop list comes off the supplier's own order list, so it needs a live
 * session — and a dead one must not take the page down with it. A failure
 * leaves the existing mappings visible and editable, and says why the list is
 * missing instead of showing an empty picker that looks like "no shops".
 */
async function loadCogsMapping(): Promise<{
  stores: HstMappedStore[];
  shops: HstShopOption[];
  shopsError: string | null;
}> {
  const service = createServiceClient();
  if (!service) {
    return { stores: [], shops: [], shopsError: "The server is missing its service role key." };
  }

  const { data, error } = await service
    .from("ad_accounts")
    .select("id, store_name, shopify_url, hst_shop_id")
    .order("store_name", { ascending: true });

  const stores = ((data ?? []) as Array<{
    id: string;
    store_name: string | null;
    shopify_url: string | null;
    hst_shop_id: string | null;
  }>).map((row) => ({
    id: row.id,
    storeName: row.store_name?.trim() || row.shopify_url?.trim() || row.id,
    shopifyUrl: row.shopify_url,
    hstShopId: row.hst_shop_id,
  }));

  if (error) {
    return { stores, shops: [], shopsError: error.message };
  }

  try {
    return { stores, shops: await fetchHstShops({ client: service }), shopsError: null };
  } catch (cause) {
    return {
      stores,
      shops: [],
      shopsError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * The HST tab: the supplier's own numbers, and what they've settled. Like the
 * other finance pages it refreshes the ledger before reading it (throttled),
 * so opening the tab is enough to see today's commission.
 */
export default async function HstPage() {
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");

  await syncHstCommission();
  const [overview, mapping] = await Promise.all([fetchHstOverview(), loadCogsMapping()]);

  return (
    <HstView
      overview={overview}
      footer={profile.role === "admin" ? <HstCogsCard {...mapping} /> : null}
    />
  );
}
