import type { Metadata } from "next";
import { PackageOpen } from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { getHstStatus } from "@/lib/admin/hst";
import { fetchHstShops } from "@/lib/admin/hst-cost-sync";
import { HstStoreCogs, type HstStoreCogsProps } from "@/components/admin/hst-store-cogs";
import { CostsManager } from "@/components/portal/costs-manager";
import { StoreSelector } from "@/components/portal/store-selector";
import { PageContainer } from "@/components/ui/page-container";
import { fmt } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.cogs };
}

/**
 * The supplier panel, for admins only, and never at a client's expense.
 *
 * Every failure here returns null rather than throwing: the HST account is the
 * agency's own side-concern, and a dead ERP session must not be able to take
 * down a client's cost page. Listing the shops needs a live call, so it is only
 * attempted once there is a session to make it with.
 */
async function loadHstPanel(
  supabase: Awaited<ReturnType<typeof createClient>>,
  adAccountId: string,
  storeName: string,
): Promise<HstStoreCogsProps | null> {
  try {
    const [status, mapping] = await Promise.all([
      getHstStatus(),
      supabase.from("ad_accounts").select("hst_shop_id").eq("id", adAccountId).maybeSingle(),
    ]);

    let shops: HstStoreCogsProps["shops"] = [];
    let shopsError: string | null = null;
    if (status.hasSession || status.hasCredentials) {
      try {
        shops = await fetchHstShops({ client: supabase });
      } catch (cause) {
        shopsError = cause instanceof Error ? cause.message : String(cause);
      }
    }

    return {
      adAccountId,
      storeName,
      hstShopId: (mapping.data as { hst_shop_id?: string | null } | null)?.hst_shop_id ?? null,
      connected: status.hasSession || status.hasCredentials,
      selfHealing: status.hasCredentials,
      shops,
      shopsError,
    };
  } catch {
    return null;
  }
}

/**
 * COGS — product costs, tiers and bundles for ONE store at a time (costs are
 * per-store config; a ?store= param picks which, defaulting to the first).
 */
export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string }>;
}) {
  const params = await searchParams;
  const [accounts, { d }] = await Promise.all([fetchAccounts(), getServerDictionary()]);

  const selected =
    accounts.find((account) => account.id === params.store) ?? accounts[0] ?? null;

  if (!selected) {
    return (
      <PageContainer title={d.portal.cogs} description={d.portal.cogsSubtitle}>
        <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
          <PackageOpen className="size-8 text-[var(--text-muted)]" />
          <p className="text-[15px] font-medium text-[var(--text-primary)]">{d.portal.noStores}</p>
          <p className="max-w-[380px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {fmt(d.portal.noStoresHelp, {
              add: d.portal.addAccount,
              request: d.portal.requestAccount,
            })}
          </p>
        </div>
      </PageContainer>
    );
  }

  const supabase = await createClient();
  const [productsRes, collectionsRes] = await Promise.all([
    supabase
      .from("store_products")
      .select("*")
      .eq("ad_account_id", selected.id)
      .order("title", { ascending: true }),
    supabase
      .from("cogs_collections")
      .select("*")
      .eq("ad_account_id", selected.id)
      .order("created_at", { ascending: true }),
  ]);

  const products = productsRes.data ?? [];
  const collections = collectionsRes.data ?? [];
  const productIds = products.map((product) => product.id);
  const collectionIds = collections.map((collection) => collection.id);

  const [costsRes, tiersRes, membersRes, cTiersRes] = await Promise.all([
    productIds.length > 0
      ? supabase.from("product_costs").select("*").in("product_id", productIds)
      : Promise.resolve({ data: [] }),
    productIds.length > 0
      ? supabase.from("product_cost_tiers").select("*").in("product_id", productIds)
      : Promise.resolve({ data: [] }),
    collectionIds.length > 0
      ? supabase.from("cogs_collection_members").select("*").in("collection_id", collectionIds)
      : Promise.resolve({ data: [] }),
    collectionIds.length > 0
      ? supabase.from("cogs_collection_tiers").select("*").in("collection_id", collectionIds)
      : Promise.resolve({ data: [] }),
  ]);

  const { profile } = await getSessionProfile();
  const hstPanel =
    profile?.role === "admin"
      ? await loadHstPanel(supabase, selected.id, selected.store_name ?? selected.id)
      : null;

  return (
    <PageContainer
      title={d.portal.cogs}
      description={d.portal.cogsSubtitle}
      actions={<StoreSelector accounts={accounts} current={selected.id} />}
    >
      {hstPanel && (
        <div className="mb-4">
          <HstStoreCogs {...hstPanel} />
        </div>
      )}
      <CostsManager
        account={selected}
        products={products}
        costs={costsRes.data ?? []}
        tiers={tiersRes.data ?? []}
        collections={collections}
        members={membersRes.data ?? []}
        collectionTiers={cTiersRes.data ?? []}
      />
    </PageContainer>
  );
}
