"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * Inline editor for an account's agency billing — two INDEPENDENT levers:
 *   • % of ad spend — the classic management fee (default 10%, always on).
 *   • Revenue share — a switch. When on, the agency bills a % of the revenue
 *     attributed to advertised collections; the RATE is read from each Google
 *     Ads campaign name (".../collections/<handle> 5%"), so there is no rate to
 *     type here — just on/off.
 * Both writes are RLS-checked updates; migration 0010's guard trigger rejects
 * them for anyone who isn't staff.
 */
export function CommissionRate({
  accountId,
  rate,
  revenueShareEnabled = false,
}: {
  accountId: string;
  rate: number;
  revenueShareEnabled?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [spend, setSpend] = React.useState(String(rate));
  const [revOn, setRevOn] = React.useState(revenueShareEnabled);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);

  function open() {
    setSpend(String(rate));
    setRevOn(revenueShareEnabled);
    setError(false);
    setEditing(true);
  }

  async function save() {
    const spendNum = Number(spend);
    if (!Number.isFinite(spendNum) || spendNum < 0 || spendNum > 100) {
      setError(true);
      return;
    }

    setBusy(true);
    setError(false);
    const { error: updateError } = await createClient()
      .from("ad_accounts")
      .update({ commission_rate: spendNum, revenue_share_enabled: revOn })
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
        onClick={open}
        className="transition-smooth inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
        title="Edit billing"
      >
        <span>{Number(rate)}% spend</span>
        {revenueShareEnabled && <span className="text-[var(--accent-gold)]">· rev share on</span>}
        <Pencil className="size-3" aria-hidden />
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5">
      {/* Lever 1 — % of ad spend */}
      <label className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-muted)]">
        Spend
        <Input
          value={spend}
          onChange={(event) => setSpend(event.target.value)}
          inputMode="decimal"
          aria-invalid={error}
          className="h-7 w-14 px-2 text-[12px]"
          aria-label="Ad spend percentage"
        />
        %
      </label>

      <span className="h-4 w-px bg-[var(--border-subtle)]" aria-hidden />

      {/* Lever 2 — revenue share on/off (rate comes from campaign names) */}
      <button
        type="button"
        onClick={() => setRevOn((value) => !value)}
        aria-pressed={revOn}
        title="Bill a % of revenue on advertised collections — rate read from campaign names"
        className={cn(
          "transition-smooth inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium",
          revOn
            ? "bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
            : "bg-[var(--bg-panel)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
        )}
      >
        Rev share {revOn ? "on" : "off"}
      </button>

      <Button
        variant="primary"
        size="icon-sm"
        onClick={save}
        loading={busy}
        aria-label="Save billing"
      >
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
