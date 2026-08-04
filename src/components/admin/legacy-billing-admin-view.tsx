"use client";

import * as React from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  ReceiptText,
  RotateCcw,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  isLegacyInvoiceOverdue,
  legacyInvoiceMatchesPeriod,
  summariseLegacyInvoices,
  stripeDashboardInvoiceUrl,
  type LegacyAdminInvoice,
  type LegacyBillingSummary,
  type LegacyCurrencySummary,
  type LegacyPeriodFilter,
} from "@/lib/billing/legacy-admin";
import { shortDate } from "@/lib/format-intl";
import { useI18n } from "@/lib/i18n/provider";
import type { InvoiceStatus } from "@/lib/supabase/types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

type StatusFilter = InvoiceStatus | "all" | "overdue" | "failed";
type PeriodFilter = LegacyPeriodFilter;
type MoneyField =
  | "issuedAmount"
  | "outstandingAmount"
  | "overdueAmount"
  | "paidAmount"
  | "failedAmount";
type CountField =
  | "issuedCount"
  | "outstandingCount"
  | "overdueCount"
  | "paidCount"
  | "failedCount";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "failed", label: "Failed attempt" },
  { value: "paid", label: "Paid" },
  { value: "draft", label: "Draft" },
  { value: "void", label: "Void" },
  { value: "uncollectible", label: "Uncollectible" },
];

const PERIOD_OPTIONS: { value: PeriodFilter; label: string }[] = [
  { value: "all", label: "All service periods" },
  { value: "current-week", label: "Current service week" },
  { value: "previous-week", label: "Previous service week" },
  { value: "current-month", label: "Current service month" },
  { value: "previous-month", label: "Previous service month" },
];

const STATUS_VARIANT: Record<
  InvoiceStatus,
  "success" | "warning" | "neutral" | "danger"
> = {
  paid: "success",
  open: "warning",
  draft: "neutral",
  void: "neutral",
  uncollectible: "danger",
};

function statusLabel(status: InvoiceStatus): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "open":
      return "Open";
    case "draft":
      return "Draft";
    case "void":
      return "Void";
    case "uncollectible":
      return "Uncollectible";
  }
}

function formatMoney(value: number, intl: string, currency: string): string {
  try {
    return new Intl.NumberFormat(intl, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${new Intl.NumberFormat(intl, { maximumFractionDigits: 2 }).format(value)} ${currency}`;
  }
}

function formatAmount(
  value: number | null,
  intl: string,
  currency: string,
): string {
  return value === null ? "Invalid amount" : formatMoney(value, intl, currency);
}

function formatPeriod(invoice: LegacyAdminInvoice, intl: string): string {
  return `${shortDate(invoice.periodStart, intl)} – ${shortDate(invoice.periodEnd, intl)}`;
}

function formatCivilDate(value: string, intl: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(intl, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatTimestamp(value: string, intl: string): string {
  return new Date(value).toLocaleString(intl, {
    timeZone: "Europe/Lisbon",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function totalFor(
  currencies: LegacyCurrencySummary[],
  field:
    | "issuedCount"
    | "outstandingCount"
    | "overdueCount"
    | "paidCount"
    | "failedCount",
): number {
  return currencies.reduce((total, item) => total + item[field], 0);
}

function MoneyValues({
  currencies,
  field,
  countField,
  intl,
}: {
  currencies: LegacyCurrencySummary[];
  field: MoneyField;
  countField: CountField;
  intl: string;
}) {
  const relevant = currencies.filter((item) => item[countField] > 0);
  const values = relevant.length > 0 ? relevant : [{ ...emptySummary, currency: "EUR" }];

  return (
    <div
      className={cn(
        "mt-2 font-semibold tracking-tight tabular-nums",
        values.length > 1 ? "space-y-0.5 text-[16px]" : "text-[22px]",
      )}
    >
      {values.map((item) => (
        <p key={item.currency}>{formatMoney(item[field], intl, item.currency)}</p>
      ))}
    </div>
  );
}

const emptySummary: LegacyCurrencySummary = {
  currency: "EUR",
  issuedCount: 0,
  issuedAmount: 0,
  outstandingCount: 0,
  outstandingAmount: 0,
  overdueCount: 0,
  overdueAmount: 0,
  paidCount: 0,
  paidAmount: 0,
  failedCount: 0,
  failedAmount: 0,
  draftCount: 0,
  voidCount: 0,
  uncollectibleCount: 0,
};

function SummaryCard({
  label,
  children,
  detail,
  tone = "gold",
}: {
  label: string;
  children: React.ReactNode;
  detail: string;
  tone?: "gold" | "success" | "danger" | "warning";
}) {
  const colour =
    tone === "success"
      ? "text-[var(--success-green)]"
      : tone === "danger"
        ? "text-[var(--danger-red)]"
        : tone === "warning"
          ? "text-[var(--warning-orange)]"
          : "text-[var(--accent-gold)]";

  return (
    <article className="panel min-w-0 p-4">
      <p className="label-caps">{label}</p>
      <div className={colour}>{children}</div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        {detail}
      </p>
    </article>
  );
}

function InvoiceStatusBadges({
  invoice,
  today,
}: {
  invoice: LegacyAdminInvoice;
  today: string;
}) {
  const overdue = isLegacyInvoiceOverdue(invoice, today);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={overdue ? "danger" : STATUS_VARIANT[invoice.status]}>
        {overdue ? "Overdue" : statusLabel(invoice.status)}
      </Badge>
      {invoice.paymentFailedAt && <Badge variant="danger">Failed attempt</Badge>}
      {invoice.amount === null && <Badge variant="danger">Invalid amount</Badge>}
    </div>
  );
}

function InvoiceDates({ invoice, intl }: { invoice: LegacyAdminInvoice; intl: string }) {
  if (invoice.paidAt) {
    return (
      <>
        <span className="block text-[var(--success-green)]">
          Paid {formatTimestamp(invoice.paidAt, intl)}
        </span>
        {invoice.dueDate && (
          <span className="mt-0.5 block text-[10.5px] text-[var(--text-muted)]">
            Due {formatCivilDate(invoice.dueDate, intl)}
          </span>
        )}
      </>
    );
  }

  if (invoice.dueDate) {
    return <span>Due {formatCivilDate(invoice.dueDate, intl)}</span>;
  }

  return invoice.issuedAt ? (
    <span>Issued {formatTimestamp(invoice.issuedAt, intl)}</span>
  ) : (
    <span className="text-[var(--text-muted)]">Not issued</span>
  );
}

function InvoiceLinks({
  invoice,
  mobile = false,
}: {
  invoice: LegacyAdminInvoice;
  mobile?: boolean;
}) {
  const dashboardUrl = stripeDashboardInvoiceUrl(invoice.stripeInvoiceId);
  const linkClass = cn(
    "transition-smooth inline-flex items-center justify-center gap-1.5 rounded-[9px] border border-[var(--border-subtle)] px-2.5 text-[12px] font-medium hover:border-[var(--border-strong)] hover:bg-[var(--bg-panel-hover)]",
    mobile ? "min-h-10 flex-1" : "min-h-8",
  );

  if (!invoice.stripeHostedUrl && !dashboardUrl && !invoice.hostedUrlInvalid) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", mobile && "w-full")}>
      {invoice.stripeHostedUrl && (
        <a
          href={invoice.stripeHostedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(linkClass, "text-[var(--accent-gold-strong)]")}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          Hosted page
        </a>
      )}
      {dashboardUrl && (
        <a
          href={dashboardUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(linkClass, "text-[var(--text-secondary)]")}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          Stripe dashboard
        </a>
      )}
      {invoice.hostedUrlInvalid && (
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--danger-red)]">
          <AlertTriangle className="size-3.5" aria-hidden />
          Invalid stored Stripe link
        </span>
      )}
    </div>
  );
}

function InvoiceLines({ invoice, intl }: { invoice: LegacyAdminInvoice; intl: string }) {
  if (invoice.lineItems.length === 0) return null;

  return (
    <details className="group/lines mt-2">
      <summary className="transition-smooth inline-flex min-h-10 cursor-pointer list-none items-center text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] lg:min-h-8 [&::-webkit-details-marker]:hidden">
        {invoice.lineItems.length} stored line{invoice.lineItems.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-1 border-l border-[var(--border-subtle)] pl-2.5">
        {invoice.lineItems.map((line, index) => (
          <li
            key={`${invoice.id}-line-${index}`}
            className="flex min-w-0 items-start justify-between gap-3 text-[11px]"
          >
            <span className="min-w-0 break-words text-[var(--text-secondary)]">
              {line.label}
            </span>
            <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
              {formatAmount(line.amount, intl, invoice.currency)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function matchesStatus(
  invoice: LegacyAdminInvoice,
  filter: StatusFilter,
  today: string,
): boolean {
  if (filter === "all") return true;
  if (filter === "overdue") return isLegacyInvoiceOverdue(invoice, today);
  if (filter === "failed") return Boolean(invoice.paymentFailedAt);
  return invoice.status === filter;
}

export function LegacyBillingAdminView({
  invoices,
  summary,
  today,
  clientWarning,
}: {
  invoices: LegacyAdminInvoice[];
  summary: LegacyBillingSummary;
  today: string;
  clientWarning: string | null;
}) {
  const { intl } = useI18n();
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [period, setPeriod] = React.useState<PeriodFilter>("all");
  const [page, setPage] = React.useState(1);

  const periodInvoices = React.useMemo(
    () => invoices.filter((invoice) => legacyInvoiceMatchesPeriod(invoice, period, today)),
    [invoices, period, today],
  );
  const activeSummary = React.useMemo(
    () => summariseLegacyInvoices(periodInvoices, today),
    [periodInvoices, today],
  );
  const filtered = React.useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return periodInvoices.filter((invoice) => {
      if (!matchesStatus(invoice, status, today)) return false;
      if (!needle) return true;

      return [
        invoice.billingName ?? "",
        invoice.clientName,
        invoice.clientEmail,
        invoice.clientId,
        invoice.stripeInvoiceId ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [periodInvoices, search, status, today]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const startIndex = (page - 1) * PAGE_SIZE;
  const visibleInvoices = filtered.slice(startIndex, startIndex + PAGE_SIZE);
  const firstVisible = filtered.length === 0 ? 0 : startIndex + 1;
  const lastVisible = Math.min(startIndex + PAGE_SIZE, filtered.length);
  const issuedCount = totalFor(activeSummary.currencies, "issuedCount");
  const openCount = totalFor(activeSummary.currencies, "outstandingCount");
  const overdueCount = totalFor(activeSummary.currencies, "overdueCount");
  const paidCount = totalFor(activeSummary.currencies, "paidCount");
  const periodLabel = PERIOD_OPTIONS.find((option) => option.value === period)?.label ?? "";

  function clearFilters() {
    setSearch("");
    setStatus("all");
    setPeriod("all");
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="panel flex items-start gap-3 p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[var(--text-primary)]">
            Legacy billing · Read-only
          </p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            This view only reads invoices already stored in Supabase. Opening it does not
            create, send, reconcile, retry or edit invoices. Open amounts are nominal invoice
            totals, not confirmed remaining balances after partial payments. A billing name is
            the client&apos;s current profile value, not a historical recipient snapshot.
          </p>
        </div>
      </div>

      {clientWarning && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/10 p-4"
        >
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-[var(--warning-orange)]"
            aria-hidden
          />
          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {clientWarning}
          </p>
        </div>
      )}

      {activeSummary.invalidAmountCount > 0 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 p-4"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--danger-red)]" aria-hidden />
          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {activeSummary.invalidAmountCount} invoice amount{activeSummary.invalidAmountCount === 1 ? " is" : "s are"} invalid and excluded from monetary totals. The affected rows remain visible below.
          </p>
        </div>
      )}

      <section
        aria-label="Billing totals"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
      >
        <SummaryCard
          label="Issued"
          detail={`${issuedCount} issued invoice${issuedCount === 1 ? "" : "s"}`}
        >
          <MoneyValues
            currencies={activeSummary.currencies}
            field="issuedAmount"
            countField="issuedCount"
            intl={intl}
          />
        </SummaryCard>
        <SummaryCard
          label="Outstanding"
          detail={`${openCount} open invoice${openCount === 1 ? "" : "s"}`}
        >
          <MoneyValues
            currencies={activeSummary.currencies}
            field="outstandingAmount"
            countField="outstandingCount"
            intl={intl}
          />
        </SummaryCard>
        <SummaryCard
          label="Overdue"
          detail={`${overdueCount} past due invoice${overdueCount === 1 ? "" : "s"}`}
          tone={overdueCount > 0 ? "danger" : "gold"}
        >
          <MoneyValues
            currencies={activeSummary.currencies}
            field="overdueAmount"
            countField="overdueCount"
            intl={intl}
          />
        </SummaryCard>
        <SummaryCard
          label="Paid"
          detail={`${paidCount} paid invoice${paidCount === 1 ? "" : "s"}`}
          tone="success"
        >
          <MoneyValues
            currencies={activeSummary.currencies}
            field="paidAmount"
            countField="paidCount"
            intl={intl}
          />
        </SummaryCard>
        <SummaryCard
          label="Failed attempts"
          detail={
            activeSummary.failedCount === 0
              ? "No failed payment attempts"
              : activeSummary.currencies
                  .filter((item) => item.failedCount > 0)
                  .map((item) => formatMoney(item.failedAmount, intl, item.currency))
                  .join(" · ") + " nominal"
          }
          tone={activeSummary.failedCount > 0 ? "warning" : "gold"}
        >
          <p className="mt-2 text-[22px] font-semibold tracking-tight tabular-nums">
            {activeSummary.failedCount}
          </p>
        </SummaryCard>
      </section>

      {summary.totalCount === 0 ? (
        <div className="panel flex flex-col items-center px-6 py-12 text-center">
          <ReceiptText className="size-6 text-[var(--text-muted)]" aria-hidden />
          <h2 className="mt-3 text-[14px] font-semibold text-[var(--text-primary)]">
            No invoices yet
          </h2>
          <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            There are no rows in the legacy invoices table. Opening this page does not create or
            send one.
          </p>
        </div>
      ) : (
        <section aria-labelledby="invoice-history-title" className="space-y-3">
          <div className="panel grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_12rem_13rem_auto] lg:items-end">
            <div className="min-w-0 flex-1">
              <Label htmlFor="billing-search" className="sr-only">
                Search invoices
              </Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
                  aria-hidden
                />
                <Input
                  id="billing-search"
                  type="search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search client, billing name, email or Stripe invoice ID"
                  className="pl-9"
                />
              </div>
            </div>

            <div className="w-full sm:w-44">
              <Label id="billing-status-label" className="sr-only">
                Filter by invoice status
              </Label>
              <Select
                value={status}
                onValueChange={(value) => {
                  setStatus(value as StatusFilter);
                  setPage(1);
                }}
              >
                <SelectTrigger aria-labelledby="billing-status-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-full">
              <Label id="billing-period-label" className="sr-only">
                Filter by service period
              </Label>
              <Select
                value={period}
                onValueChange={(value) => {
                  setPeriod(value as PeriodFilter);
                  setPage(1);
                }}
              >
                <SelectTrigger aria-labelledby="billing-period-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(search || status !== "all" || period !== "all") && (
              <Button variant="ghost" size="md" onClick={clearFilters}>
                <RotateCcw aria-hidden />
                Clear
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <div>
              <h2
                id="invoice-history-title"
                className="text-[15px] font-semibold text-[var(--text-primary)]"
              >
                Invoice history
              </h2>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]" aria-live="polite">
                {filtered.length} of {periodInvoices.length} in {periodLabel.toLocaleLowerCase()} · {summary.totalCount} total
              </p>
            </div>
            <p className="text-[11.5px] text-[var(--text-muted)]">
              Newest first · week/month assigned by period end
            </p>
          </div>

          {filtered.length === 0 ? (
            <div className="panel px-6 py-8 text-center">
              <p className="text-[13px] font-medium text-[var(--text-primary)]">
                No invoices match these filters
              </p>
              <Button variant="ghost" size="md" className="mt-2" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <>
              <ul className="space-y-3 lg:hidden">
                {visibleInvoices.map((invoice) => (
                  <li
                    key={invoice.id}
                    className={cn(
                      "panel p-4",
                      isLegacyInvoiceOverdue(invoice, today) &&
                        "border-[var(--danger-red)]/30 bg-[var(--danger-red)]/5",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                          {invoice.billingName ?? invoice.clientName}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                          {invoice.billingName && invoice.billingName !== invoice.clientName
                            ? `${invoice.clientName} · ${invoice.clientEmail}`
                            : invoice.clientEmail}
                        </p>
                      </div>
                      <p
                        className={cn(
                          "shrink-0 text-[15px] font-semibold tabular-nums",
                          invoice.amount === null
                            ? "text-[var(--danger-red)]"
                            : "text-[var(--text-primary)]",
                        )}
                      >
                        {formatAmount(invoice.amount, intl, invoice.currency)}
                      </p>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3">
                      <div>
                        <p className="text-[12px] text-[var(--text-secondary)]">
                          {formatPeriod(invoice, intl)}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                          <InvoiceDates invoice={invoice} intl={intl} />
                        </p>
                      </div>
                      <InvoiceStatusBadges invoice={invoice} today={today} />
                    </div>

                    {invoice.paymentFailedAt && (
                      <p className="mt-2 text-[11px] text-[var(--warning-orange)]">
                        Last failed attempt {formatTimestamp(invoice.paymentFailedAt, intl)}
                      </p>
                    )}

                    <InvoiceLines invoice={invoice} intl={intl} />

                    <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
                      <InvoiceLinks invoice={invoice} mobile />
                    </div>
                  </li>
                ))}
              </ul>

              <div className="panel hidden overflow-x-auto lg:block">
                <table className="w-full min-w-[920px] text-left text-[12px]">
                  <caption className="sr-only">
                    Legacy invoice history, newest billing period first
                  </caption>
                  <thead className="bg-[var(--bg-base)] text-[var(--text-muted)]">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Client / billing name
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Period
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        Amount
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Due / paid
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Invoice
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInvoices.map((invoice) => (
                      <tr
                        key={invoice.id}
                        className={cn(
                          "border-t border-[var(--border-subtle)] align-top",
                          isLegacyInvoiceOverdue(invoice, today) &&
                            "bg-[var(--danger-red)]/5",
                        )}
                      >
                        <td className="px-4 py-3">
                          <p className="max-w-52 truncate font-medium text-[var(--text-primary)]">
                            {invoice.billingName ?? invoice.clientName}
                          </p>
                          <p className="mt-0.5 max-w-52 truncate text-[10.5px] text-[var(--text-muted)]">
                            {invoice.billingName && invoice.billingName !== invoice.clientName
                              ? `${invoice.clientName} · ${invoice.clientEmail}`
                              : invoice.clientEmail}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-[var(--text-secondary)]">
                          {formatPeriod(invoice, intl)}
                        </td>
                        <td className="px-4 py-3">
                          <InvoiceStatusBadges invoice={invoice} today={today} />
                          {invoice.paymentFailedAt && (
                            <p className="mt-1.5 text-[10.5px] text-[var(--warning-orange)]">
                              {formatTimestamp(invoice.paymentFailedAt, intl)}
                            </p>
                          )}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 text-right font-medium tabular-nums",
                            invoice.amount === null
                              ? "text-[var(--danger-red)]"
                              : "text-[var(--text-primary)]",
                          )}
                        >
                          {formatAmount(invoice.amount, intl, invoice.currency)}
                        </td>
                        <td className="px-4 py-3 text-[var(--text-secondary)]">
                          <InvoiceDates invoice={invoice} intl={intl} />
                        </td>
                        <td className="px-4 py-3">
                          <InvoiceLinks invoice={invoice} />
                          <InvoiceLines invoice={invoice} intl={intl} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="panel flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-center text-[11.5px] text-[var(--text-muted)] sm:text-left">
                  Showing {firstVisible}–{lastVisible} of {filtered.length}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    <ChevronLeft aria-hidden />
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={page >= pageCount}
                    onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                  >
                    Next
                    <ChevronRight aria-hidden />
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
