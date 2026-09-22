import type { DailyMetricRow } from "@/lib/metrics/queries";
import { FX_SUPPORTED_CURRENCIES, FxError, fxDailyRates } from "@/lib/shopify/fx";

const MONEY_COLUMNS = [
  "ad_spend", "conversion_value", "revenue", "refunds_amount",
  "attributed_revenue", "product_cost", "payment_fees", "shipping_cost",
  "revenue_share_base", "revenue_share_amount",
] as const;

/** One report day's rates, shared across stores and campaigns. Never writes rollups. */
export function euroReportConverter(day: string) {
  const rates = new Map<string, Promise<number>>();

  function rate(currency: string): Promise<number> {
    const base = currency.trim().toUpperCase();
    if (base === "EUR") return Promise.resolve(1);
    if (!FX_SUPPORTED_CURRENCIES.has(base)) {
      return Promise.reject(new FxError(`Cannot price the daily report from ${base} into EUR.`));
    }
    let pending = rates.get(base);
    if (!pending) {
      pending = (async () => {
        // Include prior business days for weekends/holidays. Reject a future
        // fixing even if the provider's empty-series fallback returns one.
        const from = new Date(`${day}T12:00:00Z`);
        from.setUTCDate(from.getUTCDate() - 14);
        const pairs = await fxDailyRates(base, "EUR", from.toISOString().slice(0, 10), day);
        const prior = pairs.filter(([date]) => date <= day).sort(([a], [b]) => a.localeCompare(b));
        const value = prior.at(-1)?.[1];
        if (value === undefined || !Number.isFinite(value) || value <= 0) {
          throw new FxError(`No valid ${base}→EUR rate on or before ${day}.`);
        }
        return value;
      })();
      rates.set(base, pending);
    }
    return pending;
  }

  async function money(value: number, currency: string): Promise<number> {
    const amount = Number(value);
    if (!Number.isFinite(amount)) throw new FxError("Invalid money value in the daily report.");
    return amount * await rate(currency);
  }

  async function row(source: DailyMetricRow, currency: string): Promise<DailyMetricRow> {
    const converted = { ...source };
    const multiplier = await rate(currency);
    for (const column of MONEY_COLUMNS) {
      const value = source[column];
      if (value !== null && value !== undefined) {
        const amount = Number(value);
        if (!Number.isFinite(amount)) throw new FxError("Invalid money value in the daily report.");
        converted[column] = amount * multiplier;
      }
    }
    // Prefer original Shopify amounts: an EUR shop reporting into a USD ad
    // account must not acquire rounding differences from an EUR→USD→EUR trip.
    if (source.store_currency) {
      if (source.revenue_store != null) {
        converted.revenue = await money(source.revenue_store, source.store_currency);
      }
      if (source.refunds_store != null) {
        converted.refunds_amount = await money(source.refunds_store, source.store_currency);
      }
      if (source.attributed_revenue_store != null && source.attributed_revenue !== null) {
        converted.attributed_revenue = await money(source.attributed_revenue_store, source.store_currency);
      }
    }
    return converted;
  }

  return { money, row };
}
