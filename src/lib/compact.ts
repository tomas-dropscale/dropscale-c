/**
 * Compact-number tiers, owned by us rather than by Intl.
 *
 * `Intl.NumberFormat(…, { notation: "compact" })` takes its suffix from the
 * runtime's CLDR data, and that data is not stable across runtimes: CLDR 42
 * changed en-GB from "39.7K" to "39.7k". Node ships one ICU version, the
 * user's browser another, so the same locale and the same number render
 * differently on the server and on the client — which React reports as a
 * hydration mismatch on every page showing a compact figure.
 *
 * Splitting the number ourselves and letting Intl format only the mantissa
 * removes that dependency: plain decimal formatting (separators, rounding)
 * has not drifted between ICU versions, only the compact suffixes have.
 */

const TIERS = [
  { limit: 1e9, suffix: "B" },
  { limit: 1e6, suffix: "M" },
  { limit: 1e3, suffix: "K" },
] as const;

/** 39_700 → { value: 39.7, suffix: "K" }; 840 → { value: 840, suffix: "" }. */
export function compactParts(value: number): { value: number; suffix: string } {
  const abs = Math.abs(value);

  for (const { limit, suffix } of TIERS) {
    // The 0.9995 margin promotes numbers that only reach the next tier once
    // rounded: 999_999 would otherwise scale to 999.999 and render "1000K"
    // instead of "1M".
    if (abs >= limit * 0.9995) {
      return { value: value / limit, suffix };
    }
  }

  return { value, suffix: "" };
}

const NUMERIC_PARTS = new Set(["integer", "group", "decimal", "fraction"]);

/**
 * Joins formatted parts with the tier suffix attached to the digits.
 *
 * Plain concatenation only works while the currency symbol leads: pt-PT and
 * fr-FR put it last, so "39,7 €" + "K" would read "39,7 €K" instead of
 * "39,7K €".
 */
export function joinWithSuffix(parts: Intl.NumberFormatPart[], suffix: string) {
  if (!suffix) return parts.map((part) => part.value).join("");

  let lastDigit = -1;
  parts.forEach((part, index) => {
    if (NUMERIC_PARTS.has(part.type)) lastDigit = index;
  });

  return parts
    .map((part, index) => (index === lastDigit ? part.value + suffix : part.value))
    .join("");
}
