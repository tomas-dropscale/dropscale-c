"use client";

import * as React from "react";
import { Pencil, Plus, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import {
  Breakdown,
  DataTable,
  ErrorBanner,
  RangeTabs,
  StatCard,
  Td,
  Th,
  Tr,
  type BreakdownRow,
  type RangeKey,
} from "@/components/finance/finance-ui";
import { CommissionDialog, type CommissionTarget } from "@/components/finance/commission-dialog";
import { SourceDialog, type SourceTarget } from "@/components/finance/source-dialog";
import { useFinance } from "@/components/finance/use-finance";
import { revenueBySource, sum } from "@/lib/finance/queries";
import { COMMISSION_STATUS_BADGE, commissionStatusLabel, sourceTint } from "@/lib/finance/config";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { money, percent, shortDate } from "@/lib/format-intl";
import { cn } from "@/lib/utils";
import type { FinanceSnapshot } from "@/lib/finance/queries";

export function RevenueView({
  initial,
  initialRange,
  currentUserId,
}: {
  initial: FinanceSnapshot;
  initialRange: RangeKey;
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

  const total = sum(data.commissions.map((entry) => Number(entry.amount)));
  const pending = sum(
    data.commissions.filter((entry) => entry.status === "pending").map((e) => Number(e.amount)),
  );
  const recurringShare = React.useMemo(() => {
    const recurringIds = new Set(data.sources.filter((s) => s.recurring).map((s) => s.id));
    const recurring = sum(
      data.commissions
        .filter((entry) => recurringIds.has(entry.source_id))
        .map((entry) => Number(entry.amount)),
    );
    return total > 0 ? recurring / total : 0;
  }, [data.commissions, data.sources, total]);

  const rows: BreakdownRow[] = bySource.map((row, index) => ({
    key: row.source.id,
    label: row.source.name,
    sublabel: fmt(row.count === 1 ? d.finance.entriesOne : d.finance.entries, { count: row.count }),
    amount: money(row.amount, intl),
    share: row.share,
    color: sourceTint(index),
  }));

  const sourceName = (id: string) => data.sources.find((s) => s.id === id)?.name ?? "—";
  const clientName = (id: string | null) =>
    id ? (data.clients.find((c) => c.id === id)?.name ?? "—") : d.overview.unattributed;

  return (
    <PageContainer
      title={t.title}
      description={t.subtitle}
      actions={
        <>
          <RangeTabs value={range} onChange={setRange} />
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
          <StatCard label={t.title} value={money(total, intl)} />
          <StatCard
            label={commissionStatusLabel(d, "pending")}
            value={money(pending, intl)}
            tone="primary"
          />
          <StatCard
            label={t.recurring}
            value={percent(recurringShare, intl)}
            tone="primary"
            hint={t.recurringHelp}
          />
          <StatCard
            label={t.sources}
            value={String(data.sources.filter((s) => s.active).length)}
            tone="primary"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <Breakdown
            title={t.bySource}
            rows={rows}
            empty={
              <p className="text-[13px] text-[var(--text-muted)]">{d.overview.noRevenueYet}</p>
            }
          />

          {showSources ? (
            <section className="panel flex flex-col p-5">
              <header className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                  {t.sources}
                </h2>
                <Button variant="secondary" size="sm" onClick={() => setSourceTarget({ mode: "create" })}>
                  <Plus />
                  {t.newSource}
                </Button>
              </header>

              {data.sources.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-[var(--text-muted)]">
                  {t.noSources}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.sources.map((source) => (
                    <li key={source.id}>
                      <button
                        type="button"
                        onClick={() => setSourceTarget({ mode: "edit", source })}
                        className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-smooth hover:bg-[var(--bg-panel-hover)]"
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
          ) : (
            <section className="flex flex-col gap-3">
              <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                {t.recentEntries}
              </h2>

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
                {data.commissions.length === 0 ? (
                  <tr>
                    <Td className="py-8 text-center" align="left">
                      {d.finance.noResults}
                    </Td>
                  </tr>
                ) : (
                  data.commissions.slice(0, 50).map((entry) => (
                    <Tr key={entry.id}>
                      <Td>{shortDate(entry.occurred_on, intl)}</Td>
                      <Td className="text-[var(--text-primary)]">{sourceName(entry.source_id)}</Td>
                      <Td>{clientName(entry.client_id)}</Td>
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
                      <Td align="right" className="font-semibold text-[var(--accent-gold)]">
                        {money(entry.amount, intl, entry.currency)}
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
            </section>
          )}
        </div>
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
