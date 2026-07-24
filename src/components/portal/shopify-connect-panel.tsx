"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Link2Off, Lock } from "lucide-react";

import type { AdAccount } from "@/lib/supabase/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { PasswordInput } from "@/components/auth/password-input";
import { FormAlert } from "@/components/auth/auth-card";

/**
 * Shopify custom-app connection for one store.
 *
 * The token field is write-only: after saving, the UI shows only the masked
 * tail (`••••1234`) that the server stored alongside the ciphertext. There is
 * no way to read the token back out — not from this UI, not from the API.
 */
/** Monospace chip for a Shopify Admin API scope handle. */
function Scope({ children }: { children: React.ReactNode }) {
  return (
    <li className="list-none rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
      {children}
    </li>
  );
}

export function ShopifyConnectPanel({ account }: { account: AdAccount }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [shopDomain, setShopDomain] = React.useState(account.shopify_url ?? "");
  const [clientId, setClientId] = React.useState(account.shopify_client_id ?? "");
  const [accessToken, setAccessToken] = React.useState("");
  const [busy, setBusy] = React.useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const connected = account.shopify_connected;
  // A shpss_ secret is only usable as a pair with the app's Client ID.
  const needsClientId = accessToken.trim().startsWith("shpss_") && clientId.trim() === "";

  async function connect() {
    setBusy("connect");
    setError(null);

    const res = await fetch("/api/shopify/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: account.id,
        shopDomain,
        clientId,
        accessToken,
      }),
    });

    setBusy(null);

    const body = (await res.json().catch(() => null)) as {
      error?: string;
      syncWarning?: string | null;
    } | null;

    if (!res.ok) {
      setError(body?.error ?? "Something went wrong. Try again.");
      return;
    }

    // Connected — but if the first sync failed, say so instead of showing a
    // linked store with a silently empty dashboard.
    if (body?.syncWarning) setError(body.syncWarning);

    setAccessToken(""); // never keep the plaintext around
    setEditing(false);
    router.refresh();
  }

  async function disconnect() {
    setBusy("disconnect");
    setError(null);

    const res = await fetch(`/api/shopify/connect?accountId=${account.id}`, {
      method: "DELETE",
    });

    setBusy(null);

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Something went wrong. Try again.");
      return;
    }

    router.refresh();
  }

  return (
    <div className="space-y-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
      <div className="flex items-center gap-2">
        <Lock className="size-3.5 text-[var(--text-muted)]" />
        <span className="label-caps">Shopify connection</span>
        <Badge variant={connected ? "success" : "neutral"}>
          {connected ? "Connected" : "Disconnected"}
        </Badge>
      </div>

      {error && <FormAlert>{error}</FormAlert>}

      {connected && !editing && (
        <>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--text-muted)]">Store</dt>
              <dd className="truncate text-[var(--text-secondary)]">
                {account.shopify_url ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--text-muted)]">Admin token</dt>
              <dd className="text-[var(--text-secondary)]">
                {account.shopify_token_last4 ? `••••••••${account.shopify_token_last4}` : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--text-muted)]">Client ID</dt>
              <dd className="truncate text-[var(--text-secondary)]">
                {account.shopify_client_id ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--text-muted)]">Scopes</dt>
              <dd className="truncate text-[var(--text-secondary)]">
                {account.shopify_scopes ?? "—"}
              </dd>
            </div>
          </dl>

          <div className="flex items-center gap-3 pt-1">
            <Button
              variant="danger"
              size="sm"
              loading={busy === "disconnect"}
              onClick={disconnect}
            >
              <Link2Off />
              Disconnect
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <KeyRound />
              Update credentials
            </Button>
          </div>
        </>
      )}

      {(!connected || editing) && (
        <div className="space-y-3">
          <div className="space-y-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            <p className="label-caps text-[var(--text-secondary)]">How to connect your store</p>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>
                In your Shopify admin, open{" "}
                <span className="text-[var(--text-secondary)]">
                  Settings → Apps and sales channels → Develop apps
                </span>{" "}
                and click <span className="text-[var(--text-secondary)]">Create an app</span> (any
                name, e.g. “Dropscale”).
              </li>
              <li>
                In the app, go to{" "}
                <span className="text-[var(--text-secondary)]">Configuration</span> →{" "}
                <span className="text-[var(--text-secondary)]">Admin API integration</span> →{" "}
                <span className="text-[var(--text-secondary)]">Configure</span>, and enable these
                read scopes:
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  <Scope>read_orders</Scope>
                  <Scope>read_all_orders</Scope>
                  <Scope>read_fulfillments</Scope>
                  <Scope>read_inventory</Scope>
                  <Scope>read_products</Scope>
                  <Scope>read_reports</Scope>
                </ul>
                <span className="mt-1 block text-[11.5px]">
                  These cover orders (incl. history &amp; refunds), fulfilment, inventory cost,
                  product prices and analytics — everything the dashboard needs, read-only. We
                  never write to your store.
                </span>
              </li>
              <li>
                Click <span className="text-[var(--text-secondary)]">Save</span>, then{" "}
                <span className="text-[var(--text-secondary)]">Install app</span> (top right).
              </li>
              <li>
                Open the <span className="text-[var(--text-secondary)]">API credentials</span> tab
                and copy, from the same screen, the{" "}
                <span className="text-[var(--text-secondary)]">API key (Client ID)</span> and the{" "}
                <span className="text-[var(--text-secondary)]">API secret key</span> (starts with{" "}
                <span className="font-mono">shpss_</span>). Paste both below, with your store URL.
              </li>
            </ol>
            <p>
              We validate the credentials against Shopify before saving; the secret is encrypted
              at rest and never shown again. A direct Admin API access token (
              <span className="font-mono">shpat_…</span>) works too, if you already have one.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`shop-domain-${account.id}`}>Store URL</Label>
              <Input
                id={`shop-domain-${account.id}`}
                placeholder="my-store.myshopify.com"
                value={shopDomain}
                onChange={(event) => setShopDomain(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`shop-client-${account.id}`}>Client ID (API key)</Label>
              <Input
                id={`shop-client-${account.id}`}
                placeholder="32-character API key"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`shop-token-${account.id}`}>
                API secret key — or Admin API access token
              </Label>
              <PasswordInput
                id={`shop-token-${account.id}`}
                placeholder="shpss_… (with Client ID) or shpat_…"
                autoComplete="off"
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
              />
              {needsClientId && (
                <p className="text-[11.5px] text-[var(--warning-orange)]">
                  A secret key (shpss_…) needs the Client ID above to pair with.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={shopDomain.trim() === "" || accessToken.trim() === "" || needsClientId}
              loading={busy === "connect"}
              onClick={connect}
            >
              {connected ? "Save new credentials" : "Connect Shopify"}
            </Button>
            {editing && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
