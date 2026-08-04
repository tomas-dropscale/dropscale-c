import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { checkStripeReadiness } from "./client";

const LIMITATIONS = [
  "stripe_write_permissions_not_verified",
  "webhook_signing_secret_match_not_verified",
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Stripe live read readiness", () => {
  it("uses only hardcoded empty GET lists and returns no response bodies", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_live_readiness");
    const before = Math.floor(Date.now() / 1_000);
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "never_returned", email: "private@example.com" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const readiness = await checkStripeReadiness();

    expect(readiness).toEqual({
      keyMode: "live",
      liveMode: true,
      permissions: {
        customersRead: true,
        invoicesRead: true,
        invoiceItemsRead: true,
      },
      limitations: LIMITATIONS,
    });
    expect(JSON.stringify(readiness)).not.toContain("never_returned");
    expect(JSON.stringify(readiness)).not.toContain("private@example.com");

    const requests = fetchMock.mock.calls.map(([input, init]) => ({
      url: new URL(String(input)),
      method: init?.method,
    }));
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/v1/customers",
      "/v1/invoices",
      "/v1/invoiceitems",
    ]);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    for (const { url } of requests) {
      expect(url.searchParams.get("limit")).toBe("1");
      expect(Number(url.searchParams.get("created[gt]"))).toBeGreaterThan(
        before + 23 * 60 * 60,
      );
    }
  });

  it.each([undefined, "", "sk_test_wrong_mode", "not-a-stripe-key"])(
    "does not contact Stripe without a live key (%s)",
    async (key) => {
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const readiness = await checkStripeReadiness();

      expect(readiness.liveMode).toBe(false);
      expect(readiness.permissions).toEqual({
        customersRead: false,
        invoicesRead: false,
        invoiceItemsRead: false,
      });
      expect(readiness.limitations).toEqual(LIMITATIONS);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("normalizes a denied resource permission without exposing Stripe's body", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_partial");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/invoices") {
        return new Response(
          JSON.stringify({
            error: {
              message: "Sensitive provider detail",
              type: "invalid_request_error",
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const readiness = await checkStripeReadiness();

    expect(readiness.permissions).toEqual({
      customersRead: true,
      invoicesRead: false,
      invoiceItemsRead: true,
    });
    expect(JSON.stringify(readiness)).not.toContain("Sensitive provider detail");
  });
});
