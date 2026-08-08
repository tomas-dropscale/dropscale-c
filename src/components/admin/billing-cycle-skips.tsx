"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarX2, X } from "lucide-react";

import { FormAlert } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import type { BillingAdminDashboard } from "@/lib/billing/invoices";
import { money } from "@/lib/format-intl";
import { useI18n } from "@/lib/i18n/provider";

type Client = { id: string; name: string; email: string; owed: number };

/**
 * "This client owes nothing this cycle."
 *
 * No invoice is created and no Google evidence changes: the engine settles the
 * chosen client's week as no charge, so the Monday run issues nothing for them.
 */
export function BillingCycleSkips({
  dashboard,
  cycleLabel,
}: {
  dashboard: BillingAdminDashboard;
  cycleLabel: string;
}) {
  const router = useRouter();
  const { locale } = useI18n();
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Client | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<
    { tone: "error" | "success"; message: string } | null
  >(null);
  const boxRef = React.useRef<HTMLDivElement>(null);

  const skippedIds = new Set(dashboard.skips.map((skip) => skip.clientId));
  const clients: Client[] = dashboard.positions.clients
    .filter((position) => !skippedIds.has(position.clientId))
    .map((position) => ({
      id: position.clientId,
      name: position.clientName,
      email: position.email,
      owed: position.current.accruedFee,
    }));

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? clients.filter(
        (client) =>
          client.name.toLowerCase().includes(needle) ||
          client.email.toLowerCase().includes(needle),
      )
    : clients;

  React.useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  async function send(clientId: string, remove: boolean) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/billing/skip-cycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId,
          periodStart: dashboard.skipCycle.start,
          remove,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      if (!response.ok) {
        setFeedback({
          tone: "error",
          message:
            typeof body?.error === "string"
              ? body.error
              : "The billing cycle could not be updated.",
        });
        return;
      }
      setSelected(null);
      setQuery("");
      setFeedback({
        tone: "success",
        message: remove
          ? "The cycle is billable again for that client."
          : "That client owes nothing for this cycle.",
      });
      router.refresh();
    } catch {
      setFeedback({
        tone: "error",
        message: "The billing cycle could not be updated.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel p-4 sm:p-5" aria-label="Billing Cycle Options">
      <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
        Billing Cycle Options
      </h2>
      <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
        Optionally allow clients to skip a billing cycle by selecting an
        account. Nothing is invoiced to them for {cycleLabel}; the Google
        evidence for the week is still recorded.
      </p>

      {feedback && (
        <div className="mt-3">
          <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-start">
        <div ref={boxRef} className="relative w-full sm:max-w-sm">
          <input
            type="text"
            value={selected ? selected.name : query}
            onChange={(event) => {
              setSelected(null);
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="Search or select a client"
            aria-label="Client to skip"
            className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-gold)]"
          />
          {open && (
            /* Upward: this control lives at the foot of the page, so a
               downward list would stretch the document and push the whole
               view into extra scroll for a menu. */
            <ul className="absolute bottom-full z-20 mb-1 max-h-64 w-full overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-panel)] py-1 shadow-lg">
              {matches.length === 0 ? (
                <li className="px-3 py-2 text-[12.5px] text-[var(--text-muted)]">
                  No client matches.
                </li>
              ) : (
                matches.map((client) => (
                  <li key={client.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(client);
                        setQuery("");
                        setOpen(false);
                      }}
                      className="transition-smooth flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[var(--bg-panel-hover)]"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] text-[var(--text-primary)]">
                          {client.name}
                        </span>
                        <span className="block truncate text-[11px] text-[var(--text-muted)]">
                          {client.email}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11.5px] text-[var(--accent-gold)] tabular-nums">
                        {money(client.owed, locale, dashboard.currency)}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>

        <Button
          type="button"
          onClick={() => selected && send(selected.id, false)}
          disabled={!selected || busy}
        >
          <CalendarX2 className="size-4" aria-hidden />
          Skip Billing Cycle
        </Button>
      </div>

      {dashboard.skips.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
          {dashboard.skips.map((skip) => (
            <li
              key={skip.clientId}
              className="flex items-center justify-between gap-3 text-[12.5px]"
            >
              <span className="min-w-0 truncate text-[var(--text-primary)]">
                {skip.clientName}
                <span className="ml-2 text-[11.5px] text-[var(--text-muted)]">
                  not billed for {cycleLabel}
                </span>
              </span>
              <button
                type="button"
                onClick={() => send(skip.clientId, true)}
                disabled={busy}
                className="transition-smooth inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                <X className="size-3" aria-hidden />
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
