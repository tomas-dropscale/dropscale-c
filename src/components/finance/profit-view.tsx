"use client";

import * as React from "react";

import { PageContainer } from "@/components/ui/page-container";
import {
  DataTable,
  ErrorBanner,
  RangeTabs,
  StatCard,
  Td,
  Th,
  Tr,
  type RangeKey,
} from "@/components/finance/finance-ui";
import { PnLChart } from "@/components/finance/pnl-chart";
import { useFinance } from "@/components/finance/use-finance";
import { dailyPnL, totals } from "@/lib/finance/queries";
import { useI18n } from "@/lib/i18n/provider";
import { money, percent, shortDate } from "@/lib/format-intl";
import { cn } from "@/lib/utils";
import type { FinanceSnapshot } from "@/lib/finance/queries";

export function ProfitView({
  initial,
  initialRange,
}: {
  initial: FinanceSnapshot;
  initialRange: RangeKey;
}) {
  const { d, intl } = useI18n();
  const t = d.finance.profit;

  const { data, range, setRange, error, setError } = useFinance(initial, initialRange);

  const days = React.useMemo(
    () => dailyPnL(data.commissions, data.expenses, data.from, data.to),
    [data],
  );

  const figures = React.useMemo(
    () => totals(data.commissions, data.expenses),
    [data.commissions, data.expenses],
  );

  // Only days with movement count towards best/worst/average — a long tail of
  // untouched days would drag the average to nearly zero and say nothing.
  const activeDays = days.filter((day) => day.revenue !== 0 || day.expenses !== 0);
  const best = activeDays.reduce<(typeof activeDays)[number] | null>(
    (top, day) => (top === null || day.profit > top.profit ? day : top),
    null,
  );
  const worst = activeDays.reduce<(typeof activeDays)[number] | null>(
    (bottom, day) => (bottom === null || day.profit < bottom.profit ? day : bottom),
    null,
  );
  const average = activeDays.length > 0 ? figures.profit / activeDays.length : 0;
  const profitable = activeDays.filter((day) => day.profit > 0).length;

  // Newest first in the table, oldest first in the chart.
  // Left unmemoized on purpose — the React Compiler handles it, and a manual
  // useMemo over a locally derived array is what it refuses to preserve.
  const tableRows = [...activeDays].reverse();

  return (
    <PageContainer
      title={t.title}
      description={t.subtitle}
      actions={<RangeTabs value={range} onChange={setRange} />}
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={d.overview.netProfit}
            value={money(figures.profit, intl)}
            hint={`${d.overview.margin} ${percent(figures.margin, intl)}`}
            tone={figures.profit >= 0 ? "success" : "danger"}
          />
          <StatCard label={t.avgPerDay} value={money(average, intl)} tone="primary" />
          <StatCard
            label={t.bestDay}
            value={best ? money(best.profit, intl) : "—"}
            hint={best ? shortDate(best.day, intl) : undefined}
            tone="primary"
          />
          <StatCard
            label={t.profitableDays}
            value={activeDays.length > 0 ? `${profitable}/${activeDays.length}` : "—"}
            hint={worst ? `${t.worstDay}: ${money(worst.profit, intl)}` : undefined}
            tone="primary"
          />
        </div>

        <section className="panel p-5">
          <header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
              {d.overview.revenueVsExpenses}
            </h2>
            <p className="text-[12px] text-[var(--text-secondary)]">
              {d.overview.periodTotal}{" "}
              <span
                className={cn(
                  "font-medium tabular-nums",
                  figures.profit >= 0
                    ? "text-[var(--success-green)]"
                    : "text-[var(--danger-red)]",
                )}
              >
                {money(figures.profit, intl)}
              </span>
            </p>
          </header>

          <PnLChart days={days} />
        </section>

        <DataTable
          head={
            <>
              <Th>{t.day}</Th>
              <Th align="right">{t.revenue}</Th>
              <Th align="right">{t.expensesCol}</Th>
              <Th align="right">{t.profitCol}</Th>
            </>
          }
        >
          {tableRows.length === 0 ? (
            <tr>
              <Td className="py-8 text-center">{d.finance.noResults}</Td>
            </tr>
          ) : (
            tableRows.map((day) => (
              <Tr key={day.day}>
                <Td className="text-[var(--text-primary)]">{shortDate(day.day, intl)}</Td>
                <Td align="right" className="text-[var(--accent-gold)]">
                  {day.revenue ? money(day.revenue, intl) : "—"}
                </Td>
                <Td align="right" className="text-[var(--danger-red)]">
                  {day.expenses ? money(day.expenses, intl) : "—"}
                </Td>
                <Td
                  align="right"
                  className={cn(
                    "font-semibold",
                    day.profit > 0
                      ? "text-[var(--success-green)]"
                      : day.profit < 0
                        ? "text-[var(--danger-red)]"
                        : "text-[var(--text-muted)]",
                  )}
                >
                  {money(day.profit, intl)}
                </Td>
              </Tr>
            ))
          )}
        </DataTable>
      </div>
    </PageContainer>
  );
}
