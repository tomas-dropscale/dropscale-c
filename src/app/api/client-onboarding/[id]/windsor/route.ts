import type { NextRequest } from "next/server";

import {
  clientOnboardingErrorResponse,
  clientOnboardingResponse,
} from "@/lib/client-onboarding/http";
import {
  authorizeClientOnboardingRequest,
  ClientOnboardingError,
  getPublicClientOnboardingSession,
  submitClientOnboardingSessionIfReady,
} from "@/lib/client-onboarding/sessions";
import { createServiceClient } from "@/lib/supabase/service";
import {
  createGoogleAdsAuthorization,
  decryptWindsorAccessToken,
  encryptWindsorAccessToken,
  pollLinkedGoogleAdsAccounts,
  WindsorError,
} from "@/lib/windsor/client";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function invitationToken(request: NextRequest) {
  return request.headers.get("x-dropscale-client-onboarding");
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

function errorResponse(error: unknown) {
  if (error instanceof WindsorError) {
    return clientOnboardingResponse(
      { error: error.message, code: error.code },
      error.status === 499 ? 408 : error.status,
    );
  }
  return clientOnboardingErrorResponse(error, "Google Ads onboarding could not be completed.");
}

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const authorization = await authorizeClientOnboardingRequest(
      id,
      invitationToken(request),
    );
    if (
      authorization.session.status !== "collecting" ||
      !authorization.session.claimed_user_id ||
      !authorization.session.requested_assets.includes("google_ads")
    ) {
      throw new ClientOnboardingError(
        "invalid_state",
        "Google Ads is not available in this onboarding session.",
        409,
      );
    }
    const windsor = await createGoogleAdsAuthorization({ signal: request.signal });
    const ciphertext = await encryptWindsorAccessToken(windsor.accessToken);
    const service = serviceOrThrow();
    const { data, error } = await service.rpc("store_client_windsor_authorization", {
      p_session_id: id,
      p_token_hash: authorization.tokenHash,
      p_ciphertext: ciphertext,
    });
    if (error || data !== id) {
      throw new ClientOnboardingError(
        error?.code === "P0002" ? "invalid_state" : "database_error",
        error?.code === "P0002"
          ? "This Google Ads onboarding is no longer available. Ask Dropscale for a new link."
          : "The Google Ads authorization could not be saved.",
        error?.code === "P0002" ? 409 : 500,
      );
    }
    return clientOnboardingResponse({
      ok: true,
      authorizationUrl: windsor.authorizationUrl,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const authorization = await authorizeClientOnboardingRequest(
      id,
      invitationToken(request),
    );
    if (
      authorization.session.status !== "collecting" ||
      !authorization.session.claimed_user_id ||
      !authorization.session.requested_assets.includes("google_ads")
    ) {
      throw new ClientOnboardingError(
        "invalid_state",
        "Google Ads is not available in this onboarding session.",
        409,
      );
    }
    const service = serviceOrThrow();
    const { data: secret, error: secretError } = await service
      .from("client_onboarding_secrets")
      .select("windsor_access_token_ciphertext")
      .eq("session_id", id)
      .maybeSingle();
    if (secretError) {
      throw new ClientOnboardingError(
        "database_error",
        "The Google Ads authorization could not be checked.",
        500,
      );
    }
    if (!secret?.windsor_access_token_ciphertext) {
      return clientOnboardingResponse({ status: "not_started", accounts: [] });
    }

    const accessToken = await decryptWindsorAccessToken(
      secret.windsor_access_token_ciphertext,
    );
    const result = await pollLinkedGoogleAdsAccounts({
      accessToken,
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      signal: request.signal,
    });
    if (result.status === "connected") {
      const { error } = await service.rpc("upsert_client_google_ads_connections", {
        p_session_id: id,
        p_token_hash: authorization.tokenHash,
        p_accounts: result.accounts.map((account) => ({
          windsorAccountId: account.accountId,
          accountName: account.accountName ?? account.accountId,
          currency: account.currency?.toUpperCase() ?? null,
          timeZone: account.timeZone,
          dataSourceId: null,
        })),
      });
      if (error) {
        throw new ClientOnboardingError(
          error.code === "23505" ? "invalid_state" : "database_error",
          error.code === "23505"
            ? "One of these Google Ads accounts is already active in another onboarding."
            : "The connected Google Ads accounts could not be saved.",
          error.code === "23505" ? 409 : 500,
        );
      }
    }
    const session = await getPublicClientOnboardingSession(
      id,
      invitationToken(request),
    );
    const completed =
      result.status === "connected"
        ? await submitClientOnboardingSessionIfReady(authorization)
        : false;
    return clientOnboardingResponse({
      status: result.status,
      accounts: session.googleAds,
      completed,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
