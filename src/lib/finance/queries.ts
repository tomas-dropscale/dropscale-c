import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CrmClient,
  Commission,
  Database,
  Expense,
  RevenueSource,
} from "@/lib/supabase/types";

type SupabaseAny = SupabaseClient<Database>;

export type FinanceSnapshot = {
  sources: RevenueSource[];
  clients: CrmClient[];
  commissions: Commission[];
  expenses: Expense[];
  /** Inclusive ISO date bounds the rows were fetched for. */
  from: string;
  to: string;
};

/** YYYY-MM-DD in local time — avoids toISOString() shifting the day backwards. */
export function isoDay(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return isoDay(date);
}

export function startOfMonth() {
  const date = new Date();
  return isoDay(new Date(date.getFullYear(), date.getMonth(), 1));
}

/**
 * Loads everything the finance pages need for a date window in one round trip.
 *
 * Aggregation happens in the app rather than in SQL views: the volumes here are
 * an agency's own transactions, not analytics scale, and keeping the maths in
 * TypeScript means the same numbers can be recomputed for any grouping without
 * another migration.
 */
export async function fetchFinanceSnapshot(
  supabase: SupabaseAny,
  from: string,
  to: string,
): Promise<FinanceSnapshot> {
  const [sources, clients, commissions, expenses] = await Promise.all([
    supabase.from("revenue_sources").select("*").order("name"),
    supabase.from("clients").select("*").order("name"),
    supabase
      .from("commissions")
      .select("*")
      .gte("occurred_on", from)
      .lte("occurred_on", to)
      .order("occurred_on", { ascending: false }),
    supabase
      .from("expenses")
      .select("*")
      .gte("incurred_on", from)
      .lte("incurred_on", to)
      .order("incurred_on", { ascending: false }),
  ]);

  return {
    sources: sources.data ?? [],
    clients: clients.data ?? [],
    commissions: commissions.data ?? [],
    expenses: expenses.data ?? [],
    from,
    to,
  };
}

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

export type SourceTotal = {
  source: RevenueSource;
  amount: number;
  gross: number;
  count: number;
  /** Share of total revenue, 0–1. */
  share: number;
};

/** Revenue grouped by partner — answers "where does the money come from". */
export function revenueBySource(
  commissions: Commission[],
  sources: RevenueSource[],
): SourceTotal[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const totals = new Map<string, { amount: number; gross: number; count: number }>();

  for (const entry of commissions) {
    const bucket = totals.get(entry.source_id) ?? { amount: 0, gross: 0, count: 0 };
    bucket.amount += Number(entry.amount);
    bucket.gross += Number(entry.gross_amount);
    bucket.count += 1;
    totals.set(entry.source_id, bucket);
  }

  const total = [...totals.values()].reduce((sum, bucket) => sum + bucket.amount, 0);

  return [...totals.entries()]
    .flatMap(([sourceId, bucket]) => {
      const source = byId.get(sourceId);
      if (!source) return [];
      return [{ source, ...bucket, share: total > 0 ? bucket.amount / total : 0 }];
    })
    .sort((a, b) => b.amount - a.amount);
}

export type ExpenseTotal = {
  category: Expense["category"];
  amount: number;
  count: number;
  share: number;
};

export function expensesByCategory(expenses: Expense[]): ExpenseTotal[] {
  const totals = new Map<Expense["category"], { amount: number; count: number }>();

  for (const entry of expenses) {
    const bucket = totals.get(entry.category) ?? { amount: 0, count: 0 };
    bucket.amount += Number(entry.amount);
    bucket.count += 1;
    totals.set(entry.category, bucket);
  }

  const total = [...totals.values()].reduce((sum, bucket) => sum + bucket.amount, 0);

  return [...totals.entries()]
    .map(([category, bucket]) => ({
      category,
      ...bucket,
      share: total > 0 ? bucket.amount / total : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

export type DailyPnL = {
  day: string;
  revenue: number;
  expenses: number;
  profit: number;
};

/**
 * One row per day across the whole window, including days with no movement —
 * gaps in a P&L chart read as missing data rather than as a quiet day.
 */
export function dailyPnL(
  commissions: Commission[],
  expenses: Expense[],
  from: string,
  to: string,
): DailyPnL[] {
  const revenueByDay = new Map<string, number>();
  const expenseByDay = new Map<string, number>();

  for (const entry of commissions) {
    revenueByDay.set(
      entry.occurred_on,
      (revenueByDay.get(entry.occurred_on) ?? 0) + Number(entry.amount),
    );
  }
  for (const entry of expenses) {
    expenseByDay.set(
      entry.incurred_on,
      (expenseByDay.get(entry.incurred_on) ?? 0) + Number(entry.amount),
    );
  }

  const days: DailyPnL[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);

  while (cursor <= end) {
    const day = isoDay(cursor);
    const revenue = revenueByDay.get(day) ?? 0;
    const expense = expenseByDay.get(day) ?? 0;
    days.push({ day, revenue, expenses: expense, profit: revenue - expense });
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

export function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export type Totals = { revenue: number; expenses: number; profit: number; margin: number };

export function totals(commissions: Commission[], expenses: Expense[]): Totals {
  const revenue = sum(commissions.map((entry) => Number(entry.amount)));
  const spent = sum(expenses.map((entry) => Number(entry.amount)));
  const profit = revenue - spent;

  return {
    revenue,
    expenses: spent,
    profit,
    margin: revenue > 0 ? profit / revenue : 0,
  };
}
