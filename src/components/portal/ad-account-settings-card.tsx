"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BarChart3, Info, Store, Unplug } from "lucide-react";

import type { AdAccount } from "@/lib/supabase/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/provider";

const STATUS_VARIANT: Record<AdAccount["status"], "success" | "warning"> = {
  active: "success",
  suspended: "warning",
  pending: "warning",
};

export function AdAccountSettingsCard({ account }: { account: AdAccount }) {
  const router = useRouter();
  const { d } = useI18n();
  const searchParams = useSearchParams();
  const [customerId, setCustomerId] = React.useState(account.google_ads_customer_id ?? "");
  const [breakevenRoas, setBreakevenRoas] = React.useState(
    account.breakeven_roas != null ? String(account.breakeven_roas) : "",
  );
  const [lifetimeBudget, setLifetimeBudget] = React.useState(
    account.lifetime_ads_budget_usd != null ? String(account.lifetime_ads_budget_usd) : "",
  );
  const [saving, setSaving] = React.useState(false);
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const statusLabel: Record<AdAccount["status"], string> = {
    active: d.accounts.statusActive,
    suspended: d.accounts.statusSuspended,
    pending: d.accounts.statusPending,
  };

  // Feedback from the OAuth round-trip (?gads=connected|denied|error|…).
  const gads = searchParams.get("gads");

  // A saved Customer ID is what the live query targets — connect is pointless
  // without it, so it gates the button.
  const savedCustomerId = (account.google_ads_customer_id ?? "").trim();
  const customerIdDirty = customerId.trim() !== savedCustomerId;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);

    const { error: updateError } = await createClient()
      .from("ad_accounts")
      .update({
        google_ads_customer_id: customerId.trim() === "" ? null : customerId.trim(),
        breakeven_roas: breakevenRoas.trim() === "" ? null : Number(breakevenRoas),
        lifetime_ads_budget_usd:
          lifetimeBudget.trim() === "" ? null : Number(lifetimeBudget),
        // shopify_url is owned by the Shopify connection flow (Settings →
        // Shopify): it is set from the store Shopify itself reports, so a
        // free-text field here would silently break a working connection.
      })
      .eq("id", account.id);

    setSaving(false);

    if (updateError) {
      // The unique index from migration 0026 surfaces as a Postgres 23505. Its
      // raw message names an index, which tells a client nothing; what they
      // need to know is that the ad account is already in use somewhere else.
      setError(
        updateError.code === "23505"
          ? "That Google Ads account is already linked to another store. One Google " +
            "Ads account can only belong to one store — otherwise its spend would be " +
            "counted twice."
          : updateError.message,
      );
      return;
    }

    setSaved(true);
    router.refresh();
  }

  async function disconnectGoogleAds() {
    setDisconnecting(true);
    setError(null);

    const { error: updateError } = await createClient()
      .from("ad_accounts")
      .update({
        google_ads_refresh_token: null,
        google_ads_connected_email: null,
        google_ads_connected: false,
      })
      .eq("id", account.id);

    setDisconnecting(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }
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
        <Badge variant={STATUS_VARIANT[account.status]}>{statusLabel[account.status]}</Badge>
      </header>

      {error && <FormAlert>{error}</FormAlert>}
      {saved && <FormAlert tone="success">{d.accounts.saved}</FormAlert>}
      {gads === "connected" && <FormAlert tone="success">{d.accounts.gadsConnected}</FormAlert>}
      {gads === "denied" && <FormAlert>{d.accounts.gadsDenied}</FormAlert>}
      {gads === "error" && (
        <FormAlert>{d.accounts.gadsError}</FormAlert>
      )}
      {gads === "unconfigured" && (
        <FormAlert>{d.accounts.gadsUnconfigured}</FormAlert>
      )}

      {/* Google Ads connection */}
      <div className="space-y-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="size-3.5 text-[var(--text-muted)]" />
          <span className="label-caps">Google Ads</span>
          <Badge variant={account.google_ads_connected ? "success" : "neutral"}>
            {account.google_ads_connected ? d.accounts.connected : d.accounts.notConnected}
          </Badge>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`gads-cid-${account.id}`}>{d.accounts.customerId}</Label>
          <Input
            id={`gads-cid-${account.id}`}
            placeholder={d.accounts.customerIdPlaceholder}
            inputMode="numeric"
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
          />
        </div>

        {account.google_ads_connected ? (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {account.google_ads_connected_email && (
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-secondary)]">
                {account.google_ads_connected_email}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={disconnectGoogleAds}
              loading={disconnecting}
            >
              <Unplug />
              {d.accounts.disconnect}
            </Button>
          </div>
        ) : savedCustomerId === "" ? (
          <p className="text-[12px] text-[var(--text-muted)]">
            {d.accounts.saveThenConnect}
          </p>
        ) : customerIdDirty ? (
          <p className="text-[12px] text-[var(--text-muted)]">
            {d.accounts.saveCustomerIdFirst}
          </p>
        ) : (
          <Button variant="primary" size="sm" asChild>
            <a href={`/api/google-ads/connect?account=${account.id}`}>
              <BarChart3 />
              {d.accounts.connectGoogleAds}
            </a>
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`roas-${account.id}`}>{d.accounts.breakevenRoas}</Label>
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
            {d.accounts.lifetimeBudget}
            <span title={d.accounts.lifetimeBudgetHelp}>
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

      </div>

      <Button variant="primary" onClick={save} loading={saving}>
        {d.accounts.saveChanges}
      </Button>
    </section>
  );
}
