/**
 * Was this order referred by Meta (Instagram / Facebook)?
 *
 * Why it matters: a store's CONVERSIONS figure sits next to Google ad spend, so
 * it has to mean "orders the ads could plausibly have produced". Google's own
 * conversion count is usually 0 — conversion tracking is rarely wired up — and
 * total Shopify orders is too generous, because the same store also sells
 * through Instagram and Facebook, which Google spend had nothing to do with.
 * Subtracting the Meta-referred orders is what makes the number honest, and it
 * is exactly the rule the agency asked for.
 *
 * Three signals, because any one of them can be missing:
 *   source        Shopify's own normalised channel, e.g. "instagram".
 *   referrerUrl   the raw referring URL, e.g. https://l.instagram.com/…
 *   utmParameters what the link was tagged with, e.g. utm_source=ig
 *
 * A visit with NO usable signal counts as NOT Meta. "Unknown referrer" is not
 * evidence of Instagram, and the alternative — quietly dropping orders we
 * cannot classify — would understate conversions with no way to notice.
 *
 * Pure and I/O-free so it can be unit-tested (referrer.test.ts).
 */

/** Registrable domains Meta refers from, matched on host or any subdomain. */
const META_HOSTS = [
  "instagram.com",
  "facebook.com",
  "fb.me",
  "fb.com",
  "fbcdn.net",
  "facebook.net",
  "messenger.com",
  "threads.net",
  "threads.com",
];

/** Channel/utm values that name Meta, after lower-casing and trimming. */
const META_TOKENS = new Set([
  "instagram",
  "instagram.com",
  "ig",
  "facebook",
  "facebook.com",
  "fb",
  "meta",
  "messenger",
  "threads",
  // Shopify sometimes reports the combined paid-social channel this way.
  "instagram_facebook",
  "facebook_instagram",
]);

export type CustomerVisitLike = {
  source?: string | null;
  referrerUrl?: string | null;
  utmSource?: string | null;
};

/** Host (or a subdomain of it) belongs to Meta. */
function isMetaHost(host: string): boolean {
  const clean = host.toLowerCase().replace(/^www\./, "");
  return META_HOSTS.some((meta) => clean === meta || clean.endsWith(`.${meta}`));
}

/**
 * A single free-text signal: a bare channel name ("instagram"), or something
 * host-shaped ("l.instagram.com", "https://m.facebook.com/…").
 */
function signalIsMeta(value: string | null | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (META_TOKENS.has(raw)) return true;

  // Host-shaped: parse it, and fall back to treating the whole string as a host
  // when it has no scheme (Shopify reports `source` both ways).
  try {
    return isMetaHost(new URL(raw.includes("://") ? raw : `https://${raw}`).hostname);
  } catch {
    return isMetaHost(raw.split("/")[0]);
  }
}

/** True when any signal names Instagram, Facebook or another Meta surface. */
export function isMetaReferral(visit: CustomerVisitLike | null | undefined): boolean {
  if (!visit) return false;
  return (
    signalIsMeta(visit.source) ||
    signalIsMeta(visit.referrerUrl) ||
    signalIsMeta(visit.utmSource)
  );
}
