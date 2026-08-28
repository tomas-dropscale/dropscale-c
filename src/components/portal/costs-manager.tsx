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
  Truck,
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
import { useCogsFill } from "@/components/portal/cogs-fill";
import { money } from "@/lib/format";
import { fmt, type Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { Rich } from "@/components/ui/rich-text";
import { cn } from "@/lib/utils";

/**
 * The Costs page body: product list with inline effective-dated cost edits,
 * per-product tier editor, collections (bundles) and the store's cost
 * settings. Every write is an RLS-checked query on the client's own rows,
 * followed by a rollup resync — the dashboard's profit follows within one
 * round-trip, and REVENUE never moves.
 */

const DEBOUNCE_MS = 800;
/** Fill animation: how long one cell takes, and the gap between rows. */
const FILL_MS = 620;
const STAGGER_MS = 45;

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
  const { d } = useI18n();
  const { nonce } = useCogsFill();
  const supabase = () => createClient();
  const [error, setError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  // The supplier "fill in": while a pull is in flight the cost cells shimmer,
  // and when the fresh costs land each newcomer cascades in. `filled` maps a
  // product to its place in that cascade and is empty at rest.
  const [filling, setFilling] = React.useState(false);
  const [filled, setFilled] = React.useState<Map<string, number>>(new Map());
  const pendingRef = React.useRef(false);
  const prevCostRef = React.useRef<Map<string, number>>(new Map());
  const firstNonce = React.useRef(nonce);

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

  /**
   * The cost actually in force today, per product — the SAME one the profit
   * engine resolves. That means the most recent record effective on or before
   * today and, on a same-day tie, the supplier's figure over a manual one
   * (loadCostContext.preferred). Reading it any other way let the grid show a
   * number the client's profit was not computed from.
   */
  const currentByProduct = React.useMemo(() => {
    const now = today();
    const map = new Map<string, ProductCost | null>();
    for (const [productId, history] of costsByProduct) {
      let best: ProductCost | null = null;
      for (const record of history) {
        if (record.effective_from > now) continue;
        if (!best) {
          best = record;
          continue;
        }
        if (record.effective_from < best.effective_from) break;
        if (record.source === "hst" && best.source !== "hst") best = record;
      }
      map.set(productId, best);
    }
    return map;
  }, [costsByProduct]);

  const currentCost = (productId: string): ProductCost | null =>
    currentByProduct.get(productId) ?? null;

  // A supplier pull began (nonce bumped by the panel above): shimmer until the
  // refreshed costs arrive. A safety timer clears it if the pull failed or
  // changed nothing, so the table never shimmers forever.
  React.useEffect(() => {
    if (nonce === firstNonce.current) return;
    pendingRef.current = true;
    setFilling(true);
    const safety = setTimeout(() => {
      pendingRef.current = false;
      setFilling(false);
    }, 8000);
    return () => clearTimeout(safety);
  }, [nonce]);

  // Fresh costs landed. If a pull is pending, cascade every cost that newly
  // appeared or changed, in table order; otherwise just keep the baseline the
  // next diff compares against.
  React.useEffect(() => {
    const snapshot = new Map<string, number>();
    for (const product of products) {
      const record = currentByProduct.get(product.id);
      if (record) snapshot.set(product.id, Number(record.cost));
    }

    if (!pendingRef.current) {
      prevCostRef.current = snapshot;
      return;
    }

    const stagger = new Map<string, number>();
    let step = 0;
    for (const product of products) {
      const next = snapshot.get(product.id);
      if (next === undefined) continue;
      const prev = prevCostRef.current.get(product.id);
      if (prev === undefined || Math.abs(prev - next) > 1e-6) {
        stagger.set(product.id, step);
        step += 1;
      }
    }
    prevCostRef.current = snapshot;
    pendingRef.current = false;
    setFilling(false);
    setFilled(stagger);
    if (step === 0) return;
    const clear = setTimeout(
      () => setFilled(new Map()),
      (step - 1) * STAGGER_MS + FILL_MS + 150,
    );
    return () => clearTimeout(clear);
  }, [costs, products, currentByProduct]);

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
      setError(body?.error ?? d.costs.syncFailed);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-8">
      {error && <FormAlert>{error}</FormAlert>}

      {/* ---- store cost settings ------------------------------------------ */}
      <CostSettings account={account} d={d} onSaved={resync} onError={setError} />

      {/* ---- products ------------------------------------------------------ */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="label-caps">{fmt(d.costs.products, { count: products.length })}</h2>
            {filling && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--accent-gold-strong)]">
                <RefreshCw className="size-3 animate-spin" />
                {d.costs.supplierFilling}
              </span>
            )}
          </div>
          <Button variant="secondary" size="sm" loading={syncing} onClick={syncProducts}>
            <RefreshCw />
            {d.costs.syncProducts}
          </Button>
        </div>

        {products.length === 0 ? (
          <p className="panel px-5 py-10 text-center text-[13px] text-[var(--text-secondary)]">
            {d.costs.noProducts}
          </p>
        ) : (
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="label-caps px-4 py-2.5 text-left">{d.costs.product}</th>
                    <th className="label-caps px-4 py-2.5 text-right">{d.costs.price}</th>
                    <th className="label-caps px-4 py-2.5 text-right">{d.costs.cost}</th>
                    <th className="label-caps px-4 py-2.5 text-left">{d.costs.source}</th>
                    <th className="label-caps px-4 py-2.5 text-right">{d.costs.tiers}</th>
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
                    // Supplier costs update hourly and win the day, so the cell
                    // shows the figure rather than an input that could not
                    // override it. During a pull, cells cascade or shimmer.
                    const isHst = record?.source === "hst";
                    const fillIndex = filled.get(product.id);
                    const isFilling = fillIndex !== undefined;
                    const isShimmer = filling && !isFilling;

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
                            <div
                              className={cn(
                                "ml-auto w-24",
                                isFilling && "cost-fill",
                                isShimmer && "cost-shimmer",
                              )}
                              style={
                                isFilling
                                  ? ({
                                      "--fill-delay": `${(fillIndex ?? 0) * STAGGER_MS}ms`,
                                    } as React.CSSProperties)
                                  : undefined
                              }
                            >
                              {isHst && record ? (
                                <div
                                  className="flex h-8 items-center justify-end gap-1 rounded-[8px] border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] px-2 text-[13px] font-medium text-[var(--text-primary)]"
                                  title={d.costs.supplierManagedHint}
                                >
                                  {money(record.cost, record.currency)}
                                </div>
                              ) : (
                                <Input
                                  value={drafts[product.id] ?? (record ? String(record.cost) : "")}
                                  onChange={(event) =>
                                    scheduleCostSave(product.id, event.target.value)
                                  }
                                  placeholder={fallback.toFixed(2)}
                                  inputMode="decimal"
                                  className="h-8 w-full text-right"
                                  aria-label={fmt(d.costs.costOf, { product: product.title })}
                                />
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            {inCollection ? (
                              <Badge variant="gold">{d.costs.sourceBundle}</Badge>
                            ) : isHst ? (
                              <Badge variant="gold">
                                <Truck className="size-3" />
                                {d.costs.sourceSupplier}
                              </Badge>
                            ) : record ? (
                              <Badge variant="success">{d.costs.sourceManual}</Badge>
                            ) : (
                              <Badge variant="neutral">
                                {fmt(d.costs.sourceDefault, {
                                  pct: Number(account.default_product_cost_pct),
                                })}
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
                                  d={d}
                                  history={costsByProduct.get(product.id) ?? []}
                                  onDelete={(id) =>
                                    run(async () =>
                                      supabase().from("product_costs").delete().eq("id", id),
                                    )
                                  }
                                />
                                <TierEditor
                                  d={d}
                                  title={d.costs.quantityTiers}
                                  hint={d.costs.quantityTiersHint}
                                  tiers={productTiers.map((tier) => ({
                                    id: tier.id,
                                    minQty: tier.min_qty,
                                    totalCost: Number(tier.total_cost),
                                  }))}
                                  disabled={inCollection}
                                  disabledHint={d.costs.inBundleHint}
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
        d={d}
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
  d,
  onSaved,
  onError,
}: {
  account: AdAccount;
  /** Passed down rather than re-read: these all render inside one client tree. */
  d: Dictionary;
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
    [d.costs.defaultCostPct, d.costs.defaultCostPctHint, pct, setPct],
    [d.costs.paymentFeePct, d.costs.paymentFeePctHint, feePct, setFeePct],
    [
      fmt(d.costs.paymentFeeFixed, { currency: account.currency }),
      d.costs.paymentFeeFixedHint,
      feeFixed,
      setFeeFixed,
    ],
    [
      fmt(d.costs.shippingPerOrder, { currency: account.currency }),
      d.costs.shippingPerOrderHint,
      shipping,
      setShipping,
    ],
  ];

  return (
    <section className="panel space-y-4 p-5">
      <h2 className="label-caps">{d.costs.settings}</h2>
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
        {d.costs.saveSettings}
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------

function CostHistory({
  d,
  history,
  onDelete,
}: {
  d: Dictionary;
  history: ProductCost[];
  onDelete: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="label-caps flex items-center gap-1.5">
        <History className="size-3.5" />
        {d.costs.history}
      </p>
      {history.length === 0 ? (
        <p className="text-[12.5px] text-[var(--text-muted)]">{d.costs.noHistory}</p>
      ) : (
        <ul className="space-y-1">
          {history.map((record, index) => (
            <li
              key={record.id}
              className="flex items-center justify-between gap-3 rounded-[8px] bg-[var(--bg-panel)] px-3 py-1.5 text-[12.5px]"
            >
              <span className="text-[var(--text-secondary)]">
                {d.costs.from}{" "}
                <span className="text-[var(--text-primary)]">{record.effective_from}</span>
                {index === 0 && (
                  <span className="ml-2 text-[10.5px] text-[var(--accent-gold)]">
                    {d.costs.current}
                  </span>
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
                  aria-label={d.costs.deleteCostRecord}
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
  d,
  title,
  hint,
  tiers,
  disabled = false,
  disabledHint,
  onAdd,
  onDelete,
}: {
  d: Dictionary;
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
                  <Rich
                    text={fmt(d.costs.tierRow, {
                      qty: tier.minQty,
                      cost: tier.totalCost.toFixed(2),
                    })}
                  />
                </span>
                <button
                  type="button"
                  onClick={() => onDelete(tier.id)}
                  className="transition-smooth text-[var(--text-muted)] hover:text-[var(--danger-red)]"
                  aria-label={d.costs.deleteTier}
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
              placeholder={d.costs.minQty}
              inputMode="numeric"
              className="h-8 w-20"
            />
            <Input
              value={totalCost}
              onChange={(event) => setTotalCost(event.target.value)}
              placeholder={d.costs.totalCost}
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
              {d.costs.add}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CollectionsManager({
  d,
  accountId,
  products,
  collections,
  members,
  collectionTiers,
  memberProductIds,
  run,
}: {
  d: Dictionary;
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
      <h2 className="label-caps">{fmt(d.costs.bundles, { count: collections.length })}</h2>
      <p className="text-[12px] text-[var(--text-muted)]">{d.costs.bundlesHint}</p>

      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={d.costs.newBundleName}
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
          {d.costs.create}
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
                {d.costs.delete}
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
                    aria-label={d.costs.removeMember}
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
                    <SelectValue placeholder={d.costs.addProduct} />
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
              d={d}
              title={d.costs.bundleTiers}
              hint={d.costs.bundleTiersHint}
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
