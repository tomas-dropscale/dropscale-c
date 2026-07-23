"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  FolderPlus,
  History,
  Layers,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

import type {
  AdAccount,
  CogsCollectionMember,
  CogsCollectionRow,
  CogsCollectionTier,
  ProductCost,
  ProductCostTier,
  StoreProduct,
} from "@/lib/supabase/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The Costs page body: product list with inline effective-dated cost edits,
 * per-product tier editor, collections (bundles) and the store's cost
 * settings. Every write is an RLS-checked query on the client's own rows,
 * followed by a rollup resync — the dashboard's profit follows within one
 * round-trip, and REVENUE never moves.
 */

const DEBOUNCE_MS = 800;

type Props = {
  account: AdAccount;
  products: StoreProduct[];
  costs: ProductCost[];
  tiers: ProductCostTier[];
  collections: CogsCollectionRow[];
  members: CogsCollectionMember[];
  collectionTiers: CogsCollectionTier[];
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CostsManager({
  account,
  products,
  costs,
  tiers,
  collections,
  members,
  collectionTiers,
}: Props) {
  const router = useRouter();
  const supabase = () => createClient();
  const [error, setError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  // Debounced inline edits: productId → pending timer.
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});

  const costsByProduct = React.useMemo(() => {
    const map = new Map<string, ProductCost[]>();
    for (const cost of costs) {
      const bucket = map.get(cost.product_id) ?? [];
      bucket.push(cost);
      map.set(cost.product_id, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => b.effective_from.localeCompare(a.effective_from));
    }
    return map;
  }, [costs]);

  const tiersByProduct = React.useMemo(() => {
    const map = new Map<string, ProductCostTier[]>();
    for (const tier of tiers) {
      const bucket = map.get(tier.product_id) ?? [];
      bucket.push(tier);
      map.set(tier.product_id, bucket);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.min_qty - b.min_qty);
    return map;
  }, [tiers]);

  const memberProductIds = React.useMemo(
    () => new Set(members.map((member) => member.product_id)),
    [members],
  );

  /** Manual record in force today, or null. */
  function currentCost(productId: string): ProductCost | null {
    const history = costsByProduct.get(productId) ?? [];
    const now = today();
    return history.find((record) => record.effective_from <= now) ?? null;
  }

  async function resync() {
    try {
      await fetch("/api/cogs/resync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
    } catch {
      // The next lazy sync heals it; the edit itself already saved.
    }
    router.refresh();
  }

  function scheduleCostSave(productId: string, raw: string) {
    setDrafts((prev) => ({ ...prev, [productId]: raw }));
    const existing = timers.current.get(productId);
    if (existing) clearTimeout(existing);

    timers.current.set(
      productId,
      setTimeout(async () => {
        const value = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(value) || value < 0) return;
        setError(null);
        // A NEW effective-dated record — never an update. Editing a cost
        // today must not rewrite what June's orders resolved to.
        const { error: insertError } = await supabase().from("product_costs").insert({
          product_id: productId,
          cost: value,
          currency: account.currency,
          effective_from: today(),
        });
        if (insertError) {
          setError(insertError.message);
          return;
        }
        await resync();
      }, DEBOUNCE_MS),
    );
  }

  async function run(action: () => Promise<{ error: { message: string } | null }>) {
    setError(null);
    const { error: actionError } = await action();
    if (actionError) {
      setError(actionError.message);
      return false;
    }
    await resync();
    return true;
  }

  async function syncProducts() {
    setSyncing(true);
    setError(null);
    const res = await fetch("/api/cogs/resync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: account.id }),
    });
    setSyncing(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Sync failed. Try again.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-8">
      {error && <FormAlert>{error}</FormAlert>}

      {/* ---- store cost settings ------------------------------------------ */}
      <CostSettings account={account} onSaved={resync} onError={setError} />

      {/* ---- products ------------------------------------------------------ */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="label-caps">Products ({products.length})</h2>
          <Button variant="secondary" size="sm" loading={syncing} onClick={syncProducts}>
            <RefreshCw />
            Sync products
          </Button>
        </div>

        {products.length === 0 ? (
          <p className="panel px-5 py-10 text-center text-[13px] text-[var(--text-secondary)]">
            No products yet. They appear automatically as orders sync — or press “Sync
            products” to pull the last 90 days now.
          </p>
        ) : (
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="label-caps px-4 py-2.5 text-left">Product</th>
                    <th className="label-caps px-4 py-2.5 text-right">Price</th>
                    <th className="label-caps px-4 py-2.5 text-right">Cost</th>
                    <th className="label-caps px-4 py-2.5 text-left">Source</th>
                    <th className="label-caps px-4 py-2.5 text-right">Tiers</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => {
                    const record = currentCost(product.id);
                    const inCollection = memberProductIds.has(product.id);
                    const productTiers = tiersByProduct.get(product.id) ?? [];
                    const isOpen = expanded === product.id;
                    const fallback =
                      (Number(product.price) * Number(account.default_product_cost_pct)) / 100;

                    return (
                      <React.Fragment key={product.id}>
                        <tr
                          className={cn(
                            "transition-smooth cursor-pointer border-b border-[var(--border-subtle)] hover:bg-[var(--bg-panel-hover)]",
                            isOpen && "bg-[var(--bg-panel-hover)]",
                          )}
                          onClick={() => setExpanded(isOpen ? null : product.id)}
                        >
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <ChevronRight
                                className={cn(
                                  "transition-smooth size-3.5 shrink-0 text-[var(--text-muted)]",
                                  isOpen && "rotate-90",
                                )}
                              />
                              <span className="min-w-0">
                                <span className="block truncate font-medium text-[var(--text-primary)]">
                                  {product.title}
                                </span>
                                <span className="block truncate text-[11px] text-[var(--text-muted)]">
                                  {product.platform_key}
                                </span>
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap text-[var(--text-secondary)]">
                            {money(product.price, product.currency)}
                          </td>
                          <td
                            className="px-4 py-2.5 text-right"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Input
                              value={drafts[product.id] ?? (record ? String(record.cost) : "")}
                              onChange={(event) => scheduleCostSave(product.id, event.target.value)}
                              placeholder={fallback.toFixed(2)}
                              inputMode="decimal"
                              className="ml-auto h-8 w-24 text-right"
                              aria-label={`Cost of ${product.title}`}
                            />
                          </td>
                          <td className="px-4 py-2.5">
                            {inCollection ? (
                              <Badge variant="gold">bundle</Badge>
                            ) : record ? (
                              <Badge variant="success">manual</Badge>
                            ) : (
                              <Badge variant="neutral">
                                {Number(account.default_product_cost_pct)}% of price
                              </Badge>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right text-[var(--text-secondary)]">
                            {productTiers.length > 0 ? productTiers.length : "—"}
                          </td>
                        </tr>

                        {isOpen && (
                          <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-base)]">
                            <td colSpan={5} className="px-4 py-4 pl-10">
                              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                                <CostHistory
                                  history={costsByProduct.get(product.id) ?? []}
                                  onDelete={(id) =>
                                    run(async () =>
                                      supabase().from("product_costs").delete().eq("id", id),
                                    )
                                  }
                                />
                                <TierEditor
                                  title="Quantity tiers"
                                  hint="Total cost for min. quantity — units above pay the unit cost."
                                  tiers={productTiers.map((tier) => ({
                                    id: tier.id,
                                    minQty: tier.min_qty,
                                    totalCost: Number(tier.total_cost),
                                  }))}
                                  disabled={inCollection}
                                  disabledHint="This product is in a bundle — the bundle's tiers apply."
                                  onAdd={(minQty, totalCost) =>
                                    run(async () =>
                                      supabase().from("product_cost_tiers").insert({
                                        product_id: product.id,
                                        min_qty: minQty,
                                        total_cost: totalCost,
                                      }),
                                    )
                                  }
                                  onDelete={(id) =>
                                    run(async () =>
                                      supabase().from("product_cost_tiers").delete().eq("id", id),
                                    )
                                  }
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* ---- collections (bundles) ---------------------------------------- */}
      <CollectionsManager
        accountId={account.id}
        products={products}
        collections={collections}
        members={members}
        collectionTiers={collectionTiers}
        memberProductIds={memberProductIds}
        run={run}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function CostSettings({
  account,
  onSaved,
  onError,
}: {
  account: AdAccount;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const supabase = () => createClient();
  const [pct, setPct] = React.useState(String(account.default_product_cost_pct));
  const [feePct, setFeePct] = React.useState(String(account.payment_fee_pct));
  const [feeFixed, setFeeFixed] = React.useState(String(account.payment_fee_fixed));
  const [shipping, setShipping] = React.useState(String(account.shipping_cost_per_order));
  const [saving, setSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    const { error } = await supabase()
      .from("ad_accounts")
      .update({
        default_product_cost_pct: Number(pct) || 0,
        payment_fee_pct: Number(feePct) || 0,
        payment_fee_fixed: Number(feeFixed) || 0,
        shipping_cost_per_order: Number(shipping) || 0,
      })
      .eq("id", account.id);
    setSaving(false);
    if (error) {
      onError(error.message);
      return;
    }
    await onSaved();
  }

  const fields: [string, string, string, (v: string) => void][] = [
    ["Default cost (% of price)", "used when a product has no cost", pct, setPct],
    ["Payment fee (%)", "per order, of the order total", feePct, setFeePct],
    [`Payment fee fixed (${account.currency})`, "added per order", feeFixed, setFeeFixed],
    [`Shipping cost / order (${account.currency})`, "what YOU pay, not what you charge", shipping, setShipping],
  ];

  return (
    <section className="panel space-y-4 p-5">
      <h2 className="label-caps">Cost settings</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {fields.map(([label, hint, value, set]) => (
          <div key={label} className="space-y-1.5">
            <Label>{label}</Label>
            <Input value={value} onChange={(event) => set(event.target.value)} inputMode="decimal" />
            <p className="text-[11px] text-[var(--text-muted)]">{hint}</p>
          </div>
        ))}
      </div>
      <Button variant="primary" size="sm" loading={saving} onClick={save}>
        Save settings
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------

function CostHistory({
  history,
  onDelete,
}: {
  history: ProductCost[];
  onDelete: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="label-caps flex items-center gap-1.5">
        <History className="size-3.5" />
        Cost history
      </p>
      {history.length === 0 ? (
        <p className="text-[12.5px] text-[var(--text-muted)]">
          No manual costs yet — the default percentage applies.
        </p>
      ) : (
        <ul className="space-y-1">
          {history.map((record, index) => (
            <li
              key={record.id}
              className="flex items-center justify-between gap-3 rounded-[8px] bg-[var(--bg-panel)] px-3 py-1.5 text-[12.5px]"
            >
              <span className="text-[var(--text-secondary)]">
                from <span className="text-[var(--text-primary)]">{record.effective_from}</span>
                {index === 0 && (
                  <span className="ml-2 text-[10.5px] text-[var(--accent-gold)]">current</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-medium text-[var(--text-primary)]">
                  {money(record.cost, record.currency)}
                </span>
                <button
                  type="button"
                  onClick={() => onDelete(record.id)}
                  className="transition-smooth text-[var(--text-muted)] hover:text-[var(--danger-red)]"
                  aria-label="Delete cost record"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TierEditor({
  title,
  hint,
  tiers,
  disabled = false,
  disabledHint,
  onAdd,
  onDelete,
}: {
  title: string;
  hint: string;
  tiers: { id: string; minQty: number; totalCost: number }[];
  disabled?: boolean;
  disabledHint?: string;
  onAdd: (minQty: number, totalCost: number) => void;
  onDelete: (id: string) => void;
}) {
  const [minQty, setMinQty] = React.useState("");
  const [totalCost, setTotalCost] = React.useState("");

  return (
    <div className="space-y-2">
      <p className="label-caps flex items-center gap-1.5">
        <Layers className="size-3.5" />
        {title}
      </p>
      <p className="text-[11px] text-[var(--text-muted)]">{disabled ? disabledHint : hint}</p>

      {!disabled && (
        <>
          <ul className="space-y-1">
            {tiers.map((tier) => (
              <li
                key={tier.id}
                className="flex items-center justify-between gap-3 rounded-[8px] bg-[var(--bg-panel)] px-3 py-1.5 text-[12.5px]"
              >
                <span className="text-[var(--text-secondary)]">
                  {tier.minQty}+ units →{" "}
                  <span className="font-medium text-[var(--text-primary)]">
                    {tier.totalCost.toFixed(2)}
                  </span>{" "}
                  total
                </span>
                <button
                  type="button"
                  onClick={() => onDelete(tier.id)}
                  className="transition-smooth text-[var(--text-muted)] hover:text-[var(--danger-red)]"
                  aria-label="Delete tier"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2">
            <Input
              value={minQty}
              onChange={(event) => setMinQty(event.target.value)}
              placeholder="min qty"
              inputMode="numeric"
              className="h-8 w-20"
            />
            <Input
              value={totalCost}
              onChange={(event) => setTotalCost(event.target.value)}
              placeholder="total cost"
              inputMode="decimal"
              className="h-8 w-24"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!(Number(minQty) >= 1) || !(Number(totalCost) >= 0) || totalCost.trim() === ""}
              onClick={() => {
                onAdd(Number(minQty), Number(totalCost));
                setMinQty("");
                setTotalCost("");
              }}
            >
              <Plus />
              Add
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CollectionsManager({
  accountId,
  products,
  collections,
  members,
  collectionTiers,
  memberProductIds,
  run,
}: {
  accountId: string;
  products: StoreProduct[];
  collections: CogsCollectionRow[];
  members: CogsCollectionMember[];
  collectionTiers: CogsCollectionTier[];
  memberProductIds: Set<string>;
  run: (action: () => Promise<{ error: { message: string } | null }>) => Promise<boolean>;
}) {
  const supabase = () => createClient();
  const [name, setName] = React.useState("");
  const titleById = new Map(products.map((product) => [product.id, product.title]));
  const free = products.filter((product) => !memberProductIds.has(product.id));

  return (
    <section className="space-y-3">
      <h2 className="label-caps">Bundles / collections ({collections.length})</h2>
      <p className="text-[12px] text-[var(--text-muted)]">
        Members share one tier table, applied to their COMBINED quantity within the same
        order — individual costs and tiers are ignored while a product is in a bundle.
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New bundle name"
          className="h-9 w-56"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={name.trim() === ""}
          onClick={async () => {
            const ok = await run(async () =>
              supabase().from("cogs_collections").insert({ ad_account_id: accountId, name: name.trim() }),
            );
            if (ok) setName("");
          }}
        >
          <FolderPlus />
          Create
        </Button>
      </div>

      {collections.map((collection) => {
        const collectionMembers = members.filter((member) => member.collection_id === collection.id);
        const tiers = collectionTiers
          .filter((tier) => tier.collection_id === collection.id)
          .sort((a, b) => a.min_qty - b.min_qty);

        return (
          <div key={collection.id} className="panel space-y-4 p-4">
            <header className="flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                {collection.name}
              </h3>
              <Button
                variant="danger"
                size="sm"
                onClick={() =>
                  run(async () =>
                    supabase().from("cogs_collections").delete().eq("id", collection.id),
                  )
                }
              >
                <Trash2 />
                Delete
              </Button>
            </header>

            <div className="flex flex-wrap items-center gap-1.5">
              {collectionMembers.map((member) => (
                <span
                  key={member.product_id}
                  className="flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1 text-[12px] text-[var(--text-primary)]"
                >
                  {titleById.get(member.product_id) ?? "?"}
                  <button
                    type="button"
                    onClick={() =>
                      run(async () =>
                        supabase()
                          .from("cogs_collection_members")
                          .delete()
                          .eq("collection_id", collection.id)
                          .eq("product_id", member.product_id),
                      )
                    }
                    className="transition-smooth text-[var(--text-muted)] hover:text-[var(--danger-red)]"
                    aria-label="Remove member"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}

              {free.length > 0 && (
                <Select
                  value=""
                  onValueChange={(productId) =>
                    run(async () =>
                      supabase()
                        .from("cogs_collection_members")
                        .insert({ collection_id: collection.id, product_id: productId }),
                    )
                  }
                >
                  <SelectTrigger className="h-8 w-44 text-[12px]">
                    <SelectValue placeholder="+ Add product" />
                  </SelectTrigger>
                  <SelectContent>
                    {free.map((product) => (
                      <SelectItem key={product.id} value={product.id}>
                        {product.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <TierEditor
              title="Bundle tiers"
              hint="Total cost for the combined min. quantity across members."
              tiers={tiers.map((tier) => ({
                id: tier.id,
                minQty: tier.min_qty,
                totalCost: Number(tier.total_cost),
              }))}
              onAdd={(minQty, totalCost) =>
                run(async () =>
                  supabase()
                    .from("cogs_collection_tiers")
                    .insert({ collection_id: collection.id, min_qty: minQty, total_cost: totalCost }),
                )
              }
              onDelete={(id) =>
                run(async () => supabase().from("cogs_collection_tiers").delete().eq("id", id))
              }
            />
          </div>
        );
      })}
    </section>
  );
}
