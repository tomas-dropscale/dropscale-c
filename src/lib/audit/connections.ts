import "server-only";

import { encryptToken } from "@/lib/google-ads/crypto";
import {
  auditInvitationUrl,
  createAuditInvitationMaterial,
  hashAuditInviteToken,
} from "@/lib/audit/invitations";
import type { VerifiedAuditShop } from "@/lib/audit/shopify";
import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { AuditShopifyConnection } from "@/lib/supabase/types";

const SAFE_CONNECTION_COLUMNS =
  "id, store_label, status, invite_expires_at, failed_attempts, shopify_name, shopify_domain, primary_domain, shopify_currency, credential_hint, granted_scopes, scope_profile, created_at, updated_at, connected_at, last_verified_at, reviewed_at, revoked_at, last_error_code" as const;

export type AuditConnectionDisplayStatus =
  | "waiting"
  | "expired"
  | "connected"
  | "revoked";

export type AuditConnectionDTO = {
  id: string;
  storeLabel: string;
  status: AuditConnectionDisplayStatus;
  inviteExpiresAt: string | null;
  failedAttempts: number;
  shopifyName: string | null;
  shopifyDomain: string | null;
  primaryDomain: string | null;
  currency: string | null;
  credentialHint: string | null;
  grantedScopes: string[];
  scopeProfile: string;
  createdAt: string;
  updatedAt: string;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  reviewedAt: string | null;
  revokedAt: string | null;
  lastErrorCode: string | null;
  needsReview: boolean;
};

export class AuditConnectionError extends Error {
  constructor(
    public readonly code:
      | "unauthorised"
      | "forbidden"
      | "server_not_configured"
      | "invalid_invitation"
      | "invitation_expired"
      | "too_many_attempts"
      | "duplicate_store"
      | "not_found"
      | "invalid_state"
      | "database_error",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuditConnectionError";
  }
}

function displayStatus(
  status: AuditShopifyConnection["status"],
  inviteExpiresAt: string | null,
  now = Date.now(),
): AuditConnectionDisplayStatus {
  if (status === "connected") return "connected";
  if (status === "revoked") return "revoked";
  return inviteExpiresAt && new Date(inviteExpiresAt).getTime() <= now
    ? "expired"
    : "waiting";
}

function toDTO(row: Record<string, unknown>): AuditConnectionDTO {
  const status = displayStatus(
    row.status as AuditShopifyConnection["status"],
    typeof row.invite_expires_at === "string" ? row.invite_expires_at : null,
  );
  const reviewedAt = typeof row.reviewed_at === "string" ? row.reviewed_at : null;
  return {
    id: String(row.id),
    storeLabel: String(row.store_label),
    status,
    inviteExpiresAt:
      typeof row.invite_expires_at === "string" ? row.invite_expires_at : null,
    failedAttempts:
      typeof row.failed_attempts === "number" ? row.failed_attempts : 0,
    shopifyName: typeof row.shopify_name === "string" ? row.shopify_name : null,
    shopifyDomain: typeof row.shopify_domain === "string" ? row.shopify_domain : null,
    primaryDomain: typeof row.primary_domain === "string" ? row.primary_domain : null,
    currency: typeof row.shopify_currency === "string" ? row.shopify_currency : null,
    credentialHint: typeof row.credential_hint === "string" ? row.credential_hint : null,
    grantedScopes: Array.isArray(row.granted_scopes)
      ? row.granted_scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    scopeProfile: String(row.scope_profile),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    connectedAt: typeof row.connected_at === "string" ? row.connected_at : null,
    lastVerifiedAt:
      typeof row.last_verified_at === "string" ? row.last_verified_at : null,
    reviewedAt,
    revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
    lastErrorCode:
      typeof row.last_error_code === "string" ? row.last_error_code : null,
    needsReview: status === "connected" && !reviewedAt,
  };
}

export async function requireAuditAdmin() {
  const { user, profile } = await getSessionProfile();
  if (!user) {
    throw new AuditConnectionError("unauthorised", "Unauthorised.", 401);
  }
  if (profile?.role !== "admin") {
    throw new AuditConnectionError("forbidden", "Forbidden.", 403);
  }
  return profile;
}

function serviceOrThrow() {
  const service = createServiceClient();
  if (!service || !process.env.GOOGLE_ADS_TOKEN_ENC_KEY?.trim()) {
    throw new AuditConnectionError(
      "server_not_configured",
      "Server-side audit connections are not configured.",
      503,
    );
  }
  return service;
}

/** Admin-only DAL: service role is created only after the database-backed role check. */
export async function listAuditConnections(): Promise<AuditConnectionDTO[]> {
  await requireAuditAdmin();
  const service = serviceOrThrow();
  const { data, error } = await service
    .from("audit_shopify_connections")
    .select(SAFE_CONNECTION_COLUMNS)
    .neq("status", "revoked")
    .order("created_at", { ascending: false });

  if (error) {
    throw new AuditConnectionError(
      "database_error",
      "Could not load audit connections.",
      500,
    );
  }
  return (data ?? [])
    .map((row) => toDTO(row as unknown as Record<string, unknown>))
    .filter((connection) => connection.status !== "revoked");
}

function normaliseStoreLabel(value: string): string {
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 120) {
    throw new AuditConnectionError(
      "invalid_state",
      "Store name must contain between 1 and 120 characters.",
      400,
    );
  }
  return label;
}

export async function createAuditConnection(storeLabel: string, adminId: string) {
  const service = serviceOrThrow();
  const label = normaliseStoreLabel(storeLabel);
  const invitation = await createAuditInvitationMaterial();
  const { data, error } = await service.rpc("create_audit_shopify_invitation", {
    p_connection_id: invitation.id,
    p_store_label: label,
    p_token_hash: invitation.tokenHash,
    p_expires_at: invitation.expiresAt,
    p_created_by: adminId,
  });

  if (error || data !== invitation.id) {
    throw new AuditConnectionError(
      "database_error",
      "Could not create the audit invitation.",
      500,
    );
  }
  return {
    id: invitation.id,
    storeLabel: label,
    url: invitation.url,
    expiresAt: invitation.expiresAt,
  };
}

export async function rotateAuditConnectionInvite(connectionId: string, adminId: string) {
  const service = serviceOrThrow();
  const invitation = await createAuditInvitationMaterial();
  const { data, error } = await service.rpc("rotate_audit_shopify_invitation", {
    p_connection_id: connectionId,
    p_token_hash: invitation.tokenHash,
    p_expires_at: invitation.expiresAt,
    p_admin_id: adminId,
  });
  if (error || data !== connectionId) {
    throw new AuditConnectionError(
      error?.code === "P0002" ? "invalid_state" : "database_error",
      error?.code === "P0002"
        ? "Only a pending invitation can be replaced."
        : "Could not replace the audit invitation.",
      error?.code === "P0002" ? 409 : 500,
    );
  }

  // The replacement material generated a different id only for entropy; the
  // public route must keep the existing connection id.
  const token = invitation.token;
  return {
    id: connectionId,
    url: auditInvitationUrl(connectionId, token),
    expiresAt: invitation.expiresAt,
  };
}

export async function revokeAuditConnection(connectionId: string, adminId: string) {
  const service = serviceOrThrow();
  const { data, error } = await service.rpc("revoke_audit_shopify_connection", {
    p_connection_id: connectionId,
    p_admin_id: adminId,
  });
  if (error || data !== connectionId) {
    throw new AuditConnectionError(
      error?.code === "P0002" ? "not_found" : "database_error",
      error?.code === "P0002"
        ? "Audit connection not found."
        : "Could not revoke the audit connection.",
      error?.code === "P0002" ? 404 : 500,
    );
  }
}

export async function reviewAuditConnection(connectionId: string, adminId: string) {
  const service = serviceOrThrow();
  const { data, error } = await service.rpc("review_audit_shopify_connection", {
    p_connection_id: connectionId,
    p_admin_id: adminId,
  });
  if (error || data !== connectionId) {
    throw new AuditConnectionError(
      error?.code === "P0002" ? "not_found" : "database_error",
      error?.code === "P0002"
        ? "Connected audit store not found."
        : "Could not review the audit connection.",
      error?.code === "P0002" ? 404 : 500,
    );
  }
}

export type ValidAuditInvitation = {
  id: string;
  tokenHash: string;
};

/** Public authorization boundary: the raw bearer is hashed before the lookup. */
export async function validateAuditInvitation(
  connectionId: string,
  token: string,
): Promise<ValidAuditInvitation> {
  const service = serviceOrThrow();
  let tokenHash: string;
  try {
    tokenHash = await hashAuditInviteToken(token);
  } catch {
    throw new AuditConnectionError(
      "invalid_invitation",
      "This connection link is invalid or no longer available.",
      404,
    );
  }

  const { data, error } = await service
    .from("audit_shopify_connections")
    .select("id, status, invite_expires_at, created_by, failed_attempts")
    .eq("id", connectionId)
    .eq("invite_token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw new AuditConnectionError(
      "database_error",
      "The connection link could not be checked.",
      500,
    );
  }
  if (!data || data.status !== "pending") {
    throw new AuditConnectionError(
      "invalid_invitation",
      "This connection link is invalid or no longer available.",
      404,
    );
  }
  if (!data.invite_expires_at || new Date(data.invite_expires_at).getTime() <= Date.now()) {
    throw new AuditConnectionError(
      "invitation_expired",
      "This connection link has expired. Ask Dropscale for a new link.",
      410,
    );
  }
  if (data.failed_attempts >= 10) {
    throw new AuditConnectionError(
      "too_many_attempts",
      "This connection link has had too many unsuccessful attempts. Ask Dropscale for a new link.",
      429,
    );
  }

  // Fail before sending merchant credentials to Shopify if the admin who
  // created the invitation no longer holds that role.
  const { data: creator, error: creatorError } = await service
    .from("profiles")
    .select("role")
    .eq("id", data.created_by)
    .maybeSingle();
  if (creatorError || creator?.role !== "admin") {
    throw new AuditConnectionError(
      "invalid_invitation",
      "This connection link is invalid or no longer available.",
      404,
    );
  }

  return { id: data.id, tokenHash };
}

export async function completeAuditConnection({
  invitation,
  shop,
  clientId,
  clientSecret,
}: {
  invitation: ValidAuditInvitation;
  shop: VerifiedAuditShop;
  clientId: string;
  clientSecret: string;
}) {
  const service = serviceOrThrow();
  const cipher = await encryptToken(clientSecret.trim());
  const hint = clientSecret.trim().slice(-4);
  const { data, error } = await service.rpc("complete_audit_shopify_connection", {
    p_connection_id: invitation.id,
    p_token_hash: invitation.tokenHash,
    p_shopify_shop_id: shop.shopId,
    p_shopify_name: shop.name,
    p_shopify_domain: shop.myshopifyDomain,
    p_primary_domain: shop.primaryDomain,
    p_shopify_currency: shop.currencyCode,
    p_shopify_client_id: clientId.trim(),
    p_credential_hint: hint,
    p_granted_scopes: shop.scopes.granted,
    p_client_secret_ciphertext: cipher,
  });

  if (error || data !== invitation.id) {
    if (error?.code === "23505") {
      throw new AuditConnectionError(
        "duplicate_store",
        "This Shopify store already has an active audit connection.",
        409,
      );
    }
    if (error?.code === "P0002" || error?.code === "22023") {
      throw new AuditConnectionError(
        "invalid_invitation",
        "This connection link is invalid or no longer available.",
        409,
      );
    }
    throw new AuditConnectionError(
      "database_error",
      "The verified Shopify connection could not be saved.",
      500,
    );
  }
}

/** Safe diagnostic only; no request body, token, digest or ciphertext is logged. */
export async function recordAuditConnectionFailure(
  invitation: ValidAuditInvitation,
  code: string,
): Promise<void> {
  const service = createServiceClient();
  if (!service) return;
  const safeCode = /^[a-z0-9_]{2,64}$/.test(code) ? code : "verification_failed";
  await service.rpc("record_audit_shopify_invitation_failure", {
    p_connection_id: invitation.id,
    p_token_hash: invitation.tokenHash,
    p_error_code: safeCode,
  });
}
