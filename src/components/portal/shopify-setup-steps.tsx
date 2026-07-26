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
 */

/** The scopes the sync actually uses, and what each one buys. */
const SCOPES: { handle: string; unlocks: string; required?: boolean }[] = [
  {
    handle: "read_orders",
    unlocks: "revenue, orders and refunds — nothing syncs without it",
    required: true,
  },
  { handle: "read_all_orders", unlocks: "history beyond the last 60 days" },
  { handle: "read_products", unlocks: "product prices and collections, for COGS and revenue share" },
  { handle: "read_fulfillments", unlocks: "shipping status on the orders we read" },
  { handle: "read_inventory", unlocks: "stock and unit cost" },
  { handle: "read_reports", unlocks: "store analytics" },
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
  return (
    <div className="space-y-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
      <p className="label-caps text-[var(--text-secondary)]">How to connect your store</p>
      <ol className="list-decimal space-y-1.5 pl-4">
        <li>
          In your Shopify admin, open{" "}
          <span className="text-[var(--text-secondary)]">
            Settings → Apps and sales channels → Develop apps
          </span>{" "}
          and click <span className="text-[var(--text-secondary)]">Create an app</span> (any name,
          e.g. “Dropscale”).
        </li>
        <li>
          In the app, go to <span className="text-[var(--text-secondary)]">Configuration</span> →{" "}
          <span className="text-[var(--text-secondary)]">Admin API integration</span> →{" "}
          <span className="text-[var(--text-secondary)]">Configure</span>, and enable every one of
          these read scopes:
          <ul className="mt-2 space-y-1.5">
            {SCOPES.map((scope) => (
              <li key={scope.handle} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <Scope>{scope.handle}</Scope>
                <span className="text-[11.5px]">
                  {scope.unlocks}
                  {scope.required && (
                    <span className="ml-1.5 font-medium text-[var(--accent-gold-strong)]">
                      required
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <span className="mt-2 block text-[11.5px]">
            All read-only — we never write to your store. Note that{" "}
            <span className="font-mono">read_all_orders</span> does <strong>not</strong> include{" "}
            <span className="font-mono">read_orders</span>: it only extends it past 60 days, so
            tick both.
          </span>
        </li>
        <li>
          Click <span className="text-[var(--text-secondary)]">Save</span>, then{" "}
          <span className="text-[var(--text-secondary)]">Install app</span> (top right).
        </li>
        <li>
          Open the <span className="text-[var(--text-secondary)]">API credentials</span> tab and
          copy, from the same screen, the{" "}
          <span className="text-[var(--text-secondary)]">API key (Client ID)</span> and the{" "}
          <span className="text-[var(--text-secondary)]">API secret key</span> (starts with{" "}
          <span className="font-mono">shpss_</span>). Paste both below, with your store URL.
        </li>
      </ol>
      <p>
        We validate the credentials against Shopify before saving; the secret is encrypted at rest
        and never shown again. A direct Admin API access token (
        <span className="font-mono">shpat_…</span>) works too, if you already have one.
      </p>
    </div>
  );
}
