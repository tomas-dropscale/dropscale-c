"use client";

import { useRouter } from "next/navigation";
import { CalendarClock, Percent, ShieldCheck } from "lucide-react";

import { InlineRename } from "@/components/admin/inline-rename";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const RATE_DRAFT = /^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/;

export function parseCommissionRateDraft(value: string): number | null {
  const draft = value.trim();
  if (!RATE_DRAFT.test(draft)) return null;
  const parsed = Number(draft);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function displayDay(day: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

/** Schedule one physical billing account's manual list term through the audited CAS RPC. */
export function CommissionRate({
  accountId,
  rate,
  listRate,
  expectedTermId,
  scheduledListRate = null,
  scheduledEffectiveFrom = null,
  revenueShareEnabled = false,
}: {
  accountId: string;
  rate: number;
  listRate: number;
  expectedTermId: string | null;
  scheduledListRate?: number | null;
  scheduledEffectiveFrom?: string | null;
  revenueShareEnabled?: boolean;
}) {
  const router = useRouter();
  const referralDiscount = Math.max(0, listRate - rate);
  const draftRate = scheduledListRate ?? listRate;

  return (
    <InlineRename
      value={String(draftRate)}
      title="Manual list commission rate (%)"
      help="Creates an audited decision for this exact billing account. It takes effect on the current or next Monday; referral discounts remain separate."
      minLength={1}
      maxLength={6}
      emptyMessage="Enter a rate from 0 to 100 with up to two decimal places."
      onSave={async (value) => {
        const next = parseCommissionRateDraft(value);
        if (next === null) {
          return "Enter a rate from 0 to 100 with up to two decimal places.";
        }
        if (next === draftRate) return null;

        const { data, error } = await createClient().rpc(
          "schedule_ad_account_commission_rate",
          {
            p_account_id: accountId,
            p_list_rate: next,
            p_expected_term_id: expectedTermId,
            p_decision_id: crypto.randomUUID(),
          },
        );
        if (error) return error.message;
        if (
          !Array.isArray(data) ||
          data.length !== 1 ||
          data[0]?.ad_account_id !== accountId ||
          Number(data[0]?.list_rate) !== next
        ) {
          return "The commission decision could not be verified. Refresh and review it again.";
        }
        router.refresh();
        return null;
      }}
    >
      <span
        className="inline-flex flex-wrap items-center justify-end gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 group-hover/rename:border-[var(--accent-gold)]/40"
        title="Manual list terms are edited here; sealed referral terms remain separate in Referrals."
      >
        <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--text-secondary)]">
          <Percent className="size-3 text-[var(--text-muted)]" aria-hidden />
          {rate}% effective
        </span>
        <span className="text-[10.5px] text-[var(--text-muted)]">{listRate}% current list</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] leading-none font-medium",
            referralDiscount > 0
              ? "bg-[var(--accent-gold)]/12 text-[var(--accent-gold)]"
              : "bg-[var(--success-green)]/10 text-[var(--success-green)]",
          )}
        >
          <ShieldCheck className="size-2.5" aria-hidden />
          {referralDiscount > 0
            ? `${referralDiscount} pp referral discount`
            : "manual list is effective"}
        </span>
        {scheduledListRate !== null && scheduledEffectiveFrom && (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-[var(--warning-orange)]">
            <CalendarClock className="size-2.5" aria-hidden />
            {scheduledListRate}% scheduled · {displayDay(scheduledEffectiveFrom)}
          </span>
        )}
        {revenueShareEnabled && (
          <span className="text-[10.5px] font-medium text-[var(--warning-orange)]">
            revenue share active
          </span>
        )}
      </span>
    </InlineRename>
  );
}
