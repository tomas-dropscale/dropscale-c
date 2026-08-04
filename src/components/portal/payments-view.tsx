"use client";

import { ExternalLink, Info, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { longDate, money, shortDate } from "@/lib/format-intl";
import { useI18n } from "@/lib/i18n/provider";
import { fmt, type Dictionary } from "@/lib/i18n";
import {
  isoDay,
  isManualAgencyCalculationVersion,
} from "@/lib/billing/weekly";
import { cn } from "@/lib/utils";
import { safeStripeUrl } from "@/lib/stripe/urls";
import type { Invoice, InvoiceLine, InvoiceStatus } from "@/lib/supabase/types";

/**
 * The client's Payments tab: one automatically issued agency-fee invoice per
 * closed week, what it is made of, and a Stripe-hosted link to pay it.
 *
 * Read-only by design — every figure comes from the ledger the dashboard
 * already shows, and the only action is paying. Nothing here can change what
 * is owed.
 *
 * Google charges the client directly. Dropscale invoices only the 10% agency
 * fee; lines are rendered from their parts (kind/store/rate) rather than the
 * stored English label so they can be translated.
 */

function isLate(invoice: Invoice, today: string) {
  return invoice.status === "open" && Boolean(invoice.due_date) && invoice.due_date! < today;
}

function statusLabel(status: InvoiceStatus, d: Dictionary): string {
  switch (status) {
    case "paid":
      return d.payments.statusPaid;
    case "open":
      return d.payments.statusOpen;
    case "draft":
      return d.payments.statusDraft;
    case "waived":
      return d.payments.statusWaived;
    case "void":
      return d.payments.statusVoid;
    case "uncollectible":
      return d.payments.statusUncollectible;
  }
}

function lineTimestamp(value: string, intl: string) {
  return new Date(value).toLocaleString(intl, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rate(value: number, intl: string) {
  return new Intl.NumberFormat(intl, { maximumFractionDigits: 2 }).format(value);
}

const STATUS_VARIANT: Record<InvoiceStatus, "success" | "warning" | "neutral" | "danger"> = {
  paid: "success",
  open: "warning",
  draft: "neutral",
  waived: "neutral",
  void: "neutral",
  uncollectible: "danger",
};

/** The stored label is the fallback: old rows carry nothing else. */
function lineLabel(line: InvoiceLine, d: Dictionary): string {
  if (!line.kind || !line.store) return line.label;
  const values = { store: line.store, rate: String(line.rate ?? "") };

  switch (line.kind) {
    case "spend":
      return fmt(d.payments.lineSpend, values);
    case "fee":
      return fmt(line.rate != null ? d.payments.lineFeeRated : d.payments.lineFee, values);
    case "rev_share":
      return fmt(
        line.rate != null ? d.payments.lineRevShareRated : d.payments.lineRevShare,
        values,
      );
  }
}

type CurrencyTotal = {
  currency: string;
  amount: number;
};

/** Never add unlike currencies. EUR is first because all new billing is EUR. */
function totalsByCurrency(
  invoices: Invoice[],
  value: (invoice: Invoice) => number,
): CurrencyTotal[] {
  const totals = new Map<string, number>();

  for (const invoice of invoices) {
    const currency = invoice.currency.toUpperCase();
    totals.set(currency, (totals.get(currency) ?? 0) + value(invoice));
  }

  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => {
      if (a.currency === "EUR") return -1;
      if (b.currency === "EUR") return 1;
      return a.currency.localeCompare(b.currency);
    });
}

function CurrencyTotals({ totals, intl }: { totals: CurrencyTotal[]; intl: string }) {
  const rows = totals.length > 0 ? totals : [{ currency: "EUR", amount: 0 }];

  return (
    <div className="mt-1 space-y-0.5">
      {rows.map((total) => (
        <p key={total.currency} className="metric-value !text-[24px] tabular-nums">
          {money(total.amount, intl, total.currency)}
        </p>
      ))}
    </div>
  );
}

export function PaymentsView({ invoices }: { invoices: Invoice[] }) {
  const { d, intl } = useI18n();

  const today = isoDay(new Date());
  const hasLegacyInvoices = invoices.some(
    (invoice) => !isManualAgencyCalculationVersion(invoice.calculation_version),
  );
  const outstanding = invoices.filter((invoice) => invoice.status === "open");
  const late = outstanding.filter((invoice) => isLate(invoice, today));
  const failed = outstanding.filter((invoice) => invoice.payment_failed_at);
  const owedByCurrency = totalsByCurrency(
    outstanding,
    (invoice) => Number(invoice.amount_remaining ?? invoice.amount),
  );
  const amountReceived = (invoice: Invoice) => {
    const total = Number(invoice.amount);
    if (invoice.status === "paid") return total;
    const remaining = Number(invoice.amount_remaining ?? total);
    return Math.max(0, Math.min(total, total - remaining));
  };
  const paidByCurrency = totalsByCurrency(
    invoices.filter((invoice) => amountReceived(invoice) > 0),
    amountReceived,
  );

  function period(invoice: Invoice) {
    return `${shortDate(invoice.period_start, intl)} – ${shortDate(
      invoice.period_end,
      intl,
    )}`;
  }

  const invoiceCount = (count: number) =>
    fmt(count === 1 ? d.payments.invoiceCountOne : d.payments.invoiceCountMany, { count });

  return (
    <div className="space-y-4">
      {/* A refused charge is not the same as an unpaid invoice, and only the
          client can clear it. Shown above everything, because if this is
          happening nothing else on the page matters. */}
      {failed.length > 0 && (
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/10 px-4 py-3.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning-orange)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-[var(--text-primary)]">
              {d.payments.chargeFailed}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              {d.payments.chargeFailedHelp}
            </p>
          </div>
        </div>
      )}

      {late.length > 0 && (
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 px-4 py-3.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--danger-red)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-[var(--text-primary)]">
              {late.length === 1
                ? d.payments.pastDueOne
                : fmt(d.payments.pastDueMany, { count: late.length })}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              {d.payments.pastDueHelp}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="panel p-4">
          <p className="label-caps">{d.payments.outstanding}</p>
          <CurrencyTotals totals={owedByCurrency} intl={intl} />
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            {invoiceCount(outstanding.length)}
          </p>
        </div>
        <div className="panel p-4">
          <p className="label-caps">{d.payments.paidToDate}</p>
          <CurrencyTotals totals={paidByCurrency} intl={intl} />
        </div>
      </div>

      {/* Google is paid separately; this removes any ambiguity about whether
          the number below includes ad spend. */}
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-4 py-3">
        <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
        <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          {d.payments.howItWorks}
        </p>
      </div>

      {hasLegacyInvoices && (
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/10 px-4 py-3">
          <TriangleAlert
            className="mt-0.5 size-3.5 shrink-0 text-[var(--warning-orange)]"
            aria-hidden
          />
          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {d.payments.legacyHistoryNote}
          </p>
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          {d.payments.invoices}
        </h2>

        {invoices.length === 0 ? (
          <div className="panel px-6 py-12 text-center text-[13px] text-[var(--text-secondary)]">
            {d.payments.empty}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {invoices.map((invoice) => {
              const overdue = isLate(invoice, today);
              const paymentFailed = invoice.status === "open" && Boolean(invoice.payment_failed_at);
              const stripeHostedUrl = safeStripeUrl(invoice.stripe_hosted_url);
              const stripeInvoicePdf = safeStripeUrl(invoice.stripe_invoice_pdf);
              const invoiceTotal = Number(invoice.amount);
              const amountRemaining =
                invoice.status === "open"
                  ? Number(invoice.amount_remaining ?? invoice.amount)
                  : 0;
              const amountPaid = Math.max(0, invoiceTotal - amountRemaining);
              const partiallyPaid =
                invoice.status === "open" && amountPaid > 0 && amountRemaining < invoiceTotal;

              return (
                <li
                  key={invoice.id}
                  className={cn(
                    "panel p-4",
                    overdue && "border-[var(--danger-red)]/30 bg-[var(--danger-red)]/5",
                    paymentFailed &&
                      !overdue &&
                      "border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/5",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-medium text-[var(--text-primary)]">
                        {fmt(d.payments.weekOf, { period: period(invoice) })}
                      </p>
                      <p className="text-[11.5px] text-[var(--text-muted)]">
                        {invoice.due_date && invoice.status === "open"
                          ? fmt(d.payments.due, {
                              date: longDate(invoice.due_date, intl),
                            })
                          : invoice.status === "waived" && invoice.issued_at
                            ? fmt(d.payments.waivedOn, {
                                date: new Date(invoice.issued_at).toLocaleDateString(intl),
                              })
                          : invoice.paid_at
                            ? fmt(d.payments.paidOn, {
                                date: new Date(invoice.paid_at).toLocaleDateString(intl),
                              })
                            : invoice.issued_at
                              ? `${d.adminBilling.issued}: ${new Date(
                                  invoice.issued_at,
                                ).toLocaleDateString(intl)}`
                              : d.payments.notIssued}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {!isManualAgencyCalculationVersion(invoice.calculation_version) && (
                        <Badge variant="neutral">{d.payments.legacyLabel}</Badge>
                      )}
                      <Badge variant={overdue ? "danger" : STATUS_VARIANT[invoice.status]}>
                        {overdue ? d.payments.statusOverdue : statusLabel(invoice.status, d)}
                      </Badge>
                      {paymentFailed && (
                        <Badge variant="danger">{d.payments.statusPaymentFailed}</Badge>
                      )}
                    </div>

                    <div className="text-right">
                      <p className="text-[15px] font-semibold text-[var(--text-primary)] tabular-nums">
                        {money(
                          partiallyPaid ? amountRemaining : invoice.amount,
                          intl,
                          invoice.currency,
                        )}
                      </p>
                      {partiallyPaid && (
                        <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                          {d.payments.amountRemaining}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {invoice.status === "open" && stripeHostedUrl && (
                        <a
                          href={stripeHostedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="transition-smooth inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full bg-[var(--accent-gold)] px-3.5 py-1.5 text-[12px] font-semibold text-[#1a1409] hover:opacity-90"
                        >
                          {d.payments.payNow}
                          <ExternalLink className="size-3.5" />
                        </a>
                      )}
                      {stripeInvoicePdf && (
                        <a
                          href={stripeInvoicePdf}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="transition-smooth inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                        >
                          {d.payments.invoicePdf}
                          <ExternalLink className="size-3.5" />
                        </a>
                      )}
                    </div>
                  </div>

                  {partiallyPaid && (
                    <dl className="mt-3 grid grid-cols-1 gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 sm:grid-cols-3">
                      <div>
                        <dt className="label-caps">{d.payments.invoiceTotal}</dt>
                        <dd className="mt-1 text-[13px] font-medium text-[var(--text-primary)] tabular-nums">
                          {money(invoiceTotal, intl, invoice.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="label-caps">{d.payments.amountPaid}</dt>
                        <dd className="mt-1 text-[13px] font-medium text-[var(--success-green)] tabular-nums">
                          {money(amountPaid, intl, invoice.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="label-caps">{d.payments.amountRemaining}</dt>
                        <dd className="mt-1 text-[13px] font-semibold text-[var(--warning-orange)] tabular-nums">
                          {money(amountRemaining, intl, invoice.currency)}
                        </dd>
                      </div>
                    </dl>
                  )}

                  {invoice.line_items.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-[var(--border-subtle)] pt-3">
                      {invoice.line_items.map((line, index) => (
                        <li
                          key={`${invoice.id}-${index}`}
                          className="flex items-center justify-between gap-3 text-[12px]"
                        >
                          <div className="min-w-0 text-[var(--text-secondary)]">
                            <span className="block truncate">{lineLabel(line, d)}</span>
                            {line.kind === "fee" && line.baseAmount != null && (
                              line.sourceGrossAmount != null ? (
                                <span className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[10.5px] text-[var(--text-muted)]">
                                  <span>{d.payments.lineReportedSpend}</span>
                                  <span className="text-right tabular-nums">
                                    {money(
                                      line.sourceGrossAmount,
                                      intl,
                                      invoice.currency,
                                    )}
                                  </span>
                                  {line.baselineDeductionAmount != null && (
                                    <>
                                      <span>{d.payments.lineOpeningBaseline}</span>
                                      <span className="text-right tabular-nums">
                                        −{money(
                                          line.baselineDeductionAmount,
                                          intl,
                                          invoice.currency,
                                        )}
                                      </span>
                                    </>
                                  )}
                                  {line.endDeductionAmount != null && (
                                    <>
                                      <span>{d.payments.lineClosingDeduction}</span>
                                      <span className="text-right tabular-nums">
                                        −{money(
                                          line.endDeductionAmount,
                                          intl,
                                          invoice.currency,
                                        )}
                                      </span>
                                    </>
                                  )}
                                  <span className="font-medium text-[var(--text-secondary)]">
                                    {d.payments.lineBillableSpend}
                                  </span>
                                  <span className="text-right font-medium text-[var(--text-secondary)] tabular-nums">
                                    {money(line.baseAmount, intl, invoice.currency)}
                                  </span>
                                </span>
                              ) : (
                                <span className="mt-0.5 block text-[10.5px] text-[var(--text-muted)]">
                                  {fmt(d.payments.lineBaseAmount, {
                                    amount: money(
                                      line.baseAmount,
                                      intl,
                                      invoice.currency,
                                    ),
                                  })}
                                </span>
                              )
                            )}
                            {line.kind === "fee" &&
                              line.referralCount != null &&
                              line.listRate != null &&
                              line.referralDiscountRate != null &&
                              line.rate != null && (
                                <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-muted)]">
                                  {fmt(d.payments.lineReferralTerm, {
                                    count: line.referralCount,
                                    list: rate(line.listRate, intl),
                                    discount: rate(line.referralDiscountRate, intl),
                                    rate: rate(line.rate, intl),
                                  })}
                                </span>
                              )}
                            {line.billingStartedAt &&
                              line.billingTimeZone &&
                              line.billingStartBaselineAmount != null && (
                                <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-muted)]">
                                  {fmt(d.payments.lineTrackingStarted, {
                                    date: lineTimestamp(line.billingStartedAt, intl),
                                    timeZone: line.billingTimeZone,
                                    amount: money(
                                      line.billingStartBaselineAmount,
                                      intl,
                                      invoice.currency,
                                    ),
                                  })}
                                </span>
                              )}
                            {line.billingEndedAt &&
                              line.billingEndTimeZone &&
                              line.billingEndCounterAmount != null && (
                                <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-muted)]">
                                  {fmt(d.payments.lineTrackingEnded, {
                                    date: lineTimestamp(line.billingEndedAt, intl),
                                    timeZone: line.billingEndTimeZone,
                                    amount: money(
                                      line.billingEndCounterAmount,
                                      intl,
                                      invoice.currency,
                                    ),
                                    deduction: money(
                                      line.endDeductionAmount ?? 0,
                                      intl,
                                      invoice.currency,
                                    ),
                                  })}
                                </span>
                              )}
                          </div>
                          <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                            {money(line.amount, intl, invoice.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
