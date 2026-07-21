"use client";

import * as React from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight } from "lucide-react";

import { useI18n } from "@/lib/i18n/provider";
import { daysAgo, isoDay, startOfMonth } from "@/lib/finance/queries";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

export type RangeKey = "d7" | "d30" | "d90" | "mtd" | "ytd";

export const RANGE_KEYS: RangeKey[] = ["d7", "d30", "d90", "mtd", "ytd"];

/** Inclusive [from, to] ISO bounds for a range key. */
export function rangeBounds(key: RangeKey): { from: string; to: string } {
  const to = isoDay(new Date());

  switch (key) {
    case "d7":
      return { from: daysAgo(6), to };
    case "d30":
      return { from: daysAgo(29), to };
    case "d90":
      return { from: daysAgo(89), to };
    case "mtd":
      return { from: startOfMonth(), to };
    case "ytd":
      return { from: isoDay(new Date(new Date().getFullYear(), 0, 1)), to };
  }
}

export function RangeTabs({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
}) {
  const { d } = useI18n();

  return (
    <div
      role="tablist"
      aria-label={d.finance.rangeLabel}
      className="flex items-center gap-1 rounded-full border border-[var(--border-subtle)] p-0.5"
    >
      {RANGE_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-smooth",
            value === key
              ? "bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
          )}
        >
          {d.finance.range[key]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  hint,
  delta,
  tone = "gold",
}: {
  label: string;
  value: string;
  hint?: string;
  /** Change vs the previous window of the same length, as a ratio. */
  delta?: number | null;
  tone?: "gold" | "primary" | "danger" | "success";
}) {
  const toneClass = {
    gold: "text-[var(--accent-gold)]",
    primary: "text-[var(--text-primary)]",
    danger: "text-[var(--danger-red)]",
    success: "text-[var(--success-green)]",
  }[tone];

  const showDelta = typeof delta === "number" && Number.isFinite(delta);
  const positive = (delta ?? 0) >= 0;
  const Arrow = positive ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="panel p-5 transition-smooth hover:border-[var(--border-strong)]">
      <div className="flex items-start justify-between gap-3">
        <span className="label-caps">{label}</span>
        {showDelta && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5 text-[11.5px] font-medium",
              positive ? "text-[var(--success-green)]" : "text-[var(--danger-red)]",
            )}
          >
            {positive ? "+" : ""}
            {(delta * 100).toFixed(1)}%
            <Arrow className="size-3" aria-hidden />
          </span>
        )}
      </div>

      <p className={cn("metric-value mt-3.5 truncate", toneClass)}>{value}</p>
      {hint && <p className="mt-1.5 text-[11.5px] text-[var(--text-secondary)]">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdown bars — the "where does it come from" list
// ---------------------------------------------------------------------------

export type BreakdownRow = {
  key: string;
  label: string;
  sublabel?: string;
  amount: string;
  share: number;
  color: string;
};

export function Breakdown({
  title,
  rows,
  empty,
  action,
}: {
  title: string;
  rows: BreakdownRow[];
  empty: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="panel flex flex-col p-5">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
        {action}
      </header>

      {rows.length === 0 ? (
        <div className="py-6 text-center">{empty}</div>
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((row) => (
            <li key={row.key}>
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: row.color }}
                    aria-hidden
                  />
                  <span className="truncate text-[12.5px] text-[var(--text-primary)]">
                    {row.label}
                  </span>
                  {row.sublabel && (
                    <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                      {row.sublabel}
                    </span>
                  )}
                </span>

                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-[var(--text-primary)] tabular-nums">
                    {row.amount}
                  </span>
                  <span className="w-10 text-right text-[11px] text-[var(--text-muted)] tabular-nums">
                    {(row.share * 100).toFixed(0)}%
                  </span>
                </span>
              </div>

              <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--border-subtle)]">
                <div
                  className="h-full rounded-full transition-[width] duration-500 ease-out"
                  style={{
                    width: `${Math.max(row.share * 100, 1.5)}%`,
                    backgroundColor: row.color,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const { d } = useI18n();

  return (
    <div className="mb-4 flex items-start gap-2 rounded-[10px] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 px-3 py-2 text-[12.5px] text-[#e2a49b]">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-[11px] underline underline-offset-2"
      >
        {d.common.close}
      </button>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="panel px-6 py-12 text-center text-[13px] text-[var(--text-muted)]">
      {children}
    </div>
  );
}

/** Table shell that scrolls horizontally on small screens instead of breaking. */
export function DataTable({
  head,
  children,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--border-subtle)]">{head}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "label-caps px-4 py-3 font-medium",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-4 py-3 text-[12.5px] text-[var(--text-secondary)]",
        align === "right" && "text-right tabular-nums",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({ children }: { children: React.ReactNode }) {
  return (
    <tr className="border-b border-[var(--border-subtle)] transition-smooth last:border-0 hover:bg-[var(--bg-panel-hover)]">
      {children}
    </tr>
  );
}
