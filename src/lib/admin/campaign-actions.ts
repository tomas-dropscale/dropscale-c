import "server-only";

import type { NextRequest } from "next/server";

import {
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import {
  ClientOnboardingError,
  requireClientOnboardingAdmin,
} from "@/lib/client-onboarding/sessions";
import {
  GoogleCampaignControlError,
  readGoogleCampaignControlState,
  updateGoogleCampaignBudget,
  updateGoogleCampaignStatus,
} from "@/lib/google-ads/campaign-control";
import {
  GoogleAdsMutationError,
  GoogleAdsQueryError,
} from "@/lib/google-ads/client";
import { resolveReportingSources } from "@/lib/reporting/sources";
import { createServiceClient } from "@/lib/supabase/service";
import type {
  CampaignActionOperation,
  CampaignActionOperationStatus,
  CampaignActionPolicy,
  CampaignActionPolicyAction,
  Database,
  Json,
} from "@/lib/supabase/types";
import type { CampaignActionHistory } from "@/lib/admin/campaigns-view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAMPAIGN_ID = /^\d{1,30}$/;
const DECIMAL = /^(0|[1-9]\d{0,12})(?:\.(\d{1,6}))?$/;
const MILLION = BigInt(1_000_000);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const STALE_REQUEST_MS = 5 * 60 * 1_000;
const HISTORY_PAGE_SIZE = 1_000;
const MAX_HISTORY_PAGES = 1;

type CampaignActionService = NonNullable<ReturnType<typeof createServiceClient>>;
type CampaignOperationHistory = {
  operations: CampaignActionOperation[];
  truncated: boolean;
};

type BudgetRequest = {
  requestId: string;
  bindingId: string;
  providerCampaignId: string;
  action: "set_daily_budget";
  expectedDailyBudget: string;
  nextDailyBudget: string;
};

type StatusRequest = {
  requestId: string;
  bindingId: string;
  providerCampaignId: string;
  action: "pause" | "enable";
  expectedStatus: "active" | "paused";
};

export type CampaignActionRequest = BudgetRequest | StatusRequest;

type CampaignActionPolicyRequest = {
  requestId: string;
  bindingId: string;
  expectedPolicyId: string | null;
  allowedActions: CampaignActionPolicyAction[];
  maxDailyBudget: string | null;
};

const POLICY_ACTIONS: readonly CampaignActionPolicyAction[] = [
  "budget_changed",
  "campaign_enabled",
  "campaign_paused",
];

function invalid(message: string): never {
  throw new ClientOnboardingError("invalid_request", message, 400);
}

function conflict(message: string): never {
  throw new ClientOnboardingError("invalid_state", message, 409);
}

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

function parseRequest(value: unknown): CampaignActionRequest {
  if (
    isExactRecord(value, [
      "requestId",
      "bindingId",
      "providerCampaignId",
      "action",
      "expectedDailyBudget",
      "nextDailyBudget",
    ]) &&
    value.action === "set_daily_budget" &&
    typeof value.requestId === "string" &&
    UUID.test(value.requestId) &&
    typeof value.bindingId === "string" &&
    UUID.test(value.bindingId) &&
    typeof value.providerCampaignId === "string" &&
    CAMPAIGN_ID.test(value.providerCampaignId) &&
    typeof value.expectedDailyBudget === "string" &&
    DECIMAL.test(value.expectedDailyBudget) &&
    typeof value.nextDailyBudget === "string" &&
    DECIMAL.test(value.nextDailyBudget)
  ) {
    return value as BudgetRequest;
  }

  if (
    isExactRecord(value, [
      "requestId",
      "bindingId",
      "providerCampaignId",
      "action",
      "expectedStatus",
    ]) &&
    (value.action === "pause" || value.action === "enable") &&
    typeof value.requestId === "string" &&
    UUID.test(value.requestId) &&
    typeof value.bindingId === "string" &&
    UUID.test(value.bindingId) &&
    typeof value.providerCampaignId === "string" &&
    CAMPAIGN_ID.test(value.providerCampaignId) &&
    (value.expectedStatus === "active" || value.expectedStatus === "paused") &&
    ((value.action === "pause" && value.expectedStatus === "active") ||
      (value.action === "enable" && value.expectedStatus === "paused"))
  ) {
    return value as StatusRequest;
  }

  return invalid("Send exactly one valid campaign action.");
}

function parsePolicyRequest(value: unknown): CampaignActionPolicyRequest {
  if (
    !isExactRecord(value, [
      "requestId",
      "bindingId",
      "expectedPolicyId",
      "allowedActions",
      "maxDailyBudget",
    ]) ||
    typeof value.requestId !== "string" ||
    !UUID.test(value.requestId) ||
    typeof value.bindingId !== "string" ||
    !UUID.test(value.bindingId) ||
    !(
      value.expectedPolicyId === null ||
      (typeof value.expectedPolicyId === "string" && UUID.test(value.expectedPolicyId))
    ) ||
    !Array.isArray(value.allowedActions) ||
    !value.allowedActions.every(
      (action): action is CampaignActionPolicyAction =>
        typeof action === "string" && POLICY_ACTIONS.includes(action as CampaignActionPolicyAction),
    ) ||
    new Set(value.allowedActions).size !== value.allowedActions.length ||
    !(
      value.maxDailyBudget === null ||
      (typeof value.maxDailyBudget === "string" && DECIMAL.test(value.maxDailyBudget))
    )
  ) {
    return invalid("Send exactly one valid campaign action policy.");
  }

  const allowedActions = [...value.allowedActions].sort() as CampaignActionPolicyAction[];
  const includesBudget = allowedActions.includes("budget_changed");
  if (includesBudget !== (value.maxDailyBudget !== null)) {
    return invalid("A daily budget cap is required only when budget changes are enabled.");
  }

  return {
    requestId: value.requestId,
    bindingId: value.bindingId,
    expectedPolicyId: value.expectedPolicyId,
    allowedActions,
    maxDailyBudget: value.maxDailyBudget,
  };
}

export function campaignCurrencyUnitsToMicros(value: string): number {
  const match = DECIMAL.exec(value);
  if (!match) return invalid("Campaign budgets must be exact decimal amounts.");
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  const micros = whole * MILLION + fraction;
  if (micros > MAX_SAFE_INTEGER) return invalid("The campaign budget is too large.");
  return Number(micros);
}

export function campaignMicrosToCurrencyUnits(value: number | string | null): string | null {
  if (value === null) return null;
  if (
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) ||
    (typeof value === "string" && !/^\d{1,16}$/.test(value))
  ) {
    return null;
  }
  const micros = BigInt(value);
  if (micros < BigInt(0) || micros > MAX_SAFE_INTEGER) return null;
  const whole = micros / MILLION;
  const fraction = String(micros % MILLION).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function requestedAction(body: CampaignActionRequest): CampaignActionPolicyAction {
  if (body.action === "set_daily_budget") return "budget_changed";
  return body.action === "pause" ? "campaign_paused" : "campaign_enabled";
}

function exactOperationMatches(
  operation: CampaignActionOperation,
  body: CampaignActionRequest,
  actorId: string,
) {
  if (
    operation.id !== body.requestId ||
    operation.idempotency_key !== `campaign-action:${body.requestId}` ||
    operation.client_reporting_binding_id !== body.bindingId ||
    operation.provider_campaign_id !== body.providerCampaignId ||
    operation.requested_by !== actorId ||
    operation.action !== requestedAction(body)
  ) {
    return false;
  }
  if (body.action === "set_daily_budget") {
    return (
      Number(operation.previous_daily_budget_micros) ===
        campaignCurrencyUnitsToMicros(body.expectedDailyBudget) &&
      Number(operation.next_daily_budget_micros) ===
        campaignCurrencyUnitsToMicros(body.nextDailyBudget)
    );
  }
  return (
    operation.previous_status === body.expectedStatus &&
    operation.next_status === (body.action === "pause" ? "paused" : "active")
  );
}

function safeInteger(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function databaseError(code: string | undefined, fallback: string): ClientOnboardingError {
  if (code === "42501") return new ClientOnboardingError("forbidden", "Forbidden.", 403);
  if (["22023", "23503", "23505", "23514", "40001", "P0002"].includes(code ?? "")) {
    return new ClientOnboardingError(
      "invalid_state",
      "The campaign authority or state changed. Refresh before trying again.",
      409,
    );
  }
  return new ClientOnboardingError("database_error", fallback, 500);
}

function providerFailure(error: unknown): {
  outcome: "failed" | "uncertain";
  details: Json;
} {
  if (error instanceof GoogleAdsMutationError) {
    return {
      outcome: error.indeterminate ? "uncertain" : "failed",
      details: {
        code: error.providerCode,
        httpStatus: error.status,
        providerRequestId: error.requestId,
      },
    };
  }
  if (error instanceof GoogleCampaignControlError) {
    return {
      outcome: error.indeterminate ? "uncertain" : "failed",
      details: { code: error.code },
    };
  }
  if (error instanceof GoogleAdsQueryError) {
    return {
      outcome: "failed",
      details: { code: `GOOGLE_QUERY_${error.status}` },
    };
  }
  return { outcome: "uncertain", details: { code: "UNCLASSIFIED_PROVIDER_FAILURE" } };
}

function serviceOrThrow() {
  const service = createServiceClient();
  if (!service) {
    throw new ClientOnboardingError(
      "server_not_configured",
      "Campaign actions are not configured on the server.",
      503,
    );
  }
  return service;
}

function isStaleRequestedOperation(operation: CampaignActionOperation) {
  const requestedAt = Date.parse(operation.requested_at);
  return Number.isFinite(requestedAt) && Date.now() - requestedAt >= STALE_REQUEST_MS;
}

type CompletionArgs = Database["public"]["Functions"]["complete_campaign_action"]["Args"];

async function completeCampaignActionWithRetry(
  service: CampaignActionService,
  args: CompletionArgs,
  expectedOutcome: Exclude<CampaignActionOperationStatus, "requested">,
  fallback: string,
) {
  let lastCode: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await service.rpc("complete_campaign_action", args);
    if (!error && data?.status === expectedOutcome) return data;
    lastCode = error?.code;
    if (["22023", "23514", "40001", "42501", "P0002"].includes(lastCode ?? "")) break;
  }
  throw databaseError(lastCode, fallback);
}

async function reconcileStaleRequestedOperation(
  service: CampaignActionService,
  operation: CampaignActionOperation,
): Promise<"succeeded" | "uncertain" | null> {
  if (operation.status !== "requested" || !isStaleRequestedOperation(operation)) return null;

  let outcome: "succeeded" | "uncertain" = "uncertain";
  let observedStatus: "active" | "paused" | "ended" | null = null;
  let observedBudgetMicros: number | null = null;
  try {
    const state = await readGoogleCampaignControlState(
      operation.google_ads_customer_id,
      operation.provider_campaign_id,
    );
    const exactIdentity =
      state.currency === operation.currency && state.timeZone === operation.google_time_zone;
    const targetVerified = operation.action === "budget_changed"
      ? exactIdentity &&
        state.status !== "ended" &&
        state.budgetPeriod === "DAILY" &&
        !state.sharedBudget &&
        state.budgetMicros === safeInteger(operation.next_daily_budget_micros)
      : exactIdentity && state.status === operation.next_status;
    if (targetVerified) {
      outcome = "succeeded";
      observedStatus = state.status;
      observedBudgetMicros = state.budgetMicros;
    }
  } catch {
    // The stale executor is past its mutation deadline. An unreadable target is
    // sealed as uncertain; it is never mutated again by reconciliation.
  }

  await completeCampaignActionWithRetry(
    service,
    {
      p_operation_id: operation.id,
      p_idempotency_key: operation.idempotency_key,
      p_execution_claim_id: operation.execution_claim_id,
      p_actor_id: operation.requested_by,
      p_outcome: outcome,
      p_observed_status: observedStatus,
      p_observed_daily_budget_micros: observedBudgetMicros,
      p_details: {
        code: outcome === "succeeded" ? "STALE_TARGET_VERIFIED" : "STALE_TARGET_UNVERIFIED",
      },
    },
    outcome,
    "The pending campaign action could not be reconciled.",
  );
  return outcome;
}

/** Authenticates before reading the body or constructing service_role. */
export async function executeCampaignActionRequest(request: NextRequest) {
  const admin = await requireClientOnboardingAdmin();
  if (!sameOrigin(request)) {
    throw new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  const body = parseRequest(await readSmallJson(request, 1_024));
  const service = serviceOrThrow();
  const idempotencyKey = `campaign-action:${body.requestId}`;

  const { data: existing, error: existingError } = await service
    .from("campaign_action_operations")
    .select("*")
    .eq("id", body.requestId)
    .maybeSingle();
  if (existingError) throw databaseError(existingError.code, "Campaign action state is unavailable.");
  if (existing) {
    if (!exactOperationMatches(existing, body, admin.id)) {
      throw new ClientOnboardingError("forbidden", "Forbidden.", 403);
    }
    if (existing.status === "succeeded") return { status: "succeeded" as const };
    const reconciled = await reconcileStaleRequestedOperation(service, existing);
    if (reconciled === "succeeded") return { status: "succeeded" as const };
    if (reconciled === "uncertain") {
      return conflict(
        "The previous campaign action could not be verified and was sealed as uncertain. Refresh before trying again.",
      );
    }
    return conflict(
      existing.status === "requested"
        ? "This campaign action is already being processed. Refresh before retrying."
        : "This campaign action did not finish successfully. Refresh before another action.",
    );
  }


  const { data: pending, error: pendingError } = await service
    .from("campaign_action_operations")
    .select("*")
    .eq("client_reporting_binding_id", body.bindingId)
    .eq("provider_campaign_id", body.providerCampaignId)
    .eq("status", "requested")
    .maybeSingle();
  if (pendingError) {
    throw databaseError(pendingError.code, "Pending campaign action state is unavailable.");
  }
  if (pending) {
    if (await reconcileStaleRequestedOperation(service, pending)) {
      return conflict(
        "The previous campaign action was reconciled. Refresh before trying again.",
      );
    }
    return conflict("This campaign already has an action in progress. Refresh before trying again.");
  }

  const { data: binding, error: bindingError } = await service
    .from("client_reporting_bindings")
    .select("id, client_id, ad_account_id, google_ads_connection_id, status")
    .eq("id", body.bindingId)
    .maybeSingle();
  if (bindingError) throw databaseError(bindingError.code, "Campaign authority is unavailable.");
  if (
    !binding ||
    binding.status !== "active" ||
    !binding.google_ads_connection_id
  ) {
    return conflict("This campaign has no active Google Ads reporting authority.");
  }

  const sources = await resolveReportingSources({
    service,
    clientIds: [binding.client_id],
    adAccountIds: [binding.ad_account_id],
    includeShopifyCredentials: false,
  });
  const source = sources.find((candidate) => candidate.bindingId === binding.id);
  if (
    sources.length !== 1 ||
    !source?.googleAds ||
    source.clientId !== binding.client_id ||
    source.adAccountId !== binding.ad_account_id ||
    source.googleAds.connectionId !== binding.google_ads_connection_id ||
    !source.googleAds.currency ||
    !source.googleAds.timeZone
  ) {
    return conflict("The campaign reporting source changed. Refresh before trying again.");
  }

  const { data: policy, error: policyError } = await service
    .from("campaign_action_policies")
    .select("*")
    .eq("client_reporting_binding_id", binding.id)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (policyError) throw databaseError(policyError.code, "Campaign action policy is unavailable.");
  const action = requestedAction(body);
  if (!policy || !policy.allowed_actions.includes(action)) {
    throw new ClientOnboardingError(
      "forbidden",
      "This Google Ads binding has no policy for that campaign action.",
      403,
    );
  }

  const state = await readGoogleCampaignControlState(
    source.googleAds.customerId,
    body.providerCampaignId,
  );
  if (
    state.currency !== source.googleAds.currency ||
    state.timeZone !== source.googleAds.timeZone
  ) {
    return conflict("Google Ads returned a different reporting identity.");
  }

  let previousBudgetMicros: number | null = null;
  let nextBudgetMicros: number | null = null;
  let previousStatus: "active" | "paused" | null = null;
  let nextStatus: "active" | "paused" | null = null;

  if (body.action === "set_daily_budget") {
    previousBudgetMicros = campaignCurrencyUnitsToMicros(body.expectedDailyBudget);
    nextBudgetMicros = campaignCurrencyUnitsToMicros(body.nextDailyBudget);
    if (
      previousBudgetMicros < 1_000_000 ||
      previousBudgetMicros > 1_000_000_000_000 ||
      nextBudgetMicros < 1_000_000 ||
      nextBudgetMicros > 1_000_000_000_000
    ) {
      return invalid("Daily budgets must be between 1 and 1,000,000 account-currency units.");
    }
    const maxBudgetMicros = safeInteger(policy.max_daily_budget_micros);
    if (
      state.budgetMicros !== previousBudgetMicros ||
      nextBudgetMicros === previousBudgetMicros
    ) {
      return conflict("The campaign budget changed. Refresh before trying again.");
    }
    if (maxBudgetMicros === null || nextBudgetMicros > maxBudgetMicros) {
      throw new ClientOnboardingError(
        "forbidden",
        "The requested daily budget exceeds this binding policy.",
        403,
      );
    }
  } else {
    previousStatus = body.expectedStatus;
    nextStatus = body.action === "pause" ? "paused" : "active";
    if (state.status !== previousStatus) {
      return conflict("The campaign status changed. Refresh before trying again.");
    }
  }

  const executionClaimId = crypto.randomUUID();
  const { data: started, error: startError } = await service.rpc("start_campaign_action", {
    p_operation_id: body.requestId,
    p_idempotency_key: idempotencyKey,
    p_execution_claim_id: executionClaimId,
    p_client_id: source.clientId,
    p_client_reporting_binding_id: source.bindingId,
    p_ad_account_id: source.adAccountId,
    p_client_google_ads_connection_id: source.googleAds.connectionId,
    p_google_ads_customer_id: source.googleAds.customerId,
    p_provider_campaign_id: body.providerCampaignId,
    p_campaign_name: state.campaignName,
    p_action: action,
    p_currency: source.googleAds.currency,
    p_actor_id: admin.id,
    p_previous_status: previousStatus,
    p_next_status: nextStatus,
    p_previous_daily_budget_micros: previousBudgetMicros,
    p_next_daily_budget_micros: nextBudgetMicros,
    p_details: { source: "admin_campaigns" },
  });
  if (startError || !started) {
    throw databaseError(startError?.code, "The campaign action could not be recorded.");
  }
  if (started.status === "succeeded") return { status: "succeeded" as const };
  if (started.status !== "requested" || started.execution_claim_id !== executionClaimId) {
    return conflict("This exact campaign action is already owned by another request.");
  }

  try {
    const receipt = body.action === "set_daily_budget"
      ? await updateGoogleCampaignBudget({
          customerId: source.googleAds.customerId,
          campaignId: body.providerCampaignId,
          expectedBudgetMicros: previousBudgetMicros!,
          nextBudgetMicros: nextBudgetMicros!,
          maxBudgetMicros: safeInteger(policy.max_daily_budget_micros)!,
          expectedCurrency: source.googleAds.currency,
          expectedTimeZone: source.googleAds.timeZone,
        })
      : await updateGoogleCampaignStatus({
          customerId: source.googleAds.customerId,
          campaignId: body.providerCampaignId,
          expectedStatus: previousStatus!,
          nextStatus: nextStatus!,
          expectedCurrency: source.googleAds.currency,
          expectedTimeZone: source.googleAds.timeZone,
        });

    const observedBudget = receipt.after.budgetMicros;
    await completeCampaignActionWithRetry(
      service,
      {
        p_operation_id: body.requestId,
        p_idempotency_key: idempotencyKey,
        p_execution_claim_id: executionClaimId,
        p_actor_id: admin.id,
        p_outcome: "succeeded",
        p_observed_status: receipt.after.status,
        p_observed_daily_budget_micros: observedBudget,
        p_details: {
          code: "TARGET_VERIFIED",
          providerRequestId: receipt.requestId,
        },
      },
      "succeeded",
      "The campaign result could not be sealed.",
    );
    return { status: "succeeded" as const };
  } catch (error) {
    if (error instanceof ClientOnboardingError) throw error;
    const failure = providerFailure(error);
    await completeCampaignActionWithRetry(
      service,
      {
        p_operation_id: body.requestId,
        p_idempotency_key: idempotencyKey,
        p_execution_claim_id: executionClaimId,
        p_actor_id: admin.id,
        p_outcome: failure.outcome,
        p_observed_status: null,
        p_observed_daily_budget_micros: null,
        p_details: failure.details,
      },
      failure.outcome,
      "The campaign failure could not be sealed.",
    );
    return conflict(
      failure.outcome === "uncertain"
        ? "Google Ads did not confirm the final state. Refresh and review before another action."
        : "Google Ads rejected the campaign action.",
    );
  }
}

/** Authenticates before reading policy input or constructing service_role. */
export async function configureCampaignActionPolicyRequest(request: NextRequest) {
  const admin = await requireClientOnboardingAdmin();
  if (!sameOrigin(request)) {
    throw new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  const body = parsePolicyRequest(await readSmallJson(request, 1_024));
  const service = serviceOrThrow();
  const maxBudgetMicros = body.maxDailyBudget === null
    ? null
    : campaignCurrencyUnitsToMicros(body.maxDailyBudget);
  if (
    maxBudgetMicros !== null &&
    (maxBudgetMicros < 1_000_000 || maxBudgetMicros > 1_000_000_000_000)
  ) {
    return invalid("The daily budget cap must be between 1 and 1,000,000 account-currency units.");
  }

  const { data: policy, error } = await service.rpc("set_campaign_action_policy", {
    p_policy_id: body.requestId,
    p_idempotency_key: `campaign-policy:${body.requestId}`,
    p_client_reporting_binding_id: body.bindingId,
    p_expected_policy_id: body.expectedPolicyId,
    p_allowed_actions: body.allowedActions,
    p_max_daily_budget_micros: maxBudgetMicros,
    p_admin_id: admin.id,
    p_reason: "Admin configured campaign controls policy.",
  });
  if (error || !policy) {
    throw databaseError(error?.code, "The campaign action policy could not be recorded.");
  }

  return {
    revision: policy.revision,
    enabled: policy.allowed_actions.length > 0,
  };
}

export type CampaignActionViewState = {
  policies: Map<string, CampaignActionPolicy>;
  history: CampaignActionOperation[];
  historyTruncated: boolean;
  actorNames: Map<string, string>;
};

async function loadCampaignActorNames(
  service: CampaignActionService,
  operations: CampaignActionOperation[],
) {
  const actorIds = [...new Set(operations.map((operation) => operation.requested_by))];
  const actorNames = new Map<string, string>();
  if (actorIds.length === 0) return actorNames;

  const { data: actors, error } = await service
    .from("profiles")
    .select("id, full_name, email")
    .in("id", actorIds);
  if (error || !actors || actors.length !== actorIds.length) {
    throw new ClientOnboardingError(
      "database_error",
      "Campaign action actors are unavailable.",
      500,
    );
  }
  for (const actor of actors) {
    const name = actor.full_name.trim() || actor.email.trim();
    if (!name) {
      throw new ClientOnboardingError(
        "database_error",
        "Campaign action actors are unavailable.",
        500,
      );
    }
    actorNames.set(actor.id, name);
  }
  return actorNames;
}

async function loadBindingBudgetHistory(
  service: CampaignActionService,
  bindingIds: string[],
): Promise<CampaignOperationHistory> {
  const operations: CampaignActionOperation[] = [];
  const allowedBindingIds = new Set(bindingIds);
  let cursor: { completedAt: string; id: string } | null = null;
  for (let page = 0; page <= MAX_HISTORY_PAGES; page += 1) {
    let query = service
      .from("campaign_action_operations")
      .select("*")
      .in("client_reporting_binding_id", bindingIds)
      .eq("status", "succeeded")
      .eq("action", "budget_changed")
      .order("completed_at", { ascending: false })
      .order("id", { ascending: false });
    if (cursor) {
      query = query.or(
        `completed_at.lt.${cursor.completedAt},and(completed_at.eq.${cursor.completedAt},id.lt.${cursor.id})`,
      );
    }
    const { data, error } = await query.limit(
      page === MAX_HISTORY_PAGES ? 1 : HISTORY_PAGE_SIZE,
    );
    if (error || !data) {
      throw new ClientOnboardingError(
        "database_error",
        "Campaign action history is unavailable.",
        500,
      );
    }
    if (
      data.some(
        (operation) =>
          !allowedBindingIds.has(operation.client_reporting_binding_id) ||
          operation.status !== "succeeded" ||
          operation.action !== "budget_changed",
      )
    ) {
      throw new ClientOnboardingError(
        "database_error",
        "Campaign action history escaped its exact scope.",
        500,
      );
    }
    if (page === MAX_HISTORY_PAGES) {
      if (data.length === 0) return { operations, truncated: false };
      return { operations, truncated: true };
    }
    operations.push(...data);
    if (data.length < HISTORY_PAGE_SIZE) return { operations, truncated: false };
    const last = data.at(-1);
    if (!last?.completed_at || !UUID.test(last.id)) break;
    cursor = { completedAt: last.completed_at, id: last.id };
  }
  return { operations, truncated: true };
}

async function loadScopedCampaignActivity(
  service: CampaignActionService,
  clientId: string,
  adAccountIds: string[],
): Promise<CampaignOperationHistory> {
  const operations: CampaignActionOperation[] = [];
  const allowedAccountIds = new Set(adAccountIds);
  let cursor: { requestedAt: string; id: string } | null = null;
  for (let page = 0; page <= MAX_HISTORY_PAGES; page += 1) {
    let query = service
      .from("campaign_action_operations")
      .select("*")
      .eq("client_id", clientId)
      .in("ad_account_id", adAccountIds)
      .order("requested_at", { ascending: false })
      .order("id", { ascending: false });
    if (cursor) {
      query = query.or(
        `requested_at.lt.${cursor.requestedAt},and(requested_at.eq.${cursor.requestedAt},id.lt.${cursor.id})`,
      );
    }
    const { data, error } = await query.limit(
      page === MAX_HISTORY_PAGES ? 1 : HISTORY_PAGE_SIZE,
    );
    if (error || !data) {
      throw new ClientOnboardingError(
        "database_error",
        "Campaign action history is unavailable.",
        500,
      );
    }
    if (
      data.some(
        (operation) =>
          operation.client_id !== clientId ||
          !allowedAccountIds.has(operation.ad_account_id) ||
          !["requested", "succeeded", "failed", "uncertain"].includes(operation.status),
      )
    ) {
      throw new ClientOnboardingError(
        "database_error",
        "Campaign action activity escaped its exact scope.",
        500,
      );
    }
    if (page === MAX_HISTORY_PAGES) {
      if (data.length === 0) return { operations, truncated: false };
      return { operations, truncated: true };
    }
    operations.push(...data);
    if (data.length < HISTORY_PAGE_SIZE) return { operations, truncated: false };
    const last = data.at(-1);
    if (!last?.requested_at || !UUID.test(last.id)) break;
    cursor = { requestedAt: last.requested_at, id: last.id };
  }
  return { operations, truncated: true };
}

async function loadLatestCampaignPolicies(
  service: CampaignActionService,
  bindingIds: string[],
): Promise<CampaignActionPolicy[]> {
  return Promise.all(bindingIds.map(async (bindingId) => {
    const { data, error } = await service
      .from("campaign_action_policies")
      .select("*")
      .eq("client_reporting_binding_id", bindingId)
      .order("revision", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || (data && data.client_reporting_binding_id !== bindingId)) {
      throw new ClientOnboardingError(
        "database_error",
        "Campaign action policies are unavailable.",
        500,
      );
    }
    return data;
  })).then((policies) => policies.filter((policy): policy is CampaignActionPolicy => policy !== null));
}

export function projectCampaignActionHistory(
  operations: CampaignActionOperation[],
  actorNames: Map<string, string>,
): CampaignActionHistory[] {
  return operations.map((operation) => {
    const actorName = actorNames.get(operation.requested_by);
    const occurredAt = operation.completed_at ?? operation.requested_at;
    const previousBudgetMicros = safeInteger(operation.previous_daily_budget_micros);
    const nextBudgetMicros = safeInteger(operation.next_daily_budget_micros);
    if (!actorName || !occurredAt) {
      throw new ClientOnboardingError(
        "database_error",
        "Campaign action history is incomplete.",
        500,
      );
    }
    return {
      id: operation.id,
      adAccountId: operation.ad_account_id,
      providerCampaignId: operation.provider_campaign_id,
      campaignName: operation.campaign_name,
      action: operation.action as CampaignActionHistory["action"],
      outcome: operation.status,
      previousDailyBudget:
        previousBudgetMicros === null ? null : previousBudgetMicros / 1_000_000,
      nextDailyBudget: nextBudgetMicros === null ? null : nextBudgetMicros / 1_000_000,
      currency: operation.currency,
      occurredAt,
      actorName,
    };
  });
}

/** Exact client/account activity for Analytics, authenticated before service_role. */
export async function listCampaignActionActivity(
  clientId: string,
  adAccountIds: string[],
): Promise<{ history: CampaignActionHistory[]; truncated: boolean }> {
  await requireClientOnboardingAdmin();
  if (!UUID.test(clientId) || adAccountIds.some((id) => !UUID.test(id))) {
    return invalid("Invalid campaign activity scope.");
  }
  const uniqueAccountIds = [...new Set(adAccountIds)];
  if (uniqueAccountIds.length === 0) return { history: [], truncated: false };
  const service = serviceOrThrow();
  const result = await loadScopedCampaignActivity(service, clientId, uniqueAccountIds);
  const actorNames = await loadCampaignActorNames(service, result.operations);
  return {
    history: projectCampaignActionHistory(result.operations, actorNames),
    truncated: result.truncated,
  };
}

/** Reads only the latest policies and succeeded history after explicit admin auth. */
export async function listCampaignActionViewState(
  bindingIds: string[],
): Promise<CampaignActionViewState> {
  await requireClientOnboardingAdmin();
  const uniqueBindingIds = [...new Set(bindingIds.filter((id) => UUID.test(id)))];
  if (uniqueBindingIds.length === 0) {
    return {
      policies: new Map(),
      history: [],
      historyTruncated: false,
      actorNames: new Map(),
    };
  }
  const service = serviceOrThrow();
  const [latestPolicies, historyResult] = await Promise.all([
    loadLatestCampaignPolicies(service, uniqueBindingIds),
    loadBindingBudgetHistory(service, uniqueBindingIds),
  ]);
  const policies = new Map<string, CampaignActionPolicy>();
  for (const policy of latestPolicies) {
    policies.set(policy.client_reporting_binding_id, policy);
  }
  const actorNames = await loadCampaignActorNames(service, historyResult.operations);
  return {
    policies,
    history: historyResult.operations,
    historyTruncated: historyResult.truncated,
    actorNames,
  };
}
