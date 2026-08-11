import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class AuditConnectionError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return {
    AuditConnectionError,
    requireAuditAdmin: vi.fn(),
    createAuditConnection: vi.fn(),
  };
});

vi.mock("@/lib/audit/connections", () => ({
  AuditConnectionError: mocks.AuditConnectionError,
  requireAuditAdmin: mocks.requireAuditAdmin,
  createAuditConnection: mocks.createAuditConnection,
}));

import { POST } from "./route";

const ADMIN = "40000000-0000-4000-8000-000000000001";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/audit/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin audit invitation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuditAdmin.mockResolvedValue({ id: ADMIN, role: "admin" });
    mocks.createAuditConnection.mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000003",
      storeLabel: "Willow & Wren",
      url: "https://dropscale.app/connect/shopify/id#one-time-token",
      expiresAt: "2026-08-18T10:00:00.000Z",
    });
  });

  it("authorises before any privileged creation", async () => {
    mocks.requireAuditAdmin.mockRejectedValue(
      new mocks.AuditConnectionError("forbidden", "Forbidden.", 403),
    );
    const result = await POST(request({ storeName: "Willow & Wren" }));
    expect(result.status).toBe(403);
    expect(mocks.createAuditConnection).not.toHaveBeenCalled();
  });

  it("accepts exactly storeName and rejects injected fields", async () => {
    const result = await POST(
      request({ storeName: "Willow & Wren", clientSecret: "must-not-be-here" }),
    );
    expect(result.status).toBe(400);
    expect(mocks.createAuditConnection).not.toHaveBeenCalled();
  });

  it("returns the one-time link with no-store caching", async () => {
    const result = await POST(request({ storeName: "Willow & Wren" }));
    expect(result.status).toBe(201);
    expect(mocks.createAuditConnection).toHaveBeenCalledWith("Willow & Wren", ADMIN);
    await expect(result.json()).resolves.toMatchObject({
      ok: true,
      invitation: { storeLabel: "Willow & Wren" },
    });
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
});
