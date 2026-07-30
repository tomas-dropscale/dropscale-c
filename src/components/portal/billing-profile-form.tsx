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

  // Invoice identity (migration 0020). One state object rather than eight
  // useStates — every field is the same kind of thing and they all save together.
  const [invoice, setInvoice] = React.useState({
    billingName: profile?.billing_name ?? "",
    taxId: profile?.tax_id ?? "",
    line1: profile?.address_line1 ?? "",
    line2: profile?.address_line2 ?? "",
    city: profile?.address_city ?? "",
    postalCode: profile?.address_postal_code ?? "",
    state: profile?.address_state ?? "",
    country: profile?.address_country ?? "",
  });
  const [countryError, setCountryError] = React.useState<string | null>(null);

  const setInvoiceField = (key: keyof typeof invoice) => (value: string) =>
    setInvoice((current) => ({ ...current, [key]: value }));
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

    // Two letters or nothing: Stripe rejects anything else, and it does so at
    // invoice time — days later, in a cron, where nobody would see it.
    const country = invoice.country.trim().toUpperCase();
    if (country !== "" && !/^[A-Z]{2}$/.test(country)) {
      setCountryError(d.billing.countryInvalid);
      return;
    }

    setNameError(null);
    setCountryError(null);
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

    // Empty strings go in as null so a half-filled profile does not put blank
    // lines on an invoice.
    const orNull = (value: string) => value.trim() || null;

    const { error: upsertError } = await supabase.from("billing_profiles").upsert({
      client_id: workspaceId,
      profile_type: profileType,
      currency,
      available_budget: budget.trim() === "" ? null : Number(budget),
      billing_name: orNull(invoice.billingName),
      tax_id: orNull(invoice.taxId),
      address_line1: orNull(invoice.line1),
      address_line2: orNull(invoice.line2),
      address_city: orNull(invoice.city),
      address_postal_code: orNull(invoice.postalCode),
      address_state: orNull(invoice.state),
      address_country: country || null,
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

      {/* INVOICE DETAILS — what the PDF has to show. Empty is allowed: the
          invoice still goes out, just with the portal name and no address. */}
      <section className="space-y-3">
        <p className="label-caps">{d.billing.invoiceDetails}</p>
        <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {d.billing.invoiceDetailsHelp}
        </p>

        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="billing-name">{d.billing.billingName}</Label>
              <Input
                id="billing-name"
                value={invoice.billingName}
                onChange={(event) => setInvoiceField("billingName")(event.target.value)}
                placeholder={d.billing.billingNamePlaceholder}
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="billing-tax">{d.billing.taxId}</Label>
              <Input
                id="billing-tax"
                value={invoice.taxId}
                onChange={(event) => setInvoiceField("taxId")(event.target.value)}
                placeholder={d.billing.taxIdPlaceholder}
                maxLength={30}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="billing-line1">{d.billing.addressLine1}</Label>
            <Input
              id="billing-line1"
              value={invoice.line1}
              onChange={(event) => setInvoiceField("line1")(event.target.value)}
              placeholder={d.billing.addressLine1Placeholder}
              autoComplete="address-line1"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="billing-line2">{d.billing.addressLine2}</Label>
            <Input
              id="billing-line2"
              value={invoice.line2}
              onChange={(event) => setInvoiceField("line2")(event.target.value)}
              placeholder={d.billing.addressLine2Placeholder}
              autoComplete="address-line2"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="billing-postal">{d.billing.postalCode}</Label>
              <Input
                id="billing-postal"
                value={invoice.postalCode}
                onChange={(event) => setInvoiceField("postalCode")(event.target.value)}
                autoComplete="postal-code"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="billing-city">{d.billing.city}</Label>
              <Input
                id="billing-city"
                value={invoice.city}
                onChange={(event) => setInvoiceField("city")(event.target.value)}
                autoComplete="address-level2"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="billing-state">{d.billing.state}</Label>
              <Input
                id="billing-state"
                value={invoice.state}
                onChange={(event) => setInvoiceField("state")(event.target.value)}
                autoComplete="address-level1"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="billing-country">{d.billing.country}</Label>
              <Input
                id="billing-country"
                value={invoice.country}
                onChange={(event) => setInvoiceField("country")(event.target.value.toUpperCase())}
                placeholder="PT"
                maxLength={2}
                aria-invalid={Boolean(countryError)}
                autoComplete="country"
                className="uppercase"
              />
              <FieldError>{countryError}</FieldError>
            </div>
          </div>
        </div>
      </section>

      <Button variant="primary" size="lg" onClick={save} loading={saving}>
        {d.billing.saveSettings}
      </Button>
    </div>
  );
}
