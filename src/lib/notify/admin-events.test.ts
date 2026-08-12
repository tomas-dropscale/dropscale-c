import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  formatAdminEvent,
  isNotifiedTable,
  lookupsFor,
  type WebhookPayload,
} from "./admin-events";

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
  it("accepts the seven tables that produce alerts", () => {
    for (const table of [
      "portal_clients",
      "ad_accounts",
      "account_requests",
      "creative_submissions",
      "client_invites",
      "invoices",
      "ad_account_billing_starts",
    ]) {
      expect(isNotifiedTable(table)).toBe(true);
    }
  });

  it("rejects tables nobody asked to hear about", () => {
    expect(isNotifiedTable("daily_metrics")).toBe(false);
    expect(isNotifiedTable("campaigns")).toBe(false);
  });
});

describe("message shape", () => {
  it("is three lines: title, facts, action", () => {
    const lines = formatAdminEvent(payload())!.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("👤 <b>Cliente novo</b>");
    expect(lines[1]).toBe("Ana Dias · ana@loja.pt");
    expect(lines[2]).toBe('<a href="https://dropscale.app/admin/clients">Aprovar →</a>');
  });

  it("drops the action line when there is nothing for the team to do", () => {
    const lines = formatAdminEvent(
      payload({ table: "client_invites", record: { email: "socio@loja.pt" } }),
    )!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes("<a href"))).toBe(false);
  });

  it("omits missing facts instead of leaving empty separators", () => {
    const message = formatAdminEvent(
      payload({ record: { approval_status: "pending", full_name: "Ana Dias", email: null } }),
    )!;
    expect(message).toContain("Ana Dias");
    expect(message).not.toContain("·");
  });
});

describe("approval queue", () => {
  it("announces a new client", () => {
    const message = formatAdminEvent(payload())!;
    expect(message).toContain("Cliente novo");
    expect(message).toContain("ana@loja.pt");
  });

  it("ignores a client row inserted already approved", () => {
    expect(
      formatAdminEvent(
        payload({ record: { approval_status: "approved", full_name: "Ana", email: "a@b.pt" } }),
      ),
    ).toBeNull();
  });

  it("escapes client-supplied text so Telegram does not reject the message", () => {
    const message = formatAdminEvent(
      payload({
        record: {
          approval_status: "pending",
          full_name: "<script>alert(1)</script>",
          email: "a&b@loja.pt",
        },
      }),
    )!;
    expect(message).toContain("&lt;script&gt;");
    expect(message).not.toContain("<script>");
    expect(message).toContain("a&amp;b@loja.pt");
  });

  it("says so when a pending store has no Google customer id", () => {
    const message = formatAdminEvent(
      payload({
        table: "ad_accounts",
        record: { status: "pending", store_name: "Casa Bonita", google_ads_customer_id: null },
      }),
    )!;
    expect(message).toContain("Loja por ativar");
    expect(message).toContain("sem ID Google");
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
    expect(google).toContain("Pedido Google Ads");
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
    expect(shopify).toContain("Pedido Shopify");
    expect(shopify).toContain("loja-x.myshopify.com");
  });

  it("points submitted creatives at the creatives screen", () => {
    const message = formatAdminEvent(
      payload({
        table: "creative_submissions",
        record: { status: "new", title: "Verão — lote 3", notes: null },
      }),
    )!;
    expect(message).toContain("Criativos entregues");
    expect(message).toContain("/admin/creatives?status=new");
  });

  it("truncates a long note rather than sending a wall of text", () => {
    const message = formatAdminEvent(
      payload({
        table: "creative_submissions",
        record: { status: "new", title: "Lote", notes: "a".repeat(400) },
      }),
    )!;
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(300);
  });
});

describe("queue closing — who handled it", () => {
  const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
  const named = { profiles: { [ADMIN]: "Tomás" } };

  const decided = (status: string, names?: typeof named) =>
    formatAdminEvent(
      payload({
        type: "UPDATE",
        record: { approval_status: status, full_name: "Ana Dias", approved_by: ADMIN },
        old_record: { approval_status: "pending", full_name: "Ana Dias", approved_by: null },
      }),
      names,
    );

  it("announces an approval and who made it", () => {
    const message = decided("approved", named)!;
    expect(message).toContain("Cliente aprovado");
    expect(message).toContain("Ana Dias");
    expect(message).toContain("por Tomás");
  });

  it("announces a rejection the same way", () => {
    expect(decided("rejected", named)).toContain("Cliente rejeitado");
  });

  it("omits the attribution rather than printing a uuid", () => {
    const message = decided("approved")!;
    expect(message).toContain("Cliente aprovado");
    expect(message).not.toContain(ADMIN);
    expect(message).not.toContain("por ");
  });

  it("stays quiet when a client row changes for unrelated reasons", () => {
    expect(
      formatAdminEvent(
        payload({
          type: "UPDATE",
          record: { approval_status: "approved", full_name: "Ana", avatar_url: "b.png" },
          old_record: { approval_status: "approved", full_name: "Ana", avatar_url: null },
        }),
      ),
    ).toBeNull();
  });

  it("announces a verified store with its name and reviewer", () => {
    const ACCOUNT = "bbbbbbbb-0000-4000-8000-000000000002";
    const message = formatAdminEvent(
      payload({
        table: "ad_account_billing_starts",
        record: { ad_account_id: ACCOUNT, reviewed_by: ADMIN },
      }),
      { profiles: { [ADMIN]: "Tomás" }, accounts: { [ACCOUNT]: "Casa Bonita" } },
    )!;
    expect(message).toContain("Loja verificada");
    expect(message).toContain("Casa Bonita");
    expect(message).toContain("por Tomás");
  });
});

describe("lookupsFor", () => {
  it("asks for the approver on a client decision", () => {
    const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(
      lookupsFor(
        payload({ type: "UPDATE", record: { approval_status: "approved", approved_by: ADMIN } }),
      ),
    ).toEqual({ profileIds: [ADMIN], adAccountIds: [] });
  });

  it("asks for both the reviewer and the store on a billing start", () => {
    const result = lookupsFor(
      payload({
        table: "ad_account_billing_starts",
        record: { ad_account_id: "acc-1", reviewed_by: "adm-1" },
      }),
    );
    expect(result).toEqual({ profileIds: ["adm-1"], adAccountIds: ["acc-1"] });
  });

  it("asks for nothing on payloads with no ids worth naming", () => {
    expect(lookupsFor(payload())).toEqual({ profileIds: [], adAccountIds: [] });
  });
});

describe("partners", () => {
  const invite = (over: Partial<WebhookPayload>) =>
    formatAdminEvent(payload({ table: "client_invites", ...over }));

  it("announces the invitation", () => {
    expect(invite({ record: { email: "socio@loja.pt", status: "pending" } })).toContain(
      "Sócio convidado",
    );
  });

  it("announces the invite turning into access", () => {
    const message = invite({
      type: "UPDATE",
      record: { email: "socio@loja.pt", status: "accepted" },
      old_record: { email: "socio@loja.pt", status: "pending" },
    })!;
    expect(message).toContain("Sócio entrou");
    expect(message).toContain("socio@loja.pt");
  });

  it("stays quiet when an already-accepted invite is rewritten", () => {
    expect(
      invite({
        type: "UPDATE",
        record: { email: "socio@loja.pt", status: "accepted" },
        old_record: { email: "socio@loja.pt", status: "accepted" },
      }),
    ).toBeNull();
  });
});

describe("billing", () => {
  const invoice = (over: Partial<WebhookPayload>) =>
    formatAdminEvent(payload({ table: "invoices", type: "UPDATE", ...over }));

  it("announces issuance when issued_at is first set", () => {
    const message = invoice({
      record: {
        amount: 123.45,
        currency: "EUR",
        status: "open",
        issued_at: "2026-08-10T10:00:00Z",
        period_start: "2026-08-01",
        period_end: "2026-08-07",
      },
      old_record: { amount: 123.45, currency: "EUR", status: "draft", issued_at: null },
    })!;
    expect(message).toContain("Fatura emitida");
    expect(message).toContain("€123.45");
    expect(message).toContain("01/08–07/08");
  });

  it("announces payment", () => {
    const message = invoice({
      record: { amount: 89.5, currency: "EUR", status: "paid", stripe_invoice_number: "DS-0042" },
      old_record: { amount: 89.5, currency: "EUR", status: "open" },
    })!;
    expect(message).toContain("Fatura paga");
    expect(message).toContain("€89.50");
    expect(message).toContain("DS-0042");
  });

  it("stays quiet when Stripe reconciliation rewrites a paid invoice", () => {
    expect(
      invoice({
        record: { amount: 89.5, currency: "EUR", status: "paid", amount_remaining: 0 },
        old_record: { amount: 89.5, currency: "EUR", status: "paid", amount_remaining: null },
      }),
    ).toBeNull();
  });

  it("stays quiet when an already-issued invoice is touched again", () => {
    expect(
      invoice({
        record: { amount: 10, currency: "EUR", status: "open", issued_at: "2026-08-10T10:00:00Z" },
        old_record: {
          amount: 10,
          currency: "EUR",
          status: "open",
          issued_at: "2026-08-10T10:00:00Z",
        },
      }),
    ).toBeNull();
  });

  it("spells out a currency it has no symbol for", () => {
    const message = invoice({
      record: { amount: 50, currency: "BRL", status: "paid" },
      old_record: { amount: 50, currency: "BRL", status: "open" },
    })!;
    expect(message).toContain("50.00 BRL");
  });
});

describe("payloads that say nothing", () => {
  it("returns null with no record", () => {
    expect(formatAdminEvent(payload({ record: null }))).toBeNull();
  });

  it("returns null for a DELETE", () => {
    expect(formatAdminEvent(payload({ type: "DELETE" }))).toBeNull();
  });

  it("returns null for a table it does not handle", () => {
    expect(formatAdminEvent(payload({ table: "daily_metrics", record: { x: 1 } }))).toBeNull();
  });

  it("falls back to the production origin when the site url is unset", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(formatAdminEvent(payload())).toContain("https://dropscale.app/admin/clients");
  });
});
