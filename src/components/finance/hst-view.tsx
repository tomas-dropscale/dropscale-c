"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Check, RefreshCw, Trash2, Truck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
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
import { sourceTint } from "@/lib/finance/config";
import { useI18n } from "@/lib/i18n/provider";
import { money, percent, shortDate } from "@/lib/format-intl";
import type { HstOverview } from "@/lib/admin/hst";

/**
 * The HST tab: everything the supplier reports, plus what they've actually
 * paid us.
 *
 * All-time by design — "how much do they still owe us" only means something
 * over the whole relationship, and the ledger holds exactly what HST currently
 * reports. The commission figures are read-only (a sync republishes them);
 * the only thing entered here is a payment received.
 */
export function HstView({ overview }: { overview: HstOverview }) {
  const { intl } = useI18n();
  const router = useRouter();

  const [payOpen, setPayOpen] = React.useState(false);
  const [allOpen, setAllOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<"sync" | "pay" | string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  /**
   * Shop strings from the last sync in this session.
   *
   * Not persisted: it is a diagnostic for "why is that client missing", and the
   * answer is only meaningful about the run that just happened. Null until a
   * sync has run here, which the dialog says rather than showing an empty list.
   */
  const [shops, setShops] = React.useState<string[] | null>(null);

  const { currency } = overview;

  // The dialog opens on the obvious answer: they're settling what's owed, up
  // to the last day HST has reported.
  const [amount, setAmount] = React.useState("");
  const [coversThrough, setCoversThrough] = React.useState("");
  const [paidOn, setPaidOn] = React.useState("");
  const [paymentNotes, setPaymentNotes] = React.useState("");

  function openPayment() {
    setAmount(overview.outstanding > 0 ? overview.outstanding.toFixed(2) : "");
    setCoversThrough(overview.lastDay ?? "");
    setPaidOn(new Date().toISOString().slice(0, 10));
    setPaymentNotes("");
    setError(null);
    setNotice(null);
    setPayOpen(true);
  }

  async function sync() {
    setBusy("sync");
    setError(null);
    setNotice(null);
    const res = await fetch("/api/hst/sync", { method: "POST" });
    const body = (await res.json().catch(() => null)) as
      | {
          ok?: boolean;
          error?: string;
          booked?: number;
          days?: number;
          clients?: number;
          pages?: number;
          unnamedRows?: number;
          ignoredRows?: number;
          truncated?: boolean;
          rowsRead?: number;
          bookedTotal?: number;
          reportedTotal?: number;
          shops?: string[];
        }
      | null;
    setBusy(null);
    if (!res.ok || !body?.ok) {
      setError(body?.error ?? "Sync failed.");
      return;
    }

    // Report what came back, not just that something did. "Some clients are
    // missing" is impossible to diagnose from a bare success message: the
    // client count, the page count and the rows that were dropped or had no
    // name in the shop string are what say WHERE they went.
    const parts = [`${body.booked} entries across ${body.days} day(s)`];
    if (body.clients !== undefined) parts.push(`${body.clients} clients`);
    if (body.rowsRead !== undefined) parts.push(`${body.rowsRead} rows read`);
    if (body.pages !== undefined) parts.push(`${body.pages} page(s)`);
    if (body.ignoredRows) parts.push(`${body.ignoredRows} row(s) dropped — unreadable date`);
    if (body.unnamedRows) parts.push(`${body.unnamedRows} row(s) with no client name`);
    if (body.truncated) parts.push("⚠ page limit reached — rows are missing");

    // The integrity check that actually works: what we booked against HST's
    // own grand total. Only flagged when they disagree, so a healthy sync stays
    // quiet instead of crying wolf the way the row-count comparison did.
    if (
      body.bookedTotal !== undefined &&
      body.reportedTotal !== undefined &&
      body.reportedTotal > 0 &&
      Math.abs(body.bookedTotal - body.reportedTotal) > 0.01
    ) {
      parts.push(
        `⚠ booked ${money(body.bookedTotal, intl)} but HST reports ${money(body.reportedTotal, intl)}`,
      );
    }

    setShops(body.shops ?? null);
    setNotice(`Synced — ${parts.join(" · ")}.`);
    router.refresh();
  }

  async function recordPayment() {
    setBusy("pay");
    setError(null);
    const res = await fetch("/api/hst/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Number(amount),
        paidOn,
        coversThrough,
        notes: paymentNotes,
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; resyncError?: string | null }
      | null;
    setBusy(null);
    if (!res.ok || !body?.ok) {
      setError(body?.error ?? "Couldn't record the payment.");
      return;
    }
    setPayOpen(false);
    setNotice(
      body.resyncError
        ? `Payment recorded. The ledger couldn't be refreshed: ${body.resyncError}`
        : "Payment recorded — those commission days now count as paid.",
    );
    router.refresh();
  }

  async function removePayment(id: string) {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/hst/payments?id=${id}`, { method: "DELETE" });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    setBusy(null);
    if (!res.ok || !body?.ok) {
      setError(body?.error ?? "Couldn't remove the payment.");
      return;
    }
    setNotice("Payment removed.");
    router.refresh();
  }

  const clientRows: BreakdownRow[] = overview.clients.map((client, index) => ({
    key: client.name,
    label: client.name,
    sublabel: `${client.count} ${client.count === 1 ? "entry" : "entries"}`,
    amount: money(client.amount, intl, currency),
    share: client.share,
    color: sourceTint(index),
  }));

  const settled = overview.total > 0 ? overview.paid / overview.total : 0;

  /**
   * The sync has stopped landing.
   *
   * The hourly cron re-books HST every hour, so anything past a day means it is
   * failing — almost always an ERP session that could not renew itself. A stale
   * timestamp in the subtitle was technically already saying this, and it went
   * unnoticed for weeks, because a commission figure that stopped growing looks
   * exactly like a commission figure that grew by nothing.
   */
  const stale = overview.hoursSinceSync !== null && overview.hoursSinceSync > 26;
  const staleDays = Math.floor((overview.hoursSinceSync ?? 0) / 24);

  return (
    <PageContainer
      title="HST"
      description={
        overview.lastSyncedAt
          ? `Supplier commission, straight from the HST ERP · synced ${new Date(overview.lastSyncedAt).toLocaleString(intl)}`
          : "Supplier commission, straight from the HST ERP · never synced"
      }
      actions={
        <>
          <Button variant="secondary" size="sm" loading={busy === "sync"} onClick={sync}>
            <RefreshCw />
            Sync now
          </Button>
          <Button variant="primary" size="sm" onClick={openPayment}>
            <BadgeCheck />
            HST paid us
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="space-y-4">
        {notice && <FormAlert tone="success">{notice}</FormAlert>}

        {/* The reason, when the database has one (migration 0017). Nothing else
            on this page could tell you a sync had been REFUSED rather than
            simply having nothing to report. */}
        {overview.lastError && (
          <FormAlert>
            The last HST sync failed: {overview.lastError}
            {overview.lastAttemptAt &&
              ` (tried ${new Date(overview.lastAttemptAt).toLocaleString(intl)})`}
          </FormAlert>
        )}

        {/* Stale with no recorded reason — either 0017 isn't applied, or nothing
            is triggering a sync at all. Both need a human, so say so either way. */}
        {stale && !overview.lastError && (
          <FormAlert>
            {staleDays >= 1
              ? `No HST commission has been booked for ${staleDays} day${staleDays === 1 ? "" : "s"} — the ERP session has most likely expired.`
              : "The last HST sync is over a day old — the ERP session has most likely expired."}{" "}
            Hit “Sync now” to see the exact error, and paste a fresh login below if it asks for one.
          </FormAlert>
        )}

        {overview.paymentsUnavailable && (
          <FormAlert>
            The payments table isn’t there yet — run migration 0012 to record what HST pays.
          </FormAlert>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Commission earned"
            value={money(overview.total, intl, currency)}
            hint={
              overview.firstDay && overview.lastDay
                ? `${shortDate(overview.firstDay, intl)} – ${shortDate(overview.lastDay, intl)}`
                : undefined
            }
            glow
          />
          <StatCard
            label="Paid by HST"
            value={money(overview.paid, intl, currency)}
            tone="success"
            hint={`${percent(settled, intl)} of what they owe`}
          />
          <StatCard
            label="Outstanding"
            value={money(overview.outstanding, intl, currency)}
            tone={overview.outstanding > 0 ? "primary" : "success"}
            hint={
              overview.settledThrough
                ? `settled through ${shortDate(overview.settledThrough, intl)}`
                : "nothing settled yet"
            }
          />
          <StatCard label="Clients" value={String(overview.clients.length)} tone="primary" />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Breakdown
            title="Top clients"
            rows={clientRows}
            action={
              clientRows.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setAllOpen(true)}>
                  All clients ({clientRows.length})
                </Button>
              ) : undefined
            }
            empty={
              <p className="text-[13px] text-[var(--text-muted)]">
                Nothing synced from HST yet.
              </p>
            }
          />

          <section className="flex flex-col gap-3">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
              Payments received
            </h2>

            <DataTable
              head={
                <>
                  <Th>Received</Th>
                  <Th>Covers through</Th>
                  <Th>Notes</Th>
                  <Th align="right">Amount</Th>
                  <Th />
                </>
              }
            >
              {overview.payments.length === 0 ? (
                <tr>
                  <Td className="py-8 text-center" align="left">
                    No payment from HST recorded yet.
                  </Td>
                </tr>
              ) : (
                overview.payments.map((payment) => (
                  <Tr key={payment.id}>
                    <Td>{shortDate(payment.paid_on, intl)}</Td>
                    <Td>{shortDate(payment.covers_through, intl)}</Td>
                    <Td className="text-[var(--text-muted)]">{payment.notes ?? "—"}</Td>
                    <Td align="right" className="font-semibold text-[var(--success-green)]">
                      {money(payment.amount, intl, currency)}
                    </Td>
                    <Td align="right">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Remove payment"
                        loading={busy === payment.id}
                        onClick={() => removePayment(payment.id)}
                      >
                        <Trash2 />
                      </Button>
                    </Td>
                  </Tr>
                ))
              )}
            </DataTable>
          </section>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            Commission by day
          </h2>

          <DataTable
            head={
              <>
                <Th>Day</Th>
                <Th>Clients</Th>
                <Th>Status</Th>
                <Th align="right">Commission</Th>
              </>
            }
          >
            {overview.days.length === 0 ? (
              <tr>
                <Td className="py-8 text-center" align="left">
                  Nothing synced from HST yet.
                </Td>
              </tr>
            ) : (
              overview.days.slice(0, 60).map((day) => {
                const paid = overview.settledThrough !== null && day.day <= overview.settledThrough;
                return (
                  <Tr key={day.day}>
                    <Td>{shortDate(day.day, intl)}</Td>
                    <Td>{day.clients}</Td>
                    <Td>
                      <span
                        className={
                          paid
                            ? "inline-flex items-center gap-1 rounded-full border border-[var(--success-green)]/25 bg-[var(--success-green)]/12 px-2 py-0.5 text-[10.5px] leading-none font-medium text-[var(--success-green)]"
                            : "inline-flex items-center rounded-full border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] px-2 py-0.5 text-[10.5px] leading-none font-medium text-[var(--accent-gold-strong)]"
                        }
                      >
                        {paid && <Check className="size-3" aria-hidden />}
                        {paid ? "Paid" : "Awaiting payment"}
                      </span>
                    </Td>
                    <Td align="right" className="font-semibold text-[var(--accent-gold)]">
                      {money(day.amount, intl, currency)}
                    </Td>
                  </Tr>
                );
              })
            )}
          </DataTable>
        </section>
      </div>

      {/* Every client HST reports, not just the leaders. The Breakdown above is
          a shape-of-the-business view; this is the roll call, and it is what
          gets checked when someone asks "where is <client>?". */}
      <Dialog open={allOpen} onOpenChange={setAllOpen}>
        <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-[640px] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>All clients ({overview.clients.length})</DialogTitle>
          </DialogHeader>

          <DataTable
            head={
              <>
                <Th>Client</Th>
                <Th align="right">Entries</Th>
                <Th align="right">Share</Th>
                <Th align="right">Commission</Th>
              </>
            }
          >
            {overview.clients.map((client, index) => (
              <Tr key={client.name}>
                <Td align="left">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: sourceTint(index) }}
                      aria-hidden
                    />
                    <span className="truncate">{client.name}</span>
                  </span>
                </Td>
                <Td align="right" className="text-[var(--text-muted)]">
                  {client.count}
                </Td>
                <Td align="right" className="text-[var(--text-muted)]">
                  {percent(client.share, intl)}
                </Td>
                <Td align="right" className="font-semibold">
                  {money(client.amount, intl, currency)}
                </Td>
              </Tr>
            ))}
          </DataTable>

          {/* The diagnostic. A client absent from the table above but present
              here means we parsed their shop string wrong; absent from BOTH
              means HST never sent them, and no amount of code changes here
              will conjure them up. */}
          <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
              Shops HST returned {shops ? `(${shops.length})` : ""}
            </h3>
            {shops === null ? (
              <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                Press <strong>Sync now</strong> to list the shop strings HST sent — that is
                what says whether a missing client was never sent or was read wrong.
              </p>
            ) : shops.length === 0 ? (
              <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                HST sent no shop names at all.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {shops.map((shop) => (
                  <li
                    key={shop}
                    className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]"
                  >
                    {shop}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              <span className="flex items-center gap-2">
                <Truck className="size-4 text-[var(--accent-gold)]" />
                HST paid us
              </span>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              Record the money that landed. Every commission day up to the date below counts as
              settled, and shows as paid across the finance pages.
            </p>

            {error && <FormAlert>{error}</FormAlert>}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="hst-amount">Amount ({currency})</Label>
                <Input
                  id="hst-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hst-paid-on">Received on</Label>
                <Input
                  id="hst-paid-on"
                  type="date"
                  value={paidOn}
                  onChange={(event) => setPaidOn(event.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="hst-covers">Covers commission through</Label>
                <Input
                  id="hst-covers"
                  type="date"
                  value={coversThrough}
                  onChange={(event) => setCoversThrough(event.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="hst-notes">Notes</Label>
                <Input
                  id="hst-notes"
                  value={paymentNotes}
                  onChange={(event) => setPaymentNotes(event.target.value)}
                  placeholder="Transfer reference, invoice…"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPayOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={busy === "pay"}
                disabled={amount.trim() === "" || coversThrough === ""}
                onClick={recordPayment}
              >
                Record payment
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
