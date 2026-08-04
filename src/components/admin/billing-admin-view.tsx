"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  FileWarning,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { FormAlert } from "@/components/auth/auth-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BillingAdminDashboard } from "@/lib/billing/invoices";
import { money, shortDate } from "@/lib/format-intl";
import { fmt, type Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { safeStripeUrl } from "@/lib/stripe/urls";
import type { InvoiceStatus } from "@/lib/supabase/types";
import { cn } from "@/lib/utils";

type InvoiceHistoryItem = BillingAdminDashboard["invoices"][number];
type AutomationStatus = NonNullable<BillingAdminDashboard["automation"]>["status"];
type Feedback = { tone: "error" | "success"; message: string } | null;

type StripeReadiness = {
  ready: boolean;
  issuanceEnabled: boolean;
  automationEnabled: boolean;
  limitations: string[];
};

const STATUS_VARIANT: Record<
  InvoiceStatus,
  "success" | "warning" | "neutral" | "danger"
> = {
  paid: "success",
  open: "warning",
  draft: "neutral",
  waived: "neutral",
  void: "neutral",
  uncollectible: "danger",
};

function statusLabel(status: InvoiceStatus, d: Dictionary) {
  switch (status) {
    case "paid":
      return d.adminBilling.statusPaid;
    case "open":
      return d.adminBilling.statusOpen;
    case "draft":
      return d.adminBilling.statusDraft;
    case "waived":
      return d.adminBilling.statusWaived;
    case "void":
      return d.adminBilling.statusVoid;
    case "uncollectible":
      return d.adminBilling.statusUncollectible;
  }
}

function formatPeriod(start: string, end: string, intl: string) {
  return `${shortDate(start, intl)} – ${shortDate(end, intl)}`;
}

function formatTimestamp(value: string | null, intl: string, fallback: string) {
  if (!value) return fallback;
  return new Date(value).toLocaleString(intl, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function requestError(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (typeof record.message === "string") return record.message;
  return fallback;
}

function deliveryNeedsReconciliation(invoice: {
  status: InvoiceStatus;
  issued_at: string | null;
  stripe_sent_at: string | null;
}) {
  return Boolean(
    invoice.stripe_sent_at &&
      (invoice.status === "draft" || invoice.issued_at === null),
  );
}

function automationStatusLabel(
  status: AutomationStatus,
  d: Dictionary,
) {
  switch (status) {
    case "running":
      return d.adminBilling.automationRunning;
    case "succeeded":
      return d.adminBilling.automationSucceeded;
    case "partial":
      return d.adminBilling.automationPartial;
    case "failed":
      return d.adminBilling.automationFailed;
  }
}

function SummaryCard({
  label,
  value,
  detail,
  tone = "gold",
  icon: Icon,
  className,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "gold" | "success" | "warning";
  icon: LucideIcon;
  className?: string;
}) {
  const colour =
    tone === "success"
      ? "text-[var(--success-green)]"
      : tone === "warning"
        ? "text-[var(--warning-orange)]"
        : "text-[var(--accent-gold)]";

  return (
    <div className={cn("panel min-w-0 p-4 sm:p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="label-caps min-w-0">{label}</p>
        <Icon className={cn("size-4 shrink-0", colour)} aria-hidden />
      </div>
      <p
        className={cn(
          "mt-2 text-[24px] font-semibold tracking-tight tabular-nums",
          colour,
        )}
      >
        {value}
      </p>
      {detail && (
        <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">{detail}</p>
      )}
    </div>
  );
}

function InvoiceLinks({
  invoice,
  d,
}: {
  invoice: InvoiceHistoryItem;
  d: Dictionary;
}) {
  const stripeHostedUrl = safeStripeUrl(invoice.stripe_hosted_url);
  const stripeInvoicePdf = safeStripeUrl(invoice.stripe_invoice_pdf);

  if (!stripeHostedUrl && !stripeInvoicePdf) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {stripeHostedUrl && (
        <a
          href={stripeHostedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="transition-smooth inline-flex min-h-8 items-center gap-1.5 text-[12px] font-medium text-[var(--accent-gold-strong)] hover:text-[var(--text-primary)]"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {d.adminBilling.openStripe}
        </a>
      )}
      {stripeInvoicePdf && (
        <a
          href={stripeInvoicePdf}
          target="_blank"
          rel="noopener noreferrer"
          className="transition-smooth inline-flex min-h-8 items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <Download className="size-3.5" aria-hidden />
          PDF
        </a>
      )}
    </div>
  );
}

function PaymentState({
  invoice,
  d,
}: {
  invoice: InvoiceHistoryItem;
  d: Dictionary;
}) {
  if (invoice.payment_failed_at) {
    return <Badge variant="danger">{d.adminBilling.paymentFailed}</Badge>;
  }
  if (invoice.status === "paid") {
    return (
      <span className="text-[12px] text-[var(--success-green)]">
        {d.adminBilling.settled}
      </span>
    );
  }
  if (invoice.status === "open") {
    return (
      <span className="text-[12px] text-[var(--text-secondary)]">
        {d.adminBilling.awaiting}
      </span>
    );
  }
  return <span className="text-[12px] text-[var(--text-muted)]">—</span>;
}

export function BillingAdminView({
  dashboard,
}: {
  dashboard: BillingAdminDashboard;
}) {
  const router = useRouter();
  const { d, intl } = useI18n();
  const [syncing, setSyncing] = React.useState(false);
  const [checkingStripe, setCheckingStripe] = React.useState(false);
  const [feedback, setFeedback] = React.useState<Feedback>(null);

  const failedDetail = `${fmt(d.adminBilling.failedCount, {
    count: dashboard.summary.failedCount,
  })} · ${money(dashboard.summary.failed, intl, dashboard.currency)}`;
  const notReceivedDetail = `${fmt(d.adminBilling.closedThrough, {
    date: shortDate(dashboard.positions.closedThrough, intl),
  })}${
    dashboard.positions.summary.clientsNeedingAttention > 0
      ? ` · ${fmt(d.adminBilling.attentionCount, {
          count: dashboard.positions.summary.clientsNeedingAttention,
        })}`
      : ""
  }`;
  const automation = dashboard.automation;
  const automationStatus = automation
    ? automationStatusLabel(automation.status, d)
    : null;
  const clientPositions = [...dashboard.positions.clients].sort(
    (left, right) =>
      Number(right.closed.needsAttentionCount > 0) -
        Number(left.closed.needsAttentionCount > 0) ||
      right.closed.supportedNotReceived - left.closed.supportedNotReceived ||
      right.current.accruedFee - left.current.accruedFee ||
      left.clientName.localeCompare(right.clientName, intl),
  );

  async function refreshLedger() {
    setSyncing(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/sync-ledgers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ periodStart: dashboard.selectedWeek.start }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        setFeedback({
          tone: "error",
          message: requestError(body, d.adminBilling.refreshFailed),
        });
        router.refresh();
        return;
      }
      setFeedback({ tone: "success", message: d.adminBilling.refreshDone });
      router.refresh();
    } catch {
      setFeedback({ tone: "error", message: d.adminBilling.refreshFailed });
    } finally {
      setSyncing(false);
    }
  }

  async function checkStripe() {
    setCheckingStripe(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/stripe/readiness", {
        method: "GET",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as
        | StripeReadiness
        | { error?: string }
        | null;
      if (!response.ok || !body || !("ready" in body)) {
        setFeedback({
          tone: "error",
          message: requestError(body, d.adminBilling.stripeCheckFailed),
        });
        return;
      }
      const automaticArmed =
        body.issuanceEnabled && body.automationEnabled;
      setFeedback({
        tone: body.ready ? "success" : "error",
        message: body.ready
          ? `${d.adminBilling.stripeReady}. ${
              automaticArmed
                ? d.adminBilling.stripeGateEnabled
                : d.adminBilling.stripeGateDisabled
            }. ${d.adminBilling.stripeReadOnlyLimitation}`
          : `${d.adminBilling.stripeNotReady}. ${d.adminBilling.stripeNotReadyDetail}`,
      });
    } catch {
      setFeedback({ tone: "error", message: d.adminBilling.stripeCheckFailed });
    } finally {
      setCheckingStripe(false);
    }
  }

  return (
    <div className="space-y-6">
      <section aria-label={d.adminBilling.summaryLabel}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label={d.adminBilling.selectedWeekBilled}
            value={money(
              dashboard.summary.selectedWeekBilled,
              intl,
              dashboard.currency,
            )}
            detail={fmt(d.adminBilling.invoiceCount, {
              count: dashboard.summary.invoiceCount,
            })}
            icon={CalendarDays}
          />
          <SummaryCard
            label={d.adminBilling.currentMonthBilled}
            value={money(
              dashboard.summary.currentMonthBilled,
              intl,
              dashboard.currency,
            )}
            icon={FileCheck2}
          />
          <SummaryCard
            label={d.adminBilling.currentMonthPaid}
            value={money(
              dashboard.summary.currentMonthPaid,
              intl,
              dashboard.currency,
            )}
            detail={fmt(d.adminBilling.paidCount, {
              count: dashboard.summary.paidCount,
            })}
            tone="success"
            icon={CheckCircle2}
          />
          <SummaryCard
            label={d.adminBilling.outstanding}
            value={money(
              dashboard.summary.outstanding,
              intl,
              dashboard.currency,
            )}
            detail={failedDetail}
            tone={dashboard.summary.failedCount > 0 ? "warning" : "gold"}
            icon={
              dashboard.summary.failedCount > 0
                ? FileWarning
                : CircleDollarSign
            }
          />
        </div>
      </section>

      <section
        className="panel flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        aria-label={d.adminBilling.automationLabel}
      >
        <div className="min-w-0">
          <p className="label-caps">{d.adminBilling.automationLabel}</p>
          <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
            {automation && automationStatus
              ? fmt(d.adminBilling.automationRunSummary, {
                  status: automationStatus,
                  date: formatTimestamp(
                    automation.finished_at ?? automation.started_at,
                    intl,
                    "—",
                  ),
                  issued: automation.issued_items,
                  blocked: automation.blocked_items,
                  errors: automation.error_count,
                })
              : d.adminBilling.automationNoRuns}
          </p>
          {automation && !automation.issuance_enabled && (
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              {d.adminBilling.automationIssuanceLocked}
            </p>
          )}
        </div>
        {automation && automationStatus && (
          <Badge
            variant={
              automation.status === "succeeded"
                ? "success"
                : automation.status === "failed"
                  ? "danger"
                  : "warning"
            }
          >
            {automationStatus}
          </Badge>
        )}
      </section>

      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <SummaryCard
          label={d.adminBilling.notReceived}
          value={money(
            dashboard.positions.summary.supportedNotReceived,
            intl,
            dashboard.currency,
          )}
          detail={notReceivedDetail}
          icon={CircleDollarSign}
          className="w-full sm:max-w-sm"
        />

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Button
            type="button"
            variant="secondary"
            className="min-h-10 w-full sm:w-auto"
            loading={checkingStripe}
            disabled={syncing}
            onClick={checkStripe}
          >
            <CheckCircle2 />
            {checkingStripe
              ? d.adminBilling.stripeChecking
              : d.adminBilling.stripeCheck}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="min-h-10 w-full sm:w-auto"
            loading={syncing}
            disabled={checkingStripe}
            onClick={refreshLedger}
          >
            <RefreshCw />
            {syncing ? d.adminBilling.refreshing : d.adminBilling.refreshLedger}
          </Button>
        </div>
      </section>

      {feedback && (
        <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>
      )}

      <section
        className="space-y-4"
        aria-label={d.adminBilling.positionTitle}
      >
        <div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
            {d.adminBilling.positionTitle}
          </h2>
          <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {d.adminBilling.positionSubtitle}
          </p>
        </div>

        <div className="space-y-3">
          {clientPositions.map((position) => (
            <article key={position.clientId} className="panel p-4 sm:p-5">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
                      {position.clientName}
                    </h3>
                    {position.closed.needsAttentionCount > 0 && (
                      <Badge variant="warning">
                        {d.adminBilling.needsAttention}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate text-[11.5px] text-[var(--text-muted)]">
                    {position.email}
                  </p>
                </div>

                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="label-caps">{d.adminBilling.closedBalance}</p>
                    {position.closed.issuedOutstanding > 0 && (
                      <Badge variant="warning">
                        {d.adminBilling.statusOpen}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-[17px] font-semibold text-[var(--text-primary)] tabular-nums">
                    {money(
                      position.closed.supportedNotReceived,
                      intl,
                      position.currency,
                    )}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    {fmt(d.adminBilling.unissuedAndOpen, {
                      unissued: money(
                        position.closed.supportedUnissued,
                        intl,
                        position.currency,
                      ),
                      open: money(
                        position.closed.issuedOutstanding,
                        intl,
                        position.currency,
                      ),
                    })}
                    {position.closed.failedNotReceived > 0
                      ? ` · ${fmt(d.adminBilling.failedBalancePart, {
                          failed: money(
                            position.closed.failedNotReceived,
                            intl,
                            position.currency,
                          ),
                        })}`
                      : ""}
                  </p>
                </div>

                <div className="rounded-xl border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/5 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="label-caps">{d.adminBilling.currentCycle}</p>
                    <Clock3
                      className="size-4 shrink-0 text-[var(--warning-orange)]"
                      aria-hidden
                    />
                  </div>
                  <p className="mt-1 text-[17px] font-semibold text-[var(--warning-orange)] tabular-nums">
                    {money(
                      position.current.accruedFee,
                      intl,
                      position.currency,
                    )}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    {position.current.through
                      ? fmt(d.adminBilling.buildingThrough, {
                          date: shortDate(position.current.through, intl),
                          spend: money(
                            position.current.grossSpend,
                            intl,
                            position.currency,
                          ),
                        })
                      : d.adminBilling.noCurrentData}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-4 border-t border-[var(--border-subtle)] pt-8">
        <div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
            {d.adminBilling.historyTitle}
          </h2>
          <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
            {d.adminBilling.historySubtitle}
          </p>
        </div>

        {dashboard.invoices.length === 0 ? (
          <div className="panel px-5 py-12 text-center text-[13px] text-[var(--text-secondary)]">
            {d.adminBilling.noInvoices}
          </div>
        ) : (
          <>
            <ul className="space-y-3 md:hidden">
              {dashboard.invoices.map((invoice) => (
                <li key={invoice.id} className="panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
                        {invoice.clientName}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                        {formatPeriod(
                          invoice.period_start,
                          invoice.period_end,
                          intl,
                        )}
                      </p>
                    </div>
                    <Badge variant={STATUS_VARIANT[invoice.status]}>
                      {statusLabel(invoice.status, d)}
                    </Badge>
                  </div>
                  <div className="mt-4 flex items-end justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
                    <div>
                      <p className="label-caps">{d.adminBilling.amount}</p>
                      <p className="mt-1 text-[17px] font-semibold text-[var(--text-primary)] tabular-nums">
                        {money(invoice.amount, intl, invoice.currency)}
                      </p>
                      {invoice.status === "open" &&
                        invoice.outstandingAmount !== invoice.amount && (
                          <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                            {fmt(d.adminBilling.remaining, {
                              amount: money(
                                invoice.outstandingAmount,
                                intl,
                                invoice.currency,
                              ),
                            })}
                          </p>
                        )}
                    </div>
                    <PaymentState invoice={invoice} d={d} />
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {invoice.issued_at
                        ? formatTimestamp(invoice.issued_at, intl, "—")
                        : d.adminBilling.notIssued}
                    </span>
                    <InvoiceLinks invoice={invoice} d={d} />
                  </div>
                  {(invoice.stripe_delivery_assumed_at ||
                    deliveryNeedsReconciliation(invoice)) && (
                    <p className="mt-3 text-[11px] leading-relaxed text-[var(--warning-orange)]">
                      {invoice.stripe_delivery_assumed_at
                        ? d.adminBilling.deliveryAssumedWarning
                        : d.adminBilling.deliveryReconciliationPending}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            <div className="panel hidden overflow-x-auto md:block">
              <table className="w-full min-w-[920px] text-left text-[12px]">
                <thead className="bg-[var(--bg-base)] text-[var(--text-muted)]">
                  <tr>
                    <th className="px-5 py-3 font-medium">
                      {d.adminBilling.client}
                    </th>
                    <th className="px-4 py-3 font-medium">
                      {d.adminBilling.period}
                    </th>
                    <th className="px-4 py-3 font-medium">
                      {d.adminBilling.issued}
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      {d.adminBilling.amount}
                    </th>
                    <th className="px-4 py-3 font-medium">
                      {d.adminBilling.status}
                    </th>
                    <th className="px-4 py-3 font-medium">
                      {d.adminBilling.payment}
                    </th>
                    <th className="px-5 py-3 font-medium">
                      {d.adminBilling.documents}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.invoices.map((invoice) => (
                    <tr
                      key={invoice.id}
                      className="border-t border-[var(--border-subtle)]"
                    >
                      <td className="px-5 py-3.5">
                        <p className="font-medium text-[var(--text-primary)]">
                          {invoice.clientName}
                        </p>
                        <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                          {invoice.stripe_invoice_number ?? invoice.clientEmail}
                        </p>
                      </td>
                      <td className="px-4 py-3.5 text-[var(--text-secondary)]">
                        {formatPeriod(
                          invoice.period_start,
                          invoice.period_end,
                          intl,
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-[var(--text-secondary)]">
                        {invoice.issued_at
                          ? formatTimestamp(invoice.issued_at, intl, "—")
                          : d.adminBilling.notIssued}
                      </td>
                      <td className="px-4 py-3.5 text-right font-medium text-[var(--text-primary)] tabular-nums">
                        {money(invoice.amount, intl, invoice.currency)}
                        {invoice.status === "open" &&
                          invoice.outstandingAmount !== invoice.amount && (
                            <p className="mt-0.5 text-[10.5px] font-normal text-[var(--text-muted)]">
                              {fmt(d.adminBilling.remaining, {
                                amount: money(
                                  invoice.outstandingAmount,
                                  intl,
                                  invoice.currency,
                                ),
                              })}
                            </p>
                          )}
                      </td>
                      <td className="px-4 py-3.5">
                        <Badge variant={STATUS_VARIANT[invoice.status]}>
                          {statusLabel(invoice.status, d)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3.5">
                        <PaymentState invoice={invoice} d={d} />
                      </td>
                      <td className="px-5 py-3.5">
                        <InvoiceLinks invoice={invoice} d={d} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
