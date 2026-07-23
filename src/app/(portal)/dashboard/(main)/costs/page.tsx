import type { Metadata } from "next";
import { PackageOpen } from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { createClient } from "@/lib/supabase/server";
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

  return (
    <PageContainer
      title={d.portal.cogs}
      description={d.portal.cogsSubtitle}
      actions={<StoreSelector accounts={accounts} current={selected.id} />}
    >
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
