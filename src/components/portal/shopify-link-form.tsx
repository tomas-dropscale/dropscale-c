"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Link2, Store } from "lucide-react";

import type { AdAccount } from "@/lib/supabase/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { PasswordInput } from "@/components/auth/password-input";
import { FormAlert } from "@/components/auth/auth-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * "Link a Shopify store" — the client picks WHICH ad account the store maps
 * to, then pastes the custom-app credentials. Clients run several stores,
 * each with its own ad account; the mapping is the point, not an afterthought.
 *
 * Same POST as the per-account panel; the dropdown supplies the accountId.
 */
export function ShopifyLinkForm({ accounts }: { accounts: AdAccount[] }) {
  const router = useRouter();
  const [accountId, setAccountId] = React.useState(accounts[0]?.id ?? "");
  const [shopDomain, setShopDomain] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [accessToken, setAccessToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const needsClientId = accessToken.trim().startsWith("shpss_") && clientId.trim() === "";
  const incomplete = !accountId || shopDomain.trim() === "" || accessToken.trim() === "";

  async function connect() {
    setBusy(true);
    setError(null);
    setNotice(null);

    const res = await fetch("/api/shopify/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, shopDomain, clientId, accessToken }),
    });

    const body = (await res.json().catch(() => null)) as {
      error?: string;
      syncWarning?: string | null;
    } | null;

    setBusy(false);

    if (!res.ok) {
      setError(body?.error ?? "Something went wrong. Try again.");
      return;
    }

    if (body?.syncWarning) setNotice(body.syncWarning);
    setAccessToken(""); // never keep the plaintext around
    setShopDomain("");
    setClientId("");
    router.refresh();
  }

  return (
    <section className="panel space-y-4 p-5">
      <header className="flex items-center gap-2.5">
        <Link2 className="size-4 text-[var(--accent-gold)]" />
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          Link a Shopify store
        </h2>
      </header>

      {error && <FormAlert>{error}</FormAlert>}
      {notice && <FormAlert tone="success">{notice}</FormAlert>}

      <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
        Pick which ad account this store belongs to, then paste the credentials from
        your Shopify admin: Settings → Apps and sales channels → Develop apps → your
        app → API credentials. Copy Client ID and API secret key together, as a pair.
        The secret is validated against Shopify and encrypted — never shown again.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="link-account">Ad account</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger id="link-account" className="w-full">
              <span className="flex min-w-0 items-center gap-2">
                <Store className="size-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
                <span className="truncate">
                  <SelectValue />
                </span>
              </span>
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.store_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="link-domain">Store URL</Label>
          <Input
            id="link-domain"
            placeholder="my-store.myshopify.com"
            value={shopDomain}
            onChange={(event) => setShopDomain(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="link-client">Client ID (API key)</Label>
          <Input
            id="link-client"
            placeholder="32-character API key"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="link-token">API secret key — or Admin token</Label>
          <PasswordInput
            id="link-token"
            placeholder="shpss_… (with Client ID) or shpat_…"
            autoComplete="off"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
          />
          {needsClientId && (
            <p className="text-[11.5px] text-[var(--warning-orange)]">
              A secret key (shpss_…) needs the Client ID to pair with.
            </p>
          )}
        </div>
      </div>

      <Button
        variant="primary"
        size="sm"
        disabled={incomplete || needsClientId}
        loading={busy}
        onClick={connect}
      >
        Connect store
      </Button>
    </section>
  );
}
