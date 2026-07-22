"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

/**
 * Inline editor for an account's agency commission rate. Admin-only in
 * practice: the write is an ordinary RLS-checked update, and migration 0006's
 * guard trigger rejects the change for anyone who isn't staff.
 */
export function CommissionRate({ accountId, rate }: { accountId: string; rate: number }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(String(rate));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);

  async function save() {
    const next = Number(value);
    if (!Number.isFinite(next) || next < 0 || next > 100) {
      setError(true);
      return;
    }

    setBusy(true);
    setError(false);
    const { error: updateError } = await createClient()
      .from("ad_accounts")
      .update({ commission_rate: next })
      .eq("id", accountId);
    setBusy(false);

    if (updateError) {
      setError(true);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(String(rate));
          setEditing(true);
        }}
        className="transition-smooth inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
        title="Edit commission rate"
      >
        {Number(rate)}% fee
        <Pencil className="size-3" aria-hidden />
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        inputMode="decimal"
        aria-invalid={error}
        className="h-7 w-16 px-2 text-[12px]"
        autoFocus
      />
      <span className="text-[12px] text-[var(--text-muted)]">%</span>
      <Button variant="primary" size="icon-sm" onClick={save} loading={busy} aria-label="Save rate">
        {!busy && <Check />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setEditing(false)}
        disabled={busy}
        aria-label="Cancel"
      >
        <X />
      </Button>
    </span>
  );
}
