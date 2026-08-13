import "server-only";

import { ClientOnboardingError } from "@/lib/client-onboarding/sessions";
import { createServiceClient } from "@/lib/supabase/service";

const PORTAL_IDENTITY_COLUMNS =
  "id, full_name, email, discord_handle" as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISCORD_URL_PREFIX = /^(?:https?:\/\/|discord(?:app)?\.com\/|www\.)/i;
const DISCORD_WHITESPACE_OR_CONTROL = /\s|[\u0000-\u001f\u007f]/;

type PortalIdentity = {
  id: string;
  fullName: string;
  email: string;
  discordHandle: string | null;
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
    (row.discord_handle !== null && typeof row.discord_handle !== "string")
  ) {
    return null;
  }
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    discordHandle: row.discord_handle,
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
    left.discordHandle === right.discordHandle
  );
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
  if (!error && data === input.clientId) return desired;

  // Do not blindly compensate an ambiguous RPC response: it may have committed.
  // Re-read the exact row and restore Auth only if every database field is still
  // the before-snapshot. If the desired state is present, the operation is done.
  const verifiedResult = await readPortalIdentity(service, input.clientId);
  const verifiedPortal = verifiedResult.error
    ? null
    : asPortalIdentity(verifiedResult.data);
  if (verifiedPortal && sameIdentity(verifiedPortal, desired)) return desired;
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
