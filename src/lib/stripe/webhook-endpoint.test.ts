import { describe, expect, it } from "vitest";

import {
  STRIPE_WEBHOOK_VERSION_QUERY,
  TARGET_STRIPE_WEBHOOK_API_VERSION,
  stripeWebhookSecretSelection,
} from "./webhook-endpoint";

const CURRENT_SECRET = "whsec_current";
const TARGET_SECRET = "whsec_target";

function select(url: string) {
  return stripeWebhookSecretSelection(url, {
    current: CURRENT_SECRET,
    target: TARGET_SECRET,
  });
}

describe("Stripe webhook endpoint secret selection", () => {
  it("keeps the existing unmarked endpoint on its existing secret", () => {
    expect(select("https://dropscale.app/api/stripe/webhook")).toEqual({
      endpoint: "current",
      secret: CURRENT_SECRET,
    });
  });

  it("uses the independent target secret only for the exact target version", () => {
    const url = new URL("https://dropscale.app/api/stripe/webhook");
    url.searchParams.set(
      STRIPE_WEBHOOK_VERSION_QUERY,
      TARGET_STRIPE_WEBHOOK_API_VERSION,
    );

    expect(select(url.toString())).toEqual({
      endpoint: "target",
      secret: TARGET_SECRET,
    });
  });

  it("fails closed for an unknown or ambiguous version marker", () => {
    expect(
      select(
        `https://dropscale.app/api/stripe/webhook?${STRIPE_WEBHOOK_VERSION_QUERY}=future`,
      ),
    ).toEqual({ endpoint: "unknown", secret: null });
    expect(
      select(
        `https://dropscale.app/api/stripe/webhook?${STRIPE_WEBHOOK_VERSION_QUERY}=${TARGET_STRIPE_WEBHOOK_API_VERSION}&${STRIPE_WEBHOOK_VERSION_QUERY}=${TARGET_STRIPE_WEBHOOK_API_VERSION}`,
      ),
    ).toEqual({ endpoint: "unknown", secret: null });
  });

  it("reports a known endpoint with missing configuration separately", () => {
    expect(
      stripeWebhookSecretSelection(
        `https://dropscale.app/api/stripe/webhook?${STRIPE_WEBHOOK_VERSION_QUERY}=${TARGET_STRIPE_WEBHOOK_API_VERSION}`,
        { current: CURRENT_SECRET },
      ),
    ).toEqual({ endpoint: "target", secret: null });
  });
});
