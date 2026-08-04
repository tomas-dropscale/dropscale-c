"use client";

import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { BillingInvoiceHistoryRow } from "@/lib/billing/invoices";
import { money } from "@/lib/format-intl";
import { fmt, type Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { safeStripeUrl } from "@/lib/stripe/urls";
import type { InvoiceStatus } from "@/lib/supabase/types";

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
  const range = new Intl.DateTimeFormat(intl, {
    day: "2-digit",
    month: "short",
  });
  return `${range.format(new Date(`${start}T00:00:00`))} – ${range.format(
    new Date(`${end}T00:00:00`),
  )}`;
}

function formatDay(value: string | null, intl: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(intl, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

export function InvoiceRecordView({
  invoices,
}: {
  invoices: BillingInvoiceHistoryRow[];
}) {
  const { d, locale } = useI18n();
  const intl = locale;

  if (invoices.length === 0) {
    return (
      <p className="text-[12.5px] text-[var(--text-muted)]">
        {d.adminBilling.noInvoices}
      </p>
    );
  }

  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left text-[12.5px]">
        <thead>
          <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)]">
            <th className="px-4 py-3 font-medium">{d.adminBilling.client}</th>
            <th className="px-4 py-3 font-medium">{d.adminBilling.period}</th>
            <th className="px-4 py-3 font-medium">{d.adminBilling.status}</th>
            <th className="px-4 py-3 text-right font-medium">
              {d.adminBilling.amount}
            </th>
            <th className="px-4 py-3 font-medium">{d.adminBilling.issued}</th>
            <th className="px-4 py-3 font-medium" aria-label="Links" />
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => {
            const hostedUrl = safeStripeUrl(invoice.stripe_hosted_url);
            return (
              <tr
                key={invoice.id}
                className="border-b border-[var(--border-subtle)] last:border-b-0"
              >
                <td className="max-w-[14rem] truncate px-4 py-3 text-[var(--text-primary)]">
                  {invoice.clientName}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[var(--text-secondary)]">
                  {formatPeriod(invoice.period_start, invoice.period_end, intl)}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={STATUS_VARIANT[invoice.status]}>
                    {statusLabel(invoice.status, d)}
                  </Badge>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-[var(--text-primary)] tabular-nums">
                  {money(invoice.amount, intl, invoice.currency)}
                  {invoice.status === "open" &&
                    invoice.outstandingAmount !== Number(invoice.amount) && (
                      <span className="block text-[10.5px] font-normal text-[var(--text-muted)]">
                        {fmt(d.adminBilling.remaining, {
                          amount: money(
                            invoice.outstandingAmount,
                            intl,
                            invoice.currency,
                          ),
                        })}
                      </span>
                    )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[var(--text-secondary)]">
                  {invoice.issued_at
                    ? formatDay(invoice.issued_at, intl)
                    : d.adminBilling.notIssued}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  {hostedUrl ? (
                    <a
                      href={hostedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="transition-smooth inline-flex min-h-8 items-center gap-1.5 text-[12px] font-medium text-[var(--accent-gold-strong)] hover:text-[var(--text-primary)]"
                    >
                      <ExternalLink className="size-3.5" aria-hidden />
                      {d.adminBilling.openStripe}
                    </a>
                  ) : (
                    <span className="text-[var(--text-muted)]">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
