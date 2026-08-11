import "server-only";

import { siteUrl } from "../site";

export const AUDIT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isAuditConnectionId(value: string): boolean {
  return UUID.test(value);
}

export function isAuditInviteToken(value: string): boolean {
  return TOKEN.test(value);
}

/** 32 random bytes = 256 bits; base64url encodes them as 43 URL-safe chars. */
export function generateAuditInviteToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashAuditInviteToken(token: string): Promise<string> {
  if (!isAuditInviteToken(token)) throw new Error("Invalid audit invitation token.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export function auditInviteExpiry(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid invitation time.");
  return new Date(now.getTime() + AUDIT_INVITE_TTL_MS).toISOString();
}

function auditPublicBaseUrl(): string {
  const parsed = new URL(siteUrl());
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if ((!local && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error("NEXT_PUBLIC_SITE_URL must be a safe HTTPS origin.");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * The bearer lives in the fragment: browsers don't send it in the initial HTTP
 * request, access log or Referer. The page sends it once in a no-store POST.
 */
export function auditInvitationUrl(connectionId: string, token: string): string {
  if (!isAuditConnectionId(connectionId) || !isAuditInviteToken(token)) {
    throw new Error("Invalid audit invitation.");
  }
  return `${auditPublicBaseUrl()}/connect/shopify/${connectionId}#${token}`;
}

export async function createAuditInvitationMaterial(now = new Date()) {
  const id = crypto.randomUUID();
  const token = generateAuditInviteToken();
  const tokenHash = await hashAuditInviteToken(token);
  const expiresAt = auditInviteExpiry(now);
  return {
    id,
    token,
    tokenHash,
    expiresAt,
    url: auditInvitationUrl(id, token),
  };
}
