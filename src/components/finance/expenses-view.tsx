"use client";

import * as React from "react";
import { Pencil, Plus, Repeat } from "lucide-react";

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
import { ExpenseDialog, type ExpenseTarget } from "@/components/finance/expense-dialog";
import { useFinance } from "@/components/finance/use-finance";
import { expensesByCategory, sum } from "@/lib/finance/queries";
import { EXPENSE_TINTS, expenseCategoryLabel } from "@/lib/finance/config";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { money, shortDate } from "@/lib/format-intl";
import type { FinanceSnapshot } from "@/lib/finance/queries";

export function ExpensesView({
  initial,
  initialRange,
  currentUserId,
}: {
  initial: FinanceSnapshot;
  initialRange: RangeKey;
  currentUserId: string;
}) {
  const { d, intl } = useI18n();
  const t = d.finance.expenses;

  const { data, range, setRange, refresh, error, setError } = useFinance(initial, initialRange);
  const [target, setTarget] = React.useState<ExpenseTarget | null>(null);

  const byCategory = React.useMemo(
    () => expensesByCategory(data.expenses),
    [data.expenses],
  );

  const total = sum(data.expenses.map((entry) => Number(entry.amount)));
  const recurring = sum(
    data.expenses.filter((entry) => entry.recurring).map((entry) => Number(entry.amount)),
  );
  const biggest = byCategory[0];

  const rows: BreakdownRow[] = byCategory.map((row) => ({
    key: row.category,
    label: expenseCategoryLabel(d, row.category),
    sublabel: fmt(row.count === 1 ? d.finance.entriesOne : d.finance.entries, { count: row.count }),
    amount: money(row.amount, intl),
    share: row.share,
    color: EXPENSE_TINTS[row.category],
  }));

  return (
    <PageContainer
      title={t.title}
      description={t.subtitle}
      actions={
        <>
          <RangeTabs value={range} onChange={setRange} />
          <Button variant="primary" size="sm" onClick={() => setTarget({ mode: "create" })}>
            <Plus />
            {t.newEntry}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label={t.title} value={money(total, intl)} tone="danger" />
          <StatCard label={t.recurringTotal} value={money(recurring, intl)} tone="primary" />
          <StatCard
            label={t.byCategory}
            value={biggest ? expenseCategoryLabel(d, biggest.category) : "—"}
            hint={biggest ? money(biggest.amount, intl) : undefined}
            tone="primary"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <Breakdown
            title={t.byCategory}
            rows={rows}
            empty={<p className="text-[13px] text-[var(--text-muted)]">{d.finance.noResults}</p>}
          />

          <section className="flex flex-col gap-3">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
              {t.recentEntries}
            </h2>

            <DataTable
              head={
                <>
                  <Th>{t.date}</Th>
                  <Th>{t.category}</Th>
                  <Th>{t.vendor}</Th>
                  <Th align="right">{t.amount}</Th>
                  <Th />
                </>
              }
            >
              {data.expenses.length === 0 ? (
                <tr>
                  <Td className="py-8 text-center">{d.finance.noResults}</Td>
                </tr>
              ) : (
                data.expenses.slice(0, 50).map((entry) => (
                  <Tr key={entry.id}>
                    <Td>{shortDate(entry.incurred_on, intl)}</Td>
                    <Td className="text-[var(--text-primary)]">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: EXPENSE_TINTS[entry.category] }}
                          aria-hidden
                        />
                        {expenseCategoryLabel(d, entry.category)}
                      </span>
                    </Td>
                    <Td>
                      <span className="flex items-center gap-1.5">
                        {entry.vendor ?? "—"}
                        {entry.recurring && (
                          <Repeat
                            className="size-3 text-[var(--text-muted)]"
                            aria-label={t.recurring}
                          />
                        )}
                      </span>
                    </Td>
                    <Td align="right" className="font-semibold text-[var(--text-primary)]">
                      {money(entry.amount, intl, entry.currency)}
                    </Td>
                    <Td align="right">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t.editEntry}
                        onClick={() => setTarget({ mode: "edit", expense: entry })}
                      >
                        <Pencil />
                      </Button>
                    </Td>
                  </Tr>
                ))
              )}
            </DataTable>
          </section>
        </div>
      </div>

      <ExpenseDialog
        target={target}
        currentUserId={currentUserId}
        onClose={() => setTarget(null)}
        onSaved={refresh}
      />
    </PageContainer>
  );
}
