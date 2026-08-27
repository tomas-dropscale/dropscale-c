import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionProfile: vi.fn(),
  sendTelegram: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
// Only the send is faked. The formatter stays real — pointing the alias at the
// module itself, since the suite runs without path-alias resolution — so these
// cases cover the actual text that would reach a phone.
vi.mock("@/lib/notify/admin-events", async () => await import("../../../../lib/notify/admin-events"));
vi.mock("@/lib/notify/telegram", () => ({ sendTelegram: mocks.sendTelegram }));

import { POST } from "./route";

const SECRET = "notify-secret";

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://dropscale.app/api/notify/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const authed = { authorization: `Bearer ${SECRET}` };

const newClient = {
  type: "INSERT",
  table: "portal_clients",
  record: { approval_status: "pending", full_name: "Ana Dias", email: "ana@loja.pt" },
};

/** Minimal stand-in for the service client's `from(...).select(...).in(...)`. */
function serviceClient(rows: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => ({
      select: () => ({
        in: async () => ({ data: rows[table] ?? [], error: null }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOTIFY_SECRET = SECRET;
  process.env.NEXT_PUBLIC_SITE_URL = "https://dropscale.app";
  mocks.sendTelegram.mockResolvedValue({ ok: true });
  mocks.getSessionProfile.mockResolvedValue({ profile: null });
  mocks.createServiceClient.mockReturnValue(null);
});

describe("POST /api/notify/telegram", () => {
  it("sends the alert when the webhook presents the shared secret", async () => {
    const response = await POST(post(newClient, authed));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.sendTelegram).toHaveBeenCalledOnce();
    expect(mocks.sendTelegram.mock.calls[0][0]).toContain("Ana Dias");
  });

  it("refuses an unsigned request with no admin session", async () => {
    const response = await POST(post(newClient));

    expect(response.status).toBe(403);
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret", async () => {
    const response = await POST(post(newClient, { authorization: "Bearer wrong" }));

    expect(response.status).toBe(403);
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("closes when NOTIFY_SECRET is unset rather than accepting everything", async () => {
    delete process.env.NOTIFY_SECRET;

    const response = await POST(post(newClient, authed));

    expect(response.status).toBe(403);
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("lets an admin fire a test message from the browser", async () => {
    mocks.getSessionProfile.mockResolvedValue({ profile: { role: "admin" } });

    const response = await POST(post({ test: true }));

    expect(response.status).toBe(200);
    expect(mocks.sendTelegram.mock.calls[0][0]).toContain("Teste do Dropscale");
  });

  it("does not let a non-admin session fire a test message", async () => {
    mocks.getSessionProfile.mockResolvedValue({ profile: { role: "member" } });

    const response = await POST(post({ test: true }));

    expect(response.status).toBe(403);
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("skips a table nobody subscribed to", async () => {
    const response = await POST(
      post({ type: "INSERT", table: "daily_metrics", record: {} }, authed),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: "table not notified" });
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("skips a row that is not actually waiting on anybody", async () => {
    // A normalized reporting account: provisioned pending by the V2 lifecycle
    // and activated by billing, so no message would name work anyone owns.
    const response = await POST(
      post(
        {
          type: "INSERT",
          table: "ad_accounts",
          record: {
            status: "pending",
            reporting_role: "shopify_anchor",
            store_name: "avigail-atelier",
          },
        },
        authed,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: "nothing to announce" });
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("answers 200 when Telegram fails, so Supabase does not retry into duplicates", async () => {
    mocks.sendTelegram.mockResolvedValue({ ok: false, reason: "rejected", detail: "chat not found" });

    const response = await POST(post(newClient, authed));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("names the approver on a decision", async () => {
    const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
    mocks.createServiceClient.mockReturnValue(
      serviceClient({ profiles: [{ id: ADMIN, full_name: "Tomás" }] }),
    );

    await POST(
      post(
        {
          type: "UPDATE",
          table: "portal_clients",
          record: { approval_status: "approved", full_name: "Ana Dias", approved_by: ADMIN },
          old_record: { approval_status: "pending", full_name: "Ana Dias", approved_by: null },
        },
        authed,
      ),
    );

    expect(mocks.sendTelegram.mock.calls[0][0]).toContain("por Tomás");
  });

  it("still sends the alert when names cannot be resolved", async () => {
    mocks.createServiceClient.mockReturnValue(null);

    const response = await POST(
      post(
        {
          type: "UPDATE",
          table: "portal_clients",
          record: { approval_status: "approved", full_name: "Ana Dias", approved_by: "adm-1" },
          old_record: { approval_status: "pending", full_name: "Ana Dias", approved_by: null },
        },
        authed,
      ),
    );

    expect(response.status).toBe(200);
    const sent = mocks.sendTelegram.mock.calls[0][0];
    expect(sent).toContain("Cliente aprovado");
    expect(sent).not.toContain("adm-1");
  });

  it("does not spend lookups on a payload that announces nothing", async () => {
    await POST(
      post(
        {
          type: "UPDATE",
          table: "portal_clients",
          record: { approval_status: "approved", approved_by: "adm-1" },
          old_record: { approval_status: "approved", approved_by: "adm-1" },
        },
        authed,
      ),
    );

    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const request = new NextRequest("https://dropscale.app/api/notify/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed },
      body: "not json",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });
});
