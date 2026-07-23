"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { DateRangePicker } from "@/components/ui/date-range-picker";
import { createClient } from "@/lib/supabase/client";
import { isoDay } from "@/lib/finance/queries";
import { presetSelection, type RangeSelection } from "@/lib/portal/range";
import { money, moneyCompact } from "@/lib/format-intl";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const GOLD = "#d4a86a";

type Grouping = "day" | "week" | "month";
type Bucket = { key: string; label: string; amount: number };

/** Monday of the week containing the given local ISO date. */
function mondayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay(); // 0 = Sunday
  date.setDate(date.getDate() - ((day + 6) % 7));
  return isoDay(date);
}

function bucketize(
  rows: { occurred_on: string; amount: number }[],
  group: Grouping,
  intl: string,
): Bucket[] {
  const buckets = new Map<string, number>();

  for (const row of rows) {
    const key =
      group === "day"
        ? row.occurred_on
        : group === "week"
          ? mondayOf(row.occurred_on)
          : row.occurred_on.slice(0, 7); // YYYY-MM
    buckets.set(key, (buckets.get(key) ?? 0) + Number(row.amount));
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, amount]) => {
      let label = key;
      if (group === "month") {
        const [y, m] = key.split("-").map(Number);
        label = new Date(y, m - 1, 1).toLocaleDateString(intl, {
          month: "short",
          year: "2-digit",
        });
      } else {
        const [y, m, d] = key.split("-").map(Number);
        label = new Date(y, m - 1, d).toLocaleDateString(intl, {
          day: "2-digit",
          month: "short",
        });
      }
      return { key, label, amount };
    });
}

/**
 * "How much are we making" over any window: revenue bucketed by day, week or
 * month, with quick presets and a free calendar range. Reads the commissions
 * ledger directly (admin RLS), so the synced Google Ads commissions and any
 * manual entries land in the same bars.
 */
export function RevenueTimeline() {
  const { d, intl } = useI18n();
  const t = d.finance.timeline;

  const [selection, setSelection] = React.useState<RangeSelection>(() => presetSelection("d30"));
  const { from, to } = selection;
  const [group, setGroup] = React.useState<Grouping>("day");
  const [rows, setRows] = React.useState<{ occurred_on: string; amount: number }[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data } = await createClient()
        .from("commissions")
        .select("occurred_on, amount")
        .gte("occurred_on", from)
        .lte("occurred_on", to)
        .order("occurred_on", { ascending: true });
      if (!cancelled) {
        setRows(data ?? []);
        setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const buckets = React.useMemo(() => bucketize(rows, group, intl), [rows, group, intl]);
  const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);

  const groupings: { key: Grouping; label: string }[] = [
    { key: "day", label: t.day },
    { key: "week", label: t.week },
    { key: "month", label: t.month },
  ];

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{t.title}</h2>
          <p className="metric-value text-glow-gold mt-1 !text-[26px]">{money(total, intl)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Presets + two-month calendar, shared with the client portal */}
          <DateRangePicker value={selection} onApply={setSelection} />

          {/* Grouping */}
          <div className="flex items-center gap-1 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-1">
            {groupings.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setGroup(option.key)}
                className={cn(
                  "transition-smooth rounded-[7px] px-2.5 py-1 text-[12px]",
                  group === option.key
                    ? "bg-[var(--bg-panel-hover)] font-medium text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 h-[260px]">
        {loading ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-muted)]">
            {d.common.loading}
          </div>
        ) : buckets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-secondary)]">
            {d.finance.noResults}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={buckets} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: "#8a8680", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={{ fill: "#8a8680", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={(value: number) => moneyCompact(value, intl)}
              />
              <Tooltip
                cursor={{ fill: "rgba(212,168,106,0.08)" }}
                contentStyle={{
                  background: "#111010",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#f2efe9" }}
                formatter={(value) => [money(Number(value), intl), d.finance.total]}
              />
              <Bar dataKey="amount" fill={GOLD} radius={[4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
