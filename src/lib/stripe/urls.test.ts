import { describe, expect, it } from "vitest";

import { safeStripeUrl } from "./urls";

describe("safeStripeUrl", () => {
  it("accepts canonical Stripe hosted-invoice and PDF URLs", () => {
    expect(
      safeStripeUrl("https://invoice.stripe.com/i/acct_123/test_abc"),
    ).toBe("https://invoice.stripe.com/i/acct_123/test_abc");
    expect(
      safeStripeUrl(
        "https://pay.stripe.com/invoice/acct_123/test_abc/pdf?s=ap",
      ),
    ).toBe("https://pay.stripe.com/invoice/acct_123/test_abc/pdf?s=ap");
    expect(safeStripeUrl("  https://stripe.com/invoice/123  ")).toBe(
      "https://stripe.com/invoice/123",
    );
  });

  it.each([
    null,
    undefined,
    "",
    "not-a-url",
    "/relative/invoice",
    "http://invoice.stripe.com/i/acct_123/test_abc",
    "https://stripe.com.evil.example/invoice/123",
    "https://evilstripe.com/invoice/123",
    "https://user@invoice.stripe.com/invoice/123",
    "https://user:password@invoice.stripe.com/invoice/123",
    "https://invoice.stripe.com:444/invoice/123",
  ])("rejects a non-Stripe or non-canonical external URL: %s", (value) => {
    expect(safeStripeUrl(value)).toBeNull();
  });
});
