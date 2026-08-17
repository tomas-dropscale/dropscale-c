import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertStripeInvoiceMatchesLocal,
  createAndFinalizeInvoice,
  createCustomer,
  getInvoice,
  parseStripeSignatureHeader,
  stripeApiKeyMode,
  stripeConfigured,
  StripeError,
  updateCustomerBilling,
  verifyWebhookSignature,
} from "./client";

function jsonResponse(
  value: unknown,
  status = 200,
  requestId = "req_test",
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "request-id": requestId },
  });
}

const INVOICE_RECIPIENT = {
  email: "billing@example.com",
  name: "Billing Entity",
  address: {
    line1: null,
    line2: null,
    city: null,
    postal_code: null,
    state: null,
    country: null,
  },
  taxId: "PT123456789",
};

const STRIPE_RECIPIENT_SNAPSHOT = {
  customer_email: INVOICE_RECIPIENT.email,
  customer_name: INVOICE_RECIPIENT.name,
  customer_address: null,
  custom_fields: [{ name: "VAT / Tax ID", value: INVOICE_RECIPIENT.taxId }],
};

const LEASE_CHECK = async () => {};

describe("Stripe webhook signatures", () => {
  it("keeps all v1 signatures during secret rotation", () => {
    expect(
      parseStripeSignatureHeader(" t=123 , v1=AAAA ,v0=old,v1=bbbb "),
    ).toEqual({
      timestamp: "123",
      signatures: ["aaaa", "bbbb"],
    });
  });

  it("accepts a valid later v1 signature", async () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const secret = "whsec_test";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    await expect(
      verifyWebhookSignature(
        payload,
        `t=${timestamp},v1=${"0".repeat(64)},v1=${signature}`,
        secret,
      ),
    ).resolves.toBe(true);
  });

  it("rejects an otherwise valid signature outside the replay window", async () => {
    const payload = "{}";
    const secret = "whsec_test";
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    await expect(
      verifyWebhookSignature(payload, `t=${timestamp},v1=${signature}`, secret),
    ).resolves.toBe(false);
  });
});

describe("Stripe invoice-to-ledger binding", () => {
  const remote = {
    id: "in_bound",
    status: "open",
    collection_method: "send_invoice",
    auto_advance: false,
    customer: "cus_bound",
    currency: "eur",
    total: 1_525,
    amount_due: 1_525,
    amount_remaining: 1_525,
    hosted_invoice_url: "https://invoice.stripe.test/in_bound",
    due_date: null,
    metadata: { dropscale_invoice_id: "local-bound" },
  };
  const expected = {
    localInvoiceId: "local-bound",
    stripeInvoiceId: "in_bound",
    customerId: "cus_bound",
    currency: "EUR",
    amount: 15.25,
    requireMetadata: true,
    requireManualCollection: true,
  };

  it("accepts only the exact Customer, currency, total, metadata and manual collection mode", () => {
    expect(() =>
      assertStripeInvoiceMatchesLocal(remote, expected),
    ).not.toThrow();
  });

  it.each([
    ["customer", { customer: "cus_other" }],
    ["currency", { currency: "usd" }],
    ["total", { total: 1_524 }],
    ["metadata", { metadata: { dropscale_invoice_id: "local-other" } }],
    ["collection method", { collection_method: "charge_automatically" }],
  ] as const)(
    "rejects a remote invoice with mismatched %s",
    (_label, override) => {
      expect(() =>
        assertStripeInvoiceMatchesLocal({ ...remote, ...override }, expected),
      ).toThrow(StripeError);
    },
  );

  it("allows missing metadata only for a legacy row already bound by Stripe id", () => {
    const legacy = {
      ...remote,
      collection_method: "charge_automatically",
      auto_advance: true,
      metadata: {},
    };
    expect(() =>
      assertStripeInvoiceMatchesLocal(legacy, {
        ...expected,
        requireMetadata: false,
        requireManualCollection: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertStripeInvoiceMatchesLocal(
        { ...legacy, metadata: { dropscale_invoice_id: "local-other" } },
        { ...expected, requireMetadata: false, requireManualCollection: false },
      ),
    ).toThrow(/metadata/i);

    expect(() =>
      assertStripeInvoiceMatchesLocal(legacy, {
        ...expected,
        stripeInvoiceId: null,
        requireMetadata: false,
        requireManualCollection: false,
      }),
    ).toThrow(/metadata/i);
  });
});

describe("Stripe finalised recipient binding", () => {
  const recipient = {
    email: "finance@example.com",
    name: "Example Commerce, Lda.",
    address: {
      line1: "Rua Um, 10",
      line2: "Sala 2",
      city: "Lisboa",
      postal_code: "1000-001",
      state: "Lisboa",
      country: "PT",
    },
    taxId: "PT123456789",
  };
  const remote = {
    id: "in_recipient",
    status: "open",
    collection_method: "send_invoice",
    auto_advance: false,
    customer: "cus_recipient",
    currency: "eur",
    total: 1_000,
    amount_due: 1_000,
    amount_remaining: 1_000,
    hosted_invoice_url: "https://invoice.stripe.test/in_recipient",
    due_date: null,
    metadata: { dropscale_invoice_id: "local-recipient" },
    customer_email: recipient.email,
    customer_name: recipient.name,
    customer_address: recipient.address,
    custom_fields: [{ name: "VAT / Tax ID", value: recipient.taxId }],
    status_transitions: { finalized_at: 1_784_678_400 },
  };
  const expected = {
    localInvoiceId: "local-recipient",
    stripeInvoiceId: "in_recipient",
    customerId: "cus_recipient",
    currency: "EUR",
    amount: 10,
    requireMetadata: true,
    requireManualCollection: true,
    recipient,
  };

  it("accepts the exact open or paid Stripe recipient snapshot", () => {
    expect(() =>
      assertStripeInvoiceMatchesLocal(remote, expected),
    ).not.toThrow();
    expect(() =>
      assertStripeInvoiceMatchesLocal(
        { ...remote, status: "paid", amount_remaining: 0 },
        expected,
      ),
    ).not.toThrow();
  });

  it("treats Stripe's cleared empty-string address as the null snapshot", () => {
    // Legacy customers created by the pre-platform integration store "" in
    // every address field; our snapshot stores null. Regression: 2026-08-17,
    // seven weekly invoices finalised on Stripe and then wedged locally as
    // draft+error because "" !== null.
    const blankRemote = {
      ...remote,
      customer_address: {
        line1: "",
        line2: "",
        city: "",
        postal_code: "",
        state: "",
        country: "",
      },
    };
    const nullExpected = {
      ...expected,
      recipient: {
        ...recipient,
        address: {
          line1: null,
          line2: null,
          city: null,
          postal_code: null,
          state: null,
          country: null,
        },
      },
    };
    expect(() =>
      assertStripeInvoiceMatchesLocal(blankRemote, nullExpected),
    ).not.toThrow();
    expect(() =>
      assertStripeInvoiceMatchesLocal(
        {
          ...blankRemote,
          customer_address: {
            ...blankRemote.customer_address,
            line1: "Rua Real 1",
          },
        },
        nullExpected,
      ),
    ).toThrow(StripeError);
  });

  it("fails closed when email, name, address or VAT identity differs", () => {
    const mismatches = [
      { ...remote, customer_email: "other@example.com" },
      { ...remote, customer_name: "Another Entity" },
      {
        ...remote,
        customer_address: {
          ...remote.customer_address,
          line1: "Different street",
        },
      },
      {
        ...remote,
        custom_fields: [{ name: "VAT / Tax ID", value: "PT000000000" }],
      },
      { ...remote, custom_fields: [] },
    ];
    for (const mismatch of mismatches) {
      expect(() => assertStripeInvoiceMatchesLocal(mismatch, expected)).toThrow(
        StripeError,
      );
    }
  });
});

describe("Stripe runtime mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("recognises secret and restricted keys in live and test mode", () => {
    expect(stripeApiKeyMode("sk_live_example")).toBe("live");
    expect(stripeApiKeyMode("rk_live_example")).toBe("live");
    expect(stripeApiKeyMode("sk_test_example")).toBe("test");
    expect(stripeApiKeyMode("rk_test_example")).toBe("test");
    expect(stripeApiKeyMode("not-a-stripe-key")).toBeNull();
  });

  it("refuses to treat a test key as configured in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_wrong_mode");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(stripeConfigured()).toBe(false);
    await expect(getInvoice("in_never_requested")).rejects.toThrow(
      /production billing requires a live Stripe API key/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("STRIPE_SECRET_KEY", "rk_live_restricted");
    expect(stripeConfigured()).toBe(true);
  });
});

describe("manual Stripe invoices", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_never_sent");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("persists an inert draft, validates exact EUR lines, finalises, then sends", async () => {
    const operations: string[] = [];
    const requests: {
      path: string;
      method: string;
      params: URLSearchParams;
    }[] = [];
    const items: Array<{
      id: string;
      amount: number;
      currency: string;
      customer: string;
      description: string;
      invoice: string;
      metadata: Record<string, string>;
    }> = [];
    let status = "draft";

    const invoice = () => {
      const total = items.reduce((sum, item) => sum + item.amount, 0);
      return {
        ...STRIPE_RECIPIENT_SNAPSHOT,
        id: "in_safe",
        status,
        collection_method: "send_invoice",
        auto_advance: false,
        customer: "cus_safe",
        currency: "eur",
        total,
        amount_due: total,
        amount_remaining: total,
        hosted_invoice_url:
          status === "draft" ? null : "https://invoice.stripe.test/in_safe",
        invoice_pdf:
          status === "draft" ? null : "https://stripe.test/in_safe.pdf",
        number: status === "draft" ? null : "DS-0001",
        due_date: 1_785_283_200,
        metadata: { dropscale_invoice_id: "local-1" },
        status_transitions: {
          finalized_at: status === "draft" ? null : 1_784_678_400,
        },
      };
    };

    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const params =
          method === "GET"
            ? url.searchParams
            : new URLSearchParams(
                typeof init?.body === "string" ? init.body : "",
              );
        requests.push({ path: url.pathname, method, params });

        if (url.pathname === "/v1/invoices" && method === "GET") {
          return jsonResponse({ data: [], has_more: false });
        }
        if (url.pathname === "/v1/invoices" && method === "POST") {
          operations.push("create-draft");
          return jsonResponse(invoice());
        }
        if (url.pathname === "/v1/invoiceitems" && method === "GET") {
          return jsonResponse({ data: items, has_more: false });
        }
        if (url.pathname === "/v1/invoiceitems" && method === "POST") {
          operations.push("create-item");
          items.push({
            id: `ii_${items.length}`,
            amount: Number(params.get("amount")),
            currency: params.get("currency")!,
            customer: params.get("customer")!,
            description: params.get("description")!,
            invoice: params.get("invoice")!,
            metadata: {
              dropscale_invoice_id: params.get(
                "metadata[dropscale_invoice_id]",
              )!,
              dropscale_line_index: params.get(
                "metadata[dropscale_line_index]",
              )!,
            },
          });
          return jsonResponse(items.at(-1));
        }
        if (url.pathname === "/v1/invoices/in_safe" && method === "GET") {
          return jsonResponse(invoice());
        }
        if (url.pathname === "/v1/invoices/in_safe/finalize") {
          operations.push("finalize");
          status = "open";
          return jsonResponse(invoice());
        }
        if (url.pathname === "/v1/invoices/in_safe/send") {
          operations.push("send");
          return jsonResponse(invoice());
        }
        throw new Error(`Unexpected Stripe request: ${method} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAndFinalizeInvoice({
      customerId: "cus_safe",
      currency: "EUR",
      invoiceId: "local-1",
      description: "Agency fee for 2026-07-20 to 2026-07-26",
      daysUntilDue: 7,
      autoCharge: false,
      recipient: INVOICE_RECIPIENT,
      assertLeaseOwnership: async () => {
        operations.push("lease-check");
      },
      lines: [
        { label: "Store A - agency fee", amount: 10 },
        { label: "Store B - agency fee", amount: 5.25 },
      ],
      onDraftCreated: async (stripeId) => {
        expect(stripeId).toBe("in_safe");
        operations.push("persist-draft");
      },
      onSent: async (sentInvoice) => {
        expect(sentInvoice.id).toBe("in_safe");
        operations.push("persist-sent");
      },
    });

    expect(operations).toEqual([
      "lease-check",
      "create-draft",
      "lease-check",
      "persist-draft",
      "lease-check",
      "create-item",
      "lease-check",
      "lease-check",
      "create-item",
      "lease-check",
      "lease-check",
      "finalize",
      "lease-check",
      "lease-check",
      "send",
      "persist-sent",
      "lease-check",
    ]);
    expect(result).toMatchObject({
      id: "in_safe",
      status: "open",
      number: "DS-0001",
      amount_due: 1_525,
      amount_remaining: 1_525,
    });

    const create = requests.find(
      (request) => request.path === "/v1/invoices" && request.method === "POST",
    );
    expect(create?.params.get("currency")).toBe("eur");
    expect(create?.params.get("collection_method")).toBe("send_invoice");
    expect(create?.params.get("auto_advance")).toBe("false");
    expect(create?.params.get("pending_invoice_items_behavior")).toBe(
      "exclude",
    );
    expect(create?.params.get("discounts")).toBe("");
    expect(create?.params.get("custom_fields[0][name]")).toBe("VAT / Tax ID");
    expect(create?.params.get("custom_fields[0][value]")).toBe("PT123456789");
    expect(
      requests.filter(
        (request) =>
          request.path === "/v1/invoices/in_safe" && request.method === "GET",
      ),
    ).toHaveLength(3);
    expect(
      requests.filter(
        (request) =>
          request.path === "/v1/invoiceitems" && request.method === "GET",
      ),
    ).toHaveLength(3);
  });

  it("recovers an already-open invoice by metadata instead of creating another", async () => {
    const requests: {
      path: string;
      method: string;
      params: URLSearchParams;
    }[] = [];
    const remote = {
      ...STRIPE_RECIPIENT_SNAPSHOT,
      id: "in_recovered",
      status: "open",
      collection_method: "send_invoice",
      auto_advance: false,
      customer: "cus_safe",
      currency: "eur",
      total: 1_000,
      amount_due: 1_000,
      amount_remaining: 1_000,
      hosted_invoice_url: "https://invoice.stripe.test/in_recovered",
      due_date: null,
      metadata: { dropscale_invoice_id: "local-recovered" },
    };
    const item = {
      id: "ii_recovered",
      amount: 1_000,
      currency: "eur",
      customer: "cus_safe",
      description: "Agency fee",
      invoice: "in_recovered",
      metadata: {
        dropscale_invoice_id: "local-recovered",
        dropscale_line_index: "0",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const params =
          method === "GET"
            ? url.searchParams
            : new URLSearchParams(
                typeof init?.body === "string" ? init.body : "",
              );
        requests.push({ path: url.pathname, method, params });
        if (url.pathname === "/v1/invoices" && method === "GET") {
          return jsonResponse({ data: [remote], has_more: false });
        }
        if (url.pathname === "/v1/invoices/in_recovered" && method === "GET") {
          return jsonResponse(remote);
        }
        if (url.pathname === "/v1/invoiceitems" && method === "GET") {
          return jsonResponse({ data: [item], has_more: false });
        }
        if (
          url.pathname === "/v1/invoices/in_recovered/send" &&
          method === "POST"
        ) {
          return jsonResponse(remote);
        }
        throw new Error(`Unexpected request ${method} ${url}`);
      }),
    );

    const persisted: string[] = [];
    await expect(
      createAndFinalizeInvoice({
        customerId: "cus_safe",
        currency: "EUR",
        invoiceId: "local-recovered",
        description: "Approved agency fee",
        daysUntilDue: 7,
        recipient: INVOICE_RECIPIENT,
        assertLeaseOwnership: LEASE_CHECK,
        lines: [{ label: "Agency fee", amount: 10 }],
        onDraftCreated: async (id) => {
          persisted.push(id);
        },
      }),
    ).resolves.toMatchObject({ id: "in_recovered", status: "open" });

    expect(persisted).toEqual(["in_recovered"]);
    expect(
      requests.some(
        (request) =>
          request.path === "/v1/invoices" && request.method === "POST",
      ),
    ).toBe(false);
    expect(requests[0].params.has("status")).toBe(false);
  });

  it("times out safely in /send and retries only delivery with the stable invoice", async () => {
    vi.useFakeTimers();
    try {
      const remote = {
        ...STRIPE_RECIPIENT_SNAPSHOT,
        id: "in_send_retry",
        status: "open",
        collection_method: "send_invoice",
        auto_advance: false,
        customer: "cus_safe",
        currency: "eur",
        total: 1_000,
        amount_due: 1_000,
        amount_remaining: 1_000,
        hosted_invoice_url: "https://invoice.stripe.test/in_send_retry",
        due_date: null,
        metadata: { dropscale_invoice_id: "local-send-retry" },
      };
      const item = {
        id: "ii_send_retry",
        amount: 1_000,
        currency: "eur",
        customer: "cus_safe",
        description: "Agency fee",
        invoice: "in_send_retry",
        metadata: {
          dropscale_invoice_id: "local-send-retry",
          dropscale_line_index: "0",
        },
      };
      const mutations: string[] = [];
      let sendAttempts = 0;
      let signalFirstSend: (() => void) | undefined;
      const firstSendReached = new Promise<void>((resolve) => {
        signalFirstSend = resolve;
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          if (
            url.pathname === "/v1/invoices/in_send_retry" &&
            method === "GET"
          ) {
            return jsonResponse(remote);
          }
          if (url.pathname === "/v1/invoiceitems" && method === "GET") {
            return jsonResponse({ data: [item], has_more: false });
          }
          if (
            url.pathname === "/v1/invoices/in_send_retry/send" &&
            method === "POST"
          ) {
            mutations.push("send");
            sendAttempts += 1;
            if (sendAttempts === 1) {
              signalFirstSend?.();
              return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  reject(new DOMException("Aborted", "AbortError"));
                });
              });
            }
            return jsonResponse(remote);
          }
          throw new Error(`Unexpected request ${method} ${url}`);
        }),
      );

      const common = {
        customerId: "cus_safe",
        currency: "EUR",
        invoiceId: "local-send-retry",
        existingStripeInvoiceId: "in_send_retry",
        description: "Approved agency fee",
        daysUntilDue: 7,
        recipient: INVOICE_RECIPIENT,
        assertLeaseOwnership: LEASE_CHECK,
        lines: [{ label: "Agency fee", amount: 10 }],
      };
      const firstAttempt = createAndFinalizeInvoice(common);
      const firstAttemptResult =
        expect(firstAttempt).rejects.toThrow("timed out");
      await firstSendReached;
      await vi.advanceTimersByTimeAsync(15_000);
      await firstAttemptResult;

      const delivered: string[] = [];
      await expect(
        createAndFinalizeInvoice({
          ...common,
          onSent: async (invoice) => {
            delivered.push(invoice.id);
          },
        }),
      ).resolves.toMatchObject({ id: "in_send_retry", status: "open" });

      expect(mutations).toEqual(["send", "send"]);
      expect(delivered).toEqual(["in_send_retry"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a partial draft without recreating a line already identified by metadata", async () => {
    const items = [
      {
        id: "ii_existing",
        amount: 1_000,
        currency: "eur",
        customer: "cus_safe",
        description: "Store A - agency fee",
        invoice: "in_partial",
        metadata: {
          dropscale_invoice_id: "local-partial",
          dropscale_line_index: "0",
        },
      },
    ];
    const createdIndexes: string[] = [];
    let status = "draft";
    const remote = () => ({
      ...STRIPE_RECIPIENT_SNAPSHOT,
      id: "in_partial",
      status,
      collection_method: "send_invoice",
      auto_advance: false,
      customer: "cus_safe",
      currency: "eur",
      total: items.reduce((sum, item) => sum + item.amount, 0),
      amount_due: items.reduce((sum, item) => sum + item.amount, 0),
      amount_remaining: items.reduce((sum, item) => sum + item.amount, 0),
      hosted_invoice_url:
        status === "draft" ? null : "https://invoice.stripe.test/in_partial",
      due_date: null,
      metadata: { dropscale_invoice_id: "local-partial" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const params = new URLSearchParams(
          typeof init?.body === "string" ? init.body : "",
        );
        if (url.pathname === "/v1/invoices/in_partial" && method === "GET") {
          return jsonResponse(remote());
        }
        if (url.pathname === "/v1/invoiceitems" && method === "GET") {
          return jsonResponse({ data: items, has_more: false });
        }
        if (url.pathname === "/v1/invoiceitems" && method === "POST") {
          createdIndexes.push(params.get("metadata[dropscale_line_index]")!);
          items.push({
            id: "ii_new",
            amount: Number(params.get("amount")),
            currency: "eur",
            customer: "cus_safe",
            description: params.get("description")!,
            invoice: "in_partial",
            metadata: {
              dropscale_invoice_id: "local-partial",
              dropscale_line_index: params.get(
                "metadata[dropscale_line_index]",
              )!,
            },
          });
          return jsonResponse(items.at(-1));
        }
        if (url.pathname === "/v1/invoices/in_partial/finalize") {
          status = "open";
          return jsonResponse(remote());
        }
        if (url.pathname === "/v1/invoices/in_partial/send") {
          return jsonResponse(remote());
        }
        throw new Error(`Unexpected request ${method} ${url}`);
      }),
    );

    await createAndFinalizeInvoice({
      customerId: "cus_safe",
      currency: "EUR",
      invoiceId: "local-partial",
      existingStripeInvoiceId: "in_partial",
      description: "Approved agency fee",
      daysUntilDue: 7,
      recipient: INVOICE_RECIPIENT,
      assertLeaseOwnership: LEASE_CHECK,
      lines: [
        { label: "Store A - agency fee", amount: 10 },
        { label: "Store B - agency fee", amount: 5 },
      ],
    });

    expect(createdIndexes).toEqual(["1"]);
    expect(items).toHaveLength(2);
  });

  it("stops after a lost post-finalize fence and resumes the open invoice as send-only", async () => {
    let status = "draft";
    const mutations: string[] = [];
    const remote = () => ({
      ...STRIPE_RECIPIENT_SNAPSHOT,
      id: "in_fenced_finalize",
      status,
      collection_method: "send_invoice",
      auto_advance: false,
      customer: "cus_safe",
      currency: "eur",
      total: 1_000,
      amount_due: 1_000,
      amount_remaining: 1_000,
      hosted_invoice_url:
        status === "draft"
          ? null
          : "https://invoice.stripe.test/in_fenced_finalize",
      due_date: null,
      metadata: { dropscale_invoice_id: "local-fenced-finalize" },
    });
    const item = {
      id: "ii_fenced_finalize",
      amount: 1_000,
      currency: "eur",
      customer: "cus_safe",
      description: "Agency fee",
      invoice: "in_fenced_finalize",
      metadata: {
        dropscale_invoice_id: "local-fenced-finalize",
        dropscale_line_index: "0",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (
          url.pathname === "/v1/invoices/in_fenced_finalize" &&
          method === "GET"
        ) {
          return jsonResponse(remote());
        }
        if (url.pathname === "/v1/invoiceitems" && method === "GET") {
          return jsonResponse({ data: [item], has_more: false });
        }
        if (
          url.pathname === "/v1/invoices/in_fenced_finalize/finalize" &&
          method === "POST"
        ) {
          mutations.push("finalize");
          status = "open";
          return jsonResponse(remote());
        }
        if (
          url.pathname === "/v1/invoices/in_fenced_finalize/send" &&
          method === "POST"
        ) {
          mutations.push("send");
          return jsonResponse(remote());
        }
        throw new Error(`Unexpected request ${method} ${url}`);
      }),
    );

    const common = {
      customerId: "cus_safe",
      currency: "EUR",
      invoiceId: "local-fenced-finalize",
      existingStripeInvoiceId: "in_fenced_finalize",
      description: "Approved agency fee",
      daysUntilDue: 7,
      recipient: INVOICE_RECIPIENT,
      lines: [{ label: "Agency fee", amount: 10 }],
    };
    let checks = 0;
    await expect(
      createAndFinalizeInvoice({
        ...common,
        assertLeaseOwnership: async () => {
          checks += 1;
          if (checks === 2) throw new Error("lease lost");
        },
      }),
    ).rejects.toThrow("lease lost");
    expect(mutations).toEqual(["finalize"]);

    await expect(
      createAndFinalizeInvoice({
        ...common,
        assertLeaseOwnership: LEASE_CHECK,
      }),
    ).resolves.toMatchObject({ id: "in_fenced_finalize", status: "open" });
    expect(mutations).toEqual(["finalize", "send"]);
  });

  it("persists accepted delivery before reporting a lost post-send fence", async () => {
    const remote = {
      ...STRIPE_RECIPIENT_SNAPSHOT,
      id: "in_post_send_fence",
      status: "open",
      collection_method: "send_invoice",
      auto_advance: false,
      customer: "cus_safe",
      currency: "eur",
      total: 1_000,
      amount_due: 1_000,
      amount_remaining: 1_000,
      hosted_invoice_url: "https://invoice.stripe.test/in_post_send_fence",
      due_date: null,
      metadata: { dropscale_invoice_id: "local-post-send-fence" },
    };
    const item = {
      id: "ii_post_send_fence",
      amount: 1_000,
      currency: "eur",
      customer: "cus_safe",
      description: "Agency fee",
      invoice: remote.id,
      metadata: {
        dropscale_invoice_id: "local-post-send-fence",
        dropscale_line_index: "0",
      },
    };
    const operations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname === `/v1/invoices/${remote.id}` && method === "GET") {
          return jsonResponse(remote);
        }
        if (url.pathname === "/v1/invoiceitems" && method === "GET") {
          return jsonResponse({ data: [item], has_more: false });
        }
        if (
          url.pathname === `/v1/invoices/${remote.id}/send` &&
          method === "POST"
        ) {
          operations.push("send");
          return jsonResponse(remote);
        }
        throw new Error(`Unexpected request ${method} ${url}`);
      }),
    );

    let checks = 0;
    await expect(
      createAndFinalizeInvoice({
        customerId: "cus_safe",
        currency: "EUR",
        invoiceId: "local-post-send-fence",
        existingStripeInvoiceId: remote.id,
        description: "Approved agency fee",
        daysUntilDue: 7,
        recipient: INVOICE_RECIPIENT,
        lines: [{ label: "Agency fee", amount: 10 }],
        assertLeaseOwnership: async () => {
          checks += 1;
          operations.push(`lease-${checks}`);
          if (checks === 2) throw new Error("post-send lease lost");
        },
        onSent: async () => {
          operations.push("persist-sent");
        },
      }),
    ).rejects.toThrow("post-send lease lost");

    expect(operations).toEqual([
      "lease-1",
      "send",
      "persist-sent",
      "lease-2",
    ]);
  });

  it("leaves a newly created invoice untouched when local draft persistence fails", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (
          url.pathname === "/v1/invoices" &&
          (init?.method ?? "GET") === "GET"
        ) {
          return jsonResponse({ data: [], has_more: false });
        }
        if (url.pathname === "/v1/invoices") {
          return jsonResponse({
            id: "in_inert",
            status: "draft",
            customer: "cus_safe",
            currency: "eur",
            total: 0,
            amount_due: 0,
            hosted_invoice_url: null,
            due_date: null,
            metadata: { dropscale_invoice_id: "local-2" },
          });
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );

    await expect(
      createAndFinalizeInvoice({
        customerId: "cus_safe",
        currency: "EUR",
        invoiceId: "local-2",
        description: "Approved agency fee",
        daysUntilDue: 7,
        recipient: INVOICE_RECIPIENT,
        assertLeaseOwnership: LEASE_CHECK,
        lines: [{ label: "Agency fee", amount: 10 }],
        onDraftCreated: async () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toThrow("database unavailable");
    expect(paths).toEqual(["GET /v1/invoices", "POST /v1/invoices"]);
  });

  it("rejects non-EUR and automatic charging before any Stripe request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createAndFinalizeInvoice({
        customerId: "cus_safe",
        currency: "USD",
        invoiceId: "local-3",
        description: "Wrong currency",
        daysUntilDue: 7,
        recipient: INVOICE_RECIPIENT,
        assertLeaseOwnership: LEASE_CHECK,
        lines: [{ label: "Agency fee", amount: 10 }],
      }),
    ).rejects.toThrow("EUR");

    await expect(
      createAndFinalizeInvoice({
        customerId: "cus_safe",
        currency: "EUR",
        invoiceId: "local-4",
        description: "Wrong collection mode",
        daysUntilDue: 7,
        recipient: INVOICE_RECIPIENT,
        assertLeaseOwnership: LEASE_CHECK,
        lines: [{ label: "Agency fee", amount: 10 }],
        autoCharge: true,
      } as unknown as Parameters<typeof createAndFinalizeInvoice>[0]),
    ).rejects.toThrow("Automatic charging is disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers a Customer by metadata instead of creating a duplicate", async () => {
    const requests: { path: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ path: url.pathname, method });
        if (url.pathname === "/v1/customers/search") {
          return jsonResponse({
            data: [
              {
                id: "cus_recovered",
                metadata: { dropscale_client_id: "client-1" },
              },
            ],
            has_more: false,
          });
        }
        if (
          url.pathname === "/v1/customers/cus_recovered" &&
          method === "GET"
        ) {
          return jsonResponse({
            id: "cus_recovered",
            email: "client@example.com",
            metadata: { dropscale_client_id: "client-1" },
          });
        }
        if (
          url.pathname === "/v1/customers/cus_recovered" &&
          method === "POST"
        ) {
          return jsonResponse({ id: "cus_recovered" });
        }
        throw new Error(`Unexpected request ${method} ${url}`);
      }),
    );

    await expect(
      createCustomer({
        clientId: "client-1",
        email: "client@example.com",
        name: "Client",
        assertLeaseOwnership: LEASE_CHECK,
      }),
    ).resolves.toBe("cus_recovered");
    expect(requests).toEqual([
      { path: "/v1/customers/search", method: "GET" },
      { path: "/v1/customers/cus_recovered", method: "GET" },
      { path: "/v1/customers/cus_recovered", method: "POST" },
    ]);
  });

  it("revalidates an existing Customer and reasserts email, identity and metadata", async () => {
    const writes: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname === "/v1/customers/cus_existing" && method === "GET") {
          return jsonResponse({
            id: "cus_existing",
            email: "new@example.com",
            metadata: { dropscale_client_id: "client-1" },
          });
        }
        if (
          url.pathname === "/v1/customers/cus_existing" &&
          method === "POST"
        ) {
          writes.push(new URLSearchParams(String(init?.body ?? "")));
          return jsonResponse({ id: "cus_existing" });
        }
        throw new Error(`Unexpected request ${method} ${url}`);
      }),
    );

    await updateCustomerBilling("cus_existing", {
      clientId: "client-1",
      email: "new@example.com",
      fallbackName: "Portal name",
      identity: {
        name: "Legal name",
        address: { line1: "Street 1", country: "PT" },
      },
      assertLeaseOwnership: LEASE_CHECK,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].get("email")).toBe("new@example.com");
    expect(writes[0].get("name")).toBe("Legal name");
    expect(writes[0].get("metadata[dropscale_client_id]")).toBe("client-1");
    expect(writes[0].get("address[line1]")).toBe("Street 1");
    expect(writes[0].get("address[country]")).toBe("PT");
  });

  it("refuses a locally supplied Stripe Customer bound to another client", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (
          url.pathname === "/v1/customers/cus_other" &&
          (init?.method ?? "GET") === "GET"
        ) {
          return jsonResponse({
            id: "cus_other",
            email: "other@example.com",
            metadata: { dropscale_client_id: "another-client" },
          });
        }
        throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateCustomerBilling("cus_other", {
        clientId: "client-1",
        email: "client@example.com",
        fallbackName: "Client",
        identity: {},
        assertLeaseOwnership: LEASE_CHECK,
      }),
    ).rejects.toThrow(/belongs to another client/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces Stripe request metadata without leaking the secret", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              message: "Rate limited",
              code: "rate_limit",
              type: "api_error",
            },
          },
          429,
          "req_rate_limited",
        ),
      ),
    );

    const error = await getInvoice("in_test").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StripeError);
    expect(error).toMatchObject({
      status: 429,
      metadata: {
        code: "rate_limit",
        type: "api_error",
        requestId: "req_rate_limited",
        retryable: true,
      },
    });
    expect(String(error)).not.toContain("sk_test_never_sent");
  });
});
