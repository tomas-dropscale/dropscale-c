import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { formatAdminEvent, isNotifiedTable, type WebhookPayload } from "./admin-events";

function payload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    type: "INSERT",
    table: "portal_clients",
    schema: "public",
    record: { approval_status: "pending", full_name: "Ana Dias", email: "ana@loja.pt" },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://dropscale.app";
});

describe("isNotifiedTable", () => {
  it("accepts exactly the four tables the admin bell counts", () => {
    for (const table of [
      "portal_clients",
      "ad_accounts",
      "account_requests",
      "creative_submissions",
    ]) {
      expect(isNotifiedTable(table)).toBe(true);
    }
  });

  it("rejects tables nobody asked to hear about", () => {
    expect(isNotifiedTable("daily_metrics")).toBe(false);
    expect(isNotifiedTable("invoices")).toBe(false);
  });
});

describe("formatAdminEvent", () => {
  it("announces a new client with their name and email", () => {
    const message = formatAdminEvent(payload());
    expect(message).toContain("Novo cliente registado");
    expect(message).toContain("Ana Dias");
    expect(message).toContain("ana@loja.pt");
    expect(message).toContain("https://dropscale.app/admin/clients");
  });

  it("ignores updates — the team approving is not news to the team", () => {
    expect(formatAdminEvent(payload({ type: "UPDATE" }))).toBeNull();
    expect(formatAdminEvent(payload({ type: "DELETE" }))).toBeNull();
  });

  it("ignores a client row that is already approved", () => {
    const already = payload({
      record: { approval_status: "approved", full_name: "Ana", email: "a@b.pt" },
    });
    expect(formatAdminEvent(already)).toBeNull();
  });

  it("escapes client-supplied text so Telegram does not reject the message", () => {
    const nasty = payload({
      record: {
        approval_status: "pending",
        full_name: "<script>alert(1)</script>",
        email: "a&b@loja.pt",
      },
    });
    const message = formatAdminEvent(nasty)!;
    expect(message).toContain("&lt;script&gt;");
    expect(message).not.toContain("<script>");
    expect(message).toContain("a&amp;b@loja.pt");
  });

  it("names the store and Google customer id on a pending ad account", () => {
    const message = formatAdminEvent(
      payload({
        table: "ad_accounts",
        record: {
          status: "pending",
          store_name: "Casa Bonita",
          google_ads_customer_id: "123-456-7890",
        },
      }),
    )!;
    expect(message).toContain("Conta de anúncios por ativar");
    expect(message).toContain("Casa Bonita");
    expect(message).toContain("123-456-7890");
  });

  it("says so when a pending ad account has no Google customer id", () => {
    const message = formatAdminEvent(
      payload({
        table: "ad_accounts",
        record: { status: "pending", store_name: "Casa Bonita", google_ads_customer_id: null },
      }),
    )!;
    expect(message).toContain("Sem ID Google Ads");
  });

  it("distinguishes a Google Ads request from a Shopify one", () => {
    const google = formatAdminEvent(
      payload({
        table: "account_requests",
        record: {
          status: "pending",
          request_type: "google_ads",
          store_name: "Loja X",
          google_ads_customer_id: "111-222-3333",
        },
      }),
    )!;
    expect(google).toContain("Pedido de conta Google Ads");
    expect(google).toContain("111-222-3333");

    const shopify = formatAdminEvent(
      payload({
        table: "account_requests",
        record: {
          status: "pending",
          request_type: "shopify",
          myshopify_url: "loja-x.myshopify.com",
          shopify_collaborator_code: "4821",
        },
      }),
    )!;
    expect(shopify).toContain("Pedido de ligação Shopify");
    expect(shopify).toContain("loja-x.myshopify.com");
    expect(shopify).toContain("4821");
  });

  it("points submitted creatives at the creatives screen, not clients", () => {
    const message = formatAdminEvent(
      payload({
        table: "creative_submissions",
        record: { status: "new", title: "Verão — lote 3", notes: null },
      }),
    )!;
    expect(message).toContain("Criativos entregues");
    expect(message).toContain("https://dropscale.app/admin/creatives?status=new");
  });

  it("truncates a long note rather than sending a wall of text to a phone", () => {
    const message = formatAdminEvent(
      payload({
        table: "creative_submissions",
        record: { status: "new", title: "Lote", notes: "a".repeat(400) },
      }),
    )!;
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(400);
  });

  it("returns null for a payload with no record", () => {
    expect(formatAdminEvent(payload({ record: null }))).toBeNull();
  });

  it("falls back to the production origin when the site url is unset", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(formatAdminEvent(payload())).toContain("https://dropscale.app/admin/clients");
  });
});
