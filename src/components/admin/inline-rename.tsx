"use client";

import * as React from "react";
import { Check, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Rename something, in place.
 *
 * Shared by the two places the team fixes a name somebody else chose: a store on
 * the campaigns screen, and a client on the clients screen. Both are the same
 * interaction, so they are the same component — the caller supplies the trigger
 * it wants (a pill, or the name itself) and what to do with the new value.
 *
 * Deliberately knows nothing about the database: the save is the caller's, which
 * is what lets one component serve two tables without growing a `table` prop.
 */
export function InlineRename({
  value,
  title,
  help,
  minLength = 2,
  maxLength = 120,
  emptyMessage = "This needs a name.",
  onSave,
  children,
}: {
  value: string;
  /** Heading of the open editor, e.g. "Store name". */
  title: string;
  help?: string;
  minLength?: number;
  maxLength?: number;
  emptyMessage?: string;
  /** Returns an error message, or null when the write succeeded. */
  onSave: (next: string) => Promise<string | null>;
  /** What to click to start editing. */
  children: React.ReactNode;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function open() {
    setDraft(value);
    setError(null);
    setEditing(true);
  }

  async function commit() {
    const next = draft.trim();
    if (next.length < minLength) {
      setError(emptyMessage);
      return;
    }
    // Nothing changed — close quietly rather than writing and reporting.
    if (next === value) {
      setEditing(false);
      return;
    }

    setBusy(true);
    setError(null);
    const failure = await onSave(next);
    setBusy(false);

    if (failure) {
      setError(failure);
      return;
    }
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        title={title}
        className="transition-smooth group/rename flex min-w-0 items-center gap-1.5 text-left"
      >
        {children}
        <Pencil
          className="size-3 shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-hover/rename:opacity-100"
          aria-hidden
        />
      </button>
    );
  }

  return (
    <div className="w-full max-w-[420px] space-y-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
      <div>
        <p className="text-[12.5px] font-medium text-[var(--text-primary)]">{title}</p>
        {help && <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">{help}</p>}
      </div>

      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={maxLength}
        aria-invalid={Boolean(error)}
        aria-label={title}
        className="h-8 text-[12.5px]"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit();
          if (event.key === "Escape") setEditing(false);
        }}
      />

      {error && <p className="text-[11.5px] text-[var(--danger-red)]">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
          <X />
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={commit} loading={busy}>
          {!busy && <Check />}
          Save
        </Button>
      </div>
    </div>
  );
}
