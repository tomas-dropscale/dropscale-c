export const TARGET_STRIPE_WEBHOOK_API_VERSION = "2026-02-25.clover";
export const STRIPE_WEBHOOK_VERSION_QUERY = "stripe_api_version";

export type StripeWebhookSecretSelection =
  | { endpoint: "current" | "target"; secret: string | null }
  | { endpoint: "unknown"; secret: null };

type StripeWebhookSecrets = {
  current?: string;
  target?: string;
};

/**
 * Select the signing secret for a controlled two-endpoint Stripe migration.
 *
 * The existing endpoint has no marker and keeps its existing secret. The new
 * endpoint carries the target API version in its URL and has an independent
 * signing secret. Unknown markers fail closed instead of falling back to the
 * current endpoint's secret.
 */
export function stripeWebhookSecretSelection(
  requestUrl: string,
  secrets: StripeWebhookSecrets,
): StripeWebhookSecretSelection {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { endpoint: "unknown", secret: null };
  }

  const versions = url.searchParams.getAll(STRIPE_WEBHOOK_VERSION_QUERY);
  if (versions.length === 0) {
    return {
      endpoint: "current",
      secret: secrets.current?.trim() || null,
    };
  }
  if (
    versions.length !== 1 ||
    versions[0] !== TARGET_STRIPE_WEBHOOK_API_VERSION
  ) {
    return { endpoint: "unknown", secret: null };
  }
  return {
    endpoint: "target",
    secret: secrets.target?.trim() || null,
  };
}
