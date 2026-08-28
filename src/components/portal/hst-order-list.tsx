"use client";

import * as React from "react";
import { Coins, Loader2, PackageSearch, RefreshCw } from "lucide-react";

import type { HstOrderDisplay } from "@/lib/admin/hst-order-display";
import { Badge } from "@/components/ui/badge";
import { FormAlert } from "@/components/auth/auth-card";
import { useCogsFill } from "@/components/portal/cogs-fill";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The per-order view of a store bought through HST.
 *
 * For these stores the supplier already itemises every order — the goods, the
 * EU/US import tariff, the total — so the honest picture is per order, not a
 * cost typed per product. This reads that list live and lays it out so the €3
 * tariff sits in its own column beside the goods it rode in with, never folded
 * into either.
 *
 * It reloads on the same signal the grid used to: connecting or syncing bumps
 * the shared nonce, and the rows cascade back in. Read-only throughout — the
 * books are written by the cost sync, not here.
 */

const STAGGER_MS = 32;

type Props = {
  adAccountId: string;
  storeName: string;
};

export function HstOrderList({ adAccountId, storeName }: Props) {
  const { nonce } = useCogsFill();
  const [orders, setOrders] = React.useState<HstOrderDisplay[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Bumped on every successful load so the rows replay their entrance.
  const [reveal, setReveal] = React.useState(0);
  // The manual "Refresh"; combined with the shared nonce (connect/sync) it forms
  // the trigger below.
  const [reload, setReload] = React.useState(0);
  // The trigger whose data is on screen. While it lags the live trigger, a load
  // is in flight — that is how "loading" is known, so nothing has to set a
  // loading flag synchronously inside the effect (which the rules forbid).
  const [loaded, setLoaded] = React.useState<string | null>(null);

  const trigger = `${nonce}:${reload}`;
  const loading = loaded !== trigger;
  const slow = useSlowFlag(loading);

  // Reload on first mount, on connect/sync (nonce), and on the manual button
  // (reload). Every state update lives in a promise callback, never in the
  // effect body.
  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetch("/api/hst/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adAccountId, limit: 60 }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | { orders?: HstOrderDisplay[]; error?: string }
          | null;
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
        return body?.orders ?? [];
      })
      .then((rows) => {
        if (!active) return;
        setOrders(rows);
        setError(null);
        setReveal((value) => value + 1);
      })
      .catch((cause: unknown) => {
        if (!active || (cause as { name?: string })?.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoaded(trigger);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [adAccountId, trigger]);

  const totals = React.useMemo(() => sumOrders(orders ?? []), [orders]);
  const firstLoad = loading && orders === null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="label-caps">Orders — as HST bills them</h2>
          {orders && (
            <span className="text-[12px] text-[var(--text-muted)]">
              {orders.length} most recent
            </span>
          )}
          {loading && orders !== null && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--accent-gold-strong)]">
              <RefreshCw className="size-3 animate-spin" />
              Refreshing…
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setReload((value) => value + 1)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-secondary)] disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {error && <FormAlert>Couldn&rsquo;t load your HST orders: {error}</FormAlert>}

      {firstLoad ? (
        <div className="panel flex flex-col items-center gap-3 px-6 py-14 text-center">
          <Loader2 className="size-6 animate-spin text-[var(--accent-gold)]" />
          <p className="text-[13.5px] font-medium text-[var(--text-primary)]">
            Loading {storeName}&rsquo;s orders from HST
          </p>
          <p className="max-w-[360px] text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {slow
              ? "Still going — the supplier can take a few seconds to answer. Hang tight."
              : "This reads live from your supplier and can take a few seconds."}
          </p>
        </div>
      ) : orders && orders.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 px-6 py-12 text-center">
          <PackageSearch className="size-7 text-[var(--text-muted)]" />
          <p className="text-[13.5px] font-medium text-[var(--text-primary)]">No orders yet</p>
          <p className="max-w-[360px] text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            When HST has orders for this store&rsquo;s shop code, they show here with their goods
            cost and import duty, one row each.
          </p>
        </div>
      ) : orders ? (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border-subtle)]">
                  <th className="label-caps px-4 py-2.5 text-left">Order</th>
                  <th className="label-caps px-4 py-2.5 text-left">Recipient</th>
                  <th className="label-caps px-4 py-2.5 text-right">Sold</th>
                  <th className="label-caps px-4 py-2.5 text-right">Goods</th>
                  <th className="label-caps px-4 py-2.5 text-right">EU/US tax</th>
                  <th className="label-caps px-4 py-2.5 text-right">Total cost</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order, index) => (
                  <tr
                    // Keyed with `reveal` so a reload remounts the rows and the
                    // entrance animation plays again — the "fill in" the client
                    // asked to see on connect and sync.
                    key={`${order.platformOrderId}-${reveal}`}
                    className="order-row-in border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--bg-panel-hover)]"
                    style={{ "--row-delay": `${index * STAGGER_MS}ms` } as React.CSSProperties}
                  >
                    <td className="px-4 py-2.5">
                      <span className="block font-medium text-[var(--text-primary)]">
                        {order.orderNumber || order.platformOrderId}
                      </span>
                      <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                        {order.paidDay ?? order.platformOrderId}
                        {order.status && (
                          <Badge variant="neutral" className="py-0 text-[10px]">
                            {order.status}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="block truncate text-[var(--text-primary)]">
                        {order.recipient || "—"}
                      </span>
                      {order.country && (
                        <span className="block text-[11px] text-[var(--text-muted)]">
                          {order.country}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-[var(--text-secondary)]">
                      {order.sold != null ? money(order.sold, order.soldCurrency) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-[var(--text-secondary)]">
                      {money(order.goods, order.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {order.tariff > 0 ? (
                        <span className="font-medium text-[var(--accent-gold-strong)]">
                          {money(order.tariff, order.currency)}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold whitespace-nowrap text-[var(--text-primary)]">
                      {money(order.total, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {totals && (
                <tfoot>
                  <tr className="border-t border-[var(--border-strong)] bg-[var(--bg-base)]">
                    <td className="px-4 py-2.5 text-[12px] text-[var(--text-muted)]" colSpan={3}>
                      <span className="inline-flex items-center gap-1.5">
                        <Coins className="size-3.5 text-[var(--accent-gold)]" />
                        {orders.length} order{orders.length === 1 ? "" : "s"} shown
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap text-[var(--text-secondary)]">
                      {money(totals.goods, totals.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap text-[var(--accent-gold-strong)]">
                      {money(totals.tariff, totals.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold whitespace-nowrap text-[var(--text-primary)]">
                      {money(totals.total, totals.currency)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      ) : null}

      <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        These are the supplier&rsquo;s own figures, read live from HST — goods and the per-order
        EU/US import tariff shown apart. Both are already counted in this store&rsquo;s costs; the
        cost sync writes them to your reporting on its own.
      </p>
    </section>
  );
}

/** True once a load has been running long enough to be worth reassuring about. */
function useSlowFlag(loading: boolean): boolean {
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), 2500);
    // Reset on the way out — when loading ends or the input changes — so the
    // effect body itself never updates state synchronously.
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [loading]);
  return slow;
}

function sumOrders(
  orders: HstOrderDisplay[],
): { goods: number; tariff: number; total: number; currency: string } | null {
  if (orders.length === 0) return null;
  // Cost figures share the settlement currency; take it from the first row.
  const currency = orders[0].currency;
  let goods = 0;
  let tariff = 0;
  let total = 0;
  for (const order of orders) {
    if (order.currency !== currency) continue;
    goods += order.goods;
    tariff += order.tariff;
    total += order.total;
  }
  return { goods, tariff, total, currency };
}
