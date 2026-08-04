/**
 * Which currency a set of stores can honestly be totalled in.
 *
 * A client can hold several stores, and nothing stops two of them trading in
 * different currencies. Every page that sums across stores used to take
 * `accounts[0].currency` and print it against the sum — so a shop in EUR and a
 * shop in GBP produced a single "€" figure that is not a quantity of anything.
 * It never errored, and the number looked entirely normal.
 *
 * The rule here: one currency across the set means the totals are real. More
 * than one means they are not, and the caller has to say so rather than pick a
 * symbol. Stores with no rows contribute nothing either way.
 *
 * Pure and I/O-free so it can be unit-tested (currency.test.ts).
 */

export type CurrencyScope = {
  /** What to format totals in. The single currency, or null when mixed. */
  currency: string | null;
  /** Every distinct currency in the set, sorted — for the warning text. */
  currencies: string[];
  /** True when totals across these stores cannot be added up honestly. */
  mixed: boolean;
};

export function currencyScope(
  accounts: { currency: string | null | undefined }[],
  fallback = "EUR",
): CurrencyScope {
  const currencies = [
    ...new Set(
      accounts
        .map((account) => (account.currency ?? "").trim().toUpperCase())
        .filter((code) => code.length > 0),
    ),
  ].sort();

  // No stores, or none with a currency set: nothing to contradict, so the
  // fallback is safe. This is the empty dashboard, not a mixed one.
  if (currencies.length === 0) {
    return { currency: fallback, currencies: [], mixed: false };
  }

  if (currencies.length === 1) {
    return { currency: currencies[0], currencies, mixed: false };
  }

  return { currency: null, currencies, mixed: true };
}

/**
 * The currency to format a figure in when the scope may be mixed.
 *
 * Mixed scopes still have to render something — a dashboard cannot go blank —
 * so the first currency is used and the UI carries a warning beside it. This
 * function exists so that choice is made in ONE place and is obviously a
 * fallback, rather than being spelled `accounts[0].currency` in six files where
 * it reads like a decision someone made on purpose.
 *
 * Takes no fallback of its own: `currencyScope` has already resolved the empty
 * case, and a second default here only creates two places to disagree about
 * what "nothing set" means.
 */
export function displayCurrency(scope: CurrencyScope): string {
  return scope.currency ?? scope.currencies[0] ?? "EUR";
}
