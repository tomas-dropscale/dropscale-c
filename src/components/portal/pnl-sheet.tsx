import Link from "next/link";
import { Info } from "lucide-react";

import { money, percent, multiplier } from "@/lib/format";
import type { Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { PnlSheet } from "@/lib/portal/pnl";

/**
 * The P&L, laid out like the spreadsheet a store owner already keeps.
 *
 * A server component: it is a table of numbers with links for the month tabs,
 * and nothing on it needs to react to a click. The period lives in the URL, so
 * a month is a shareable link and the browser's back button works.
 *
 * The cumulative column is the point of the whole sheet — a single day says
 * little, but "where am I for the month so far" is the number a client is
 * actually asking for.
 */

const MONTH_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Money that is a COST reads muted; only revenue and profit get emphasis. */
function Cell({
  value,
  currency,
  tone = "cost",
}: {
  value: number;
  currency: string;
  tone?: "cost" | "revenue" | "profit";
}) {
  return (
    <td
      className={cn(
        "px-3 py-2 text-right whitespace-nowrap tabular-nums",
        tone === "cost" && "text-[var(--text-secondary)]",
        tone === "revenue" && "text-[var(--text-primary)]",
        tone === "profit" &&
          (value >= 0 ? "font-medium text-[var(--success-green)]" : "font-medium text-[var(--danger-red)]"),
      )}
    >
      {money(value, currency)}
    </td>
  );
}

export function PnlSheetView({
  d,
  intl,
  sheet,
  currency,
  year,
  month,
  years,
  hrefFor,
}: {
  d: Dictionary;
  intl: string;
  sheet: PnlSheet;
  currency: string;
  year: number;
  month: number;
  /** Years worth offering — derived from the data, never a guessed range. */
  years: number[];
  hrefFor: (opts: { year?: number; month?: number }) => string;
}) {
  const { totals } = sheet;
  const monthName = (index: number) =>
    new Date(year, index - 1, 1).toLocaleDateString(intl, { month: "short" });

  // A month with nothing in it should say so rather than show 31 zero rows.
  const hasActivity = sheet.days.some(
    (day) => day.grossRevenue !== 0 || day.adSpend !== 0 || day.orders !== 0,
  );

  return (
    <div className="space-y-4">
      {/* ---- period ---- */}
      <div className="flex flex-wrap items-center gap-2">
        {years.length > 1 && (
          <div className="flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-1">
            {years.map((option) => (
              <Link
                key={option}
                href={hrefFor({ year: option })}
                className={cn(
                  "transition-smooth rounded-full px-3 py-1 text-[12.5px] font-medium",
                  option === year
                    ? "bg-[var(--accent-gold)] text-[#1a1409]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                )}
              >
                {option}
              </Link>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-1">
          {MONTH_KEYS.map((option) => (
            <Link
              key={option}
              href={hrefFor({ month: option })}
              className={cn(
                "transition-smooth rounded-full px-2.5 py-1 text-[12.5px] font-medium capitalize",
                option === month
                  ? "bg-[var(--accent-gold)] text-[#1a1409]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              {monthName(option)}
            </Link>
          ))}
        </div>
      </div>

      {/* ---- the month at a glance ---- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: d.pnl.monthRevenue, value: money(totals.netRevenue, currency), tone: "" },
          { label: d.pnl.monthCosts, value: money(totals.totalCosts, currency), tone: "" },
          {
            label: d.pnl.monthProfit,
            value: money(totals.profit, currency),
            tone: totals.profit >= 0 ? "text-[var(--success-green)]" : "text-[var(--danger-red)]",
          },
          { label: d.pnl.monthMargin, value: percent(totals.margin), tone: "" },
        ].map((card) => (
          <div key={card.label} className="panel p-4">
            <p className="label-caps">{card.label}</p>
            <p className={cn("metric-value mt-1 !text-[22px]", card.tone)}>{card.value}</p>
          </div>
        ))}
      </div>

      {/* ---- where the product cost comes from ---- */}
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-4 py-3">
        <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
        <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          {d.pnl.costsNote}
        </p>
      </div>

      {/* ---- the sheet ---- */}
      {!hasActivity ? (
        <div className="panel px-6 py-14 text-center">
          <p className="text-[13px] text-[var(--text-secondary)]">{d.pnl.empty}</p>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">{d.pnl.emptyHelp}</p>
        </div>
      ) : (
        <section className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--border-subtle)]">
                  <th className="label-caps sticky left-0 z-10 bg-[var(--bg-panel)] px-3 py-2.5 text-left">
                    {d.pnl.date}
                  </th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.orders}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.grossRevenue}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.refunds}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.netRevenue}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.cogs}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.adSpend}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.agencyFee}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.revShare}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.paymentFees}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.shipping}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.totalCosts}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.profit}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.margin}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.cogsPct}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.roas}</th>
                  <th className="label-caps px-3 py-2.5 text-right">{d.pnl.cumulative}</th>
                </tr>
              </thead>

              <tbody>
                {sheet.days.map((day) => {
                  const [, , dayNumber] = day.day.split("-");
                  const weekday = new Date(day.day + "T12:00:00").toLocaleDateString(intl, {
                    weekday: "short",
                  });
                  const quiet = day.grossRevenue === 0 && day.adSpend === 0;

                  return (
                    <tr
                      key={day.day}
                      className={cn(
                        "border-b border-[var(--border-subtle)] last:border-b-0",
                        quiet && "opacity-40",
                      )}
                    >
                      <td className="sticky left-0 z-10 bg-[var(--bg-panel)] px-3 py-2 whitespace-nowrap">
                        <span className="text-[var(--text-primary)]">{dayNumber}</span>
                        <span className="ml-1.5 text-[11px] text-[var(--text-muted)] capitalize">
                          {weekday}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--text-secondary)] tabular-nums">
                        {day.orders}
                      </td>
                      <Cell value={day.grossRevenue} currency={currency} tone="revenue" />
                      <Cell value={day.refunds} currency={currency} />
                      <Cell value={day.netRevenue} currency={currency} tone="revenue" />
                      <Cell value={day.cogs} currency={currency} />
                      <Cell value={day.adSpend} currency={currency} />
                      <Cell value={day.agencyFee} currency={currency} />
                      <Cell value={day.revShare} currency={currency} />
                      <Cell value={day.paymentFees} currency={currency} />
                      <Cell value={day.shipping} currency={currency} />
                      <Cell value={day.totalCosts} currency={currency} />
                      <Cell value={day.profit} currency={currency} tone="profit" />
                      <td className="px-3 py-2 text-right text-[var(--text-secondary)] tabular-nums">
                        {percent(day.margin)}
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--text-secondary)] tabular-nums">
                        {percent(day.cogsPct)}
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--text-secondary)] tabular-nums">
                        {multiplier(day.roas)}
                      </td>
                      <Cell value={day.cumulativeProfit} currency={currency} tone="profit" />
                    </tr>
                  );
                })}

                <tr className="bg-[var(--bg-panel-hover)] font-semibold">
                  <td className="sticky left-0 z-10 bg-[var(--bg-panel-hover)] px-3 py-2.5 text-[var(--text-primary)]">
                    {d.pnl.total}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totals.orders}</td>
                  <Cell value={totals.grossRevenue} currency={currency} tone="revenue" />
                  <Cell value={totals.refunds} currency={currency} />
                  <Cell value={totals.netRevenue} currency={currency} tone="revenue" />
                  <Cell value={totals.cogs} currency={currency} />
                  <Cell value={totals.adSpend} currency={currency} />
                  <Cell value={totals.agencyFee} currency={currency} />
                  <Cell value={totals.revShare} currency={currency} />
                  <Cell value={totals.paymentFees} currency={currency} />
                  <Cell value={totals.shipping} currency={currency} />
                  <Cell value={totals.totalCosts} currency={currency} />
                  <Cell value={totals.profit} currency={currency} tone="profit" />
                  <td className="px-3 py-2.5 text-right tabular-nums">{percent(totals.margin)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{percent(totals.cogsPct)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {multiplier(totals.roas)}
                  </td>
                  <Cell value={totals.profit} currency={currency} tone="profit" />
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
