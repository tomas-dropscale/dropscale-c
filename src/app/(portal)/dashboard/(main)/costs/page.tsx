import type { Metadata } from "next";
import { Suspense } from "react";
import { PackageOpen } from "lucide-react";

import { fetchAccounts } from "@/lib/portal/data";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { clientHstStatus } from "@/lib/portal/client-hst";
import { activeWorkspaceId } from "@/lib/portal/workspace";
import { fetchHstShops } from "@/lib/admin/hst-cost-sync";
import { HstStoreCogs, type HstStoreCogsProps } from "@/components/portal/hst-store-cogs";
import { CogsFillProvider } from "@/components/portal/cogs-fill";
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
 * This store's own supplier connection.
 *
 * The credentials belong to the client, so this belongs on the client's cost
 * page: their HST account sees their shop, prices their goods, and is theirs to
 * connect and disconnect. The agency's separate HST session — the one that
 * reads the commission HST pays the agency — is not this and is not reachable
 * from here.
 *
 * Read through the SERVICE role for two reasons: client_hst_credentials denies
 * everyone under RLS by design, and 0055 hides a shopify_anchor ad_account from
 * its own owner, so a viewer-scoped read reports a client's own store code as
 * unset with nothing to say it was hidden rather than empty.
 *
 * Nothing throws and nothing returns nothing: a panel that disappears when its
 * own query fails leaves whoever is looking unable to tell "not connected" from
 * "the migration is not applied".
 */
async function loadHstPanel(
  clientId: string,
  adAccountId: string,
  storeName: string,
): Promise<HstStoreCogsProps | null> {
  const base: HstStoreCogsProps = {
    adAccountId,
    storeName,
    hstShopId: null,
    connected: false,
    lastError: null,
    shops: [],
    shopsError: null,
  };

  const service = createServiceClient();
  if (!service) {
    return { ...base, shopsError: "The server is missing its service role key." };
  }

  try {
    const [status, mapping] = await Promise.all([
      clientHstStatus(service, clientId),
      service.from("ad_accounts").select("hst_shop_id").eq("id", adAccountId).maybeSingle(),
    ]);

    // Not provisioned here yet: show nothing rather than a button that can
    // only fail.
    if (!status.available) return null;

    let shops: HstStoreCogsProps["shops"] = [];
    let shopsError: string | null = null;
    if (status.connected) {
      try {
        shops = await fetchHstShops({ service, clientId });
      } catch (cause) {
        shopsError = cause instanceof Error ? cause.message : String(cause);
      }
    }

    return {
      ...base,
      hstShopId: (mapping.data as { hst_shop_id?: string | null } | null)?.hst_shop_id ?? null,
      connected: status.connected,
      lastError: status.lastError,
      shops,
      shopsError,
    };
  } catch (cause) {
    return {
      ...base,
      shopsError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * The supplier panel, resolved off the page's critical path.
 *
 * loadHstPanel makes a live call to HST for a connected client's shop list;
 * awaiting it in the page body held the whole Costs screen behind that network
 * round-trip. Here it sits inside its own Suspense boundary, so the grid paints
 * at once and the panel streams in after.
 */
async function HstPanel({
  clientId,
  adAccountId,
  storeName,
}: {
  clientId: string;
  adAccountId: string;
  storeName: string;
}) {
  const panel = await loadHstPanel(clientId, adAccountId, storeName);
  if (!panel) return null;
  return <HstStoreCogs {...panel} />;
}

/** The panel's silhouette while its shop list loads — same frame, no content. */
function HstPanelSkeleton() {
  return (
    <section className="panel space-y-4 p-4 md:p-5">
      <div className="flex animate-pulse items-start gap-3">
        <div className="size-9 shrink-0 rounded-[10px] bg-[var(--bg-elevated)]" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-4 w-44 rounded bg-[var(--bg-elevated)]" />
          <div className="h-3 w-3/4 rounded bg-[var(--bg-elevated)]" />
        </div>
      </div>
      <div className="h-10 w-full max-w-md animate-pulse rounded-[10px] bg-[var(--bg-elevated)]" />
    </section>
  );
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

  // The panel belongs to whoever owns the store, which on this page is always
  // the active workspace — the page would not have rendered otherwise.
  const clientId = await activeWorkspaceId();

  return (
    <PageContainer
      title={d.portal.cogs}
      description={d.portal.cogsSubtitle}
      actions={<StoreSelector accounts={accounts} current={selected.id} />}
    >
      {/* One provider around both halves so choosing a shop in the panel can
          drive the fill animation down in the grid — they are siblings with no
          prop path between them otherwise. */}
      <CogsFillProvider>
        {/* Streamed on its own: the panel loads its shop list live from the
            supplier, and the grid below must not wait on that network call. The
            page paints immediately with a placeholder; the panel swaps in when
            HST answers (or falls back to manual entry if it does not). */}
        {clientId && (
          <div className="mb-4">
            <Suspense fallback={<HstPanelSkeleton />}>
              <HstPanel
                clientId={clientId}
                adAccountId={selected.id}
                storeName={selected.store_name ?? selected.id}
              />
            </Suspense>
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
      </CogsFillProvider>
    </PageContainer>
  );
}
