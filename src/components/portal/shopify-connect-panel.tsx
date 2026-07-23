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
          <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            In your Shopify admin: Settings → Apps and sales channels → Develop apps →
            your app → API credentials. Paste the store URL, the{" "}
            <span className="text-[var(--text-secondary)]">Client ID (API key)</span> and
            the <span className="text-[var(--text-secondary)]">API secret key</span>{" "}
            (shpss_…) — copy both from the same tab, as a pair. A direct Admin API
            access token (shpat_…) works too. We validate against Shopify before
            saving, and the secret is encrypted at rest — never shown again after
            this.
          </p>

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
