import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuditMachineSponsor: vi.fn(),
  requireAuditAdmin: vi.fn(),
  runLaraAuditBaseline: vi.fn(),
}));

vi.mock("@/lib/audit/connections", () => ({
  AuditConnectionError: class AuditConnectionError extends Error {
    constructor(public status: number) {
      super("Audit connection error");
    }
  },
  getAuditMachineSponsor: mocks.getAuditMachineSponsor,
  requireAuditAdmin: mocks.requireAuditAdmin,
}));
vi.mock("@/lib/audit/shopify-collector", () => ({
  LARA_AUDIT_CONNECTION: {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: "jwmtjg-fm.myshopify.com",
    shopId: "gid://shopify/Shop/95462097276",
  },
  LARA_INITIAL_BASELINE_RUN_ID: "6d481a86-9fbe-4b11-8be1-b665fb8d4b32",
  runLaraAuditBaseline: mocks.runLaraAuditBaseline,
}));
vi.mock("@/lib/audit/invitations", () => ({
  isAuditConnectionId: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
}));

import { POST } from "./route";

const CONNECTION_ID = "a023c7e2-a96b-4f04-bc6e-0165e23332c3";

function request(
  body: unknown,
  options: { origin?: string; id?: string; authorization?: string } = {},
) {
  return {
    request: new NextRequest(
      `https://dropscale.app/api/admin/audit/connections/${options.id ?? CONNECTION_ID}/collect`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.authorization
            ? { authorization: options.authorization }
            : {}),
        },
        body: JSON.stringify(body),
      },
    ),
    context: { params: Promise.resolve({ id: options.id ?? CONNECTION_ID }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret-for-test");
  mocks.requireAuditAdmin.mockResolvedValue({ id: "admin", role: "admin" });
  mocks.getAuditMachineSponsor.mockResolvedValue("sponsor-admin");
  mocks.runLaraAuditBaseline.mockResolvedValue({
    runId: "40000000-0000-4000-8000-000000000010",
    state: "completed",
    artifact: {
      schemaVersion: "shopify-audit-baseline-v2",
      auditStatus: "complete",
      generatedAt: "2026-08-12T14:00:00.000Z",
      completionIssues: [],
      modules: { shopIdentity: { status: "complete", requests: 1 } },
      counts: {
        productsCount: { count: 1_448, precision: "EXACT" },
        productVariantsCount: { count: 38_068, precision: "EXACT" },
      },
      priorityProducts: [{ found: true, secret: "never-return" }],
      policies: [{ body: "never-return" }],
      pages: [],
      menus: [],
      theme: { sourceScan: { matches: [] } },
      shopIdentity: { contactEmail: "never-return@example.com" },
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin read-only Shopify audit collector route", () => {
  it("authenticates before invoking the privileged collector", async () => {
    mocks.requireAuditAdmin.mockRejectedValue(new Error("Forbidden"));
    const input = request({ confirmation: "collect-read-only" });
    const result = await POST(input.request, input.context);
    expect(result.status).toBe(403);
    expect(mocks.runLaraAuditBaseline).not.toHaveBeenCalled();
  });

  it("accepts only the exact cron bearer and derives the machine sponsor from the pinned connection", async () => {
    const input = request(
      { confirmation: "collect-read-only" },
      { authorization: "Bearer cron-secret-for-test" },
    );
    const result = await POST(input.request, input.context);

    expect(result.status).toBe(200);
    expect(mocks.requireAuditAdmin).not.toHaveBeenCalled();
    expect(mocks.getAuditMachineSponsor).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      shopifyDomain: "jwmtjg-fm.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/95462097276",
    });
    expect(mocks.runLaraAuditBaseline).toHaveBeenCalledWith({
      requestedBy: "sponsor-admin",
      runId: "6d481a86-9fbe-4b11-8be1-b665fb8d4b32",
      trigger: "system",
    });
  });

  it("does not treat a wrong machine bearer as machine authority", async () => {
    mocks.requireAuditAdmin.mockRejectedValue(new Error("Forbidden"));
    const input = request(
      { confirmation: "collect-read-only" },
      { authorization: "Bearer wrong-secret" },
    );
    const result = await POST(input.request, input.context);

    expect(result.status).toBe(403);
    expect(mocks.getAuditMachineSponsor).not.toHaveBeenCalled();
    expect(mocks.runLaraAuditBaseline).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests and injected GraphQL/operation fields", async () => {
    const crossOrigin = request(
      { confirmation: "collect-read-only" },
      { origin: "https://attacker.example" },
    );
    expect((await POST(crossOrigin.request, crossOrigin.context)).status).toBe(403);

    const injected = request({
      confirmation: "collect-read-only",
      query: "mutation Unsafe { shop { id } }",
    });
    expect((await POST(injected.request, injected.context)).status).toBe(400);
    expect(mocks.runLaraAuditBaseline).not.toHaveBeenCalled();
  });

  it("is hard-pinned to the Lara connection UUID", async () => {
    const input = request(
      { confirmation: "collect-read-only" },
      { id: "40000000-0000-4000-8000-000000000099" },
    );
    const result = await POST(input.request, input.context);
    expect(result.status).toBe(404);
    expect(mocks.runLaraAuditBaseline).not.toHaveBeenCalled();
  });

  it("returns only a sanitized aggregate summary with no-store headers", async () => {
    const input = request(
      { confirmation: "collect-read-only" },
      { origin: "https://dropscale.app" },
    );
    const result = await POST(input.request, input.context);
    expect(result.status).toBe(200);
    const payload = await result.json();
    expect(payload).toEqual({
      ok: true,
      runId: "40000000-0000-4000-8000-000000000010",
      state: "completed",
      summary: {
        schemaVersion: "shopify-audit-baseline-v2",
        auditStatus: "complete",
        generatedAt: "2026-08-12T14:00:00.000Z",
        completionIssues: [],
        modules: { shopIdentity: { status: "complete" } },
        counts: {
          productsCount: { count: 1_448, precision: "EXACT" },
          productVariantsCount: { count: 38_068, precision: "EXACT" },
        },
        captured: {
          priorityProductsRequested: 1,
          priorityProductsFound: 1,
          policies: 1,
          pages: 0,
          menus: 0,
          themeSourceFilesMatched: 0,
        },
      },
    });
    const rendered = JSON.stringify(payload);
    expect(rendered).not.toContain("never-return");
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(mocks.runLaraAuditBaseline).toHaveBeenCalledWith({ requestedBy: "admin" });
  });

  it("does not expose internal error messages", async () => {
    mocks.runLaraAuditBaseline.mockRejectedValue(
      new Error("client_secret=must-not-leak ciphertext=must-not-leak"),
    );
    const input = request({ confirmation: "collect-read-only" });
    const result = await POST(input.request, input.context);
    expect(result.status).toBe(500);
    const rendered = JSON.stringify(await result.json());
    expect(rendered).not.toContain("client_secret");
    expect(rendered).not.toContain("ciphertext");
  });

  it("reuses an already-running collection without returning an artifact", async () => {
    mocks.runLaraAuditBaseline.mockResolvedValue({
      runId: "40000000-0000-4000-8000-000000000010",
      state: "in_progress",
    });
    const input = request({ confirmation: "collect-read-only" });
    const result = await POST(input.request, input.context);
    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({
      ok: true,
      runId: "40000000-0000-4000-8000-000000000010",
      state: "in_progress",
    });
  });
});
