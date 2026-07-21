"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import {
  Breakdown,
  ErrorBanner,
  RangeTabs,
  StatCard,
  type BreakdownRow,
  type RangeKey,
} from "@/components/finance/finance-ui";
import { PnLChart } from "@/components/finance/pnl-chart";
import { CommissionDialog, type CommissionTarget } from "@/components/finance/commission-dialog";
import { useFinance } from "@/components/finance/use-finance";
import { dailyPnL, revenueBySource, totals } from "@/lib/finance/queries";
import { sourceTint } from "@/lib/finance/config";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { money, percent } from "@/lib/format-intl";
import { cn } from "@/lib/utils";
import type { FinanceSnapshot } from "@/lib/finance/queries";

export function OverviewView({
  initial,
  initialRange,
  firstName,
  currentUserId,
}: {
  initial: FinanceSnapshot;
  initialRange: RangeKey;
  firstName: string;
  currentUserId: string;
}) {
  const { d, intl } = useI18n();
  const { data, range, setRange, refresh, error, setError } = useFinance(initial, initialRange);
  const [target, setTarget] = React.useState<CommissionTarget | null>(null);

  const figures = React.useMemo(
    () => totals(data.commissions, data.expenses),
    [data.commissions, data.expenses],
  );

  const days = React.useMemo(
    () => dailyPnL(data.commissions, data.expenses, data.from, data.to),
    [data],
  );

  const bySource = React.useMemo(
    () => revenueBySource(data.commissions, data.sources),
    [data.commissions, data.sources],
  );

  /** Revenue attributed per client, so the top accounts are visible at a glance. */
  const byClient = React.useMemo(() => {
    const totalsByClient = new Map<string, number>();

    for (const entry of data.commissions) {
      const key = entry.client_id ?? "__none__";
      totalsByClient.set(key, (totalsByClient.get(key) ?? 0) + Number(entry.amount));
    }

    const grand = [...totalsByClient.values()].reduce((sum, value) => sum + value, 0);

    return [...totalsByClient.entries()]
      .map(([id, amount]) => ({
        id,
        name:
          id === "__none__"
            ? d.overview.unattributed
            : (data.clients.find((client) => client.id === id)?.name ?? "—"),
        amount,
        share: grand > 0 ? amount / grand : 0,
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);
  }, [data.commissions, data.clients, d]);

  const activeClients = data.clients.filter((client) => client.status === "active").length;

  const sourceRows: BreakdownRow[] = bySource.map((row, index) => ({
    key: row.source.id,
    label: row.source.name,
    sublabel: fmt(row.count === 1 ? d.finance.entriesOne : d.finance.entries, { count: row.count }),
    amount: money(row.amount, intl),
    share: row.share,
    color: sourceTint(index),
  }));

  const clientRows: BreakdownRow[] = byClient.map((row, index) => ({
    key: row.id,
    label: row.name,
    amount: money(row.amount, intl),
    share: row.share,
    color: sourceTint(index),
  }));

  return (
    <PageContainer
      title={fmt(d.overview.greeting, { name: firstName })}
      description={d.overview.subtitle}
      actions={
        <>
          <RangeTabs value={range} onChange={setRange} />
          <Button
            variant="primary"
            size="sm"
            onClick={() => setTarget({ mode: "create" })}
            disabled={data.sources.length === 0}
          >
            <Plus />
            {d.finance.revenue.newEntry}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label={d.overview.revenue} value={money(figures.revenue, intl)} />
          <StatCard
            label={d.overview.expenses}
            value={money(figures.expenses, intl)}
            tone="danger"
          />
          <StatCard
            label={d.overview.netProfit}
            value={money(figures.profit, intl)}
            hint={`${d.overview.margin} ${percent(figures.margin, intl)}`}
            tone={figures.profit >= 0 ? "success" : "danger"}
          />
          <StatCard
            label={d.overview.activeClients}
            value={String(activeClients)}
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

          <PnLChart days={days} height={250} />
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Breakdown
            title={d.overview.revenueBySource}
            rows={sourceRows}
            action={
              <Link
                href="/admin/revenue"
                className="flex items-center gap-1 text-[12px] text-[var(--text-secondary)] transition-smooth hover:text-[var(--accent-gold)]"
              >
                {d.overview.viewAll}
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            }
            empty={
              <div className="space-y-3">
                <p className="text-[13px] text-[var(--text-muted)]">{d.overview.noRevenueYet}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setTarget({ mode: "create" })}
                  disabled={data.sources.length === 0}
                >
                  <Plus />
                  {d.overview.addFirstEntry}
                </Button>
              </div>
            }
          />

          <Breakdown
            title={d.overview.topClients}
            rows={clientRows}
            empty={<p className="text-[13px] text-[var(--text-muted)]">{d.overview.noClientsYet}</p>}
          />
        </div>
      </div>

      <CommissionDialog
        target={target}
        sources={data.sources}
        clients={data.clients}
        currentUserId={currentUserId}
        onClose={() => setTarget(null)}
        onSaved={refresh}
      />
    </PageContainer>
  );
}
