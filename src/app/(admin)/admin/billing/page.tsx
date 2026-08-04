import type { Metadata } from "next";
import { AlertTriangle, RotateCcw } from "lucide-react";

import { LegacyBillingAdminView } from "@/components/admin/legacy-billing-admin-view";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import {
  normaliseLegacyInvoice,
  summariseLegacyInvoices,
  type LegacyClientIdentity,
} from "@/lib/billing/legacy-admin";
import { getServerDictionary } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import type { Invoice } from "@/lib/supabase/types";

const DATABASE_PAGE_SIZE = 500;
const CLIENT_LOOKUP_CHUNK = 50;
const INVOICE_COLUMNS =
  "id, client_id, period_start, period_end, amount, currency, status, due_date, line_items, stripe_invoice_id, stripe_hosted_url, issued_at, paid_at, payment_failed_at, created_at, updated_at";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.nav.billing };
}

/**
 * PostgREST installations commonly cap a response at 1,000 rows. Fetch in
 * explicit ranges so the totals and the searchable history cannot quietly
 * become a subset once the agency has more than a year of weekly invoices.
 */
async function fetchAllLegacyInvoices(
  supabase: Supabase,
): Promise<{ data: Invoice[]; error: string | null }> {
  const invoices: Invoice[] = [];
  let expectedCount: number | null = null;
  let from = 0;

  while (true) {
    const { data, error, count } = await supabase
      .from("invoices")
      .select(INVOICE_COLUMNS, from === 0 ? { count: "exact" } : {})
      .order("period_start", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + DATABASE_PAGE_SIZE - 1);

    if (error) return { data: [], error: error.message };

    const page: Invoice[] = data ?? [];
    if (from === 0) expectedCount = count;
    invoices.push(...page);

    if (expectedCount !== null && invoices.length >= expectedCount) break;
    if (page.length < DATABASE_PAGE_SIZE) {
      if (expectedCount !== null && invoices.length < expectedCount) {
        return {
          data: [],
          error: `Expected ${expectedCount} invoices but loaded ${invoices.length}.`,
        };
      }
      break;
    }

    from += DATABASE_PAGE_SIZE;
  }

  const unique = [...new Map(invoices.map((invoice) => [invoice.id, invoice])).values()];
  if (expectedCount !== null && unique.length !== expectedCount) {
    return {
      data: [],
      error: `Invoice history changed while loading (${unique.length}/${expectedCount} unique rows).`,
    };
  }

  return { data: unique, error: null };
}

async function fetchClientIdentities(
  supabase: Supabase,
  clientIds: string[],
): Promise<{
  data: LegacyClientIdentity[];
  billingNames: Map<string, string>;
  warning: string | null;
}> {
  if (clientIds.length === 0) {
    return { data: [], billingNames: new Map(), warning: null };
  }

  const chunks = Array.from(
    { length: Math.ceil(clientIds.length / CLIENT_LOOKUP_CHUNK) },
    (_, index) =>
      clientIds.slice(index * CLIENT_LOOKUP_CHUNK, (index + 1) * CLIENT_LOOKUP_CHUNK),
  );
  const [results, billingResults] = await Promise.all([
    Promise.all(
      chunks.map((ids) =>
        supabase.from("portal_clients").select("id, full_name, email").in("id", ids),
      ),
    ),
    Promise.all(
      chunks.map((ids) =>
        supabase
          .from("billing_profiles")
          .select("client_id, billing_name")
          .in("client_id", ids),
      ),
    ),
  ]);

  const clientErrors = results.flatMap((result) =>
    result.error ? [result.error.message] : [],
  );
  const billingErrors = billingResults.flatMap((result) =>
    result.error ? [result.error.message] : [],
  );
  const errors = [...clientErrors, ...billingErrors];
  if (errors.length > 0) {
    console.error("Legacy billing client lookup failed:", errors.join(" | "));
  }

  const billingNames = new Map<string, string>();
  for (const result of billingResults) {
    for (const row of result.data ?? []) {
      if (row.billing_name?.trim()) billingNames.set(row.client_id, row.billing_name.trim());
    }
  }

  const warnings = [
    clientErrors.length > 0
      ? "Some client names could not be read; those invoices show their client ID."
      : null,
    billingErrors.length > 0
      ? "Current billing names could not be read; invoice rows still show portal identities."
      : null,
  ].filter((value): value is string => Boolean(value));

  return {
    data: results.flatMap((result) => (result.data ?? []) as LegacyClientIdentity[]),
    billingNames,
    warning: warnings.length > 0 ? `Invoices loaded. ${warnings.join(" ")}` : null,
  };
}

/** A civil date in Lisbon; UTC can be the previous day around local midnight. */
function todayInLisbon(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function BillingReadError() {
  return (
    <div
      role="alert"
      className="panel flex flex-col items-start gap-4 border-[var(--danger-red)]/35 bg-[var(--danger-red)]/10 p-5 sm:flex-row"
    >
      <AlertTriangle className="size-5 shrink-0 text-[var(--danger-red)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
          Invoices could not be loaded
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          Supabase returned an error, so this page will not pretend the history is empty. No
          invoice or payment was changed.
        </p>
      </div>
      <Button asChild variant="secondary" size="md" className="w-full sm:w-auto">
        <a href="/admin/billing">
          <RotateCcw aria-hidden />
          Retry
        </a>
      </Button>
    </div>
  );
}

/**
 * Read-only by construction: only SELECT queries run here. Stripe, invoice
 * reconciliation and the legacy generator are deliberately not imported.
 */
export default async function LegacyBillingPage() {
  const supabase = await createClient();
  const [{ d }, invoiceResult] = await Promise.all([
    getServerDictionary(),
    fetchAllLegacyInvoices(supabase),
  ]);

  if (invoiceResult.error) {
    console.error("Legacy billing invoice read failed:", invoiceResult.error);
    return (
      <PageContainer
        title={d.nav.billing}
        description="Invoices already stored in the current Supabase schema."
      >
        <BillingReadError />
      </PageContainer>
    );
  }

  const clientIds = [...new Set(invoiceResult.data.map((invoice) => invoice.client_id))];
  const clients = await fetchClientIdentities(supabase, clientIds);
  const clientById = new Map(clients.data.map((client) => [client.id, client]));
  const today = todayInLisbon();
  const invoices = invoiceResult.data.map((invoice) =>
    normaliseLegacyInvoice(
      invoice,
      clientById.get(invoice.client_id),
      clients.billingNames.get(invoice.client_id) ?? null,
    ),
  );
  const summary = summariseLegacyInvoices(invoices, today);

  return (
    <PageContainer
      title={d.nav.billing}
      description="All invoice statuses and payment links already stored in Supabase."
    >
      <LegacyBillingAdminView
        invoices={invoices}
        summary={summary}
        today={today}
        clientWarning={clients.warning}
      />
    </PageContainer>
  );
}
