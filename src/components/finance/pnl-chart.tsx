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
import type { Dictionary } from "@/lib/i18n";
import { money, shortDate } from "@/lib/format-intl";
import type { DailyPnL } from "@/lib/finance/queries";

const GOLD = "#d4a86a";
const RED = "#c46a5f";
const GREEN = "#6fae7a";

type Row = DailyPnL & { cumulative: number };

/**
 * Recharts renders tooltips outside the React tree that owns our i18n context,
 * so the dictionary is passed in rather than read from a hook.
 */
type TooltipRenderer = Extract<
  NonNullable<React.ComponentProps<typeof Tooltip>["content"]>,
  (...args: never[]) => unknown
>;

function pnlTooltip(d: Dictionary, intl: string) {
  return function PnLTooltip({ active, payload }: Parameters<TooltipRenderer>[0]) {
    if (!active || !payload?.length) return null;

    const row = payload[0].payload as Row;
    const rows: [string, number, string][] = [
      [d.finance.profit.revenue, row.revenue, GOLD],
      [d.finance.profit.expensesCol, row.expenses, RED],
      [d.finance.profit.profitCol, row.profit, row.profit >= 0 ? GREEN : RED],
      [d.finance.profit.cumulative, row.cumulative, "#8a8680"],
    ];

    return (
      <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2.5 shadow-xl shadow-black/40">
        <p className="mb-1.5 text-[11px] text-[var(--text-secondary)]">
          {shortDate(row.day, intl)}
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
              <dd className="text-right font-medium text-[var(--text-primary)] tabular-nums">
                {money(value, intl)}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    );
  };
}

export function PnLChart({ days, height = 280 }: { days: DailyPnL[]; height?: number }) {
  const { d, intl } = useI18n();

  // Prefix sums without a running accumulator: mutating a closure variable
  // across a map is exactly what the React Compiler refuses to memoize.
  // Windows here top out at a year, so the quadratic walk is irrelevant.
  const data = React.useMemo<Row[]>(
    () =>
      days.map((day, index) => ({
        ...day,
        cumulative: days
          .slice(0, index + 1)
          .reduce((total, entry) => total + entry.profit, 0),
      })),
    [days],
  );

  const Tip = React.useMemo(() => pnlTooltip(d, intl), [d, intl]);

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            minTickGap={28}
            tick={{ fill: "#565350", fontSize: 10.5 }}
            tickFormatter={(value: string) => shortDate(value, intl)}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={58}
            tick={{ fill: "#565350", fontSize: 10.5 }}
            tickFormatter={(value: number) =>
              Math.abs(value) >= 1000 ? `€${(value / 1000).toFixed(1)}k` : `€${value}`
            }
          />
          <Tooltip content={Tip} cursor={{ fill: "rgba(255,255,255,0.03)" }} isAnimationActive={false} />

          <Bar dataKey="revenue" fill={GOLD} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="expenses" fill={RED} fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Line
            type="monotone"
            dataKey="cumulative"
            stroke="#8a8680"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
