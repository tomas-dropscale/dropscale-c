/**
 * Return a canonical Stripe-owned HTTPS URL that is safe to expose as an
 * external link. Billing rows can include legacy data, so rendering code must
 * not assume every stored URL was written by the current signed webhook.
 *
 * This module is deliberately client-safe: it contains no Stripe credentials
 * and can be imported by both portal and admin Client Components.
 */
export function safeStripeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const stripeOwnedHost =
      hostname === "stripe.com" || hostname.endsWith(".stripe.com");

    if (
      url.protocol !== "https:" ||
      !stripeOwnedHost ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}
