import "server-only";

import {
  clientOnboardingInvitationUrl,
  createClientOnboardingInvitationMaterial,
  hashClientOnboardingToken,
  isClientOnboardingId,
  isClientOnboardingToken,
} from "@/lib/client-onboarding/invitations";
import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { normalizeShopDomain } from "@/lib/shopify/client";
import type {
  AdAccount,
  ClientGoogleAdsConnection,
  ClientOnboardingAsset,
  ClientOnboardingMode,
  ClientOnboardingSession,
  ClientShopifyReconnectTargetSource,
  ClientShopifyConnection,
} from "@/lib/supabase/types";

const SAFE_SESSION_COLUMNS =
  "id, mode, requested_assets, status, invite_expires_at, failed_attempts, target_client_id, reconnect_legacy_ad_account_id, reconnect_shopify_connection_id, reconnect_completed_at, claimed_user_id, first_name, last_name, email, discord_handle, created_at, updated_at, identity_created_at, submitted_at, reviewed_at, activated_at, last_error_code" as const;
const AUTH_SESSION_COLUMNS = `${SAFE_SESSION_COLUMNS}, invite_token_hash, created_by` as const;
const SAFE_SHOPIFY_COLUMNS =
  "id, session_id, client_id, status, shopify_name, shopify_domain, primary_domain, shopify_currency, granted_scopes, connected_at, last_verified_at, last_error_code" as const;
const SAFE_GOOGLE_COLUMNS =
  "id, session_id, client_id, status, windsor_account_id, account_name, currency, time_zone, connected_at, last_verified_at, last_error_code" as const;

export type ClientOnboardingPublicStatus =
  | "waiting"
  | "expired"
  | "collecting"
  | "submitted"
  | "reviewed"
  | "active";

export type ClientOnboardingShopifyDTO = {
  id: string;
  sessionId: string;
  name: string;
  domain: string;
  primaryDomain: string | null;
  currency: string;
  grantedScopes: string[];
  connectedAt: string;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
};

export type ClientOnboardingGoogleDTO = {
  id: string;
  sessionId: string;
  customerId: string;
  accountName: string;
  currency: string | null;
  timeZone: string | null;
  connectedAt: string;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
};

export type ClientOnboardingShopifyReconnectTargetDTO = {
  source: ClientShopifyReconnectTargetSource;
  id: string;
  name: string;
  domain: string;
  currency: string | null;
};

export type ClientOnboardingShopifyReconnectTarget = Pick<
  ClientOnboardingShopifyReconnectTargetDTO,
  "source" | "id"
>;

export type ClientOnboardingSessionDTO = {
  id: string;
  mode: ClientOnboardingMode;
  requestedAssets: ClientOnboardingAsset[];
  status: ClientOnboardingPublicStatus;
  rawStatus: ClientOnboardingSession["status"];
  inviteExpiresAt: string | null;
  targetClientId: string | null;
  targetClientName: string | null;
  reconnectTarget: ClientOnboardingShopifyReconnectTargetDTO | null;
  reconnectCompletedAt: string | null;
  claimedUserId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  discordHandle?: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  activatedAt: string | null;
  lastErrorCode: string | null;
  shopify: ClientOnboardingShopifyDTO[];
  googleAds: ClientOnboardingGoogleDTO[];
  mappings: Array<{ shopifyConnectionId: string; googleAdsConnectionId: string }>;
  needsReview: boolean;
};

export type ClientOnboardingAuthorization = {
  session: ClientOnboardingSession;
  tokenHash: string;
  actorUserId: string | null;
  usingInvitation: boolean;
};

export class ClientOnboardingError extends Error {
  constructor(
    public readonly code:
      | "unauthorised"
      | "forbidden"
      | "server_not_configured"
      | "invalid_invitation"
      | "invitation_expired"
      | "too_many_attempts"
      | "invalid_request"
      | "identity_exists"
      | "identity_failed"
      | "not_found"
      | "invalid_state"
      | "database_error",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ClientOnboardingError";
  }
}

function serviceOrThrow() {
  const service = createServiceClient();
  if (!service) {
    throw new ClientOnboardingError(
      "server_not_configured",
      "Client onboarding is not configured on the server.",
      503,
    );
  }
  return service;
}

export async function requireClientOnboardingAdmin() {
  const { user, profile } = await getSessionProfile();
  if (!user) {
    throw new ClientOnboardingError("unauthorised", "Unauthorised.", 401);
  }
  if (profile?.role !== "admin") {
    throw new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  return profile;
}

function publicStatus(
  status: ClientOnboardingSession["status"],
  expiresAt: string | null,
): ClientOnboardingPublicStatus {
  if (
    (status === "pending" || status === "collecting") &&
    expiresAt &&
    new Date(expiresAt).getTime() <= Date.now()
  ) {
    return "expired";
  }
  if (status === "pending") return "waiting";
  if (status === "revoked") return "expired";
  return status;
}

function asShopifyDTO(row: ClientShopifyConnection): ClientOnboardingShopifyDTO {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.shopify_name,
    domain: row.shopify_domain,
    primaryDomain: row.primary_domain,
    currency: row.shopify_currency,
    grantedScopes: row.granted_scopes,
    connectedAt: row.connected_at,
    lastVerifiedAt: row.last_verified_at,
    lastErrorCode: row.last_error_code,
  };
}

function asGoogleDTO(row: ClientGoogleAdsConnection): ClientOnboardingGoogleDTO {
  return {
    id: row.id,
    sessionId: row.session_id,
    customerId: row.windsor_account_id,
    accountName: row.account_name,
    currency: row.currency,
    timeZone: row.time_zone,
    connectedAt: row.connected_at,
    lastVerifiedAt: row.last_verified_at,
    lastErrorCode: row.last_error_code,
  };
}

type SafeSessionRow = Omit<
  ClientOnboardingSession,
  | "invite_token_hash"
  | "last_attempt_at"
  | "created_by"
  | "reviewed_by"
  | "revoked_at"
>;

function toDTO(
  row: SafeSessionRow,
  targetClientName: string | null,
  shopify: ClientShopifyConnection[],
  googleAds: ClientGoogleAdsConnection[],
  mappings: Array<{ shopify_connection_id: string; google_ads_connection_id: string }>,
  aggregateByClient: boolean,
  reconnectTargets: ReadonlyMap<string, ClientOnboardingShopifyReconnectTargetDTO>,
): ClientOnboardingSessionDTO {
  const ownerId = row.claimed_user_id ?? row.target_client_id;
  const shops = shopify
    .filter((item) =>
      aggregateByClient && ownerId ? item.client_id === ownerId : item.session_id === row.id,
    )
    .map(asShopifyDTO);
  const ads = googleAds
    .filter((item) =>
      aggregateByClient && ownerId ? item.client_id === ownerId : item.session_id === row.id,
    )
    .map(asGoogleDTO);
  return {
    id: row.id,
    mode: row.mode,
    requestedAssets: row.requested_assets,
    status: publicStatus(row.status, row.invite_expires_at),
    rawStatus: row.status,
    inviteExpiresAt: row.invite_expires_at,
    targetClientId: row.target_client_id,
    targetClientName,
    reconnectTarget: row.reconnect_legacy_ad_account_id
      ? reconnectTargets.get(`legacy:${row.reconnect_legacy_ad_account_id}`) ?? null
      : row.reconnect_shopify_connection_id
        ? reconnectTargets.get(`onboarding:${row.reconnect_shopify_connection_id}`) ?? null
        : null,
    reconnectCompletedAt: row.reconnect_completed_at,
    claimedUserId: row.claimed_user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    discordHandle: row.discord_handle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    activatedAt: row.activated_at,
    lastErrorCode: row.last_error_code,
    shopify: shops,
    googleAds: ads,
    mappings: mappings
      .filter(
        (item) =>
          shops.some((shop) => shop.id === item.shopify_connection_id) &&
          ads.some((account) => account.id === item.google_ads_connection_id),
      )
      .map((item) => ({
        shopifyConnectionId: item.shopify_connection_id,
        googleAdsConnectionId: item.google_ads_connection_id,
      })),
    needsReview: row.status === "submitted",
  };
}

async function loadSessionBundle(
  sessionRows: SafeSessionRow[],
  aggregateByClient = false,
): Promise<ClientOnboardingSessionDTO[]> {
  if (sessionRows.length === 0) return [];
  const service = serviceOrThrow();
  const ids = sessionRows.map((session) => session.id);
  const clientIds = [
    ...new Set(
      sessionRows.flatMap((session) => {
        const ownerId = session.claimed_user_id ?? session.target_client_id;
        return ownerId ? [ownerId] : [];
      }),
    ),
  ];
  const targetIds = [
    ...new Set(
      sessionRows.flatMap((session) =>
        session.target_client_id ? [session.target_client_id] : [],
      ),
    ),
  ];
  const legacyReconnectIds = [
    ...new Set(
      sessionRows.flatMap((session) =>
        session.reconnect_legacy_ad_account_id
          ? [session.reconnect_legacy_ad_account_id]
          : [],
      ),
    ),
  ];
  const onboardingReconnectIds = [
    ...new Set(
      sessionRows.flatMap((session) =>
        session.reconnect_shopify_connection_id
          ? [session.reconnect_shopify_connection_id]
          : [],
      ),
    ),
  ];
  const connectionScope = aggregateByClient ? clientIds : ids;
  const connectionColumn = aggregateByClient ? "client_id" : "session_id";
  const [
    shopsResult,
    adsResult,
    clientsResult,
    legacyReconnectResult,
    onboardingReconnectResult,
  ] = await Promise.all([
    connectionScope.length
      ? service
          .from("client_shopify_connections")
          .select(SAFE_SHOPIFY_COLUMNS)
          .in(connectionColumn, connectionScope)
          .eq("status", "connected")
      : Promise.resolve({ data: [], error: null }),
    connectionScope.length
      ? service
          .from("client_google_ads_connections")
          .select(SAFE_GOOGLE_COLUMNS)
          .in(connectionColumn, connectionScope)
          .eq("status", "connected")
      : Promise.resolve({ data: [], error: null }),
    targetIds.length
      ? service.from("portal_clients").select("id, full_name").in("id", targetIds)
      : Promise.resolve({ data: [], error: null }),
    legacyReconnectIds.length
      ? service
          .from("ad_accounts")
          .select("id, store_name, shopify_url, currency")
          .in("id", legacyReconnectIds)
      : Promise.resolve({ data: [], error: null }),
    onboardingReconnectIds.length
      ? service
          .from("client_shopify_connections")
          .select(SAFE_SHOPIFY_COLUMNS)
          .in("id", onboardingReconnectIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (
    shopsResult.error ||
    adsResult.error ||
    clientsResult.error ||
    legacyReconnectResult.error ||
    onboardingReconnectResult.error
  ) {
    throw new ClientOnboardingError(
      "database_error",
      "Could not load client onboarding assets.",
      500,
    );
  }
  const shopRows = (shopsResult.data ?? []) as ClientShopifyConnection[];
  const adRows = (adsResult.data ?? []) as ClientGoogleAdsConnection[];
  const shopIds = shopRows.map((shop) => shop.id);
  const mappingsResult = shopIds.length
    ? await service
        .from("client_asset_mappings")
        .select("session_id, shopify_connection_id, google_ads_connection_id")
        .in("shopify_connection_id", shopIds)
    : { data: [], error: null };
  if (mappingsResult.error) {
    throw new ClientOnboardingError(
      "database_error",
      "Could not load client onboarding asset mappings.",
      500,
    );
  }
  const targetNames = new Map(
    (clientsResult.data ?? []).map((client) => [client.id, client.full_name]),
  );
  const reconnectTargets = new Map<
    string,
    ClientOnboardingShopifyReconnectTargetDTO
  >();
  for (const row of (legacyReconnectResult.data ?? []) as Array<
    Pick<AdAccount, "id" | "store_name" | "shopify_url" | "currency">
  >) {
    const domain = row.shopify_url ? normalizeShopDomain(row.shopify_url) : null;
    if (!domain) continue;
    reconnectTargets.set(`legacy:${row.id}`, {
      source: "legacy",
      id: row.id,
      name: row.store_name.trim() || domain,
      domain,
      currency: row.currency,
    });
  }
  for (const row of (onboardingReconnectResult.data ?? []) as ClientShopifyConnection[]) {
    reconnectTargets.set(`onboarding:${row.id}`, {
      source: "onboarding",
      id: row.id,
      name: row.shopify_name,
      domain: row.shopify_domain,
      currency: row.shopify_currency,
    });
  }
  return sessionRows.map((row) =>
    toDTO(
      row,
      row.target_client_id ? targetNames.get(row.target_client_id) ?? null : null,
      shopRows,
      adRows,
      mappingsResult.data ?? [],
      aggregateByClient,
      reconnectTargets,
    ),
  );
}

export async function listClientOnboardingSessions(): Promise<ClientOnboardingSessionDTO[]> {
  await requireClientOnboardingAdmin();
  const service = serviceOrThrow();
  const { data, error } = await service
    .from("client_onboarding_sessions")
    .select(SAFE_SESSION_COLUMNS)
    .neq("status", "revoked")
    .order("created_at", { ascending: false });
  if (error) {
    throw new ClientOnboardingError(
      "database_error",
      "Could not load client onboarding sessions.",
      500,
    );
  }
  const sessions = (data ?? []) as SafeSessionRow[];
  const clientIds = [
    ...new Set(
      sessions
        .flatMap((session) => [session.target_client_id, session.claimed_user_id])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const clientsResult = clientIds.length
    ? await service
        .from("portal_clients")
        .select("id, approval_status")
        .in("id", clientIds)
    : { data: [], error: null };
  if (clientsResult.error) {
    throw new ClientOnboardingError(
      "database_error",
      "Could not check archived clients.",
      500,
    );
  }
  const archived = new Set(
    (clientsResult.data ?? [])
      .filter((client) => client.approval_status === "rejected")
      .map((client) => client.id),
  );
  return loadSessionBundle(
    sessions.filter(
      (session) =>
        !archived.has(session.target_client_id ?? "") &&
        !archived.has(session.claimed_user_id ?? ""),
    ),
    true,
  );
}

function normaliseAssets(
  value: readonly string[],
  mode: ClientOnboardingMode,
): ClientOnboardingAsset[] {
  const assets = [...new Set(value)].filter(
    (asset): asset is ClientOnboardingAsset => asset === "shopify" || asset === "google_ads",
  );
  const invalidShape =
    mode === "new_client"
      ? assets.length === 1 && assets[0] !== "shopify"
      : mode === "reconnect"
        ? assets.length !== 1 || assets[0] !== "shopify"
        : assets.length === 0;
  if (assets.length !== value.length || invalidShape) {
    throw new ClientOnboardingError(
      "invalid_request",
      mode === "new_client"
        ? "Choose account only, Account & Shopify, or complete Shopify and Google Ads setup."
        : mode === "reconnect"
          ? "A reconnect link must target exactly one Shopify store."
          : "Choose Shopify, Google Ads or both.",
      400,
    );
  }
  return assets.sort();
}

function normaliseReconnectTarget(
  value: ClientOnboardingShopifyReconnectTarget | null | undefined,
) {
  if (
    !value ||
    !(["legacy", "onboarding"] as const).includes(value.source) ||
    !isClientOnboardingId(value.id)
  ) {
    throw new ClientOnboardingError(
      "invalid_request",
      "Choose the exact Shopify store to reconnect.",
      400,
    );
  }
  return { source: value.source, id: value.id };
}

export async function createClientOnboardingSession(input: {
  mode: ClientOnboardingMode;
  requestedAssets: readonly string[];
  targetClientId?: string | null;
  targetShopify?: ClientOnboardingShopifyReconnectTarget | null;
  adminId: string;
}) {
  const service = serviceOrThrow();
  if (!(["new_client", "add_assets", "reconnect"] as const).includes(input.mode)) {
    throw new ClientOnboardingError("invalid_request", "Invalid onboarding mode.", 400);
  }
  const requestedAssets = normaliseAssets(input.requestedAssets, input.mode);
  const targetClientId = input.targetClientId?.trim() || null;
  if (
    (input.mode === "new_client" && targetClientId) ||
    (input.mode === "add_assets" &&
      (!targetClientId || !isClientOnboardingId(targetClientId))) ||
    (input.mode === "reconnect" && targetClientId) ||
    (input.mode !== "reconnect" && input.targetShopify)
  ) {
    throw new ClientOnboardingError(
      "invalid_request",
      input.mode === "new_client"
        ? "A new-client link cannot target an existing client."
        : input.mode === "reconnect"
          ? "Reconnect the selected Shopify store, not a general client workspace."
          : "Select an existing client.",
      400,
    );
  }
  const targetShopify =
    input.mode === "reconnect"
      ? normaliseReconnectTarget(input.targetShopify)
      : null;
  const invitation = await createClientOnboardingInvitationMaterial();
  const { data, error } = targetShopify
    ? await service.rpc("create_client_shopify_reconnect_invitation", {
        p_session_id: invitation.id,
        p_target_source: targetShopify.source,
        p_target_id: targetShopify.id,
        p_token_hash: invitation.tokenHash,
        p_expires_at: invitation.expiresAt,
        p_created_by: input.adminId,
      })
    : await service.rpc("create_client_onboarding_invitation", {
        p_session_id: invitation.id,
        p_mode: input.mode,
        p_requested_assets: requestedAssets,
        p_target_client_id: targetClientId,
        p_token_hash: invitation.tokenHash,
        p_expires_at: invitation.expiresAt,
        p_created_by: input.adminId,
      });
  if (error || data !== invitation.id) {
    throw new ClientOnboardingError(
      error?.code === "P0002"
        ? "not_found"
        : error?.code === "23505"
          ? "invalid_state"
          : "database_error",
      error?.code === "P0002"
        ? targetShopify
          ? "The selected Shopify store is no longer available."
          : "The selected client no longer exists."
        : error?.code === "23505"
          ? "This client already has an open link for one of the requested assets. Complete or cancel that link first."
          : "Could not create the onboarding invitation.",
      error?.code === "P0002" ? 404 : error?.code === "23505" ? 409 : 500,
    );
  }
  return {
    id: invitation.id,
    url: invitation.url,
    expiresAt: invitation.expiresAt,
    mode: input.mode,
    requestedAssets,
    targetShopify,
  };
}

export async function rotateClientOnboardingInvitation(sessionId: string, adminId: string) {
  if (!isClientOnboardingId(sessionId)) {
    throw new ClientOnboardingError("not_found", "Onboarding session not found.", 404);
  }
  const service = serviceOrThrow();
  const invitation = await createClientOnboardingInvitationMaterial();
  const { data, error } = await service.rpc("rotate_client_onboarding_invitation", {
    p_session_id: sessionId,
    p_token_hash: invitation.tokenHash,
    p_expires_at: invitation.expiresAt,
    p_admin_id: adminId,
  });
  if (error || data !== sessionId) {
    throw new ClientOnboardingError(
      error?.code === "P0002" ? "invalid_state" : "database_error",
      error?.code === "P0002"
        ? "Only an open onboarding link can be replaced."
        : "Could not replace the onboarding invitation.",
      error?.code === "P0002" ? 409 : 500,
    );
  }
  return {
    id: sessionId,
    url: clientOnboardingInvitationUrl(sessionId, invitation.token),
    expiresAt: invitation.expiresAt,
  };
}

export async function authorizeClientOnboardingRequest(
  sessionId: string,
  invitationToken?: string | null,
): Promise<ClientOnboardingAuthorization> {
  if (!isClientOnboardingId(sessionId)) {
    throw new ClientOnboardingError(
      "invalid_invitation",
      "This onboarding link is invalid or no longer available.",
      404,
    );
  }
  const service = serviceOrThrow();
  const { data, error } = await service
    .from("client_onboarding_sessions")
    .select(AUTH_SESSION_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) {
    throw new ClientOnboardingError(
      "database_error",
      "The onboarding link could not be checked.",
      500,
    );
  }
  if (!data || data.status === "revoked") {
    throw new ClientOnboardingError(
      "invalid_invitation",
      "This onboarding link is invalid or no longer available.",
      404,
    );
  }
  const ownerId = data.target_client_id ?? data.claimed_user_id;
  if (ownerId) {
    const { data: owner, error: ownerError } = await service
      .from("portal_clients")
      .select("approval_status")
      .eq("id", ownerId)
      .maybeSingle();
    if (ownerError) {
      throw new ClientOnboardingError(
        "database_error",
        "The client account could not be checked.",
        500,
      );
    }
    if (owner?.approval_status === "rejected") {
      throw new ClientOnboardingError(
        "invalid_invitation",
        "This onboarding link is no longer available.",
        404,
      );
    }
  }

  const token = invitationToken?.trim() ?? "";
  // Once an existing workspace has been claimed, the original bearer is no
  // longer sufficient. Require the authenticated owner and keep the stored
  // digest server-side solely for the purpose-bound lifecycle RPCs.
  if (data.mode !== "new_client" && data.claimed_user_id) {
    const { user } = await getSessionProfile();
    if (!user || user.id !== data.claimed_user_id || user.id !== data.target_client_id) {
      throw new ClientOnboardingError(
        "unauthorised",
        "Sign in as the invited client to continue this onboarding.",
        401,
      );
    }
    if (["submitted", "reviewed", "active"].includes(data.status)) {
      return {
        session: data as ClientOnboardingSession,
        tokenHash: "",
        actorUserId: user.id,
        usingInvitation: false,
      };
    }
    if (
      !data.invite_token_hash ||
      !data.invite_expires_at ||
      new Date(data.invite_expires_at).getTime() <= Date.now() ||
      !["pending", "collecting"].includes(data.status)
    ) {
      throw new ClientOnboardingError(
        "invalid_state",
        "This onboarding session is no longer open.",
        409,
      );
    }
    return {
      session: data as ClientOnboardingSession,
      tokenHash: data.invite_token_hash,
      actorUserId: user.id,
      usingInvitation: false,
    };
  }

  if (token) {
    let tokenHash: string;
    try {
      tokenHash = await hashClientOnboardingToken(token);
    } catch {
      throw new ClientOnboardingError(
        "invalid_invitation",
        "This onboarding link is invalid or no longer available.",
        404,
      );
    }
    if (
      data.status === "pending" || data.status === "collecting"
        ? data.invite_token_hash !== tokenHash
        : true
    ) {
      throw new ClientOnboardingError(
        "invalid_invitation",
        "This onboarding link is invalid or no longer available.",
        404,
      );
    }
    if (!data.invite_expires_at || new Date(data.invite_expires_at).getTime() <= Date.now()) {
      throw new ClientOnboardingError(
        "invitation_expired",
        "This onboarding link has expired. Ask Dropscale for a new link.",
        410,
      );
    }
    if (data.failed_attempts >= 10) {
      throw new ClientOnboardingError(
        "too_many_attempts",
        "This onboarding link has had too many unsuccessful attempts. Ask Dropscale for a new link.",
        429,
      );
    }
    return {
      session: data as ClientOnboardingSession,
      tokenHash,
      actorUserId: null,
      usingInvitation: true,
    };
  }

  const { user } = await getSessionProfile();
  const ownsSession =
    user && (data.claimed_user_id === user.id || data.target_client_id === user.id);
  if (!ownsSession) {
    throw new ClientOnboardingError(
      "unauthorised",
      "Reopen the original onboarding link or sign in as the invited client.",
      401,
    );
  }
  if (["submitted", "reviewed", "active"].includes(data.status)) {
    return {
      session: data as ClientOnboardingSession,
      tokenHash: "",
      actorUserId: user.id,
      usingInvitation: false,
    };
  }
  if (!data.invite_token_hash) {
    throw new ClientOnboardingError(
      "invalid_state",
      "This onboarding session is no longer open.",
      409,
    );
  }
  if (
    !data.invite_expires_at ||
    new Date(data.invite_expires_at).getTime() <= Date.now() ||
    !["pending", "collecting"].includes(data.status)
  ) {
    throw new ClientOnboardingError(
      "invalid_state",
      "This onboarding session is no longer open.",
      409,
    );
  }
  return {
    session: data as ClientOnboardingSession,
    tokenHash: data.invite_token_hash,
    actorUserId: user.id,
    usingInvitation: false,
  };
}

export async function getPublicClientOnboardingSession(
  sessionId: string,
  invitationToken?: string | null,
): Promise<ClientOnboardingSessionDTO> {
  const authorization = await authorizeClientOnboardingRequest(sessionId, invitationToken);
  const safe = Object.fromEntries(
    Object.entries(authorization.session).filter(
      ([key]) => !["invite_token_hash", "last_attempt_at", "created_by", "reviewed_by", "revoked_at"].includes(key),
    ),
  ) as SafeSessionRow;
  // Existing assets become visible only after the invited person has proved
  // ownership of the target workspace. This lets Add Assets map a new account
  // to an existing store without disclosing asset metadata to an unclaimed
  // bearer link.
  const [dto] = await loadSessionBundle([safe], Boolean(safe.claimed_user_id));
  return safe.claimed_user_id ? dto : { ...dto, reconnectTarget: null };
}

function normaliseIdentity(input: {
  firstName: string;
  lastName: string;
  email: string;
  discordHandle: string;
}) {
  const firstName = input.firstName.trim().replace(/\s+/g, " ");
  const lastName = input.lastName.trim().replace(/\s+/g, " ");
  const email = input.email.trim().toLowerCase();
  const discordHandle = input.discordHandle.trim().replace(/^@/, "");
  if (
    firstName.length < 1 ||
    firstName.length > 80 ||
    lastName.length < 1 ||
    lastName.length > 80 ||
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    discordHandle.length < 2 ||
    discordHandle.length > 64 ||
    discordHandle.startsWith("@") ||
    /\s|[\u0000-\u001f\u007f]/.test(discordHandle) ||
    /^(?:https?:\/\/|discord(?:app)?\.com\/|www\.)/i.test(discordHandle)
  ) {
    throw new ClientOnboardingError(
      "invalid_request",
      "Enter a valid first name, last name, email and Discord handle.",
      400,
    );
  }
  return { firstName, lastName, email, discordHandle };
}

export async function createClientOnboardingIdentity(input: {
  sessionId: string;
  invitationToken: string;
  firstName: string;
  lastName: string;
  email: string;
  discordHandle: string;
  userId: string;
}) {
  if (!isClientOnboardingToken(input.invitationToken)) {
    throw new ClientOnboardingError("invalid_invitation", "Invalid onboarding link.", 404);
  }
  const authorization = await authorizeClientOnboardingRequest(
    input.sessionId,
    input.invitationToken,
  );
  if (authorization.session.mode !== "new_client") {
    throw new ClientOnboardingError(
      "invalid_state",
      "Existing clients must sign in to continue this onboarding.",
      409,
    );
  }
  const identity = normaliseIdentity(input);
  if (authorization.session.claimed_user_id) {
    if (authorization.session.email === identity.email) {
      const completed = await submitClientOnboardingSessionIfReady(authorization);
      return {
        needsEmailConfirmation: true,
        alreadyCreated: true,
        completed,
      };
    }
    throw new ClientOnboardingError(
      "invalid_state",
      "This onboarding identity has already been created.",
      409,
    );
  }

  if (!isClientOnboardingId(input.userId)) {
    throw new ClientOnboardingError(
      "identity_failed",
      "The client account could not be verified. Try again.",
      409,
    );
  }

  const service = serviceOrThrow();
  const { data: authResult, error: authError } = await service.auth.admin.getUserById(
    input.userId,
  );
  const authUser = authResult.user;
  const metadataSession = authUser?.user_metadata?.client_onboarding_id;
  if (
    authError ||
    !authUser?.email ||
    authUser.email.toLowerCase() !== identity.email ||
    metadataSession !== input.sessionId
  ) {
    throw new ClientOnboardingError(
      "identity_failed",
      "The client account could not be verified. Reopen the invitation and try again.",
      409,
    );
  }
  const { data: claimed, error: claimError } = await service.rpc(
    "claim_client_onboarding_identity",
    {
      p_session_id: input.sessionId,
      p_token_hash: authorization.tokenHash,
      p_user_id: authUser.id,
      p_first_name: identity.firstName,
      p_last_name: identity.lastName,
      p_email: identity.email,
      p_discord_handle: identity.discordHandle,
    },
  );
  if (claimError || claimed !== input.sessionId) {
    if (!authUser.email_confirmed_at && claimError?.code !== "23505") {
      await service.auth.admin.deleteUser(authUser.id).catch(() => undefined);
    }
    throw new ClientOnboardingError(
      claimError?.code === "23505" ? "identity_exists" : "database_error",
      claimError?.code === "23505"
        ? "That account already has a Dropscale workspace. Ask for an Add assets link instead."
        : "The client account was not attached to this onboarding. Try again.",
      claimError?.code === "23505" ? 409 : 500,
    );
  }
  const completed = await submitClientOnboardingSessionIfReady(authorization);
  return {
    needsEmailConfirmation: !authUser.email_confirmed_at,
    alreadyCreated: false,
    completed,
  };
}

export async function recoverClientOnboardingIdentity(input: {
  sessionId: string;
  invitationToken: string;
  firstName: string;
  lastName: string;
  email: string;
  discordHandle: string;
}) {
  if (!isClientOnboardingToken(input.invitationToken)) {
    throw new ClientOnboardingError("invalid_invitation", "Invalid onboarding link.", 404);
  }
  const authorization = await authorizeClientOnboardingRequest(
    input.sessionId,
    input.invitationToken,
  );
  if (authorization.session.mode !== "new_client") {
    throw new ClientOnboardingError(
      "invalid_state",
      "Existing clients must use their Add assets invitation.",
      409,
    );
  }
  const identity = normaliseIdentity(input);
  const { user } = await getSessionProfile();
  const metadataSession = user?.user_metadata?.client_onboarding_id;
  const service = serviceOrThrow();
  let metadataMatches =
    typeof metadataSession !== "string" || metadataSession === input.sessionId;
  if (
    user?.email &&
    typeof metadataSession === "string" &&
    metadataSession !== input.sessionId &&
    isClientOnboardingId(metadataSession)
  ) {
    const { data: priorSession, error: priorSessionError } = await service
      .from("client_onboarding_sessions")
      .select("mode, status, claimed_user_id, email")
      .eq("id", metadataSession)
      .maybeSingle();
    if (priorSessionError) {
      throw new ClientOnboardingError(
        "database_error",
        "The previous onboarding identity could not be verified.",
        500,
      );
    }
    metadataMatches = Boolean(
      priorSession?.mode === "new_client" &&
        priorSession.status === "revoked" &&
        priorSession.claimed_user_id === user.id &&
        priorSession.email === identity.email,
    );
  }
  if (
    !user?.email ||
    user.email.toLowerCase() !== identity.email ||
    !metadataMatches
  ) {
    throw new ClientOnboardingError(
      "identity_failed",
      "Sign in with the account created for this invitation and try again.",
      409,
    );
  }
  const { data, error } = await service.rpc("claim_client_onboarding_identity", {
    p_session_id: input.sessionId,
    p_token_hash: authorization.tokenHash,
    p_user_id: user.id,
    p_first_name: identity.firstName,
    p_last_name: identity.lastName,
    p_email: identity.email,
    p_discord_handle: identity.discordHandle,
  });
  if (error || data !== input.sessionId) {
    throw new ClientOnboardingError(
      error?.code === "23505" ? "identity_exists" : "database_error",
      error?.code === "23505"
        ? "That account already has a Dropscale workspace. Ask for an Add assets link instead."
        : "The client account could not be recovered for this invitation.",
      error?.code === "23505" ? 409 : 500,
    );
  }
  if (metadataSession !== input.sessionId) {
    await service.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...user.user_metadata,
        client_onboarding_id: input.sessionId,
      },
    });
  }
  const completed = await submitClientOnboardingSessionIfReady(authorization);
  return {
    needsEmailConfirmation: !user.email_confirmed_at,
    alreadyCreated: true,
    completed,
  };
}

export async function claimExistingClientOnboardingIdentity(input: {
  sessionId: string;
  invitationToken?: string | null;
}) {
  const { user } = await getSessionProfile();
  if (!user?.email) {
    throw new ClientOnboardingError(
      "unauthorised",
      "Sign in as the invited client to continue.",
      401,
    );
  }
  const authorization = await authorizeClientOnboardingRequest(
    input.sessionId,
    input.invitationToken,
  );
  if (
    authorization.session.mode === "new_client" ||
    authorization.session.target_client_id !== user.id
  ) {
    throw new ClientOnboardingError(
      "forbidden",
      "This onboarding invitation belongs to another client.",
      403,
    );
  }
  const service = serviceOrThrow();
  const { data: client, error: clientError } = await service
    .from("portal_clients")
    .select("full_name, email, discord_handle")
    .eq("id", user.id)
    .maybeSingle();
  if (clientError || !client) {
    throw new ClientOnboardingError("not_found", "Client profile not found.", 404);
  }
  const parts = client.full_name.trim().split(/\s+/);
  const firstName = parts.shift() || "Client";
  const lastName = parts.join(" ") || "Account";
  const { data, error } = await service.rpc("claim_client_onboarding_identity", {
    p_session_id: input.sessionId,
    p_token_hash: authorization.tokenHash,
    p_user_id: user.id,
    p_first_name: firstName,
    p_last_name: lastName,
    p_email: user.email.toLowerCase(),
    p_discord_handle: client.discord_handle,
  });
  if (error || data !== input.sessionId) {
    throw new ClientOnboardingError(
      "database_error",
      "The client profile could not be attached to this onboarding.",
      500,
    );
  }
}

export async function submitClientOnboardingSession(
  sessionId: string,
  invitationToken?: string | null,
) {
  const authorization = await authorizeClientOnboardingRequest(sessionId, invitationToken);
  const service = serviceOrThrow();
  const { data, error } = await service.rpc("submit_client_onboarding_session", {
    p_session_id: sessionId,
    p_token_hash: authorization.tokenHash,
  });
  if (error || data !== sessionId) {
    throw new ClientOnboardingError(
      error?.code === "23514" ? "invalid_state" : "database_error",
      error?.code === "23514"
        ? error.message
        : "The onboarding could not be submitted for review.",
      error?.code === "23514" ? 409 : 500,
    );
  }
}

/** Consume the verified link as soon as every requested connection exists. */
export async function submitClientOnboardingSessionIfReady(
  authorization: ClientOnboardingAuthorization,
): Promise<boolean> {
  const service = serviceOrThrow();
  const { data: current, error: sessionError } = await service
    .from("client_onboarding_sessions")
    .select(
      "id, mode, requested_assets, status, claimed_user_id, reconnect_completed_at, invite_token_hash",
    )
    .eq("id", authorization.session.id)
    .maybeSingle();
  if (sessionError) {
    throw new ClientOnboardingError(
      "database_error",
      "The completed onboarding could not be verified.",
      500,
    );
  }
  if (!current) return false;
  if (["submitted", "reviewed", "active"].includes(current.status)) return true;
  if (
    current.status !== "collecting" ||
    !current.claimed_user_id ||
    !current.invite_token_hash ||
    current.invite_token_hash !== authorization.tokenHash
  ) {
    return false;
  }
  if (current.mode === "reconnect" && !current.reconnect_completed_at) return false;

  const needsShopify = current.requested_assets.includes("shopify");
  const needsGoogle = current.requested_assets.includes("google_ads");
  const [shopifyResult, googleResult] = await Promise.all([
    needsShopify
      ? service
          .from("client_shopify_connections")
          .select("id")
          .eq("session_id", current.id)
          .eq("status", "connected")
          .limit(100)
      : Promise.resolve({ data: [] as Array<{ id: string }>, error: null }),
    needsGoogle
      ? service
          .from("client_google_ads_connections")
          .select("id")
          .eq("session_id", current.id)
          .eq("status", "connected")
          .limit(100)
      : Promise.resolve({ data: [] as Array<{ id: string }>, error: null }),
  ]);
  if (shopifyResult.error || googleResult.error) {
    throw new ClientOnboardingError(
      "database_error",
      "The completed onboarding could not be verified.",
      500,
    );
  }
  if (
    (needsShopify && !shopifyResult.data?.length) ||
    (needsGoogle && !googleResult.data?.length)
  ) {
    return false;
  }

  // One connected store is the only deterministic automatic mapping. Keep a
  // multi-store link open until an explicit mapping exists instead of guessing
  // and sending campaign data to the wrong store.
  if (needsShopify && needsGoogle) {
    if (shopifyResult.data.length !== 1) return false;
    const shopifyConnectionId = shopifyResult.data[0]?.id;
    if (!shopifyConnectionId) return false;
    const { error: mappingError } = await service.rpc(
      "replace_client_asset_mappings",
      {
        p_session_id: current.id,
        p_token_hash: authorization.tokenHash,
        p_mappings: googleResult.data.map((connection) => ({
          shopifyConnectionId,
          googleAdsConnectionId: connection.id,
        })),
      },
    );
    if (mappingError) {
      throw new ClientOnboardingError(
        "database_error",
        "The connected store and Google Ads accounts could not be matched.",
        500,
      );
    }
  }

  const { data, error } = await service.rpc("submit_client_onboarding_session", {
    p_session_id: current.id,
    p_token_hash: authorization.tokenHash,
  });
  if (error || data !== current.id) {
    throw new ClientOnboardingError(
      error?.code === "23514" ? "invalid_state" : "database_error",
      error?.code === "23514"
        ? error.message
        : "The completed onboarding could not be finalized.",
      error?.code === "23514" ? 409 : 500,
    );
  }
  return true;
}

export async function replaceClientAssetMappings(
  sessionId: string,
  invitationToken: string | null | undefined,
  mappings: Array<{
    shopifyConnectionId: string;
    googleAdsConnectionId: string;
  }>,
) {
  if (
    mappings.length > 100 ||
    mappings.some(
      (mapping) =>
        !isClientOnboardingId(mapping.shopifyConnectionId) ||
        !isClientOnboardingId(mapping.googleAdsConnectionId),
    )
  ) {
    throw new ClientOnboardingError("invalid_request", "Invalid asset mappings.", 400);
  }
  const authorization = await authorizeClientOnboardingRequest(sessionId, invitationToken);
  const service = serviceOrThrow();
  const { error } = await service.rpc("replace_client_asset_mappings", {
    p_session_id: sessionId,
    p_token_hash: authorization.tokenHash,
    p_mappings: mappings,
  });
  if (error) {
    throw new ClientOnboardingError(
      error.code === "42501" || error.code === "P0002"
        ? "invalid_state"
        : "database_error",
      error.code === "42501"
        ? "One of the selected assets does not belong to this onboarding."
        : error.code === "P0002"
          ? "Asset mapping is no longer available."
          : "The asset mappings could not be saved.",
      error.code === "42501" || error.code === "P0002" ? 409 : 500,
    );
  }
}

export async function reviewClientOnboardingSession(
  sessionId: string,
  adminId: string,
  activate: boolean,
) {
  const service = serviceOrThrow();
  const { data, error } = await service.rpc("review_client_onboarding_session", {
    p_session_id: sessionId,
    p_admin_id: adminId,
    p_activate: activate,
  });
  if (error || data !== sessionId) {
    throw new ClientOnboardingError(
      error?.code === "23514" || error?.code === "P0002"
        ? "invalid_state"
        : "database_error",
      error?.code === "23514"
        ? error.message.includes("reporting activation")
          ? "The client cannot be activated until reporting is connected to their dashboard."
          : "The client must confirm their email before activation."
        : error?.code === "P0002"
          ? "Submitted onboarding session not found."
          : "The onboarding review could not be saved.",
      error?.code === "23514" || error?.code === "P0002" ? 409 : 500,
    );
  }
}

export async function revokeClientOnboardingSession(sessionId: string, adminId: string) {
  const service = serviceOrThrow();
  const { data: pendingIdentity, error: identityLookupError } = await service
    .from("client_onboarding_sessions")
    .select("mode, status, claimed_user_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (identityLookupError) {
    throw new ClientOnboardingError(
      "database_error",
      "The onboarding session could not be checked before cancellation.",
      500,
    );
  }
  const needsCancellation =
    pendingIdentity?.status === "pending" || pendingIdentity?.status === "collecting";
  const canFinalizePriorCancellation = Boolean(
    pendingIdentity?.mode === "new_client" &&
      pendingIdentity.status === "revoked" &&
      pendingIdentity.claimed_user_id,
  );
  if (needsCancellation) {
    const { data, error } = await service.rpc("revoke_client_onboarding_session", {
      p_session_id: sessionId,
      p_admin_id: adminId,
    });
    if (error || data !== sessionId) {
      throw new ClientOnboardingError(
        error?.code === "P0002" ? "not_found" : "database_error",
        error?.code === "P0002"
          ? "Only an open onboarding session can be revoked."
          : "The onboarding connections could not be removed.",
        error?.code === "P0002" ? 409 : 500,
      );
    }
  } else if (!canFinalizePriorCancellation) {
    throw new ClientOnboardingError(
      "not_found",
      "Only an open onboarding session can be revoked.",
      409,
    );
  }

  // Preserve the Auth identity: the immutable session/audit rows deliberately
  // reference it with ON DELETE RESTRICT. Only remove this invitation's
  // transient correlation key so a later new-client link can recover the same
  // identity; all unrelated user metadata remains intact.
  if (
    pendingIdentity?.mode === "new_client" &&
    (needsCancellation || canFinalizePriorCancellation) &&
    pendingIdentity.claimed_user_id
  ) {
    const { data: authResult, error: authLookupError } =
      await service.auth.admin.getUserById(pendingIdentity.claimed_user_id);
    const authUser = authResult.user;
    if (authLookupError || !authUser) {
      throw new ClientOnboardingError(
        "database_error",
        "The onboarding was cancelled, but its account metadata could not be finalized.",
        500,
      );
    }
    if (
      authUser.user_metadata?.client_onboarding_id === sessionId
    ) {
      const preservedMetadata = { ...authUser.user_metadata };
      delete preservedMetadata.client_onboarding_id;
      const { error: metadataError } = await service.auth.admin.updateUserById(
        authUser.id,
        { user_metadata: preservedMetadata },
      );
      if (metadataError) {
        throw new ClientOnboardingError(
          "database_error",
          "The onboarding was cancelled, but its account metadata could not be finalized.",
          500,
        );
      }
    }
  }
}
