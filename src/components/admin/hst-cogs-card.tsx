"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { PackageCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBanner, Td, Th, Tr } from "@/components/finance/finance-ui";

/** One Dropscale store, and the supplier's own code for it (if any). */
export type HstMappedStore = {
  id: string;
  storeName: string;
  shopifyUrl: string | null;
  hstShopId: string | null;
};

export type HstShopOption = { id: string; name: string };

/**
 * Every store's supplier code in one place — the bulk view of what the COGS
 * screen does one store at a time.
 *
 * The code is typed, not picked. Listing the supplier's shops needs a live call
 * to their ERP, and a code has to stay enterable on the day that call fails;
 * the list is offered as suggestions instead.
 *
 * There is no default and never an inferred one. One HST login sees every shop
 * the agency buys through, and the only person who knows which of them is a
 * given client's store is the person reading this table. Getting it wrong
 * writes another client's costs onto these products, and every number would
 * still look plausible afterwards.
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
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [shopsErrorHidden, setShopsErrorHidden] = React.useState(false);

  function valueFor(store: HstMappedStore) {
    return drafts[store.id] ?? store.hstShopId ?? "";
  }

  async function save(store: HstMappedStore) {
    const shopId = valueFor(store).trim();
    setSaving(store.id);
    setError(null);
    try {
      const res = await fetch("/api/admin/hst/shop-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adAccountId: store.id, shopId: shopId || null }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      setDrafts((current) => {
        const next = { ...current };
        delete next[store.id];
        return next;
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="mt-6 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4 md:p-6">
      <header className="mb-4 flex items-start gap-3">
        <PackageCheck className="mt-0.5 size-5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
        <div>
          <h2 className="text-base font-semibold">Automatic COGS</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            A store with a supplier code gets its product costs and import duty from HST&rsquo;s own
            order list, every hour. Leave it empty and its client keeps entering costs by hand.
          </p>
        </div>
      </header>

      {shopsError && !shopsErrorHidden ? (
        <div className="mb-4">
          <ErrorBanner
            message={`Couldn't list the supplier's shops (${shopsError}) — codes can still be typed.`}
            onDismiss={() => setShopsErrorHidden(true)}
          />
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      ) : null}

      <datalist id="hst-shop-codes">
        {shops.map((shop) => (
          <option key={shop.id} value={shop.id}>
            {shop.name}
          </option>
        ))}
      </datalist>

      <DataTable
        head={
          <>
            <Th>Store</Th>
            <Th>Supplier ERP code</Th>
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
          stores.map((store) => {
            const dirty = valueFor(store).trim() !== (store.hstShopId ?? "");
            return (
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
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`Supplier code for ${store.storeName}`}
                      list="hst-shop-codes"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="2021639129"
                      className="h-9 max-w-[16rem]"
                      value={valueFor(store)}
                      disabled={saving === store.id}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [store.id]: event.target.value }))
                      }
                    />
                    <Button
                      variant={dirty ? "primary" : "secondary"}
                      size="sm"
                      loading={saving === store.id}
                      disabled={saving !== null || !dirty}
                      onClick={() => save(store)}
                    >
                      Save
                    </Button>
                  </div>
                </Td>
              </Tr>
            );
          })
        )}
      </DataTable>
    </section>
  );
}
