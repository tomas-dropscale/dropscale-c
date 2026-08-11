import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AUDIT_INVITE_TTL_MS,
  auditInvitationUrl,
  auditInviteExpiry,
  createAuditInvitationMaterial,
  generateAuditInviteToken,
  hashAuditInviteToken,
  isAuditInviteToken,
} from "./invitations";

const CONNECTION_ID = "40000000-0000-4000-8000-000000000001";

describe("audit invitation material", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://dropscale.app";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it("generates 32-byte URL-safe bearer tokens", () => {
    const tokens = new Set(Array.from({ length: 64 }, generateAuditInviteToken));
    expect(tokens.size).toBe(64);
    for (const token of tokens) {
      expect(token).toHaveLength(43);
      expect(isAuditInviteToken(token)).toBe(true);
    }
  });

  it("stores the standard SHA-256 digest, never an encoded token", async () => {
    const token = "A".repeat(43);
    const expected = createHash("sha256").update(token).digest("hex");
    expect(await hashAuditInviteToken(token)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("places the bearer in the URL fragment rather than path or query", () => {
    const token = generateAuditInviteToken();
    const url = new URL(auditInvitationUrl(CONNECTION_ID, token));
    expect(url.pathname).toBe(`/connect/shopify/${CONNECTION_ID}`);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${token}`);
    expect(url.pathname).not.toContain(token);
  });

  it("uses a seven-day expiry and returns only hash + one-time raw material", async () => {
    const now = new Date("2026-08-11T10:00:00.000Z");
    expect(Date.parse(auditInviteExpiry(now)) - now.getTime()).toBe(AUDIT_INVITE_TTL_MS);

    const invitation = await createAuditInvitationMaterial(now);
    expect(invitation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(invitation.tokenHash).toBe(await hashAuditInviteToken(invitation.token));
    expect(invitation.url.endsWith(`#${invitation.token}`)).toBe(true);
  });

  it("refuses non-HTTPS public origins", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "http://attacker.example";
    expect(() => auditInvitationUrl(CONNECTION_ID, generateAuditInviteToken())).toThrow(
      /HTTPS origin/,
    );
  });
});
