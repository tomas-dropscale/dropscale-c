"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  FileWarning,
  MoreHorizontal,
  RefreshCw,
  Search,
  Store,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { FormAlert } from "@/components/auth/auth-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BillingAdminDashboard } from "@/lib/billing/invoices";
import { money, shortDate } from "@/lib/format-intl";
import { fmt, type Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import {
  presetSelection,
  type RangeSelection,
} from "@/lib/portal/range";
import { safeStripeUrl } from "@/lib/stripe/urls";
import type { InvoiceStatus } from "@/lib/supabase/types";
import { cn } from "@/lib/utils";

type ClientPreview = BillingAdminDashboard["clients"][number];
type InvoiceHistoryItem = BillingAdminDashboard["invoices"][number];

type Feedback = { tone: "error" | "success"; message: string } | null;

type OverviewClient =
  BillingAdminDashboard["positions"]["overview"]["clients"][number];
type ClientBillingState = OverviewClient["status"];

type ClientBillingRow = {
  client: OverviewClient;
  invoices: InvoiceHistoryItem[];
};

type StripeReadiness = {
  ready: boolean;
  keyMode: "live" | "test" | null;
  liveMode: boolean;
  webhookSecretConfigured: boolean;
  serviceRoleConfigured: boolean;
  issuanceEnabled: boolean;
  permissions: {
    customersRead: boolean;
    invoicesRead: boolean;
    invoiceItemsRead: boolean;
  };
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

function rate(value: number, intl: string) {
  return new Intl.NumberFormat(intl, { maximumFractionDigits: 2 }).format(
    value,
  );
}

function storeRateLabel(
  store: ClientPreview["stores"][number],
  d: Dictionary,
  intl: string,
) {
  return store.pricingMode === "referral"
    ? fmt(d.adminBilling.manualReferralRate, {
        count: store.referralCount,
        list: rate(store.listRate, intl),
        discount: rate(store.referralDiscountRate, intl),
        rate: rate(store.feeRate, intl),
      })
    : fmt(d.adminBilling.agencyFeeRate, {
        rate: rate(store.feeRate, intl),
      });
}

function clientRateLabel(client: ClientPreview, d: Dictionary, intl: string) {
  if (!client.mixedRates) {
    const store = client.stores[0];
    return store
      ? storeRateLabel(store, d, intl)
      : fmt(d.adminBilling.agencyFeeRate, {
          rate: rate(client.feeRate, intl),
        });
  }
  return [
    ...new Set(client.stores.map((store) => storeRateLabel(store, d, intl))),
  ].join(" · ");
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

const REPORTING_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function timestampDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = REPORTING_DAY.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function roundedSum(values: number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
}

function selectionForRange(
  range: { start: string; end: string },
  now: Date,
): RangeSelection {
  const presets = [
    "today",
    "yesterday",
    "d3",
    "d7",
    "d14",
    "d30",
    "mtd",
    "ytd",
  ] as const;
  const preset = presets.find((key) => {
    const selection = presetSelection(key, now);
    return selection.from === range.start && selection.to === range.end;
  });
  return preset
    ? presetSelection(preset, now)
    : { key: "custom", from: range.start, to: range.end };
}

function searchable(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
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

function startsInWeek(
  store: ClientPreview["stores"][number],
  week: { start: string; end: string },
) {
  const date = store.billingStart?.date;
  return Boolean(date && date >= week.start && date <= week.end);
}

function endsInWeek(
  store: ClientPreview["stores"][number],
  week: { start: string; end: string },
) {
  const date = store.billingEnd?.date;
  return Boolean(date && date >= week.start && date <= week.end);
}

function requestError(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (typeof record.message === "string") return record.message;
  return fallback;
}

function requestCode(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function recipientAddress(
  recipient: ClientPreview["recipient"],
): string | null {
  const locality = [recipient.addressPostalCode, recipient.addressCity]
    .filter(Boolean)
    .join(" ");
  const parts = [
    recipient.addressLine1,
    recipient.addressLine2,
    locality || null,
    recipient.addressState,
    recipient.addressCountry,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(", ") : null;
}

function SummaryCard({
  label,
  value,
  detail,
  tone = "gold",
  icon: Icon,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "gold" | "success" | "warning" | "danger" | "neutral";
  icon: LucideIcon;
}) {
  const colour =
    tone === "success"
      ? "text-[var(--success-green)]"
      : tone === "danger"
        ? "text-[var(--danger-red)]"
      : tone === "warning"
        ? "text-[var(--warning-orange)]"
        : tone === "neutral"
          ? "text-[var(--text-primary)]"
        : "text-[var(--accent-gold)]";

  return (
    <div className="panel min-w-0 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="label-caps min-w-0">{label}</p>
        <Icon className={cn("size-4 shrink-0", colour)} aria-hidden />
      </div>
      <p
        className={cn(
          "mt-2 text-[22px] font-semibold tracking-tight tabular-nums sm:text-[24px]",
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
  const [changingWeek, startWeekTransition] = React.useTransition();
  const [syncing, setSyncing] = React.useState(false);
  const [checkingStripe, setCheckingStripe] = React.useState(false);
  const [stripeReadiness, setStripeReadiness] =
    React.useState<StripeReadiness | null>(null);
  const [issuingId, setIssuingId] = React.useState<string | null>(null);
  const [confirmClient, setConfirmClient] =
    React.useState<ClientPreview | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const [modalError, setModalError] = React.useState<string | null>(null);
  const overview = dashboard.positions.overview;
  const [range, setRange] = React.useState<RangeSelection>(() =>
    selectionForRange(overview.range, new Date(dashboard.generatedAt)),
  );
  const [query, setQuery] = React.useState("");
  const [stateFilter, setStateFilter] = React.useState<
    "all" | ClientBillingState
  >("all");
  const [detailClientId, setDetailClientId] = React.useState<string | null>(
    null,
  );
  const [skipClient, setSkipClient] = React.useState<OverviewClient | null>(
    null,
  );
  const [skippingId, setSkippingId] = React.useState<string | null>(null);
  const [skipFeedback, setSkipFeedback] = React.useState<Feedback>(null);

  const clientRows = React.useMemo<ClientBillingRow[]>(
    () =>
      overview.clients.map((client) => ({
        client,
        invoices: dashboard.invoices.filter(
          (invoice) => invoice.client_id === client.clientId,
        ),
      })),
    [dashboard.invoices, overview.clients],
  );

  const normalizedQuery = searchable(query.trim());
  const filteredRows = clientRows.filter((row) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      searchable(`${row.client.clientName} ${row.client.email}`).includes(
        normalizedQuery,
      );
    const matchesState =
      stateFilter === "all" || row.client.status === stateFilter;
    return matchesQuery && matchesState;
  });

  const currentSpendTotal = roundedSum(
    overview.clients.map((client) => client.currentSpend),
  );
  const localPeriodInvoices = dashboard.invoices.filter((invoice) => {
    const day = timestampDay(invoice.issued_at);
    return Boolean(
      day &&
        day >= range.from &&
        day <= range.to &&
        invoice.currency.toUpperCase() === dashboard.currency &&
        (invoice.status === "open" ||
          invoice.status === "paid" ||
          invoice.status === "uncollectible"),
    );
  });
  const localPeriodPayments = dashboard.invoices.filter((invoice) => {
    const day = timestampDay(invoice.paid_at);
    return Boolean(
      day &&
        day >= range.from &&
        day <= range.to &&
        invoice.currency.toUpperCase() === dashboard.currency &&
        invoice.status === "paid",
    );
  });
  const usesServerRange =
    range.from === overview.range.start && range.to === overview.range.end;
  const billedTotal = usesServerRange
    ? overview.summary.billed
    : roundedSum(localPeriodInvoices.map((invoice) => invoice.amount));
  const billedCount = usesServerRange
    ? overview.summary.billedCount
    : localPeriodInvoices.length;
  const receivedTotal = usesServerRange
    ? overview.summary.received
    : roundedSum(localPeriodPayments.map((invoice) => invoice.amount));
  const receivedCount = usesServerRange
    ? overview.summary.receivedCount
    : localPeriodPayments.length;
  const payableClientCount = overview.clients.filter(
    (client) => (client.payableCount ?? 0) > 0,
  ).length;
  const overdueClientCount = overview.clients.filter(
    (client) => (client.overdueCount ?? 0) > 0,
  ).length;
  const detailRow =
    clientRows.find((row) => row.client.clientId === detailClientId) ?? null;

  function changeWeek(periodStart: string) {
    setFeedback(null);
    startWeekTransition(() => {
      router.replace(`/admin/billing?week=${encodeURIComponent(periodStart)}`);
    });
  }

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
        // A forced refresh is per account: one Google failure must be reported,
        // but accounts that completed successfully should become reviewable
        // immediately instead of waiting for a manual page reload.
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
        StripeReadiness | { error?: string } | null;
      if (!response.ok || !body || !("ready" in body)) {
        setStripeReadiness(null);
        setFeedback({
          tone: "error",
          message: requestError(body, d.adminBilling.stripeCheckFailed),
        });
        return;
      }
      setStripeReadiness(body);
    } catch {
      setStripeReadiness(null);
      setFeedback({ tone: "error", message: d.adminBilling.stripeCheckFailed });
    } finally {
      setCheckingStripe(false);
    }
  }

  async function skipCurrentCycle() {
    if (!skipClient?.capabilities.canSkip) return;
    setSkippingId(skipClient.clientId);
    setSkipFeedback(null);
    try {
      const response = await fetch("/api/admin/billing/skip-cycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: skipClient.clientId }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        setSkipFeedback({
          tone: "error",
          message: requestError(
            body,
            "Não foi possível fazer skip deste ciclo.",
          ),
        });
        return;
      }
      setSkipFeedback({
        tone: "success",
        message: `O ciclo atual de ${skipClient.clientName} ficou marcado como Skip cycle.`,
      });
      setSkipClient(null);
      router.refresh();
    } catch {
      setSkipFeedback({
        tone: "error",
        message: "Não foi possível fazer skip deste ciclo.",
      });
    } finally {
      setSkippingId(null);
    }
  }

  function openConfirmation(client: ClientPreview) {
    setFeedback(null);
    setModalError(null);
    setConfirmed(false);
    setConfirmClient(client);
  }

  async function issueInvoice() {
    if (!confirmClient || !confirmed || !confirmClient.canIssue) return;
    setIssuingId(confirmClient.clientId);
    setFeedback(null);
    setModalError(null);

    try {
      const response = await fetch("/api/billing/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: confirmClient.clientId,
          periodStart: dashboard.selectedWeek.start,
          expectedAmount: confirmClient.amount,
          expectedReviewToken: confirmClient.reviewToken,
        }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const message = requestError(body, d.adminBilling.issueFailed);
        setFeedback({
          tone: "error",
          message,
        });
        if (requestCode(body) === "stale_preview") {
          setConfirmClient(null);
          setConfirmed(false);
          setModalError(null);
          router.refresh();
          return;
        }
        setModalError(message);
        return;
      }

      setConfirmClient(null);
      setConfirmed(false);
      setModalError(null);
      setFeedback({
        tone: "success",
        message: fmt(
          confirmClient.amount === 0
            ? d.adminBilling.waiveDone
            : d.adminBilling.issueDone,
          { client: confirmClient.clientName },
        ),
      });
      router.refresh();
    } catch {
      setFeedback({ tone: "error", message: d.adminBilling.issueFailed });
      setModalError(d.adminBilling.issueFailed);
    } finally {
      setIssuingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <section
        aria-label="Período do resumo"
        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
      >
        <DateRangePicker value={range} onApply={setRange} align="start" />
        <p className="text-[11px] text-[var(--text-muted)]">
          Faturado e recebido:{" "}
          <span className="font-medium text-[var(--text-secondary)]">
            {formatPeriod(range.from, range.to, intl)}
          </span>
        </p>
      </section>

      {skipFeedback && (
        <FormAlert tone={skipFeedback.tone}>{skipFeedback.message}</FormAlert>
      )}

      <section
        aria-label="Resumo financeiro"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5"
      >
        <SummaryCard
          label="A faturar · ciclo atual"
          value={money(
            overview.summary.currentAccrued,
            intl,
            overview.currency,
          )}
          detail="Estimativa até hoje · fecha domingo"
          tone="gold"
          icon={Clock3}
        />
        <SummaryCard
          label="A pagar"
          value={
            overview.summary.payable === null
              ? "—"
              : money(overview.summary.payable, intl, overview.currency)
          }
          detail={`${payableClientCount} ${payableClientCount === 1 ? "cliente" : "clientes"} · ciclo anterior`}
          tone="warning"
          icon={CircleDollarSign}
        />
        <SummaryCard
          label="Em atraso"
          value={
            overview.summary.overdue === null
              ? "—"
              : money(overview.summary.overdue, intl, overview.currency)
          }
          detail={`${overdueClientCount} ${overdueClientCount === 1 ? "cliente" : "clientes"} · atravessaram outro fecho`}
          tone="danger"
          icon={FileWarning}
        />
        <SummaryCard
          label="Faturado no período"
          value={
            billedTotal === null
              ? "—"
              : money(billedTotal, intl, overview.currency)
          }
          detail={
            billedCount === null
              ? "Dados incompletos"
              : billedCount === 1
              ? "1 fatura emitida"
                : `${billedCount} faturas emitidas`
          }
          tone="neutral"
          icon={CalendarDays}
        />
        <SummaryCard
          label="Recebido no período"
          value={
            receivedTotal === null
              ? "—"
              : money(receivedTotal, intl, overview.currency)
          }
          detail={
            receivedCount === null
              ? "Dados incompletos"
              : receivedCount === 1
              ? "1 pagamento recebido"
                : `${receivedCount} pagamentos recebidos`
          }
          tone="success"
          icon={CheckCircle2}
        />
      </section>

      <section aria-labelledby="client-billing-title" className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2
              id="client-billing-title"
              className="text-[16px] font-semibold text-[var(--text-primary)]"
            >
              Faturação por cliente
            </h2>
            <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
              O ciclo atual fecha domingo. A pagar e Em atraso consideram
              faturas emitidas que continuam abertas.
            </p>
          </div>

          <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
            <label className="relative block min-w-0 sm:w-72">
              <span className="sr-only">Pesquisar clientes</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
                aria-hidden
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Pesquisar clientes"
                className="pl-9"
              />
            </label>
            <Select
              value={stateFilter}
              onValueChange={(value) =>
                setStateFilter(value as "all" | ClientBillingState)
              }
            >
              <SelectTrigger
                aria-label="Filtrar por estado"
                className="w-full sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os estados</SelectItem>
                <SelectItem value="paid">Pago</SelectItem>
                <SelectItem value="payable">Por pagar</SelectItem>
                <SelectItem value="overdue">Em atraso</SelectItem>
                <SelectItem value="skip_cycle">Skip cycle</SelectItem>
                <SelectItem value="paused">Billing pausado</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="panel overflow-hidden">
          <div className="flex flex-col gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-base)]/40 px-4 py-3 text-[11px] text-[var(--text-secondary)] sm:flex-row sm:items-center sm:gap-5">
            <span>
              <strong className="font-medium text-[var(--text-primary)]">
                Ciclo atual:
              </strong>{" "}
              {formatPeriod(
                overview.currentPeriod.start,
                overview.currentPeriod.end,
                intl,
              )}
            </span>
            <span>
              <strong className="font-medium text-[var(--text-primary)]">
                Último ciclo fechado:
              </strong>{" "}
              {formatPeriod(
                overview.previousPeriod.start,
                overview.previousPeriod.end,
                intl,
              )}
            </span>
            <span className="sm:ml-auto">
              {fmt(d.adminBilling.calculatedAt, {
                date: formatTimestamp(dashboard.generatedAt, intl, "—"),
              })}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-left text-[12px]">
              <thead className="bg-[var(--bg-base)]/30 text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Ad spend · ciclo atual
                  </th>
                  <th className="px-4 py-3 text-right font-medium">Taxa</th>
                  <th className="px-4 py-3 text-right font-medium">
                    A faturar
                  </th>
                  <th className="px-4 py-3 text-right font-medium">A pagar</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Em atraso
                  </th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const latestDocument = row.invoices.find(
                    (invoice) =>
                      safeStripeUrl(invoice.stripe_hosted_url) ||
                      safeStripeUrl(invoice.stripe_invoice_pdf),
                  );
                  const stripeHostedUrl = safeStripeUrl(
                    latestDocument?.stripe_hosted_url,
                  );
                  const stripeInvoicePdf = safeStripeUrl(
                    latestDocument?.stripe_invoice_pdf,
                  );
                  const stateLabel =
                    row.client.status === "overdue"
                      ? "Em atraso"
                      : row.client.status === "payable"
                        ? "Por pagar"
                        : row.client.status === "skip_cycle"
                          ? "Skip cycle"
                          : row.client.status === "paused"
                            ? "Billing pausado"
                            : "Pago";
                  const stateVariant =
                    row.client.status === "overdue"
                      ? "danger"
                      : row.client.status === "payable"
                        ? "gold"
                        : row.client.status === "paid"
                          ? "success"
                          : "neutral";

                  return (
                    <tr
                      key={row.client.clientId}
                      className="border-t border-[var(--border-subtle)] transition-smooth first:border-t-0 hover:bg-[var(--bg-panel-hover)]"
                    >
                      <td className="px-4 py-3">
                        <p className="max-w-56 truncate font-semibold text-[var(--text-primary)]">
                          {row.client.clientName}
                        </p>
                        <p className="mt-0.5 max-w-56 truncate text-[10.5px] text-[var(--text-muted)]">
                          {row.client.email}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-[var(--text-primary)] tabular-nums">
                        {money(
                          row.client.currentSpend,
                          intl,
                          row.client.currency,
                        )}
                        <span className="mt-0.5 block text-[9.5px] font-normal text-[var(--text-muted)]">
                          {row.client.currentThrough
                            ? `até ${shortDate(
                                row.client.currentThrough,
                                intl,
                              )}`
                            : "ainda sem dados"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--text-secondary)] tabular-nums">
                        {row.client.currentRate === null
                          ? "—"
                          : `${rate(row.client.currentRate, intl)}%`}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-[var(--accent-gold-strong)] tabular-nums">
                        {money(
                          row.client.currentSkipId
                            ? 0
                            : row.client.currentAccrued,
                          intl,
                          row.client.currency,
                        )}
                        <span className="mt-0.5 block text-[9.5px] font-normal text-[var(--text-muted)]">
                          {row.client.currentSkipId
                            ? "ciclo dispensado"
                            : "estimativa até hoje"}
                        </span>
                      </td>
                      <td
                        className={cn(
                          "px-4 py-3 text-right tabular-nums",
                          row.client.payable !== null &&
                            row.client.payable > 0
                            ? "font-semibold text-[var(--accent-gold-strong)]"
                            : "text-[var(--text-muted)]",
                        )}
                      >
                        {row.client.payable === null
                          ? "—"
                          : row.client.payable > 0
                            ? money(
                                row.client.payable,
                                intl,
                                row.client.currency,
                              )
                            : "—"}
                        {row.client.payable !== null &&
                          row.client.payable > 0 && (
                          <span className="mt-0.5 block text-[9.5px] font-normal text-[var(--text-muted)]">
                            {formatPeriod(
                              overview.previousPeriod.start,
                              overview.previousPeriod.end,
                              intl,
                            )}
                          </span>
                          )}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-3 text-right tabular-nums",
                          row.client.overdue !== null &&
                            row.client.overdue > 0
                            ? "font-semibold text-[var(--danger-red)]"
                            : "text-[var(--text-muted)]",
                        )}
                      >
                        {row.client.overdue === null
                          ? "—"
                          : row.client.overdue > 0
                            ? money(
                                row.client.overdue,
                                intl,
                                row.client.currency,
                              )
                            : "—"}
                        {row.client.overdue !== null &&
                          row.client.overdue > 0 && (
                          <span className="mt-0.5 block text-[9.5px] font-normal text-[var(--text-muted)]">
                            {row.client.overdueCount === 1
                              ? "1 ciclo aberto"
                              : `${row.client.overdueCount} ciclos abertos`}
                          </span>
                          )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={stateVariant}>
                          <span
                            className="size-1.5 rounded-full bg-current"
                            aria-hidden
                          />
                          {stateLabel}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Ações de ${row.client.clientName}`}
                            >
                              <MoreHorizontal aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-56">
                            <DropdownMenuItem
                              onSelect={() =>
                                setDetailClientId(row.client.clientId)
                              }
                            >
                              <CircleDollarSign aria-hidden />
                              Ver ciclos e pagamentos
                            </DropdownMenuItem>
                            {row.client.capabilities.canSkip && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setSkipFeedback(null);
                                    setSkipClient(row.client);
                                  }}
                                >
                                  <CalendarDays aria-hidden />
                                  Skip ciclo atual
                                </DropdownMenuItem>
                              </>
                            )}
                            {(stripeHostedUrl || stripeInvoicePdf) && (
                              <DropdownMenuSeparator />
                            )}
                            {stripeHostedUrl && (
                              <DropdownMenuItem asChild>
                                <a
                                  href={stripeHostedUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <ExternalLink aria-hidden />
                                  Abrir fatura na Stripe
                                </a>
                              </DropdownMenuItem>
                            )}
                            {stripeInvoicePdf && (
                              <DropdownMenuItem asChild>
                                <a
                                  href={stripeInvoicePdf}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <Download aria-hidden />
                                  Descarregar PDF
                                </a>
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-[var(--border-subtle)] bg-[var(--bg-base)]/40">
                <tr>
                  <td className="px-4 py-3 font-semibold text-[var(--text-secondary)]">
                    Total do portefólio
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-[var(--text-primary)] tabular-nums">
                    {money(currentSpendTotal, intl, overview.currency)}
                  </td>
                  <td />
                  <td className="px-4 py-3 text-right font-semibold text-[var(--accent-gold-strong)] tabular-nums">
                    {money(
                      overview.summary.currentAccrued,
                      intl,
                      overview.currency,
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-[var(--accent-gold-strong)] tabular-nums">
                    {overview.summary.payable === null
                      ? "—"
                      : money(
                          overview.summary.payable,
                          intl,
                          overview.currency,
                        )}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-[var(--danger-red)] tabular-nums">
                    {overview.summary.overdue === null
                      ? "—"
                      : money(
                          overview.summary.overdue,
                          intl,
                          overview.currency,
                        )}
                  </td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">
                    {clientRows.length}{" "}
                    {clientRows.length === 1 ? "cliente" : "clientes"}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {filteredRows.length === 0 && (
            <div className="border-t border-[var(--border-subtle)] px-5 py-12 text-center text-[13px] text-[var(--text-secondary)]">
              Nenhum cliente corresponde à pesquisa ou ao estado escolhido.
            </div>
          )}
        </div>
      </section>

      <details className="group/advanced panel overflow-hidden">
        <summary className="transition-smooth flex min-h-16 cursor-pointer list-none items-center gap-4 px-4 py-3 hover:bg-[var(--bg-panel-hover)] sm:px-5 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
              Operações avançadas
            </h2>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
              Rever e emitir manualmente, atualizar dados e consultar o
              histórico completo.
            </p>
          </div>
          <ChevronDown
            className="ml-auto size-4 shrink-0 text-[var(--text-muted)] transition-transform group-open/advanced:rotate-180"
            aria-hidden
          />
        </summary>

        <div className="space-y-6 border-t border-[var(--border-subtle)] p-4 sm:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <label htmlFor="billing-week" className="label-caps">
                {d.adminBilling.weekLabel}
              </label>
              <Select
                value={dashboard.selectedWeek.start}
                onValueChange={changeWeek}
                disabled={changingWeek || syncing || Boolean(issuingId)}
              >
                <SelectTrigger
                  id="billing-week"
                  className="mt-2 w-full sm:w-64"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dashboard.weeks.map((week) => (
                    <SelectItem key={week.start} value={week.start}>
                      {formatPeriod(week.start, week.end, intl)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
              <Button
                type="button"
                variant="secondary"
                loading={checkingStripe}
                disabled={syncing || changingWeek || Boolean(issuingId)}
                onClick={checkStripe}
              >
                <CheckCircle2 />
                {checkingStripe ? "A testar Stripe" : d.adminBilling.stripeCheck}
              </Button>
              <Button
                type="button"
                variant="secondary"
                loading={syncing}
                disabled={checkingStripe || changingWeek || Boolean(issuingId)}
                onClick={refreshLedger}
              >
                <RefreshCw />
                {syncing ? "A atualizar" : d.adminBilling.refreshLedger}
              </Button>
            </div>
          </div>

          {feedback && (
            <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>
          )}

          {stripeReadiness && (
            <section
              className={cn(
                "rounded-[var(--radius-card)] border p-4",
                stripeReadiness.ready
                  ? "border-[var(--success-green)]/30 bg-[var(--success-green)]/5"
                  : "border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/5",
              )}
              aria-live="polite"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                      {stripeReadiness.ready
                        ? d.adminBilling.stripeReady
                        : d.adminBilling.stripeNotReady}
                    </h3>
                    <Badge
                      variant={stripeReadiness.liveMode ? "success" : "danger"}
                    >
                      {stripeReadiness.liveMode ? "LIVE" : "NOT LIVE"}
                    </Badge>
                    <Badge
                      variant={
                        stripeReadiness.issuanceEnabled ? "warning" : "neutral"
                      }
                    >
                      {stripeReadiness.issuanceEnabled
                        ? d.adminBilling.stripeGateEnabled
                        : d.adminBilling.stripeGateDisabled}
                    </Badge>
                  </div>
                  <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
                    {stripeReadiness.ready
                      ? d.adminBilling.stripeReadyDetail
                      : d.adminBilling.stripeNotReadyDetail}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <Badge
                    variant={
                      stripeReadiness.permissions.customersRead
                        ? "success"
                        : "danger"
                    }
                  >
                    Customers
                  </Badge>
                  <Badge
                    variant={
                      stripeReadiness.permissions.invoicesRead
                        ? "success"
                        : "danger"
                    }
                  >
                    Invoices
                  </Badge>
                  <Badge
                    variant={
                      stripeReadiness.permissions.invoiceItemsRead
                        ? "success"
                        : "danger"
                    }
                  >
                    Invoice items
                  </Badge>
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {d.adminBilling.stripeReadOnlyLimitation}
              </p>
            </section>
          )}

          <section className="space-y-4">
        <div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
            {d.adminBilling.reviewTitle}
          </h2>
          <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {d.adminBilling.reviewSubtitle}
          </p>
          <p className="mt-1 max-w-3xl text-[11.5px] leading-relaxed text-[var(--warning-orange)]">
            {d.adminBilling.googleReportingFreshness}
          </p>
        </div>

        {dashboard.clients.length === 0 ? (
          <div className="panel px-5 py-12 text-center text-[13px] text-[var(--text-secondary)]">
            {d.adminBilling.noClients}
          </div>
        ) : (
          <div className="space-y-3">
            {dashboard.clients.map((client) => {
              const errors = client.blockers.filter(
                (blocker) => blocker.severity === "error",
              );
              const warnings = client.blockers.filter(
                (blocker) => blocker.severity === "warning",
              );
              const invoice = client.existingInvoice;
              const stripeHostedUrl = safeStripeUrl(invoice?.stripe_hosted_url);
              const stripeInvoicePdf = safeStripeUrl(
                invoice?.stripe_invoice_pdf,
              );
              const issueBusy = issuingId === client.clientId;
              const amountDue = invoice
                ? invoice.status === "open"
                  ? (invoice.amount_remaining ?? invoice.amount)
                  : invoice.status === "draft"
                    ? invoice.amount
                    : 0
                : client.amount;

              return (
                <article
                  key={client.clientId}
                  className="panel overflow-hidden"
                >
                  <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-[15px] font-semibold text-[var(--text-primary)]">
                          {client.clientName}
                        </h3>
                        {invoice ? (
                          <Badge variant={STATUS_VARIANT[invoice.status]}>
                            {statusLabel(invoice.status, d)}
                          </Badge>
                        ) : client.canIssue ? (
                          <Badge variant="success">
                            {d.adminBilling.ready}
                          </Badge>
                        ) : (
                          <Badge variant="danger">
                            {d.adminBilling.blocked}
                          </Badge>
                        )}
                        {invoice?.payment_failed_at && (
                          <Badge variant="danger">
                            {d.adminBilling.paymentFailed}
                          </Badge>
                        )}
                        {warnings.length > 0 && (
                          <Badge variant="warning">
                            {fmt(d.adminBilling.warningCount, {
                              count: warnings.length,
                            })}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 truncate text-[12px] text-[var(--text-muted)]">
                        {client.email}
                      </p>

                      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                          <p className="label-caps">
                            {d.adminBilling.reportedGoogleSpend}
                          </p>
                          <p className="mt-1 text-[17px] font-semibold text-[var(--text-primary)] tabular-nums">
                            {money(client.grossSpend, intl, client.currency)}
                          </p>
                          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                            {d.adminBilling.paidDirectlyGoogle}
                          </p>
                        </div>
                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                          <p className="label-caps">
                            {d.adminBilling.openingBaselineExcluded}
                          </p>
                          <p className="mt-1 text-[17px] font-semibold text-[var(--text-primary)] tabular-nums">
                            {money(
                              client.baselineDeduction,
                              intl,
                              client.currency,
                            )}
                          </p>
                          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                            {d.adminBilling.notBillableBeforeTracking}
                          </p>
                        </div>
                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                          <p className="label-caps">
                            {d.adminBilling.billableGoogleSpend}
                          </p>
                          <p className="mt-1 text-[17px] font-semibold text-[var(--text-primary)] tabular-nums">
                            {money(client.billableSpend, intl, client.currency)}
                          </p>
                          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                            {clientRateLabel(client, d, intl)}
                          </p>
                        </div>
                        <div className="rounded-xl border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] p-3">
                          <p className="label-caps">
                            {d.adminBilling.amountDue}
                          </p>
                          <p className="mt-1 text-[20px] font-semibold text-[var(--accent-gold-strong)] tabular-nums">
                            {money(amountDue, intl, client.currency)}
                          </p>
                          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                            {clientRateLabel(client, d, intl)} · EUR
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex w-full shrink-0 flex-col gap-2 lg:w-48">
                      {stripeHostedUrl && (
                        <Button
                          asChild
                          type="button"
                          variant="secondary"
                          size="sm"
                        >
                          <a
                            href={stripeHostedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink />
                            {d.adminBilling.openStripe}
                          </a>
                        </Button>
                      )}
                      {stripeInvoicePdf && (
                        <Button asChild type="button" variant="ghost" size="sm">
                          <a
                            href={stripeInvoicePdf}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Download />
                            {d.adminBilling.downloadPdf}
                          </a>
                        </Button>
                      )}
                      {(!invoice ||
                        (((invoice.status === "draft" &&
                          invoice.stripe_sent_at === null &&
                          invoice.stripe_delivery_assumed_at === null) ||
                          (invoice.status === "open" &&
                            invoice.stripe_sent_at === null &&
                            invoice.stripe_delivery_assumed_at === null)) &&
                          client.canIssue)) && (
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          className="min-h-10"
                          disabled={!client.canIssue || Boolean(issuingId)}
                          loading={issueBusy}
                          onClick={() => openConfirmation(client)}
                        >
                          <FileCheck2 />
                          {issueBusy
                            ? d.adminBilling.issuing
                            : invoice
                              ? d.adminBilling.retryIssue
                              : client.amount === 0
                                ? d.adminBilling.reviewAndWaive
                                : d.adminBilling.reviewAndIssue}
                        </Button>
                      )}
                    </div>
                  </div>

                  {(errors.length > 0 ||
                    warnings.length > 0 ||
                    invoice?.issue_error ||
                    invoice?.stripe_delivery_assumed_at ||
                    (invoice && deliveryNeedsReconciliation(invoice))) && (
                    <div className="border-t border-[var(--border-subtle)] px-4 py-3 sm:px-5">
                      <ul className="space-y-2">
                        {invoice?.issue_error && (
                          <li className="flex items-start gap-2 text-[12px] text-[var(--danger-red)]">
                            <AlertCircle
                              className="mt-0.5 size-3.5 shrink-0"
                              aria-hidden
                            />
                            <span>{invoice.issue_error}</span>
                          </li>
                        )}
                        {invoice?.stripe_delivery_assumed_at && (
                          <li className="flex items-start gap-2 text-[12px] text-[var(--warning-orange)]">
                            <TriangleAlert
                              className="mt-0.5 size-3.5 shrink-0"
                              aria-hidden
                            />
                            <span>{d.adminBilling.deliveryAssumedWarning}</span>
                          </li>
                        )}
                        {invoice && deliveryNeedsReconciliation(invoice) && (
                          <li className="flex items-start gap-2 text-[12px] text-[var(--warning-orange)]">
                            <RefreshCw
                              className="mt-0.5 size-3.5 shrink-0"
                              aria-hidden
                            />
                            <span>
                              {d.adminBilling.deliveryReconciliationPending}
                            </span>
                          </li>
                        )}
                        {[...errors, ...warnings].map((blocker, index) => (
                          <li
                            key={`${blocker.code}-${blocker.accountId ?? "client"}-${index}`}
                            className={cn(
                              "flex items-start gap-2 text-[12px]",
                              blocker.severity === "error"
                                ? "text-[var(--danger-red)]"
                                : "text-[var(--warning-orange)]",
                            )}
                          >
                            {blocker.severity === "error" ? (
                              <AlertCircle
                                className="mt-0.5 size-3.5 shrink-0"
                                aria-hidden
                              />
                            ) : (
                              <TriangleAlert
                                className="mt-0.5 size-3.5 shrink-0"
                                aria-hidden
                              />
                            )}
                            <span>{blocker.message}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <details className="group/stores border-t border-[var(--border-subtle)]">
                    <summary className="transition-smooth flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] sm:px-5 [&::-webkit-details-marker]:hidden">
                      <Store
                        className="size-3.5 text-[var(--accent-gold)]"
                        aria-hidden
                      />
                      <span className="font-medium text-[var(--text-primary)]">
                        {fmt(d.adminBilling.storeCount, {
                          count: client.stores.length,
                        })}
                      </span>
                      <span aria-hidden>·</span>
                      <Clock3 className="size-3.5" aria-hidden />
                      <span>
                        {fmt(d.adminBilling.latestSync, {
                          date: formatTimestamp(
                            client.lastLedgerUpdate,
                            intl,
                            d.adminBilling.neverSynced,
                          ),
                        })}
                      </span>
                      <span className="ml-auto text-[var(--text-muted)] group-open/stores:hidden">
                        {d.adminBilling.showDetails}
                      </span>
                      <span className="ml-auto hidden text-[var(--text-muted)] group-open/stores:inline">
                        {d.adminBilling.hideDetails}
                      </span>
                    </summary>

                    <div className="overflow-x-auto border-t border-[var(--border-subtle)]">
                      <table className="w-full min-w-[1100px] text-left text-[12px]">
                        <thead className="bg-[var(--bg-base)] text-[var(--text-muted)]">
                          <tr>
                            <th className="px-5 py-2.5 font-medium">
                              {d.adminBilling.store}
                            </th>
                            <th className="px-4 py-2.5 text-right font-medium">
                              {d.adminBilling.reportedGoogleSpend}
                            </th>
                            <th className="px-4 py-2.5 text-right font-medium">
                              {d.adminBilling.openingBaselineExcluded}
                            </th>
                            <th className="px-4 py-2.5 text-right font-medium">
                              {d.adminBilling.closingSpendExcluded}
                            </th>
                            <th className="px-4 py-2.5 text-right font-medium">
                              {d.adminBilling.billableGoogleSpend}
                            </th>
                            <th className="px-4 py-2.5 text-right font-medium">
                              {d.adminBilling.agencyFee}
                            </th>
                            <th className="px-4 py-2.5 font-medium">
                              {d.adminBilling.coverage}
                            </th>
                            <th className="px-5 py-2.5 font-medium">
                              {d.adminBilling.connection}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {client.stores.map((store) => (
                            <tr
                              key={store.accountId}
                              className="border-t border-[var(--border-subtle)]"
                            >
                              <td className="px-5 py-3">
                                <p className="font-medium text-[var(--text-primary)]">
                                  {store.storeName}
                                </p>
                                <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                                  {store.accountCurrency}
                                </p>
                              </td>
                              <td className="px-4 py-3 text-right text-[var(--text-primary)] tabular-nums">
                                {money(
                                  store.grossSpend,
                                  intl,
                                  store.accountCurrency,
                                )}
                              </td>
                              <td className="px-4 py-3 text-right text-[var(--text-secondary)] tabular-nums">
                                {startsInWeek(store, dashboard.selectedWeek)
                                  ? money(
                                      store.baselineDeduction,
                                      intl,
                                      store.accountCurrency,
                                    )
                                  : "—"}
                              </td>
                              <td className="px-4 py-3 text-right text-[var(--text-secondary)] tabular-nums">
                                {endsInWeek(store, dashboard.selectedWeek)
                                  ? money(
                                      store.endDeduction,
                                      intl,
                                      store.accountCurrency,
                                    )
                                  : "—"}
                              </td>
                              <td className="px-4 py-3 text-right font-medium text-[var(--text-primary)] tabular-nums">
                                {money(
                                  store.billableSpend,
                                  intl,
                                  store.accountCurrency,
                                )}
                                {startsInWeek(store, dashboard.selectedWeek) &&
                                  store.billingStart && (
                                    <p className="mt-0.5 max-w-64 text-right text-[10px] font-normal text-[var(--text-muted)]">
                                      {fmt(d.adminBilling.trackingStarted, {
                                        date: formatTimestamp(
                                          store.billingStart.capturedAt,
                                          intl,
                                          store.billingStart.date,
                                        ),
                                        timeZone: store.billingStart.timeZone,
                                        amount: money(
                                          store.billingStart.baselineAmount,
                                          intl,
                                          store.accountCurrency,
                                        ),
                                      })}
                                    </p>
                                  )}
                                {endsInWeek(store, dashboard.selectedWeek) &&
                                  store.billingEnd && (
                                    <p className="mt-0.5 max-w-64 text-right text-[10px] font-normal text-[var(--text-muted)]">
                                      {fmt(d.adminBilling.trackingEnded, {
                                        date: formatTimestamp(
                                          store.billingEnd.capturedAt,
                                          intl,
                                          store.billingEnd.date,
                                        ),
                                        timeZone: store.billingEnd.timeZone,
                                        amount: money(
                                          store.billingEnd.endAmount,
                                          intl,
                                          store.accountCurrency,
                                        ),
                                        deduction: money(
                                          store.endDeduction,
                                          intl,
                                          store.accountCurrency,
                                        ),
                                      })}
                                    </p>
                                  )}
                              </td>
                              <td className="px-4 py-3 text-right font-medium text-[var(--accent-gold-strong)] tabular-nums">
                                {money(store.fee, intl, client.currency)}
                                <p className="mt-0.5 text-[10px] font-normal text-[var(--text-muted)]">
                                  {storeRateLabel(store, d, intl)}
                                </p>
                              </td>
                              <td className="px-4 py-3 text-[var(--text-secondary)]">
                                {fmt(d.adminBilling.sourceDays, {
                                  count: store.sourceDays,
                                })}
                                <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                                  {formatTimestamp(
                                    store.lastLedgerUpdate,
                                    intl,
                                    d.adminBilling.neverSynced,
                                  )}
                                </p>
                              </td>
                              <td className="px-5 py-3">
                                <Badge
                                  variant={
                                    store.connected ? "success" : "danger"
                                  }
                                >
                                  {store.connected
                                    ? d.adminBilling.connected
                                    : d.adminBilling.disconnected}
                                </Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4">
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
                  {invoice.stripe_delivery_assumed_at && (
                    <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-[var(--warning-orange)]">
                      <TriangleAlert
                        className="mt-0.5 size-3.5 shrink-0"
                        aria-hidden
                      />
                      <span>{d.adminBilling.deliveryAssumedWarning}</span>
                    </p>
                  )}
                  {deliveryNeedsReconciliation(invoice) && (
                    <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-[var(--warning-orange)]">
                      <RefreshCw
                        className="mt-0.5 size-3.5 shrink-0"
                        aria-hidden
                      />
                      <span>
                        {d.adminBilling.deliveryReconciliationPending}
                      </span>
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
                        {invoice.stripe_delivery_assumed_at && (
                          <p className="mt-1.5 max-w-52 text-[10.5px] leading-relaxed text-[var(--warning-orange)]">
                            {d.adminBilling.deliveryAssumedWarning}
                          </p>
                        )}
                        {deliveryNeedsReconciliation(invoice) && (
                          <p className="mt-1.5 max-w-52 text-[10.5px] leading-relaxed text-[var(--warning-orange)]">
                            {d.adminBilling.deliveryReconciliationPending}
                          </p>
                        )}
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
      </details>

      <Dialog
        open={Boolean(skipClient)}
        onOpenChange={(open) => {
          if (!open && !skippingId) setSkipClient(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Skip ciclo atual</DialogTitle>
            <DialogDescription>
              {skipClient
                ? `Dispensar ${skipClient.clientName} do ciclo ${formatPeriod(
                    overview.currentPeriod.start,
                    overview.currentPeriod.end,
                    intl,
                  )}.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {skipFeedback?.tone === "error" && (
            <FormAlert tone="error">{skipFeedback.message}</FormAlert>
          )}

          <div className="rounded-xl border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/10 p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            O ad spend continua registado, mas este ciclo não será cobrado. Na
            segunda-feira começa automaticamente um novo ciclo normal.
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={Boolean(skippingId)}
              onClick={() => setSkipClient(null)}
            >
              {d.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={Boolean(skippingId)}
              disabled={!skipClient?.capabilities.canSkip}
              onClick={skipCurrentCycle}
            >
              <CalendarDays />
              {skippingId ? "A guardar skip" : "Confirmar skip"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(detailRow)}
        onOpenChange={(open) => {
          if (!open) setDetailClientId(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detailRow?.client.clientName}</DialogTitle>
            <DialogDescription>
              Ciclos, faturas emitidas e pagamentos registados para este
              cliente.
            </DialogDescription>
          </DialogHeader>

          {detailRow && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-[var(--accent-gold)]/20 bg-[var(--accent-gold-dim)] p-3">
                  <p className="label-caps">A faturar</p>
                  <p className="mt-1 text-[17px] font-semibold text-[var(--accent-gold-strong)] tabular-nums">
                    {money(
                      detailRow.client.currentSkipId
                        ? 0
                        : detailRow.client.currentAccrued,
                      intl,
                      detailRow.client.currency,
                    )}
                  </p>
                </div>
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                  <p className="label-caps">A pagar</p>
                  <p className="mt-1 text-[17px] font-semibold text-[var(--text-primary)] tabular-nums">
                    {detailRow.client.payable === null
                      ? "—"
                      : money(
                          detailRow.client.payable,
                          intl,
                          detailRow.client.currency,
                        )}
                  </p>
                </div>
                <div className="rounded-xl border border-[var(--danger-red)]/20 bg-[var(--danger-red)]/5 p-3">
                  <p className="label-caps">Em atraso</p>
                  <p className="mt-1 text-[17px] font-semibold text-[var(--danger-red)] tabular-nums">
                    {detailRow.client.overdue === null
                      ? "—"
                      : money(
                          detailRow.client.overdue,
                          intl,
                          detailRow.client.currency,
                        )}
                  </p>
                </div>
              </div>

              {detailRow.invoices.length === 0 ? (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-10 text-center text-[12.5px] text-[var(--text-secondary)]">
                  Ainda não existem faturas emitidas para este cliente.
                </div>
              ) : (
                <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                  {detailRow.invoices.map((invoice) => (
                    <li
                      key={invoice.id}
                      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-medium text-[var(--text-primary)]">
                            {formatPeriod(
                              invoice.period_start,
                              invoice.period_end,
                              intl,
                            )}
                          </p>
                          <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                            {invoice.issued_at
                              ? formatTimestamp(invoice.issued_at, intl, "—")
                              : d.adminBilling.notIssued}
                          </p>
                        </div>
                        <Badge variant={STATUS_VARIANT[invoice.status]}>
                          {statusLabel(invoice.status, d)}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-3 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                          <p className="text-[15px] font-semibold text-[var(--text-primary)] tabular-nums">
                            {money(invoice.amount, intl, invoice.currency)}
                          </p>
                          {invoice.status === "open" && (
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
                        <div className="flex flex-wrap items-center gap-3">
                          <PaymentState invoice={invoice} d={d} />
                          <InvoiceLinks invoice={invoice} d={d} />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDetailClientId(null)}
            >
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(confirmClient)}
        onOpenChange={(open) => {
          if (!open && !issuingId) {
            setConfirmClient(null);
            setConfirmed(false);
            setModalError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmClient?.amount === 0
                ? d.adminBilling.confirmWaiveTitle
                : d.adminBilling.confirmTitle}
            </DialogTitle>
            <DialogDescription>
              {confirmClient
                ? fmt(
                    confirmClient.amount === 0
                      ? d.adminBilling.confirmWaiveDescription
                      : d.adminBilling.confirmDescription,
                    {
                      client: confirmClient.clientName,
                      period: formatPeriod(
                        dashboard.selectedWeek.start,
                        dashboard.selectedWeek.end,
                        intl,
                      ),
                    },
                  )
                : ""}
            </DialogDescription>
          </DialogHeader>

          {modalError && <FormAlert>{modalError}</FormAlert>}

          {confirmClient && (
            <div className="space-y-4">
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                <p className="label-caps">{d.billing.invoiceDetails}</p>
                <p className="mt-2 text-[13px] font-medium text-[var(--text-primary)]">
                  {confirmClient.recipient.billingName ??
                    confirmClient.recipient.fallbackName}
                </p>
                <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">
                  {confirmClient.recipient.email}
                </p>
                {confirmClient.recipient.taxId && (
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    {d.billing.taxId}: {confirmClient.recipient.taxId}
                  </p>
                )}
                {recipientAddress(confirmClient.recipient) && (
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                    {recipientAddress(confirmClient.recipient)}
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)]">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Store
                      className="size-3.5 shrink-0 text-[var(--accent-gold)]"
                      aria-hidden
                    />
                    <p className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                      {fmt(d.adminBilling.storeCount, {
                        count: confirmClient.stores.length,
                      })}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">
                    {d.adminBilling.amountDue}
                  </span>
                </div>

                <ul className="max-h-60 divide-y divide-[var(--border-subtle)] overflow-y-auto">
                  {confirmClient.stores.map((store) => (
                    <li key={store.accountId} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                            {store.storeName}
                          </p>
                          <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                            {store.accountCurrency}
                          </p>
                        </div>
                        <p className="shrink-0 text-[13px] font-semibold text-[var(--accent-gold-strong)] tabular-nums">
                          {money(store.fee, intl, confirmClient.currency)}
                          <span className="mt-0.5 block max-w-52 text-right text-[10px] font-normal text-[var(--text-muted)]">
                            {storeRateLabel(store, d, intl)}
                          </span>
                        </p>
                      </div>
                      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[10.5px] text-[var(--text-muted)]">
                        <span>{d.adminBilling.reportedGoogleSpend}</span>
                        <span className="shrink-0 text-right tabular-nums">
                          {money(store.grossSpend, intl, store.accountCurrency)}
                        </span>
                        {startsInWeek(store, dashboard.selectedWeek) && (
                          <>
                            <span>
                              {d.adminBilling.openingBaselineExcluded}
                            </span>
                            <span className="shrink-0 text-right tabular-nums">
                              −
                              {money(
                                store.baselineDeduction,
                                intl,
                                store.accountCurrency,
                              )}
                            </span>
                          </>
                        )}
                        {endsInWeek(store, dashboard.selectedWeek) && (
                          <>
                            <span>{d.adminBilling.closingSpendExcluded}</span>
                            <span className="shrink-0 text-right tabular-nums">
                              −
                              {money(
                                store.endDeduction,
                                intl,
                                store.accountCurrency,
                              )}
                            </span>
                          </>
                        )}
                        <span className="font-medium text-[var(--text-secondary)]">
                          {d.adminBilling.billableGoogleSpend}
                        </span>
                        <span className="shrink-0 text-right font-medium text-[var(--text-secondary)] tabular-nums">
                          {money(
                            store.billableSpend,
                            intl,
                            store.accountCurrency,
                          )}
                        </span>
                      </div>
                      {startsInWeek(store, dashboard.selectedWeek) &&
                        store.billingStart && (
                          <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
                            {fmt(d.adminBilling.trackingStarted, {
                              date: formatTimestamp(
                                store.billingStart.capturedAt,
                                intl,
                                store.billingStart.date,
                              ),
                              timeZone: store.billingStart.timeZone,
                              amount: money(
                                store.billingStart.baselineAmount,
                                intl,
                                store.accountCurrency,
                              ),
                            })}
                          </p>
                        )}
                      {endsInWeek(store, dashboard.selectedWeek) &&
                        store.billingEnd && (
                          <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
                            {fmt(d.adminBilling.trackingEnded, {
                              date: formatTimestamp(
                                store.billingEnd.capturedAt,
                                intl,
                                store.billingEnd.date,
                              ),
                              timeZone: store.billingEnd.timeZone,
                              amount: money(
                                store.billingEnd.endAmount,
                                intl,
                                store.accountCurrency,
                              ),
                              deduction: money(
                                store.endDeduction,
                                intl,
                                store.accountCurrency,
                              ),
                            })}
                          </p>
                        )}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                <div className="flex items-center justify-between gap-4 text-[12.5px]">
                  <span className="text-[var(--text-secondary)]">
                    {d.adminBilling.reportedGoogleSpend}
                  </span>
                  <span className="font-medium text-[var(--text-primary)] tabular-nums">
                    {money(
                      confirmClient.grossSpend,
                      intl,
                      confirmClient.currency,
                    )}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-4 text-[12.5px]">
                  <span className="text-[var(--text-secondary)]">
                    {d.adminBilling.openingBaselineExcluded}
                  </span>
                  <span className="font-medium text-[var(--text-primary)] tabular-nums">
                    −
                    {money(
                      confirmClient.baselineDeduction,
                      intl,
                      confirmClient.currency,
                    )}
                  </span>
                </div>
                {confirmClient.endDeduction > 0 && (
                  <div className="mt-2 flex items-center justify-between gap-4 text-[12.5px]">
                    <span className="text-[var(--text-secondary)]">
                      {d.adminBilling.closingSpendExcluded}
                    </span>
                    <span className="font-medium text-[var(--text-primary)] tabular-nums">
                      −
                      {money(
                        confirmClient.endDeduction,
                        intl,
                        confirmClient.currency,
                      )}
                    </span>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-3 text-[12.5px]">
                  <span className="font-medium text-[var(--text-primary)]">
                    {d.adminBilling.billableGoogleSpend}
                  </span>
                  <span className="font-medium text-[var(--text-primary)] tabular-nums">
                    {money(
                      confirmClient.billableSpend,
                      intl,
                      confirmClient.currency,
                    )}
                  </span>
                </div>
                <p className="mt-1 text-right text-[10.5px] text-[var(--text-muted)]">
                  {d.adminBilling.paidDirectlyGoogle}
                </p>
                <div className="mt-3 flex items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-3">
                  <span className="text-[13px] font-medium text-[var(--text-primary)]">
                    {clientRateLabel(confirmClient, d, intl)}
                  </span>
                  <span className="text-[20px] font-semibold text-[var(--accent-gold-strong)] tabular-nums">
                    {money(confirmClient.amount, intl, confirmClient.currency)}
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-2.5 rounded-xl border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/10 p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-[var(--warning-orange)]"
                  aria-hidden
                />
                <p>
                  {confirmClient.amount === 0
                    ? d.adminBilling.confirmWaiveWarning
                    : d.adminBilling.confirmWarning}
                </p>
              </div>

              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-[var(--border-subtle)] p-3 transition-smooth hover:border-[var(--border-strong)]">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(checked) => setConfirmed(checked === true)}
                  className="mt-0.5"
                  aria-label={
                    confirmClient.amount === 0
                      ? d.adminBilling.confirmWaiveCheckbox
                      : d.adminBilling.confirmCheckbox
                  }
                />
                <span className="text-[12.5px] leading-relaxed text-[var(--text-primary)]">
                  {confirmClient.amount === 0
                    ? d.adminBilling.confirmWaiveCheckbox
                    : d.adminBilling.confirmCheckbox}
                </span>
              </label>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={Boolean(issuingId)}
              onClick={() => {
                setConfirmClient(null);
                setConfirmed(false);
                setModalError(null);
              }}
            >
              {d.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={Boolean(issuingId)}
              disabled={!confirmed || !confirmClient?.canIssue}
              onClick={issueInvoice}
            >
              <FileCheck2 />
              {issuingId
                ? d.adminBilling.issuing
                : confirmClient?.amount === 0
                  ? d.adminBilling.confirmWaive
                  : d.adminBilling.confirmIssue}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
