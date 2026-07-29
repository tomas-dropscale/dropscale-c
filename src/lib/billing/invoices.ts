/**
 * Weekly client invoicing.
 *
 * Every Monday a client is billed for the week that just closed (Monday→Sunday):
 *
 *   1. the GOOGLE ADS SPEND the agency fronted on their behalf, at cost, and
 *   2. the management FEE on that spend (each account's commission_rate), and
 *   3. the REVENUE SHARE, for accounts that have it switched on.
 *
 * All three already exist in the `commissions` ledger, booked daily by
 * lib/admin/commission-sync. The ad-spend rows carry the spend in
 * `gross_amount` and the fee in `amount`; the rev-share rows carry revenue in
 * `gross_amount` and the agency's cut in `amount`. This module aggregates a
 * week of that into one invoice per client and, when Stripe is configured,
 * into a real Stripe invoice that a saved card settles on its own.
 *
 * Generation runs from two places, and both must be safe to repeat:
 *   - the Monday Cloudflare cron trigger (custom-worker.ts → /api/billing/cron)
 *   - lazily, on any page that shows invoices, as the fallback for a missed run
 *
 * So idempotency is the whole design: the (client_id, period_start) unique
 * index means a duplicate attempt loses harmlessly, and every Stripe call
 * carries an Idempotency-Key derived from our own invoice id — a retry can
 * never bill a client twice.
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
import {
  addDays,
  billingCurrency,
  closedWeeks,
  DAYS_UNTIL_DUE,
  isAutoBillable,
  emptyTotals,
  isoDay,
  round2,
  storeLines,
  type StoreTotals,
} from "@/lib/billing/weekly";

type Supabase = SupabaseClient<Database>;

const THROTTLE_MS = 15 * 60 * 1000;
let lastRunAt = 0;

// Re-exported so callers keep importing billing from one place.
export { closedWeeks, mondayOf, DAYS_UNTIL_DUE } from "@/lib/billing/weekly";

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

type ClientWeek = {
  clientId: string;
  amount: number;
  currency: string;
  lines: InvoiceLine[];
};

/** The two ledger sources that are client-billable, seeded by 0007 and 0010. */
const SPEND_SOURCE = "Google Ads Management";
const REV_SHARE_SOURCE = "Revenue Share";

/**
 * The shared context a run needs: which stores are billable, and which ledger
 * source id means what.
 *
 * Resolved ONCE per run rather than per week. Not just for the round trips —
 * `spendSourceId` being null would make every commission row unrecognised and
 * quietly bill nobody, so the caller has to be able to see that and say so.
 */
type BillingContext = {
  accountById: Map<string, Pick<AdAccount, "id" | "client_id" | "store_name">>;
  spendSourceId: string | null;
  revShareSourceId: string | null;
};

async function loadBillingContext(supabase: Supabase): Promise<BillingContext> {
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

  // Which source a row came from decides what it MEANS: ad-spend rows carry the
  // spend to re-bill, rev-share rows carry revenue we take a cut of. Reading
  // `amount` off both without distinguishing them is how you bill revenue as
  // if it were ad spend.
  const { data: sourceRows } = await supabase
    .from("revenue_sources")
    .select("id, name")
    .in("name", [SPEND_SOURCE, REV_SHARE_SOURCE]);

  return {
    accountById: new Map(accounts.map((account) => [account.id, account])),
    spendSourceId: (sourceRows ?? []).find((row) => row.name === SPEND_SOURCE)?.id ?? null,
    revShareSourceId: (sourceRows ?? []).find((row) => row.name === REV_SHARE_SOURCE)?.id ?? null,
  };
}

/**
 * What each client owes for one closed week, from the commission ledger.
 *
 * Three lines per store at most — spend, fee, rev share — so an invoice reads
 * as "here is what went to Google, here is what went to us". Rates are blended
 * over the week (fee ÷ spend), which is exactly the rate the client was charged
 * even if the agency changed commission_rate mid-week.
 */
async function billableForWeek(
  supabase: Supabase,
  week: { start: string; end: string },
  { accountById, spendSourceId, revShareSourceId }: BillingContext,
): Promise<ClientWeek[]> {
  if (accountById.size === 0) return [];

  // Only rows tied to a store are client-billable. Supplier commission (HST)
  // carries no ad_account_id and is the agency's own income — never a client's
  // bill.
  const { data: commissionRows } = await supabase
    .from("commissions")
    .select("ad_account_id, source_id, gross_amount, amount, currency")
    .gte("occurred_on", week.start)
    .lte("occurred_on", week.end)
    .not("ad_account_id", "is", null);

  const byClient = new Map<string, Map<string, StoreTotals>>();
  for (const row of commissionRows ?? []) {
    const account = row.ad_account_id ? accountById.get(row.ad_account_id) : undefined;
    if (!account) continue;

    // A row from a source we don't recognise (a hand-made source pointed at a
    // store) is not something we know how to explain on an invoice.
    const isSpend = row.source_id === spendSourceId;
    const isRevShare = row.source_id === revShareSourceId;
    if (!isSpend && !isRevShare) continue;

    const perStore = byClient.get(account.client_id) ?? new Map<string, StoreTotals>();
    const totals = perStore.get(account.id) ?? emptyTotals();

    if (isSpend) {
      totals.spend += Number(row.gross_amount);
      totals.fee += Number(row.amount);
    } else {
      totals.revShareBase += Number(row.gross_amount);
      totals.revShare += Number(row.amount);
    }
    totals.currency ??= row.currency;

    perStore.set(account.id, totals);
    byClient.set(account.client_id, perStore);
  }

  const result: ClientWeek[] = [];
  for (const [clientId, perStore] of byClient) {
    const lines: InvoiceLine[] = [];
    const currencies = new Set<string>();

    for (const [accountId, totals] of perStore) {
      const store = accountById.get(accountId)?.store_name ?? "Store";
      if (totals.currency) currencies.add(totals.currency.toUpperCase());
      lines.push(...storeLines(accountId, store, totals));
    }

    const amount = round2(lines.reduce((sum, line) => sum + line.amount, 0));
    if (amount < 1) continue; // never invoice loose change

    result.push({ clientId, amount, currency: billingCurrency(currencies), lines });
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
    description: `Dropscale — ad spend and management, week of ${invoice.period_start} to ${invoice.period_end}`,
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
  /** Rows created for weeks too old to bill without being asked. */
  heldBack: number;
  errors: string[];
};

/**
 * Make sure every closed week has an invoice for every client that owed
 * something. Safe to call on any page load: throttled per isolate, and every
 * write is idempotent.
 *
 * `client` overrides who does the work. It matters, because the ledger this
 * reads (`commissions`) and the table it writes (`invoices`) are both
 * admin-only under RLS: on an admin page the viewer's own session is enough,
 * but the Monday cron arrives with no session and must pass the service-role
 * client. Called from a CLIENT's session it is a deliberate no-op — RLS refuses
 * the read, the error is collected, and nothing is billed from a browser.
 */
export async function ensureWeeklyInvoices(opts?: {
  force?: boolean;
  client?: Supabase;
  /**
   * Also send weeks older than AUTO_BILL_WEEKS. An admin asking for it in so
   * many words is the only thing that releases back-invoices.
   */
  billBacklog?: boolean;
}): Promise<GenerateResult> {
  const result: GenerateResult = { created: 0, pushed: 0, heldBack: 0, errors: [] };
  if (!opts?.force && Date.now() - lastRunAt < THROTTLE_MS) return result;
  lastRunAt = Date.now();

  const supabase = opts?.client ?? (await createClient());

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

  const context = await loadBillingContext(supabase);

  // Without the ad-spend source there is nothing to recognise a commission row
  // by, so the run would bill nobody and report success. Say so instead.
  if (!context.spendSourceId) {
    result.errors.push(
      `Revenue source "${SPEND_SOURCE}" is missing — run migration 0007. Nothing was billed.`,
    );
    return result;
  }

  for (const [weekIndex, week] of weeks.entries()) {
    // Old weeks are recorded but not sent. See AUTO_BILL_WEEKS.
    const mayBill = opts?.billBacklog || isAutoBillable(weekIndex);
    const billable = await billableForWeek(supabase, week, context);

    for (const entry of billable) {
      if (seen.has(`${entry.clientId}|${week.start}`)) continue;

      const { data: inserted, error } = await supabase
        .from("invoices")
        .insert({
          client_id: entry.clientId,
          period_start: week.start,
          period_end: week.end,
          amount: entry.amount,
          currency: entry.currency,
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

      if (!mayBill) {
        result.heldBack += 1;
        continue;
      }

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

  // Drafts left behind by an earlier Stripe outage — pick them up. Held-back
  // backlog rows are drafts too, so this is bounded by the same window;
  // otherwise the next run would send exactly what we just declined to send.
  const billableStarts = new Set(
    weeks.filter((_, index) => opts?.billBacklog || isAutoBillable(index)).map((w) => w.start),
  );
  const stale = (existingRows ?? []).filter(
    (row) =>
      row.status === "draft" && !row.stripe_invoice_id && billableStarts.has(row.period_start),
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
 * URL — neither of which exists in local dev. This is the safety net: ask
 * Stripe about the invoices we think are unpaid. It writes `invoices`, so like
 * the generator it needs admin rights — an admin page load or the cron's
 * service-role client. With nothing but STRIPE_SECRET_KEY set, this alone keeps
 * payment state honest.
 */
export async function reconcileInvoices(client?: Supabase): Promise<void> {
  if (!stripeConfigured()) return;

  const supabase = client ?? (await createClient());
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
