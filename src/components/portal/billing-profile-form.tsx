"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, User } from "lucide-react";

import type { BillingProfile, BillingProfileType, Client } from "@/lib/supabase/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const CURRENCIES = ["EUR", "USD", "GBP"] as const;

export function BillingProfileForm({
  viewer,
  workspaceId,
  workspaceName,
  profile,
}: {
  /** Who is signed in — the read-only identity block. */
  viewer: Client;
  /** Whose billing profile is being edited: the workspace owner's id. */
  workspaceId: string;
  /** Set only when the viewer is a sócio, so the form says whose profile this is. */
  workspaceName?: string | null;
  profile: BillingProfile | null;
}) {
  const router = useRouter();
  const { d } = useI18n();
  const [profileType, setProfileType] = React.useState<BillingProfileType>(
    profile?.profile_type ?? "individual",
  );
  const [currency, setCurrency] = React.useState(profile?.currency ?? "EUR");
  const [budget, setBudget] = React.useState(
    profile?.available_budget != null ? String(profile.available_budget) : "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);

    const { error: upsertError } = await createClient()
      .from("billing_profiles")
      .upsert({
        client_id: workspaceId,
        profile_type: profileType,
        currency,
        available_budget: budget.trim() === "" ? null : Number(budget),
        updated_at: new Date().toISOString(),
      });

    setSaving(false);

    if (upsertError) {
      setError(upsertError.message);
      return;
    }

    setSaved(true);
    router.refresh();
  }

  return (
    <div className="max-w-[560px] space-y-7">
      {error && <FormAlert>{error}</FormAlert>}
      {saved && <FormAlert tone="success">{d.billing.saved}</FormAlert>}

      {/* ACCOUNT — read-only, managed by the team */}
      <section className="space-y-3">
        <p className="label-caps">{d.billing.account}</p>
        <div className="panel divide-y divide-[var(--border-subtle)]">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13px] text-[var(--text-secondary)]">{d.billing.name}</span>
            <span className="text-[13px] font-medium text-[var(--text-primary)]">
              {viewer.full_name}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13px] text-[var(--text-secondary)]">{d.billing.email}</span>
            <span className="text-[13px] font-medium text-[var(--text-primary)]">
              {viewer.email}
            </span>
          </div>
        </div>
      </section>

      {/* BILLING PROFILE */}
      <section className="space-y-3">
        <p className="label-caps">{d.billing.profile}</p>
        {/* A sócio edits the BUSINESS's billing profile, not a personal one —
            say so, or the change looks like it applies to them. */}
        {workspaceName && (
          <p className="text-[12px] text-[var(--text-muted)]">
            {fmt(d.team.billingBelongsTo, { name: workspaceName })}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(
            [
              {
                value: "company",
                icon: Building2,
                title: d.billing.company,
                subtitle: d.billing.companyHint,
              },
              {
                value: "individual",
                icon: User,
                title: d.billing.individual,
                subtitle: d.billing.individualHint,
              },
            ] as const
          ).map((option) => {
            const selected = profileType === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setProfileType(option.value)}
                aria-pressed={selected}
                className={cn(
                  "panel transition-smooth flex flex-col items-start gap-2 p-4 text-left",
                  selected
                    ? "border-[var(--accent-gold)]/60 bg-[var(--accent-gold-dim)]"
                    : "hover:border-[var(--border-strong)] hover:bg-[var(--bg-panel-hover)]",
                )}
              >
                <option.icon
                  className={cn(
                    "size-5",
                    selected ? "text-[var(--accent-gold)]" : "text-[var(--text-muted)]",
                  )}
                />
                <span className="text-[14px] font-semibold text-[var(--text-primary)]">
                  {option.title}
                </span>
                <span className="text-[12px] text-[var(--text-secondary)]">
                  {option.subtitle}
                </span>
              </button>
            );
          })}
        </div>

        <div className="space-y-1.5 pt-2">
          <Label htmlFor="budget">{d.billing.availableBudget}</Label>
          <div className="flex gap-2">
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger className="w-[96px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              id="budget"
              type="number"
              min="0"
              step="100"
              placeholder={d.billing.budgetPlaceholder}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              className="flex-1"
            />
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
            {d.billing.budgetHelp}
          </p>
        </div>
      </section>

      <Button variant="primary" size="lg" onClick={save} loading={saving}>
        {d.billing.saveSettings}
      </Button>
    </div>
  );
}
