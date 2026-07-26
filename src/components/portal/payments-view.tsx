"use client";

import * as React from "react";
import { CheckCircle2, CreditCard, ExternalLink, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormAlert } from "@/components/auth/auth-card";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Invoice, InvoiceStatus } from "@/lib/supabase/types";

/**
 * The client's Payments tab: one invoice per week, what it's made of, and a
 * link to pay it.
 *
 * Read-only by design — every figure comes from the ledger the dashboard
 * already shows, and the only action is paying. Nothing here can change what
 * is owed.
 */

const STATUS: Record<InvoiceStatus, { label: string; variant: "success" | "warning" | "neutral" | "danger" }> = {
  paid: { label: "Paid", variant: "success" },
  open: { label: "Awaiting payment", variant: "warning" },
  draft: { label: "Preparing", variant: "neutral" },
  void: { label: "Cancelled", variant: "neutral" },
  uncollectible: { label: "Written off", variant: "danger" },
};

function isLate(invoice: Invoice, today: string) {
  return invoice.status === "open" && Boolean(invoice.due_date) && invoice.due_date! < today;
}

function period(invoice: Invoice) {
  const format = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  };
  return `${format(invoice.period_start)} – ${format(invoice.period_end)}`;
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

  async function setUpCard() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/billing/setup", { method: "POST" });
    const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
    setBusy(false);
    if (!res.ok || !body?.url) {
      setError(body?.error ?? "Couldn't open the payment setup.");
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
              {late.length} {late.length === 1 ? "invoice is" : "invoices are"} past due
            </p>
            <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              Settle them to keep your campaigns running without interruption.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="panel p-4">
          <p className="label-caps">Outstanding</p>
          <p className="metric-value mt-1 !text-[24px]">{money(owed, currency)}</p>
          <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
            {outstanding.length} {outstanding.length === 1 ? "invoice" : "invoices"}
          </p>
        </div>
        <div className="panel p-4">
          <p className="label-caps">Paid to date</p>
          <p className="metric-value mt-1 !text-[24px]">{money(paidTotal, currency)}</p>
        </div>
        <div className="panel flex flex-col justify-between gap-3 p-4">
          <div>
            <p className="label-caps">Payment method</p>
            <p className="mt-1 flex items-center gap-1.5 text-[13px] text-[var(--text-primary)]">
              {hasCardOnFile ? (
                <>
                  <CheckCircle2 className="size-3.5 text-[var(--success-green)]" />
                  Card on file — invoices settle automatically
                </>
              ) : (
                "No card saved"
              )}
            </p>
          </div>
          {stripeReady && (
            <Button variant="secondary" size="sm" loading={busy} onClick={setUpCard}>
              <CreditCard />
              {hasCardOnFile ? "Change card" : "Save a card"}
            </Button>
          )}
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Invoices</h2>

        {invoices.length === 0 ? (
          <div className="panel px-6 py-12 text-center text-[13px] text-[var(--text-secondary)]">
            No invoices yet. We bill every Monday for the week that just closed.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {invoices.map((invoice) => {
              const status = STATUS[invoice.status];
              const overdue = isLate(invoice, today);

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
                        Week of {period(invoice)}
                      </p>
                      <p className="text-[11.5px] text-[var(--text-muted)]">
                        {invoice.due_date && invoice.status === "open"
                          ? `Due ${invoice.due_date}`
                          : invoice.paid_at
                            ? `Paid ${new Date(invoice.paid_at).toLocaleDateString()}`
                            : "Not issued yet"}
                      </p>
                    </div>

                    <Badge variant={overdue ? "danger" : status.variant}>
                      {overdue ? "Past due" : status.label}
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
                        Pay now
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>

                  {invoice.line_items.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-[var(--border-subtle)] pt-3">
                      {invoice.line_items.map((line, index) => (
                        <li
                          key={`${invoice.id}-${index}`}
                          className="flex items-center justify-between gap-3 text-[12px]"
                        >
                          <span className="min-w-0 truncate text-[var(--text-secondary)]">
                            {line.label}
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
