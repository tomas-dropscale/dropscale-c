"use client";

import * as React from "react";
import { Pencil, Plus, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import {
  Breakdown,
  DataTable,
  ErrorBanner,
  StatCard,
  Td,
  Th,
  Tr,
  type BreakdownRow,
} from "@/components/finance/finance-ui";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import type { RangeSelection } from "@/lib/portal/range";
import { CommissionDialog, type CommissionTarget } from "@/components/finance/commission-dialog";
import { SourceDialog, type SourceTarget } from "@/components/finance/source-dialog";
import { RevenueTimeline } from "@/components/finance/revenue-timeline";
import { PnLChart } from "@/components/finance/pnl-chart";
import { useFinance } from "@/components/finance/use-finance";
import { dailyPnL, revenueByClient, revenueBySource, sum, totals } from "@/lib/finance/queries";
import {
  COMMISSION_STATUS_BADGE,
  commissionClientLabel,
  commissionStatusLabel,
  sourceTint,
} from "@/lib/finance/config";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { money, percent, shortDate } from "@/lib/format-intl";
import { cn } from "@/lib/utils";
import type { FinanceSnapshot } from "@/lib/finance/queries";

/**
 * The money-in screen: revenue and the daily P&L in one place, because they
 * were always the same question asked twice — "what came in" and "what did it
 * leave behind". It reads top to bottom: the figures, where the money comes
 * from, how it lands day by day, and finally every single transaction that
 * paid us.
 */
export function RevenueView({
  initial,
  initialRange,
  currentUserId,
}: {
  initial: FinanceSnapshot;
  initialRange: RangeSelection;
  currentUserId: string;
}) {
  const { d, intl } = useI18n();
  const t = d.finance.revenue;

  const { data, range, setRange, refresh, error, setError } = useFinance(initial, initialRange);

  const [commissionTarget, setCommissionTarget] = React.useState<CommissionTarget | null>(null);
  const [sourceTarget, setSourceTarget] = React.useState<SourceTarget | null>(null);
  const [showSources, setShowSources] = React.useState(false);

  const bySource = React.useMemo(
    () => revenueBySource(data.commissions, data.sources),
    [data.commissions, data.sources],
  );

  const byClient = React.useMemo(
    () => revenueByClient(data.commissions, data.clients, d.overview.unattributed),
    [data.commissions, data.clients, d],
  );

  const figures = React.useMemo(
    () => totals(data.commissions, data.expenses),
    [data.commissions, data.expenses],
  );

  const days = React.useMemo(
    () => dailyPnL(data.commissions, data.expenses, data.from, data.to),
    [data],
  );

  const total = sum(data.commissions.map((entry) => Number(entry.amount)));
  const pending = sum(
    data.commissions.filter((entry) => entry.status === "pending").map((e) => Number(e.amount)),
  );

  // Only days with movement count towards the average — a long tail of
  // untouched days would drag it to nearly zero and say nothing.
  const activeDays = days.filter((day) => day.revenue !== 0 || day.expenses !== 0);
  const average = activeDays.length > 0 ? figures.profit / activeDays.length : 0;
  const dayRows = [...activeDays].reverse(); // newest first in the table

  // Every transaction that paid us, newest first. Not a "recent" sample: the
  // window IS the filter, so what you see is what came in.
  const incoming = [...data.commissions].sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));

  const sourceRows: BreakdownRow[] = bySource.map((row, index) => ({
    key: row.source.id,
    label: row.source.name,
    sublabel: fmt(row.count === 1 ? d.finance.entriesOne : d.finance.entries, { count: row.count }),
    amount: money(row.amount, intl),
    share: row.share,
    color: sourceTint(index),
  }));

  const clientRows: BreakdownRow[] = byClient.map((row, index) => ({
    key: row.key,
    label: row.name,
    sublabel: fmt(row.count === 1 ? d.finance.entriesOne : d.finance.entries, { count: row.count }),
    amount: money(row.amount, intl),
    share: row.share,
    color: sourceTint(index),
  }));

  const sourceName = (id: string) => data.sources.find((s) => s.id === id)?.name ?? "—";

  return (
    <PageContainer
      title={t.title}
      description={t.subtitle}
      actions={
        <>
          <DateRangePicker value={range} onApply={setRange} />
          <Button variant="secondary" size="sm" onClick={() => setShowSources((v) => !v)}>
            <Settings2 />
            {t.manageSources}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCommissionTarget({ mode: "create" })}
            disabled={data.sources.length === 0}
          >
            <Plus />
            {t.newEntry}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={t.title} value={money(total, intl)} glow />
          <StatCard
            label={commissionStatusLabel(d, "pending")}
            value={money(pending, intl)}
            tone="primary"
          />
          <StatCard
            label={d.overview.netProfit}
            value={money(figures.profit, intl)}
            hint={`${d.overview.margin} ${percent(figures.margin, intl)}`}
            tone={figures.profit >= 0 ? "success" : "danger"}
          />
          <StatCard label={d.finance.profit.avgPerDay} value={money(average, intl)} tone="primary" />
        </div>

        {/* Day/week/month revenue with its own calendar — independent of the
            page's range selector so exploring dates never reloads the lists. */}
        <RevenueTimeline />

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

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Breakdown
            title={t.bySource}
            rows={sourceRows}
            empty={
              <p className="text-[13px] text-[var(--text-muted)]">{d.overview.noRevenueYet}</p>
            }
          />

          {/* Who the money comes from, ranked. Supplier commissions (HST)
              carry their own client names, so this covers them too. */}
          <Breakdown
            title={t.byClient}
            rows={clientRows}
            empty={
              <p className="text-[13px] text-[var(--text-muted)]">{d.overview.noRevenueYet}</p>
            }
          />
        </div>

        {showSources && (
          <section className="panel flex flex-col p-5">
            <header className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{t.sources}</h2>
              <Button variant="secondary" size="sm" onClick={() => setSourceTarget({ mode: "create" })}>
                <Plus />
                {t.newSource}
              </Button>
            </header>

            {data.sources.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-[var(--text-muted)]">{t.noSources}</p>
            ) : (
              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {data.sources.map((source) => (
                  <li key={source.id}>
                    <button
                      type="button"
                      onClick={() => setSourceTarget({ mode: "edit", source })}
                      className="transition-smooth flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--bg-panel-hover)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-[var(--text-primary)]">
                          {source.name}
                        </span>
                        <span className="block truncate text-[11.5px] text-[var(--text-secondary)]">
                          {source.default_rate}% · {source.recurring ? t.recurring : "—"}
                          {!source.active && ` · ${t.inactive}`}
                        </span>
                      </span>
                      <Pencil className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Day by day: what came in, what went out, what stayed. */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {d.finance.profit.title}
          </h2>

          <DataTable
            head={
              <>
                <Th>{d.finance.profit.day}</Th>
                <Th align="right">{d.finance.profit.revenue}</Th>
                <Th align="right">{d.finance.profit.expensesCol}</Th>
                <Th align="right">{d.finance.profit.profitCol}</Th>
              </>
            }
          >
            {dayRows.length === 0 ? (
              <tr>
                <Td className="py-8 text-center">{d.finance.noResults}</Td>
              </tr>
            ) : (
              dayRows.map((day) => (
                <Tr key={day.day}>
                  <Td className="text-[var(--text-primary)]">{shortDate(day.day, intl)}</Td>
                  <Td align="right" className="text-[var(--success-green)]">
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
        </section>

        {/* Every individual payment in, green because it all points one way. */}
        <section className="flex flex-col gap-3">
          <header className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{t.moneyIn}</h2>
            <p className="text-[12px] text-[var(--text-secondary)]">
              {fmt(incoming.length === 1 ? d.finance.entriesOne : d.finance.entries, {
                count: incoming.length,
              })}{" "}
              ·{" "}
              <span className="font-medium tabular-nums text-[var(--success-green)]">
                {money(total, intl)}
              </span>
            </p>
          </header>

          {/* Tall lists scroll inside the panel instead of pushing the page
              down forever — the header above always shows the true total. */}
          <div className="max-h-[520px] overflow-y-auto">
            <DataTable
              head={
                <>
                  <Th>{t.date}</Th>
                  <Th>{t.source}</Th>
                  <Th>{t.client}</Th>
                  <Th>{t.status}</Th>
                  <Th align="right">{t.amount}</Th>
                  <Th />
                </>
              }
            >
              {incoming.length === 0 ? (
                <tr>
                  <Td className="py-8 text-center" align="left">
                    {d.finance.noResults}
                  </Td>
                </tr>
              ) : (
                incoming.map((entry) => (
                  <Tr key={entry.id}>
                    <Td>{shortDate(entry.occurred_on, intl)}</Td>
                    <Td className="text-[var(--text-primary)]">{sourceName(entry.source_id)}</Td>
                    <Td>{commissionClientLabel(entry, data.clients, d.overview.unattributed)}</Td>
                    <Td>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] leading-none font-medium",
                          COMMISSION_STATUS_BADGE[entry.status],
                        )}
                      >
                        {commissionStatusLabel(d, entry.status)}
                      </span>
                    </Td>
                    <Td align="right" className="font-semibold text-[var(--success-green)]">
                      +{money(entry.amount, intl, entry.currency)}
                    </Td>
                    <Td align="right">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t.editEntry}
                        onClick={() => setCommissionTarget({ mode: "edit", commission: entry })}
                      >
                        <Pencil />
                      </Button>
                    </Td>
                  </Tr>
                ))
              )}
            </DataTable>
          </div>
        </section>
      </div>

      <CommissionDialog
        target={commissionTarget}
        sources={data.sources}
        clients={data.clients}
        currentUserId={currentUserId}
        onClose={() => setCommissionTarget(null)}
        onSaved={refresh}
      />

      <SourceDialog
        target={sourceTarget}
        onClose={() => setSourceTarget(null)}
        onSaved={refresh}
      />
    </PageContainer>
  );
}
