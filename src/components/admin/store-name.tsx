"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Store, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

const MAX_LENGTH = 80;

/**
 * Inline rename for a store, from the campaigns screen.
 *
 * Stores get named by whoever created them — often the client, often badly
 * ("Loja 1", a myshopify subdomain) — and that name is what the agency reads on
 * every screen and what a client sees in their own sidebar. The team needs to be
 * able to fix it without going through the client.
 *
 * Sits in the open panel rather than in the <summary> beside the name it edits:
 * a click on a control inside <summary> toggles the panel shut. Same reason the
 * CommissionRate control lives here.
 *
 * The write is a plain RLS-checked update. `store_name` is not one of the
 * columns migration 0001's guard trigger protects (status and client_id are),
 * so an admin session is all it takes — and a client renaming their own store
 * was always allowed anyway.
 */
export function StoreName({ accountId, name }: { accountId: string; name: string }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(name);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function open() {
    setValue(name);
    setError(null);
    setEditing(true);
  }

  async function save() {
    const next = value.trim();
    if (next.length < 2) {
      setError("A store needs a name.");
      return;
    }
    // Nothing to write, and nothing to report either.
    if (next === name) {
      setEditing(false);
      return;
    }

    setBusy(true);
    setError(null);
    const { error: updateError } = await createClient()
      .from("ad_accounts")
      .update({ store_name: next })
      .eq("id", accountId);
    setBusy(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        className="transition-smooth group/name inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1 hover:border-[var(--accent-gold)]/40"
        title="Rename store"
      >
        <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
          <Store className="size-3 text-[var(--text-muted)]" aria-hidden />
          Rename
        </span>
        <Pencil
          className="size-3 text-[var(--text-muted)] opacity-0 transition-opacity group-hover/name:opacity-100"
          aria-hidden
        />
      </button>
    );
  }

  return (
    <div className="w-full max-w-[420px] space-y-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
      <div>
        <p className="text-[12.5px] font-medium text-[var(--text-primary)]">Store name</p>
        <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          Shown everywhere, including in the client&apos;s own sidebar.
        </p>
      </div>

      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={MAX_LENGTH}
        aria-invalid={Boolean(error)}
        aria-label="Store name"
        className="h-8 text-[12.5px]"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
          if (event.key === "Escape") setEditing(false);
        }}
      />

      {error && <p className="text-[11.5px] text-[var(--danger-red)]">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
          <X />
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={save} loading={busy}>
          {!busy && <Check />}
          Save
        </Button>
      </div>
    </div>
  );
}
