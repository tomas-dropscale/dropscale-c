"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Percent, X } from "lucide-react";

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
        className="transition-smooth group/fee inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1 hover:border-[var(--accent-gold)]/40"
        title="Edit billing"
      >
        <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
          <Percent className="size-3 text-[var(--text-muted)]" aria-hidden />
          {Number(rate)}% ad spend
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10.5px] leading-none font-medium",
            revenueShareEnabled
              ? "bg-[var(--success-green)]/15 text-[var(--success-green)]"
              : "text-[var(--text-muted)]",
          )}
        >
          {revenueShareEnabled ? "+ rev share" : "no rev share"}
        </span>
        <Pencil
          className="size-3 text-[var(--text-muted)] opacity-0 transition-opacity group-hover/fee:opacity-100"
          aria-hidden
        />
      </button>
    );
  }

  return (
    <div className="w-full max-w-[420px] space-y-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
      {/* Lever 1 — % of ad spend. Always on; 10% unless changed. */}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-[var(--text-primary)]">
            Management fee
          </p>
          <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            Billed on ad spend, every day this store spends.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Input
            value={spend}
            onChange={(event) => setSpend(event.target.value)}
            inputMode="decimal"
            aria-invalid={error}
            className="h-8 w-16 px-2 text-center text-[12.5px]"
            aria-label="Ad spend percentage"
          />
          <span className="text-[12.5px] text-[var(--text-muted)]">%</span>
        </div>
      </div>

      <div className="h-px bg-[var(--border-subtle)]" aria-hidden />

      {/* Lever 2 — revenue share. On/off here; the RATE lives in the campaign
          name, because the rate and the collection it applies to are one
          decision and must not be able to disagree. */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-[var(--text-primary)]">Revenue share</p>
          <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            A % of the store revenue that comes from an advertised collection. The rate is
            whatever the campaign name ends with —{" "}
            <span className="font-mono text-[10.5px]">… /collections/velas — 5%</span> bills 5%.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRevOn((value) => !value)}
          aria-pressed={revOn}
          className={cn(
            "transition-smooth relative h-5 w-9 shrink-0 rounded-full",
            revOn ? "bg-[var(--success-green)]" : "bg-[var(--border-strong)]",
          )}
          aria-label="Toggle revenue share"
        >
          <span
            className={cn(
              "absolute top-0.5 size-4 rounded-full bg-white transition-all",
              revOn ? "left-[18px]" : "left-0.5",
            )}
          />
        </button>
      </div>

      {error && (
        <p className="text-[11.5px] text-[var(--danger-red)]">
          Enter a percentage between 0 and 100.
        </p>
      )}

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
