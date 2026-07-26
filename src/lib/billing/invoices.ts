/**
 * Weekly client invoicing.
 *
 * Every Monday each client owes the agency commission booked against their ad
 * accounts for the week that just closed (Monday→Sunday). This module turns
 * that ledger into invoice rows and, when Stripe is configured, into real
 * Stripe invoices with a payable link.
 *
 * There is no cron on this stack, so generation is LAZY — it runs when someone
 * opens a page that shows invoices, exactly like the commission ledger and the
 * daily metrics before it. That makes idempotency the whole design: the
 * (client_id, period_start) unique index means a duplicate attempt loses
 * harmlessly, and every Stripe call carries an Idempotency-Key derived from
 * our own invoice id, so a retry can never bill a client twice.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  createAndFinalizeInvoice,
  createCustomer,
  customerHasCard,
  getInvoice,
  stripeConfigured,
  StripeError,
} from "@/lib/stripe/client";
import type { AdAccount, Database, Invoice, InvoiceLine } from "@/lib/supabase/types";

type Supabase = SupabaseClient<Database>;

/** How long a client has to pay before an invoice counts as late. */
export const DAYS_UNTIL_DUE = 7;

/** How many closed weeks back the generator will heal on a run. */
const BACKFILL_WEEKS = 8;

const THROTTLE_MS = 15 * 60 * 1000;
let lastRunAt = 0;

// ---------------------------------------------------------------------------
// Week maths — Monday is day 1
// ---------------------------------------------------------------------------

function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return isoDay(date);
}

/** The Monday of the week `date` falls in. */
export function mondayOf(date: Date): string {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (copy.getDay() + 6) % 7; // 0 = Monday
  copy.setDate(copy.getDate() - weekday);
  return isoDay(copy);
}

/**
 * The billable weeks: every Monday→Sunday that has fully CLOSED, newest first.
 * The current week is never invoiced — it isn't over, and commission for it is
 * still moving.
 */
export function closedWeeks(now = new Date(), count = BACKFILL_WEEKS): { start: string; end: string }[] {
  const thisMonday = mondayOf(now);
  return Array.from({ length: count }, (_, index) => {
    const start = addDays(thisMonday, -7 * (index + 1));
    return { start, end: addDays(start, 6) };
  });
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

type ClientWeek = { clientId: string; amount: number; lines: InvoiceLine[] };

/** What each client owes for one closed week, from the commission ledger. */
async function billableForWeek(
  supabase: Supabase,
  week: { start: string; end: string },
): Promise<ClientWeek[]> {
  // Admin-owned stores are internal: the agency doesn't invoice itself.
  const { data: adminRows } = await supabase.from("profiles").select("id").eq("role", "admin");
  const adminIds = new Set((adminRows ?? []).map((row) => row.id));

  const { data: accountRows } = await supabase
    .from("ad_accounts")
    .select("id, client_id, store_name");
  const accounts = ((accountRows ?? []) as unknown as Pick<
    AdAccount,
    "id" | "client_id" | "store_name"
  >[]).filter((account) => !adminIds.has(account.client_id));
  if (accounts.length === 0) return [];

  const accountById = new Map(accounts.map((account) => [account.id, account]));

  // Only rows tied to a store are client-billable. Supplier commission (HST)
  // carries no ad_account_id and is the agency's own income — never a client's
  // bill.
  const { data: commissionRows } = await supabase
    .from("commissions")
    .select("ad_account_id, amount")
    .gte("occurred_on", week.start)
    .lte("occurred_on", week.end)
    .not("ad_account_id", "is", null);

  const byClient = new Map<string, Map<string, number>>();
  for (const row of commissionRows ?? []) {
    const account = row.ad_account_id ? accountById.get(row.ad_account_id) : undefined;
    if (!account) continue;
    const perStore = byClient.get(account.client_id) ?? new Map<string, number>();
    perStore.set(account.id, (perStore.get(account.id) ?? 0) + Number(row.amount));
    byClient.set(account.client_id, perStore);
  }

  const result: ClientWeek[] = [];
  for (const [clientId, perStore] of byClient) {
    const lines: InvoiceLine[] = [...perStore.entries()]
      // Sub-cent lines would finalise at zero in Stripe and read as noise.
      .filter(([, amount]) => amount >= 0.01)
      .map(([accountId, amount]) => ({
        accountId,
        label: `${accountById.get(accountId)?.store_name ?? "Store"} — management commission`,
        amount: Math.round(amount * 100) / 100,
      }));
    const amount = lines.reduce((sum, line) => sum + line.amount, 0);
    if (amount >= 1) result.push({ clientId, amount, lines }); // never invoice loose change
  }
  return result;
}

/** Create the Stripe invoice for a row we've already stored, and link it back. */
async function pushToStripe(supabase: Supabase, invoice: Invoice): Promise<Invoice> {
  const { data: client } = await supabase
    .from("portal_clients")
    .select("id, full_name, email, stripe_customer_id")
    .eq("id", invoice.client_id)
    .maybeSingle();
  if (!client) return invoice;

  let customerId = client.stripe_customer_id;
  if (!customerId) {
    customerId = await createCustomer({
      email: client.email,
      name: client.full_name,
      clientId: client.id,
    });
    await supabase
      .from("portal_clients")
      .update({ stripe_customer_id: customerId })
      .eq("id", client.id);
  }

  // A saved card means the week settles itself; without one the invoice goes
  // out with a due date and a payable link.
  const autoCharge = await customerHasCard(customerId);

  const stripeInvoice = await createAndFinalizeInvoice({
    customerId,
    currency: invoice.currency,
    lines: invoice.line_items,
    daysUntilDue: DAYS_UNTIL_DUE,
    description: `Dropscale — week of ${invoice.period_start}`,
    invoiceId: invoice.id,
    autoCharge,
  });

  const { data: updated } = await supabase
    .from("invoices")
    .update({
      status: stripeInvoice.status === "paid" ? "paid" : "open",
      stripe_invoice_id: stripeInvoice.id,
      stripe_hosted_url: stripeInvoice.hosted_invoice_url,
      due_date: stripeInvoice.due_date
        ? isoDay(new Date(stripeInvoice.due_date * 1000))
        : addDays(invoice.period_end, DAYS_UNTIL_DUE),
      issued_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoice.id)
    .select("*")
    .maybeSingle();

  return (updated as Invoice | null) ?? invoice;
}

export type GenerateResult = {
  created: number;
  pushed: number;
  errors: string[];
};

/**
 * Make sure every closed week has an invoice for every client that owed
 * something. Safe to call on any page load: throttled per isolate, and every
 * write is idempotent.
 */
export async function ensureWeeklyInvoices(opts?: { force?: boolean }): Promise<GenerateResult> {
  const result: GenerateResult = { created: 0, pushed: 0, errors: [] };
  if (!opts?.force && Date.now() - lastRunAt < THROTTLE_MS) return result;
  lastRunAt = Date.now();

  const supabase = await createClient();

  // Which weeks already have rows — one query, so a warm system does almost
  // no work at all.
  const weeks = closedWeeks();
  const { data: existingRows, error: existingError } = await supabase
    .from("invoices")
    .select("id, client_id, period_start, status, stripe_invoice_id")
    .gte("period_start", weeks[weeks.length - 1].start);

  if (existingError) {
    // Table missing (migration not run) must not take a dashboard down.
    result.errors.push(existingError.message);
    return result;
  }

  const seen = new Set((existingRows ?? []).map((row) => `${row.client_id}|${row.period_start}`));

  for (const week of weeks) {
    const billable = await billableForWeek(supabase, week);

    for (const entry of billable) {
      if (seen.has(`${entry.clientId}|${week.start}`)) continue;

      const { data: inserted, error } = await supabase
        .from("invoices")
        .insert({
          client_id: entry.clientId,
          period_start: week.start,
          period_end: week.end,
          amount: entry.amount,
          line_items: entry.lines,
          due_date: addDays(week.end, DAYS_UNTIL_DUE),
        })
        .select("*")
        .maybeSingle();

      if (error) {
        // A concurrent generator won the unique index — that's success.
        if (!error.message.includes("duplicate key")) result.errors.push(error.message);
        continue;
      }
      result.created += 1;

      if (inserted && stripeConfigured()) {
        try {
          await pushToStripe(supabase, inserted as Invoice);
          result.pushed += 1;
        } catch (stripeError) {
          // The row survives as a draft and the next run retries it; the
          // Idempotency-Key makes that safe.
          result.errors.push(
            stripeError instanceof StripeError
              ? `Stripe: ${stripeError.message}`
              : "Stripe call failed.",
          );
        }
      }
    }
  }

  // Drafts left behind by an earlier Stripe outage — pick them up.
  const stale = (existingRows ?? []).filter(
    (row) => row.status === "draft" && !row.stripe_invoice_id,
  );
  if (stripeConfigured() && stale.length > 0) {
    const { data: rows } = await supabase
      .from("invoices")
      .select("*")
      .in("id", stale.map((row) => row.id));
    for (const row of (rows ?? []) as Invoice[]) {
      try {
        await pushToStripe(supabase, row);
        result.pushed += 1;
      } catch {
        // Still down; try again next time.
      }
    }
  }

  return result;
}

/**
 * Pull payment state back from Stripe for invoices still outstanding.
 *
 * The webhook is the fast path, but it needs a service-role key and a public
 * URL — neither of which exists in local dev. This is the safety net: whenever
 * someone opens a billing page, ask Stripe about the invoices we think are
 * unpaid. Same lazy-and-throttled shape as every other sync here, and it means
 * the feature is fully usable with nothing but STRIPE_SECRET_KEY.
 */
export async function reconcileInvoices(): Promise<void> {
  if (!stripeConfigured()) return;

  const supabase = await createClient();
  const { data } = await supabase
    .from("invoices")
    .select("id, stripe_invoice_id, status")
    .in("status", ["open", "draft"])
    .not("stripe_invoice_id", "is", null)
    .limit(50);

  for (const row of data ?? []) {
    if (!row.stripe_invoice_id) continue;
    try {
      const remote = await getInvoice(row.stripe_invoice_id);
      const status =
        remote.status === "paid"
          ? "paid"
          : remote.status === "void"
            ? "void"
            : remote.status === "uncollectible"
              ? "uncollectible"
              : "open";
      if (status === row.status) continue;

      await supabase
        .from("invoices")
        .update({
          status,
          stripe_hosted_url: remote.hosted_invoice_url,
          ...(status === "paid" ? { paid_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    } catch {
      // Stripe unreachable — the row keeps its last known state.
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** An invoice is late when it's payable, past due, and still unpaid. */
export function isOverdue(invoice: Pick<Invoice, "status" | "due_date">, today = isoDay(new Date())) {
  return invoice.status === "open" && Boolean(invoice.due_date) && invoice.due_date! < today;
}

export async function fetchClientInvoices(clientId: string): Promise<Invoice[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("invoices")
    .select("*")
    .eq("client_id", clientId)
    .order("period_start", { ascending: false });
  return (data as Invoice[] | null) ?? [];
}

export type ClientBillingSummary = {
  clientId: string;
  overdue: number;
  overdueAmount: number;
  open: number;
  openAmount: number;
};

/** Per-client billing state for the admin clients tab. */
export async function fetchBillingSummaries(): Promise<Map<string, ClientBillingSummary>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("invoices")
    .select("client_id, amount, status, due_date")
    .in("status", ["open"]);

  const today = isoDay(new Date());
  const byClient = new Map<string, ClientBillingSummary>();

  for (const row of data ?? []) {
    const summary = byClient.get(row.client_id) ?? {
      clientId: row.client_id,
      overdue: 0,
      overdueAmount: 0,
      open: 0,
      openAmount: 0,
    };
    summary.open += 1;
    summary.openAmount += Number(row.amount);
    if (isOverdue(row, today)) {
      summary.overdue += 1;
      summary.overdueAmount += Number(row.amount);
    }
    byClient.set(row.client_id, summary);
  }

  return byClient;
}
