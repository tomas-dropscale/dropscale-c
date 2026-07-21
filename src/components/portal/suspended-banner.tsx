"use client";

import * as React from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shown at the top of a store view when status = 'suspended'. Warm amber over
 * the panel background — never a raw red that fights the theme.
 */
export function SuspendedBanner() {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/8">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
        aria-expanded={expanded}
      >
        <AlertTriangle className="size-4 shrink-0 text-[var(--warning-orange)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-[var(--text-primary)]">
            Account suspended by Google
          </span>
          <span className="block text-[12.5px] text-[var(--text-secondary)]">
            Ads are not running. Review the steps below to start the appeal.
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-[var(--warning-orange)]">
          View steps
          <ChevronDown
            className={cn("transition-smooth size-3.5", expanded && "rotate-180")}
          />
        </span>
      </button>

      {expanded && (
        <ol className="space-y-2 border-t border-[var(--warning-orange)]/20 px-4 py-4 pl-11 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          <li>
            1. Open the notification in your Google Ads account to see the exact policy
            Google cited.
          </li>
          <li>
            2. Don&apos;t submit an appeal yourself yet — appeals are limited and a
            rejected one makes the next harder.
          </li>
          <li>
            3. Contact your Dropscale account manager. We prepare and submit the appeal
            with you.
          </li>
        </ol>
      )}
    </div>
  );
}
