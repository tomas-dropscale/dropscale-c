import "server-only";

import { ClientOnboardingError } from "@/lib/client-onboarding/sessions";
import { createServiceClient } from "@/lib/supabase/service";

const PORTAL_IDENTITY_COLUMNS =
  "id, full_name, email, discord_handle, approval_status" as const;
const PASSWORD_RESET_REDIRECT =
  "https://dropscale.app/auth/callback?next=%2Freset-password";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISCORD_URL_PREFIX = /^(?:https?:\/\/|discord(?:app)?\.com\/|www\.)/i;
const DISCORD_WHITESPACE_OR_CONTROL = /\s|[\u0000-\u001f\u007f]/;

type PortalIdentity = {
  id: string;
  fullName: string;
  email: string;
  discordHandle: string | null;
  approvalStatus: string;
};

export type PortalClientIdentityInput = {
  clientId: string;
  fullName: string;
  email: string;
  discordHandle: string | null;
  adminId: string;
};

function serviceOrThrow() {
  const service = createServiceClient();
  if (!service) {
    throw new ClientOnboardingError(
      "server_not_configured",
      "Client administration is not configured on the server.",
      503,
    );
  }
  return service;
}

function normaliseIdentity(input: PortalClientIdentityInput): PortalClientIdentityInput {
  const fullName = input.fullName.trim().replace(/\s+/g, " ");
  const email = input.email.trim().toLowerCase();
  const rawDiscordHandle = input.discordHandle?.trim() ?? "";
  const discordHandle = rawDiscordHandle
    ? rawDiscordHandle.replace(/^@/, "")
    : null;

  if (
    fullName.length < 1 ||
    fullName.length > 160 ||
    email.length < 3 ||
    email.length > 320 ||
    !EMAIL.test(email) ||
    (discordHandle !== null &&
      (discordHandle.length < 2 ||
        discordHandle.length > 64 ||
        discordHandle.startsWith("@") ||
        DISCORD_WHITESPACE_OR_CONTROL.test(discordHandle) ||
        DISCORD_URL_PREFIX.test(discordHandle)))
  ) {
    throw new ClientOnboardingError(
      "invalid_request",
      "Enter a valid client name, email and Discord handle.",
      400,
    );
  }

  return { ...input, fullName, email, discordHandle };
}

function asPortalIdentity(value: unknown): PortalIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.full_name !== "string" ||
    typeof row.email !== "string" ||
    typeof row.approval_status !== "string" ||
    (row.discord_handle !== null && typeof row.discord_handle !== "string")
  ) {
    return null;
  }
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    discordHandle: row.discord_handle,
    approvalStatus: row.approval_status,
  };
}

async function readPortalIdentity(
  service: NonNullable<ReturnType<typeof createServiceClient>>,
  clientId: string,
) {
  return service
    .from("portal_clients")
    .select(PORTAL_IDENTITY_COLUMNS)
    .eq("id", clientId)
    .maybeSingle();
}

function sameIdentity(left: PortalIdentity, right: PortalIdentity) {
  return (
    left.id === right.id &&
    left.fullName === right.fullName &&
    left.email === right.email &&
    left.discordHandle === right.discordHandle &&
    left.approvalStatus === right.approvalStatus
  );
}

function publicIdentity(identity: PortalIdentity) {
  return {
    id: identity.id,
    fullName: identity.fullName,
    email: identity.email,
    discordHandle: identity.discordHandle,
  };
}

function databaseError(
  message = "The client identity could not be updated.",
) {
  return new ClientOnboardingError("database_error", message, 500);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function errorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
}

function errorMessage(error: unknown) {
  return error && typeof error === "object" && "message" in error
    ? (error as { message?: unknown }).message
    : undefined;
}

function identityWriteError(error: unknown) {
  const code = errorCode(error);
  if (code === "22023") {
    return new ClientOnboardingError(
      "invalid_request",
      "Enter a valid client name, email and Discord handle.",
      400,
    );
  }
  if (code === "P0002") {
    return new ClientOnboardingError("not_found", "Client not found.", 404);
  }
  if (code === "42501") {
    return new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  if (code === "23505") {
    return new ClientOnboardingError(
      "identity_exists",
      "That email is already used by another account.",
      409,
    );
  }
  return databaseError();
}

function authWriteError(error: unknown) {
  const code = errorCode(error);
  const status = errorStatus(error);
  const message = errorMessage(error);
  if (
    code === "email_exists" ||
    code === "user_already_exists" ||
    (typeof message === "string" && /already.{0,20}(registered|exists|used)/i.test(message))
  ) {
    return new ClientOnboardingError(
      "identity_exists",
      "That email is already used by another account.",
      409,
    );
  }
  if (status === 422 || code === "email_address_invalid") {
    return new ClientOnboardingError(
      "invalid_request",
      "Enter a valid client email.",
      400,
    );
  }
  return databaseError("The client login email could not be updated.");
}

function passwordResetError(error: unknown) {
  if (
    errorStatus(error) === 429 ||
    errorCode(error) === "over_request_rate_limit" ||
    errorCode(error) === "over_email_send_rate_limit"
  ) {
    return new ClientOnboardingError(
      "too_many_attempts",
      "Too many reset emails were requested. Wait a minute and try again.",
      429,
    );
  }
  return new ClientOnboardingError(
    "identity_failed",
    "The password reset email could not be sent.",
    502,
  );
}

async function readAuthEmail(
  service: NonNullable<ReturnType<typeof createServiceClient>>,
  clientId: string,
) {
  const { data, error } = await service.auth.admin.getUserById(clientId);
  const email = data.user?.email?.trim().toLowerCase() ?? null;
  return {
    email,
    confirmed: Boolean(data.user?.email_confirmed_at),
    error,
  };
}

async function changeAuthEmail(
  service: NonNullable<ReturnType<typeof createServiceClient>>,
  clientId: string,
  previousEmail: string,
  nextEmail: string,
  confirmed: boolean,
) {
  const result = await service.auth.admin.updateUserById(clientId, {
    email: nextEmail,
    email_confirm: confirmed,
  });
  if (
    !result.error &&
    result.data.user?.email?.trim().toLowerCase() === nextEmail
  ) {
    return;
  }

  // An Auth HTTP failure can be ambiguous. Re-read before deciding whether the
  // RPC may run; a confirmed target email means the mutation did land.
  const current = await readAuthEmail(service, clientId);
  if (!current.error && current.email === nextEmail) return;
  if (!current.error && current.email === previousEmail) {
    throw authWriteError(result.error);
  }
  throw databaseError(
    "The client login email update could not be verified. Refresh before retrying.",
  );
}

async function restoreAuthEmail(
  service: NonNullable<ReturnType<typeof createServiceClient>>,
  clientId: string,
  expectedEmail: string,
  previousEmail: string,
  wasConfirmed: boolean,
) {
  const current = await readAuthEmail(service, clientId);
  if (current.error) {
    throw databaseError(
      "The client login email changed, but its database update failed and the email could not be restored.",
    );
  }
  if (current.email === previousEmail) return;
  if (current.email !== expectedEmail) {
    throw databaseError(
      "The client login email changed again while the update was being restored. Refresh before retrying.",
    );
  }

  const restored = await service.auth.admin.updateUserById(clientId, {
    email: previousEmail,
    email_confirm: wasConfirmed,
  });
  if (
    !restored.error &&
    restored.data.user?.email?.trim().toLowerCase() === previousEmail
  ) {
    return;
  }
  const verified = await readAuthEmail(service, clientId);
  if (!verified.error && verified.email === previousEmail) return;
  throw databaseError(
    "The client login email changed, but its database update failed and the email could not be restored.",
  );
}

/**
 * Update one non-admin portal identity. Auth owns the login email, so it is
 * changed first and restored only after proving the database stayed unchanged.
 */
export async function updatePortalClientIdentity(
  rawInput: PortalClientIdentityInput,
) {
  const input = normaliseIdentity(rawInput);
  const service = serviceOrThrow();

  // Capture both authorities before the first mutation. These snapshots are
  // also the only safe compensation material if the transactional RPC fails.
  const [portalResult, authResult] = await Promise.all([
    readPortalIdentity(service, input.clientId),
    readAuthEmail(service, input.clientId),
  ]);
  if (portalResult.error) throw databaseError();
  const previousPortal = asPortalIdentity(portalResult.data);
  if (!previousPortal) {
    throw new ClientOnboardingError("not_found", "Client not found.", 404);
  }
  if (authResult.error || !authResult.email) {
    throw databaseError("The client login account could not be loaded.");
  }

  const desired: PortalIdentity = {
    id: input.clientId,
    fullName: input.fullName,
    email: input.email,
    discordHandle: input.discordHandle,
    approvalStatus: previousPortal.approvalStatus,
  };
  const authEmailChanged = authResult.email !== input.email;
  if (authEmailChanged) {
    await changeAuthEmail(
      service,
      input.clientId,
      authResult.email,
      input.email,
      authResult.confirmed,
    );
  }

  let data: unknown = null;
  let error: unknown = null;
  try {
    const result = await service.rpc(
      "update_portal_client_identity",
      {
        p_client_id: input.clientId,
        p_full_name: input.fullName,
        p_email: input.email,
        p_discord_handle: input.discordHandle,
        p_admin_id: input.adminId,
      },
    );
    data = result.data;
    error = result.error;
  } catch (rpcError) {
    error = rpcError;
  }
  if (!error && data === input.clientId) return publicIdentity(desired);

  // Do not blindly compensate an ambiguous RPC response: it may have committed.
  // Re-read the exact row and restore Auth only if every database field is still
  // the before-snapshot. If the desired state is present, the operation is done.
  const verifiedResult = await readPortalIdentity(service, input.clientId);
  const verifiedPortal = verifiedResult.error
    ? null
    : asPortalIdentity(verifiedResult.data);
  if (verifiedPortal && sameIdentity(verifiedPortal, desired)) {
    return publicIdentity(desired);
  }
  if (verifiedPortal && sameIdentity(verifiedPortal, previousPortal)) {
    if (authEmailChanged) {
      await restoreAuthEmail(
        service,
        input.clientId,
        input.email,
        authResult.email,
        authResult.confirmed,
      );
    }
    throw error ? identityWriteError(error) : databaseError();
  }
  throw databaseError(
    "The client identity update could not be verified. Refresh before retrying.",
  );
}

/** Send a recovery email to the current Auth email, never to browser input. */
export async function sendPortalClientPasswordReset(clientId: string) {
  const service = serviceOrThrow();
  const portalResult = await readPortalIdentity(service, clientId);
  if (portalResult.error) throw databaseError();
  const portal = asPortalIdentity(portalResult.data);
  if (!portal || portal.approvalStatus === "rejected") {
    throw new ClientOnboardingError("not_found", "Client not found.", 404);
  }

  const [authResult, profileResult] = await Promise.all([
    readAuthEmail(service, clientId),
    service.from("profiles").select("role").eq("id", clientId).maybeSingle(),
  ]);
  if (profileResult.error) throw databaseError();
  if (!profileResult.data) {
    throw new ClientOnboardingError(
      "invalid_state",
      "The client login account could not be loaded.",
      409,
    );
  }
  if (profileResult.data?.role === "admin") {
    throw new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  if (authResult.error) {
    throw new ClientOnboardingError(
      "identity_failed",
      "The client login account could not be loaded.",
      502,
    );
  }
  if (!authResult.email) {
    throw new ClientOnboardingError(
      "invalid_state",
      "The client login account could not be loaded.",
      409,
    );
  }
  if (authResult.email !== portal.email.trim().toLowerCase()) {
    throw new ClientOnboardingError(
      "invalid_state",
      "The client login email is still being updated. Refresh before retrying.",
      409,
    );
  }

  let error: unknown;
  try {
    ({ error } = await service.auth.resetPasswordForEmail(authResult.email, {
      redirectTo: PASSWORD_RESET_REDIRECT,
    }));
  } catch (cause) {
    throw passwordResetError(cause);
  }
  if (error) throw passwordResetError(error);
  return authResult.email;
}

/** Archive means revoke portal access and open links, never delete history. */
export async function archivePortalClient(clientId: string, adminId: string) {
  const service = serviceOrThrow();
  const { data, error } = await service.rpc(
    "archive_portal_client",
    {
      p_client_id: clientId,
      p_admin_id: adminId,
    },
  );
  if (error) throw identityWriteError(error);
  if (data !== clientId) throw databaseError("The client archive could not be verified.");
}

/**
 * Block is the reversible middle ground between "approved" and "archived":
 * the client cannot open the portal, but nothing about their billing, spend or
 * reporting changes. Archiving (above) is the one-way door; this is the switch.
 */
export async function setPortalClientAccessBlock(
  clientId: string,
  adminId: string,
  blocked: boolean,
) {
  const service = serviceOrThrow();
  const { data, error } = await service.rpc(
    "set_portal_client_access_block",
    {
      p_client_id: clientId,
      p_admin_id: adminId,
      p_blocked: blocked,
    },
  );
  if (error) throw identityWriteError(error);
  if (data !== clientId) {
    throw databaseError("The client access change could not be verified.");
  }
}

/**
 * Say which store a Google Ads account's spend belongs to.
 *
 * The client-facing step that used to do this is unreachable: the Windsor poll
 * submits the session a second after the account connects, and submitting
 * clears the invite token the client-side RPC requires. An account connected
 * today therefore arrives unmapped with no way to fix it.
 */
/**
 * A mapping refusal is a statement about reporting, not about the client's
 * identity. Borrowing identityWriteError here answered a failed link with
 * "The client identity could not be updated." — and a duplicate would have
 * claimed the email was taken. The database already explains these refusals
 * precisely ("A staged Google Ads source is reserved for another Shopify
 * mapping"), and this route is admin-only, so its wording is carried through
 * instead of being replaced by a guess.
 */
function assetMappingWriteError(error: unknown) {
  const code = errorCode(error);
  if (code === "42501") {
    return new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  if (code === "P0002") {
    return new ClientOnboardingError(
      "not_found",
      "That store or Google Ads account is no longer connected.",
      404,
    );
  }
  // 22023 is the adoption RPC stating its own input contract. Without it the
  // caller got a generic "could not be saved", which reads like a fault on our
  // side rather than a refusal with a reason.
  if (code === "23514" || code === "23503" || code === "23505" || code === "22023") {
    const explanation = errorMessage(error);
    const stated =
      typeof explanation === "string" && explanation.trim().length > 0
        ? explanation.trim().slice(0, 300)
        : null;
    return new ClientOnboardingError(
      "invalid_state",
      stated ?? "This account cannot be linked to that store yet.",
      409,
    );
  }
  return databaseError("The store mapping could not be saved.");
}

/**
 * Name a Google Ads account, or clear the name back to Windsor's.
 *
 * The name is stored beside Windsor's rather than over it: every reconnect
 * rewrites account_name from what Windsor just reported, so a name written
 * there would disappear the next time the client reconnects.
 */
export async function renameClientGoogleAdsAccount(input: {
  googleAdsConnectionId: string;
  label: string | null;
  adminId: string;
}) {
  const service = serviceOrThrow();
  const { data, error } = await service.rpc("set_client_google_ads_admin_label", {
    p_connection_id: input.googleAdsConnectionId,
    p_label: input.label,
    p_admin_id: input.adminId,
  });
  if (error) throw googleAdsLabelWriteError(error);
  if (data !== input.googleAdsConnectionId) {
    throw databaseError("The account name could not be saved.");
  }
}

function googleAdsLabelWriteError(error: unknown) {
  const code = errorCode(error);
  if (code === "42501") {
    return new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  if (code === "P0002") {
    return new ClientOnboardingError(
      "not_found",
      "That Google Ads account no longer exists.",
      404,
    );
  }
  if (code === "22023" || code === "23514") {
    return new ClientOnboardingError(
      "invalid_request",
      "Enter a name of 80 characters or fewer, without line breaks.",
      400,
    );
  }
  return databaseError("The account name could not be saved.");
}

export async function mapGoogleAdsAccountToStore(input: {
  googleAdsConnectionId: string;
  shopifyConnectionId: string;
  adminId: string;
}) {
  const service = serviceOrThrow();

  // A Google source that is already BOUND standalone needs more than a mapping:
  // the resolver rejects a mapped Google binding that has no Shopify anchor
  // (reporting/sources.ts), so writing only the mapping would blank the whole
  // client. Adopt it into the anchor instead - one RPC that writes the mapping
  // and answers the binding's null anchor in the same transaction.
  const adopted = await adoptExistingBindingIfAny(service, input);
  if (adopted) return;

  // A Google source already PAIRED with a store is a different move again: the
  // client is swapping stores under the same Google account. The handover RPC
  // retires the pair, keeps the old store's history on its own account, and
  // re-binds the source as a child of the requested store's anchor - with the
  // billing boundary as the split point.
  const handed = await handoverExistingPairIfAny(service, input);
  if (handed) return;

  const { data, error } = await service.rpc("map_client_google_ads_to_store", {
    p_google_ads_connection_id: input.googleAdsConnectionId,
    p_shopify_connection_id: input.shopifyConnectionId,
    p_admin_id: input.adminId,
  });
  if (error) throw assetMappingWriteError(error);
  if (data !== input.googleAdsConnectionId) {
    throw databaseError("The store mapping could not be verified.");
  }
}

/**
 * Fill in the anchor of an already-bound standalone Google source.
 *
 * Returns false when this connection has no such binding, leaving the caller on
 * the ordinary pre-binding mapping path. Any anchor whose store does not match
 * the requested one is simply not adopted - the RPC is the authority on whether
 * the pair is legitimate, exactly as the mapping RPC is.
 */
async function adoptExistingBindingIfAny(
  service: ReturnType<typeof serviceOrThrow>,
  input: { googleAdsConnectionId: string; shopifyConnectionId: string; adminId: string },
): Promise<boolean> {
  type BindingRow = {
    id: string;
    client_id: string;
    status: string;
    shopify_connection_id: string | null;
    shopify_anchor_binding_id: string | null;
  };
  const COLUMNS = "id, client_id, status, shopify_connection_id, shopify_anchor_binding_id";

  // Deliberately one filter per read, with the rest applied here: the shape a
  // binding must have to be adoptable is a rule worth stating in code rather
  // than spreading across PostgREST operators.
  const { data: byGoogle } = await service
    .from("client_reporting_bindings")
    .select(COLUMNS)
    .eq("google_ads_connection_id", input.googleAdsConnectionId);
  const child = ((byGoogle ?? []) as BindingRow[]).find(
    (row) =>
      row.status === "active" &&
      row.shopify_connection_id === null &&
      row.shopify_anchor_binding_id === null,
  );
  if (!child) return false;

  const { data: byShopify } = await service
    .from("client_reporting_bindings")
    .select(COLUMNS)
    .eq("shopify_connection_id", input.shopifyConnectionId);
  const anchor = ((byShopify ?? []) as BindingRow[]).find(
    (row) =>
      row.status === "active" &&
      row.client_id === child.client_id &&
      row.shopify_anchor_binding_id === null,
  );
  if (!anchor) {
    throw new ClientOnboardingError(
      "invalid_state",
      "That store has no active reporting anchor to attach this account to.",
      409,
    );
  }

  const { data, error } = await service.rpc("adopt_client_reporting_google_child", {
    p_binding_id: child.id,
    p_shopify_anchor_binding_id: anchor.id,
    p_admin_id: input.adminId,
    p_idempotency_key: `adopt:${child.id}:${anchor.id}`,
    p_reason: "Admin linked an unanchored Google source to its store.",
  });
  if (error) throw assetMappingWriteError(error);
  if (data !== child.id) {
    throw databaseError("The store link could not be verified.");
  }
  return true;
}

/**
 * Move an already-paired Google source to another of the client's stores.
 *
 * Returns false when this connection has no active paired binding, leaving the
 * caller on its other paths. The RPC is the authority on whether the move is
 * legitimate - most importantly that the old store's Google billing boundary
 * is already CLOSED (Stop counting), so no euro can bill twice.
 */
async function handoverExistingPairIfAny(
  service: ReturnType<typeof serviceOrThrow>,
  input: { googleAdsConnectionId: string; shopifyConnectionId: string; adminId: string },
): Promise<boolean> {
  type BindingRow = {
    id: string;
    client_id: string;
    status: string;
    shopify_connection_id: string | null;
    shopify_anchor_binding_id: string | null;
  };
  const COLUMNS = "id, client_id, status, shopify_connection_id, shopify_anchor_binding_id";

  const { data: byGoogle } = await service
    .from("client_reporting_bindings")
    .select(COLUMNS)
    .eq("google_ads_connection_id", input.googleAdsConnectionId);
  const rows = (byGoogle ?? []) as BindingRow[];
  // A pair carries its store directly; a child carries it through its anchor.
  // Both are handovers - a child is simply what a previous handover left
  // behind, which is exactly what makes the succession repeatable.
  const source = rows.find(
    (row) =>
      row.status === "active" &&
      (row.shopify_connection_id !== null || row.shopify_anchor_binding_id !== null),
  );
  if (!source) return false;

  let currentShopify = source.shopify_connection_id;
  if (!currentShopify && source.shopify_anchor_binding_id) {
    const { data: anchorRows } = await service
      .from("client_reporting_bindings")
      .select(COLUMNS)
      .eq("id", source.shopify_anchor_binding_id);
    currentShopify =
      ((anchorRows ?? []) as BindingRow[])[0]?.shopify_connection_id ?? null;
  }
  // Selecting the store it already reports to is not a move.
  if (currentShopify === input.shopifyConnectionId) return true;
  const pair = source;

  const { data: byShopify } = await service
    .from("client_reporting_bindings")
    .select(COLUMNS)
    .eq("shopify_connection_id", input.shopifyConnectionId);
  const anchor = ((byShopify ?? []) as BindingRow[]).find(
    (row) =>
      row.status === "active" &&
      row.client_id === pair.client_id &&
      row.shopify_anchor_binding_id === null,
  );
  if (!anchor) {
    throw new ClientOnboardingError(
      "invalid_state",
      "That store has no active reporting anchor to attach this account to.",
      409,
    );
  }

  const { data, error } = await service.rpc("handover_client_reporting_google_source", {
    p_source_binding_id: pair.id,
    p_target_anchor_binding_id: anchor.id,
    p_admin_id: input.adminId,
    p_idempotency_key: `handover:${pair.id}:${anchor.id}`,
    p_reason: "Admin moved the Google source to the store it now advertises.",
  });
  if (error) throw assetMappingWriteError(error);
  if (typeof data !== "string" || !/^[0-9a-f-]{36}$/i.test(data)) {
    throw databaseError("The store handover could not be verified.");
  }
  return true;
}

/**
 * Owner decision (2026-08-19): "Remove client" is a FULL delete — the client
 * and every row of theirs leaves the platform. Stripe keeps its own invoice
 * records; nothing recoverable remains here.
 */
export async function deletePortalClientCompletely(
  clientId: string,
  adminId: string,
) {
  const service = serviceOrThrow();
  const { data, error } = await service.rpc(
    "delete_portal_client_completely",
    {
      p_client_id: clientId,
      p_admin_id: adminId,
    },
  );
  if (error) throw identityWriteError(error);
  if (data !== clientId) throw databaseError("The client deletion could not be verified.");
}
