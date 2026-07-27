"use client";

import { Rich } from "@/components/ui/rich-text";
import type { Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/**
 * How to create the Shopify custom app, and — the part clients get wrong —
 * exactly which Admin API read scopes it needs.
 *
 * Shared by BOTH connect surfaces: the onboarding form (a store being linked
 * for the first time) and the per-store panel (credentials being replaced).
 * It used to live only in the panel, which onboarding never renders, so the
 * people who most needed the scope list were the only ones who never saw it.
 *
 * Read-only throughout: nothing here grants write access to a client's store.
 *
 * The steps are single translated strings with `**…**` around the Shopify menu
 * names, rendered by <Rich>. Splitting each sentence into fragments so the code
 * could style them would force English word order onto five languages.
 */

/**
 * The scopes to enable on the custom app, and what each one buys. The handle is
 * a Shopify identifier and never translates; only the explanation does.
 *
 * Ordered by how much the platform depends on them:
 *   · read_orders     — the sync is built on it, and the connect route REFUSES
 *                       a token without it. The only one marked required.
 *   · read_all_orders — widens history past Shopify's 60-day default.
 *   · read_products   — collection lookups, for revenue share and COGS. Missing
 *                       it degrades to empty rather than failing.
 *   · the rest        — granted so the app is provisioned once and covers what
 *                       is coming (fulfilment state, stock and unit cost,
 *                       store analytics). No query reads them TODAY, so nothing
 *                       breaks if a client leaves one off; they are here so a
 *                       client isn't asked to revisit their app later.
 */
const SCOPES: { handle: string; dict: keyof Dictionary["shopify"]; required?: boolean }[] = [
  { handle: "read_orders", dict: "scopeOrders", required: true },
  { handle: "read_all_orders", dict: "scopeAllOrders" },
  { handle: "read_products", dict: "scopeProducts" },
  { handle: "read_analytics", dict: "scopeAnalytics" },
  { handle: "read_fulfillments", dict: "scopeFulfillments" },
  { handle: "read_inventory", dict: "scopeInventory" },
];

/** Monospace chip for a Shopify Admin API scope handle. */
export function Scope({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
      {children}
    </span>
  );
}

export function ShopifySetupSteps() {
  const { d } = useI18n();

  return (
    <div className="space-y-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
      <p className="label-caps text-[var(--text-secondary)]">{d.shopify.setupTitle}</p>
      <ol className="list-decimal space-y-1.5 pl-4">
        <li>
          <Rich text={d.shopify.setupStep1} className="text-[var(--text-secondary)] font-normal" />
        </li>
        <li>
          <Rich text={d.shopify.setupStep2} className="text-[var(--text-secondary)] font-normal" />
          <ul className="mt-2 space-y-1.5">
            {SCOPES.map((scope) => (
              <li key={scope.handle} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <Scope>{scope.handle}</Scope>
                <span className="text-[11.5px]">
                  {d.shopify[scope.dict]}
                  {scope.required && (
                    <span className="ml-1.5 font-medium text-[var(--accent-gold-strong)]">
                      {d.shopify.required}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <span className="mt-2 block text-[11.5px]">
            <Rich text={d.shopify.scopesNote} as="strong" />
          </span>
        </li>
        <li>
          <Rich text={d.shopify.setupStep3} className="text-[var(--text-secondary)] font-normal" />
        </li>
        <li>
          <Rich text={d.shopify.setupStep4} className="text-[var(--text-secondary)] font-normal" />
        </li>
      </ol>
      <p>{d.shopify.setupFooter}</p>
    </div>
  );
}
