"use client";

import * as React from "react";
import { CheckCircle2, CreditCard, ExternalLink, Info, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormAlert } from "@/components/auth/auth-card";
import { money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/provider";
import { fmt, type Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Invoice, InvoiceLine, InvoiceStatus } from "@/lib/supabase/types";

/**
 * The client's Payments tab: one invoice per week, what it's made of, and a
 * link to pay it.
 *
 * Read-only by design — every figure comes from the ledger the dashboard
 * already shows, and the only action is paying. Nothing here can change what
 * is owed.
 *
 * A week's invoice is the ad spend we fronted PLUS our fee on it, so the
 * breakdown is doing real work: it is the difference between "you owe €5,610"
 * and "€5,000 of that went to Google". Lines are rendered from their parts
 * (kind/store/rate) rather than the stored English label, which is what lets
 * them translate; rows written before those parts existed fall back to it.
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
    case "void":
      return d.payments.statusVoid;
    case "uncollectible":
      return d.payments.statusUncollectible;
  }
}

const STATUS_VARIANT: Record<InvoiceStatus, "success" | "warning" | "neutral" | "danger"> = {
  paid: "success",
  open: "warning",
  draft: "neutral",
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

export function PaymentsView({
  invoices,
  hasCardOnFile,
  stripeReady,
}: {
  invoices: Invoice[];
  hasCardOnFile: boolean;
  stripeReady: boolean;
}) {
  const { d, intl } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const outstanding = invoices.filter((invoice) => invoice.status === "open");
  const late = outstanding.filter((invoice) => isLate(invoice, today));
  const owed = outstanding.reduce((sum, invoice) => sum + Number(invoice.amount), 0);
  const paidTotal = invoices
    .filter((invoice) => invoice.status === "paid")
    .reduce((sum, invoice) => sum + Number(invoice.amount), 0);
  const currency = invoices[0]?.currency ?? "EUR";

  function period(invoice: Invoice) {
    const format = (iso: string) => {
      const [y, m, day] = iso.split("-").map(Number);
      return new Date(y, m - 1, day).toLocaleDateString(intl, {
        day: "2-digit",
        month: "short",
      });
    };
    return `${format(invoice.period_start)} – ${format(invoice.period_end)}`;
  }

  const invoiceCount = (count: number) =>
    fmt(count === 1 ? d.payments.invoiceCountOne : d.payments.invoiceCountMany, { count });

  async function setUpCard() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/billing/setup", { method: "POST" });
    const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
    setBusy(false);
    if (!res.ok || !body?.url) {
      setError(body?.error ?? d.payments.setupFailed);
      return;
    }
    window.location.href = body.url;
  }

  return (
    <div className="space-y-4">
      {error && <FormAlert>{error}</FormAlert>}

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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="panel p-4">
          <p className="label-caps">{d.payments.outstanding}</p>
          <p className="metric-value mt-1 !text-[24px]">{money(owed, currency)}</p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            {invoiceCount(outstanding.length)}
          </p>
        </div>
        <div className="panel p-4">
          <p className="label-caps">{d.payments.paidToDate}</p>
          <p className="metric-value mt-1 !text-[24px]">{money(paidTotal, currency)}</p>
        </div>
        <div className="panel flex flex-col justify-between gap-3 p-4">
          <div>
            <p className="label-caps">{d.payments.paymentMethod}</p>
            <p className="mt-1 flex items-center gap-1.5 text-[13px] text-[var(--text-primary)]">
              {hasCardOnFile ? (
                <>
                  <CheckCircle2 className="size-3.5 text-[var(--success-green)]" />
                  {d.payments.cardOnFile}
                </>
              ) : (
                d.payments.noCard
              )}
            </p>
          </div>
          {stripeReady && (
            <Button variant="secondary" size="sm" loading={busy} onClick={setUpCard}>
              <CreditCard />
              {hasCardOnFile ? d.payments.changeCard : d.payments.saveCard}
            </Button>
          )}
        </div>
      </div>

      {/* What a weekly invoice is made of. Worth saying once, up front: the
          total is mostly money that went straight to Google. */}
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-4 py-3">
        <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
        <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          {d.payments.howItWorks}
        </p>
      </div>

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

              // Spend passed through at cost vs. what the agency earns — the
              // two numbers a client actually wants separated.
              const spend = invoice.line_items
                .filter((line) => line.kind === "spend")
                .reduce((sum, line) => sum + Number(line.amount), 0);
              const fees = invoice.line_items
                .filter((line) => line.kind === "fee" || line.kind === "rev_share")
                .reduce((sum, line) => sum + Number(line.amount), 0);

              return (
                <li
                  key={invoice.id}
                  className={cn(
                    "panel p-4",
                    overdue && "border-[var(--danger-red)]/30 bg-[var(--danger-red)]/5",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-medium text-[var(--text-primary)]">
                        {fmt(d.payments.weekOf, { period: period(invoice) })}
                      </p>
                      <p className="text-[11.5px] text-[var(--text-muted)]">
                        {invoice.due_date && invoice.status === "open"
                          ? fmt(d.payments.due, { date: invoice.due_date })
                          : invoice.paid_at
                            ? fmt(d.payments.paidOn, {
                                date: new Date(invoice.paid_at).toLocaleDateString(intl),
                              })
                            : d.payments.notIssued}
                      </p>
                    </div>

                    <Badge variant={overdue ? "danger" : STATUS_VARIANT[invoice.status]}>
                      {overdue ? d.payments.statusOverdue : statusLabel(invoice.status, d)}
                    </Badge>

                    <p className="text-[15px] font-semibold text-[var(--text-primary)] tabular-nums">
                      {money(invoice.amount, invoice.currency)}
                    </p>

                    {invoice.status === "open" && invoice.stripe_hosted_url && (
                      <a
                        href={invoice.stripe_hosted_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-smooth inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--accent-gold)] px-3.5 py-1.5 text-[12px] font-semibold text-[#1a1409] hover:opacity-90"
                      >
                        {d.payments.payNow}
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>

                  {/* Spend vs. fee at a glance, above the per-store detail.
                      Only for invoices that carry the newer line parts. */}
                  {spend > 0 && (
                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-[var(--border-subtle)] pt-3 text-[12px]">
                      <span className="text-[var(--text-secondary)]">
                        {d.payments.adSpendTotal}{" "}
                        <span className="font-medium text-[var(--text-primary)] tabular-nums">
                          {money(spend, invoice.currency)}
                        </span>
                      </span>
                      <span className="text-[var(--text-secondary)]">
                        {d.payments.feeTotal}{" "}
                        <span className="font-medium text-[var(--text-primary)] tabular-nums">
                          {money(fees, invoice.currency)}
                        </span>
                      </span>
                    </div>
                  )}

                  {invoice.line_items.length > 0 && (
                    <ul
                      className={cn(
                        "mt-3 space-y-1 pt-3",
                        spend > 0 ? "" : "border-t border-[var(--border-subtle)]",
                      )}
                    >
                      {invoice.line_items.map((line, index) => (
                        <li
                          key={`${invoice.id}-${index}`}
                          className="flex items-center justify-between gap-3 text-[12px]"
                        >
                          <span className="min-w-0 truncate text-[var(--text-secondary)]">
                            {lineLabel(line, d)}
                          </span>
                          <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                            {money(line.amount, invoice.currency)}
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
