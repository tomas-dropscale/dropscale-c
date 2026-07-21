"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Info, KeyRound, Lock, Store } from "lucide-react";

import type { AdAccount } from "@/lib/supabase/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";

const STATUS_BADGE: Record<
  AdAccount["status"],
  { label: string; variant: "success" | "warning" }
> = {
  active: { label: "Active", variant: "success" },
  suspended: { label: "Suspended", variant: "warning" },
  pending: { label: "Pending", variant: "warning" },
};

export function AdAccountSettingsCard({ account }: { account: AdAccount }) {
  const router = useRouter();
  const [breakevenRoas, setBreakevenRoas] = React.useState(
    account.breakeven_roas != null ? String(account.breakeven_roas) : "",
  );
  const [lifetimeBudget, setLifetimeBudget] = React.useState(
    account.lifetime_ads_budget_usd != null ? String(account.lifetime_ads_budget_usd) : "",
  );
  const [shopifyUrl, setShopifyUrl] = React.useState(account.shopify_url ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const status = STATUS_BADGE[account.status];

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);

    const { error: updateError } = await createClient()
      .from("ad_accounts")
      .update({
        breakeven_roas: breakevenRoas.trim() === "" ? null : Number(breakevenRoas),
        lifetime_ads_budget_usd:
          lifetimeBudget.trim() === "" ? null : Number(lifetimeBudget),
        shopify_url: shopifyUrl.trim() === "" ? null : shopifyUrl.trim(),
      })
      .eq("id", account.id);

    setSaving(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSaved(true);
    router.refresh();
  }

  return (
    <section className="panel space-y-5 p-5">
      <header className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-[10px] bg-[var(--accent-gold-dim)]">
          <Store className="size-4 text-[var(--accent-gold)]" />
        </div>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--text-primary)]">
          {account.store_name}
        </h2>
        <Badge variant={status.variant}>{status.label}</Badge>
      </header>

      {error && <FormAlert>{error}</FormAlert>}
      {saved && <FormAlert tone="success">Account settings saved.</FormAlert>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`roas-${account.id}`}>Breakeven ROAS</Label>
          <Input
            id={`roas-${account.id}`}
            type="number"
            min="0"
            step="0.1"
            placeholder="e.g. 2.5"
            value={breakevenRoas}
            onChange={(event) => setBreakevenRoas(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor={`budget-${account.id}`}
            className="flex items-center gap-1.5"
          >
            Lifetime ads budget (USD)
            <span title="Total budget available for this account across its lifetime. Used for pacing.">
              <Info className="size-3.5 text-[var(--text-muted)]" />
            </span>
          </Label>
          <Input
            id={`budget-${account.id}`}
            type="number"
            min="0"
            step="500"
            placeholder="e.g. 25000"
            value={lifetimeBudget}
            onChange={(event) => setLifetimeBudget(event.target.value)}
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`shopify-${account.id}`}>Shopify URL</Label>
          <Input
            id={`shopify-${account.id}`}
            placeholder="e.g. my-store.myshopify.com"
            value={shopifyUrl}
            onChange={(event) => setShopifyUrl(event.target.value)}
          />
        </div>
      </div>

      {/* Shopify credentials — read-only; managed via Update credentials */}
      <div className="space-y-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div className="flex items-center gap-2">
          <Lock className="size-3.5 text-[var(--text-muted)]" />
          <span className="label-caps">Shopify credentials</span>
          <Badge variant={account.shopify_connected ? "success" : "neutral"}>
            {account.shopify_connected ? "Connected" : "Disconnected"}
          </Badge>
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2">
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--text-muted)]">Store</dt>
            <dd className="truncate text-[var(--text-secondary)]">
              {account.shopify_url ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--text-muted)]">Currency</dt>
            <dd className="text-[var(--text-secondary)]">{account.currency}</dd>
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
          {/* Placeholder actions until the real Shopify integration exists */}
          <button
            type="button"
            className="transition-smooth text-[12.5px] text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--danger-red)] hover:underline"
          >
            Disconnect
          </button>
          <Button variant="outline" size="sm">
            <KeyRound />
            Update credentials
          </Button>
        </div>
      </div>

      <Button variant="primary" onClick={save} loading={saving}>
        Save changes
      </Button>
    </section>
  );
}
