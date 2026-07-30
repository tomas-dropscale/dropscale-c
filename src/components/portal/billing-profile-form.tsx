"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, User } from "lucide-react";

import type { BillingProfile, BillingProfileType, Client } from "@/lib/supabase/types";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
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
  const [fullName, setFullName] = React.useState(viewer.full_name);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  /**
   * Saves both halves of this page in one click, even though they are two
   * different rows in two different scopes: the name is the VIEWER's own
   * portal_clients row, the billing profile belongs to the workspace.
   *
   * The name write is skipped when nothing changed, so an unrelated save never
   * touches the identity row.
   */
  async function save() {
    const name = fullName.trim();
    if (name.length < 2) {
      setNameError(d.billing.nameRequired);
      return;
    }

    setNameError(null);
    setSaving(true);
    setError(null);
    setSaved(false);

    const supabase = createClient();

    if (name !== viewer.full_name) {
      // Only ever your OWN row: portal_clients UPDATE is `id = auth.uid()`, so
      // this cannot rename the workspace owner when a sócio is looking at it.
      const { error: nameSaveError } = await supabase
        .from("portal_clients")
        .update({ full_name: name })
        .eq("id", viewer.id);

      if (nameSaveError) {
        setSaving(false);
        setError(nameSaveError.message);
        return;
      }
    }

    const { error: upsertError } = await supabase.from("billing_profiles").upsert({
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
    // Re-renders the server tree, so the topbar avatar and the workspace label
    // pick the new name up straight away rather than at the next navigation.
    router.refresh();
  }

  return (
    <div className="max-w-[560px] space-y-7">
      {error && <FormAlert>{error}</FormAlert>}
      {saved && <FormAlert tone="success">{d.billing.saved}</FormAlert>}

      {/* ACCOUNT — the name is theirs to change; the email is the login and
          is not editable here, since moving it means re-verifying an address. */}
      <section className="space-y-3">
        <p className="label-caps">{d.billing.account}</p>

        <div className="space-y-1.5">
          <Label htmlFor="full-name">{d.billing.name}</Label>
          <Input
            id="full-name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            aria-invalid={Boolean(nameError)}
            maxLength={80}
            autoComplete="name"
          />
          <FieldError>{nameError}</FieldError>
          <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            {d.billing.nameHelp}
          </p>
        </div>

        <div className="panel">
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
