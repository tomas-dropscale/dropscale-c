import "server-only";

import { siteUrl } from "../site";

export const CLIENT_ONBOARDING_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

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

export function isClientOnboardingId(value: string): boolean {
  return UUID.test(value);
}

export function isClientOnboardingToken(value: string): boolean {
  return TOKEN.test(value);
}

export function generateClientOnboardingToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashClientOnboardingToken(token: string): Promise<string> {
  if (!isClientOnboardingToken(token)) {
    throw new Error("Invalid client onboarding invitation token.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export function clientOnboardingInviteExpiry(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid invitation time.");
  return new Date(now.getTime() + CLIENT_ONBOARDING_INVITE_TTL_MS).toISOString();
}

function publicBaseUrl(): string {
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
 * The bearer is a fragment so it is absent from HTTP access logs, Referer and
 * server-rendered props. The onboarding page captures it once and clears it.
 */
export function clientOnboardingInvitationUrl(sessionId: string, token: string): string {
  if (!isClientOnboardingId(sessionId) || !isClientOnboardingToken(token)) {
    throw new Error("Invalid client onboarding invitation.");
  }
  return `${publicBaseUrl()}/onboarding/client/${sessionId}#${token}`;
}

export async function createClientOnboardingInvitationMaterial(now = new Date()) {
  const id = crypto.randomUUID();
  const token = generateClientOnboardingToken();
  return {
    id,
    token,
    tokenHash: await hashClientOnboardingToken(token),
    expiresAt: clientOnboardingInviteExpiry(now),
    url: clientOnboardingInvitationUrl(id, token),
  };
}
