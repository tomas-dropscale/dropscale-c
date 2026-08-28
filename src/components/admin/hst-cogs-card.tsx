"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { PackageCheck } from "lucide-react";

import { DataTable, ErrorBanner, Td, Th, Tr } from "@/components/finance/finance-ui";

/** One Dropscale store, and the HST shop it buys through (if any). */
export type HstMappedStore = {
  id: string;
  storeName: string;
  shopifyUrl: string | null;
  hstShopId: string | null;
};

export type HstShopOption = { id: string; name: string };

/**
 * Which stores buy through HST — the switch that turns automatic COGS on.
 *
 * Deliberately a per-store choice with no default. One HST login sees every
 * shop the agency buys through, and the only person who knows which of them is
 * a given client's store is the person reading this table. Choosing wrong
 * writes another client's costs onto these products, and every number would
 * still look plausible afterwards, so the mapping is never inferred.
 */
export function HstCogsCard({
  stores,
  shops,
  shopsError,
}: {
  stores: HstMappedStore[];
  shops: HstShopOption[];
  shopsError: string | null;
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [shopsErrorHidden, setShopsErrorHidden] = React.useState(false);

  async function save(adAccountId: string, shopId: string | null) {
    setSaving(adAccountId);
    setError(null);
    try {
      const res = await fetch("/api/admin/hst/shop-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adAccountId, shopId }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  }

  // Shops the supplier no longer lists, but a store is still mapped to. Kept
  // as options so opening this page cannot silently unmap a working store.
  const known = new Set(shops.map((shop) => shop.id));
  const orphans = stores
    .map((store) => store.hstShopId)
    .filter((id): id is string => !!id && !known.has(id));
  const options = [...shops, ...[...new Set(orphans)].map((id) => ({ id, name: id }))];

  return (
    <section className="mt-6 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4 md:p-6">
      <header className="mb-4 flex items-start gap-3">
        <PackageCheck className="mt-0.5 size-5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
        <div>
          <h2 className="text-base font-semibold">Automatic COGS</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Stores that buy through HST get their product costs and import duty from the
            supplier&rsquo;s own order list, refreshed every hour. Leave a store unmapped and its
            client keeps entering costs by hand.
          </p>
        </div>
      </header>

      {shopsError && !shopsErrorHidden ? (
        <div className="mb-4">
          <ErrorBanner message={`HST shop list unavailable: ${shopsError}`} onDismiss={() => setShopsErrorHidden(true)} />
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      ) : null}

      <DataTable
        head={
          <>
            <Th>Store</Th>
            <Th>HST shop</Th>
          </>
        }
      >
        {stores.length === 0 ? (
          <Tr>
            <Td>
              <span className="text-[var(--text-muted)]">No stores yet.</span>
            </Td>
            <Td />
          </Tr>
        ) : (
          stores.map((store) => (
            <Tr key={store.id}>
              <Td>
                <span className="font-medium">{store.storeName}</span>
                {store.shopifyUrl ? (
                  <span className="block text-xs text-[var(--text-muted)]">
                    {store.shopifyUrl}
                  </span>
                ) : null}
              </Td>
              <Td>
                <select
                  aria-label={`HST shop for ${store.storeName}`}
                  className="min-h-9 w-full max-w-[22rem] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-sm disabled:opacity-60"
                  value={store.hstShopId ?? ""}
                  disabled={saving === store.id || (options.length === 0 && !store.hstShopId)}
                  onChange={(event) => save(store.id, event.target.value || null)}
                >
                  <option value="">Not supplied by HST</option>
                  {options.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                    </option>
                  ))}
                </select>
              </Td>
            </Tr>
          ))
        )}
      </DataTable>
    </section>
  );
}
