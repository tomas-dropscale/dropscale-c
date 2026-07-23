"use client";

import * as React from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useI18n } from "@/lib/i18n/provider";
import { money } from "@/lib/format-intl";

const GOLD = "#d4a86a";
const RED = "#c46a5f";
const GREEN = "#6fae7a";

/** One chart day, pre-summed server-side from daily_metrics. */
export type ChartDay = {
  day: string;
  revenue: number;
  adSpend: number;
  profit: number;
};

/**
 * Recharts renders tooltips outside the React tree that owns our i18n context,
 * so intl/currency are captured rather than read from a hook. (Same pattern
 * as the admin's pnl-chart.)
 */
type TooltipRenderer = Extract<
  NonNullable<React.ComponentProps<typeof Tooltip>["content"]>,
  (...args: never[]) => unknown
>;

function dayLabel(iso: string, intl: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(intl, { day: "2-digit", month: "short" });
}

function performanceTooltip(intl: string, currency: string) {
  return function PerformanceTooltip({ active, payload }: Parameters<TooltipRenderer>[0]) {
    if (!active || !payload?.length) return null;

    const row = payload[0].payload as ChartDay;
    const rows: [string, number, string][] = [
      ["Revenue", row.revenue, GOLD],
      ["Ad spend", row.adSpend, RED],
      ["Profit", row.profit, row.profit >= 0 ? GREEN : RED],
    ];

    return (
      <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2.5 shadow-xl shadow-black/40">
        <p className="mb-1.5 text-[11px] text-[var(--text-secondary)]">
          {dayLabel(row.day, intl)}
        </p>
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-[11.5px]">
          {rows.map(([label, value, color]) => (
            <React.Fragment key={label}>
              <dt className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: color }}
                  aria-hidden
                />
                {label}
              </dt>
              <dd className="text-right font-medium text-[var(--text-primary)]">
                {money(value, intl, currency)}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    );
  };
}

export function DailyPerformanceChart({
  days,
  currency,
}: {
  days: ChartDay[];
  currency: string;
}) {
  const { intl } = useI18n();

  if (days.length === 0) return null;

  return (
    <section className="panel p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          Daily performance
        </h2>
        <div className="flex items-center gap-4 text-[11px] text-[var(--text-secondary)]">
          {(
            [
              ["Revenue", GOLD],
              ["Ad spend", RED],
              ["Profit", GREEN],
            ] as const
          ).map(([label, color]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
              {label}
            </span>
          ))}
        </div>
      </header>

      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={days} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
            <XAxis
              dataKey="day"
              tickFormatter={(iso: string) => dayLabel(iso, intl)}
              tick={{ fill: "#8a8680", fontSize: 10.5 }}
              axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              tickFormatter={(value: number) =>
                new Intl.NumberFormat(intl, { notation: "compact" }).format(value)
              }
              tick={{ fill: "#8a8680", fontSize: 10.5 }}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip
              content={performanceTooltip(intl, currency)}
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
            />
            <Bar dataKey="revenue" fill={GOLD} radius={[3, 3, 0, 0]} maxBarSize={26} />
            <Bar dataKey="adSpend" fill={RED} radius={[3, 3, 0, 0]} maxBarSize={26} opacity={0.75} />
            <Line
              type="monotone"
              dataKey="profit"
              stroke={GREEN}
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
