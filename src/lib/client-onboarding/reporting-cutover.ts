import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isExactRecord, readSmallJson } from "@/lib/client-onboarding/http";
import {
  ClientOnboardingError,
  requireClientOnboardingAdmin,
} from "@/lib/client-onboarding/sessions";
import {
  refreshReportingSourcesNow,
  refreshStagedReportingSourceNow,
} from "@/lib/metrics/recompute";
import { normalizeShopDomain } from "@/lib/shopify/client";
import { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

type Service = SupabaseClient<Database>;

type ClientRow = {
  id: string;
  full_name: string;
  email: string;
  approval_status: string;
};
type ProfileRow = { id: string; role: string };
type RolloutRow = {
  client_id: string;
  operational_surface: string;
  onboarding_session_id: string | null;
  reporting_cutover_at: string | null;
  reporting_cutover_by: string | null;
  reporting_cutover_reason: string | null;
};
type AdAccountRow = {
  id: string;
  client_id: string;
  store_name: string;
  google_ads_customer_id: string | null;
  shopify_url: string | null;
  status: string;
  reporting_role: string;
  currency: string;
  shopify_connected: boolean;
  shopify_client_id: string | null;
  shopify_scopes: string | null;
  shopify_token_last4: string | null;
  shopify_connected_at: string | null;
  google_ads_connected_email: string | null;
  google_ads_connected: boolean;
};
type ShopifyRow = {
  id: string;
  session_id?: string;
  client_id: string;
  status: string;
  shopify_name: string;
  shopify_domain: string;
  shopify_currency: string;
  last_verified_at: string | null;
  last_error_code: string | null;
  updated_at: string;
};
type ShopifyCredentialRow = { connection_id: string };
type GoogleRow = {
  id: string;
  session_id?: string;
  client_id: string;
  status: string;
  windsor_account_id: string;
  account_name: string;
  currency: string | null;
  time_zone: string | null;
  last_verified_at: string | null;
  last_error_code: string | null;
  updated_at: string;
};
type MappingRow = {
  session_id?: string;
  shopify_connection_id: string;
  google_ads_connection_id: string;
};
type BindingRow = {
  id: string;
  client_id: string;
  ad_account_id: string;
  shopify_connection_id: string | null;
  google_ads_connection_id: string | null;
  shopify_anchor_binding_id: string | null;
  status: string;
  bound_at: string;
};
type SyncRow = {
  binding_id: string;
  source_type: string;
  last_success_at: string;
  last_success_from: string;
  last_success_to: string;
  source_currency: string;
  row_count: number;
};
type SessionRow = {
  id: string;
  created_by?: string;
  mode: string;
  requested_assets: string[];
  status: string;
  target_client_id: string | null;
  claimed_user_id: string | null;
  reconnect_legacy_ad_account_id: string | null;
  reconnect_shopify_connection_id: string | null;
  reconnect_completed_at: string | null;
};
type OnboardingEventRow = {
  session_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  details: unknown;
  created_at: string;
};
type AnchorEventRow = {
  binding_id: string;
  prior_binding_id: string | null;
  ad_account_id: string;
  event_type: string;
  idempotency_key: string;
  actor_id: string;
  reason: string;
  details: unknown;
  created_at: string;
};
type BillingStartRow = {
  ad_account_id: string;
  google_ads_customer_id: string;
  currency: string;
};
type BillingEndRow = BillingStartRow;

export type ClientReportingCutoverSnapshot = {
  clients: ClientRow[];
  profiles: ProfileRow[];
  rolloutStates: RolloutRow[];
  adAccounts: AdAccountRow[];
  shopifyConnections: ShopifyRow[];
  shopifyCredentials: ShopifyCredentialRow[];
  googleConnections: GoogleRow[];
  mappings: MappingRow[];
  bindings: BindingRow[];
  syncStates: SyncRow[];
  sessions: SessionRow[];
  onboardingEvents: OnboardingEventRow[];
  anchorEvents: AnchorEventRow[];
  billingStarts: BillingStartRow[];
  billingEnds: BillingEndRow[];
};

export type ReportingCutoverCandidate = {
  id: string;
  kind: "provision" | "adopt" | "restage" | "upgrade";
  clientName: string;
  clientEmail: string;
  sourceLabel: string;
  existingAccountName: string | null;
  requiresExplicitReview: boolean;
  message: string;
};

export type ReportingStagedSource = {
  bindingId: string;
  sourceLabel: string;
  syncedSourceCount: number;
  sourceCount: number;
  billingReady: boolean;
  syncActionId: string | null;
  promoteActionId: string | null;
  abandonActionId: string | null;
  message: string;
};

export type ReportingCutoverClient = {
  id: string;
  name: string;
  email: string;
  status:
    | "bindings_required"
    | "ready_to_sync"
    | "ready_to_activate"
    | "active"
    | "replacement_required"
    | "blocked";
  sourceCount: number;
  boundSourceCount: number;
  syncedSourceCount: number;
  reportingCutoverAt: string | null;
  syncActionId: string | null;
  activateActionId: string | null;
  stagedSources: ReportingStagedSource[];
  message: string;
};

export type ClientReportingCutoverQueue = {
  available: boolean;
  candidates: ReportingCutoverCandidate[];
  clients: ReportingCutoverClient[];
};

type ProvisionAction = {
  kind: "provision" | "adopt" | "restage";
  clientId: string;
  postCutover: boolean;
  shopifyConnectionId: string | null;
  googleAdsConnectionId: string | null;
  shopifyAnchorBindingId: string | null;
  existingAdAccountId: string | null;
};
type ProvisionCandidateAction = Omit<ProvisionAction, "clientId" | "postCutover">;
type UpgradeAction = {
  kind: "upgrade";
  bindingId: string;
  shopifyConnectionId: string;
  reconnectSessionId: string;
};
type SyncAction = { kind: "sync"; clientId: string; adAccountIds: string[] };
type ActivateAction = { kind: "activate"; clientId: string };
type StagedSyncAction = { kind: "staged_sync"; bindingId: string };
type PromoteAction = { kind: "promote"; bindingId: string };
type AbandonAction = { kind: "abandon"; bindingId: string };
type CutoverAction =
  | ProvisionAction
  | UpgradeAction
  | SyncAction
  | ActivateAction
  | StagedSyncAction
  | PromoteAction
  | AbandonAction;
type BuiltQueue = ClientReportingCutoverQueue & { actions: Map<string, CutoverAction> };

type SourceBundle = {
  clientId: string;
  shopify: ShopifyRow | null;
  google: GoogleRow | null;
  anchorBinding: BindingRow | null;
};

const ACTION_ID = /^rw_[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVISION_REASON = "Admin-reviewed reporting anchor provisioning";
const ADOPT_REASON = "Admin-reviewed explicit reporting anchor adoption";
const UPGRADE_REASON = "Admin-reviewed exact reconnect reporting upgrade";
const ACTIVATE_REASON = "Admin-reviewed reporting cutover after 90-day source sync";
const STAGE_REASON = "Admin-reviewed post-cutover reporting source staging";
const RESTAGE_REASON = "Admin-reviewed explicit abandoned reporting source reuse";
const PROMOTE_REASON = "Admin-reviewed post-stage reporting source promotion";
const ABANDON_REASON = "Admin-reviewed staged reporting source abandonment";

function canonicalGoogleCustomerId(value: string | null): string | null {
  if (!value || !/^[0-9\s-]+$/.test(value)) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

function isoDay(offset: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function opaqueActionId(parts: readonly (string | null)[]): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts))),
  );
  return `rw_${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function validShopify(connection: ShopifyRow, credentials: Set<string>): boolean {
  return Boolean(
    connection.status === "connected" &&
      connection.last_verified_at &&
      !connection.last_error_code &&
      credentials.has(connection.id) &&
      normalizeShopDomain(connection.shopify_domain) &&
      /^[A-Z]{3}$/.test(connection.shopify_currency),
  );
}

function validGoogle(connection: GoogleRow): boolean {
  return Boolean(
    connection.status === "connected" &&
      connection.last_verified_at &&
      !connection.last_error_code &&
      canonicalGoogleCustomerId(connection.windsor_account_id) &&
      connection.currency &&
      /^[A-Z]{3}$/.test(connection.currency) &&
      connection.time_zone?.trim(),
  );
}

function isVisiblePristineShell(account: AdAccountRow): boolean {
  return (
    account.status === "pending" &&
    account.reporting_role === "legacy_hybrid" &&
    !account.shopify_connected &&
    !account.shopify_client_id &&
    !account.shopify_scopes &&
    !account.shopify_token_last4 &&
    !account.shopify_connected_at &&
    !account.google_ads_connected_email &&
    !account.google_ads_connected
  );
}

function bundleCurrency(bundle: SourceBundle): string | null {
  return bundle.google?.currency ?? (bundle.shopify ? "EUR" : null);
}

function accountOwnsBundleIdentity(account: AdAccountRow, bundle: SourceBundle): boolean {
  const domain = bundle.shopify ? normalizeShopDomain(bundle.shopify.shopify_domain) : null;
  const customerId = bundle.google
    ? canonicalGoogleCustomerId(bundle.google.windsor_account_id)
    : null;
  return Boolean(
    (domain && account.shopify_url && normalizeShopDomain(account.shopify_url) === domain) ||
      (customerId && canonicalGoogleCustomerId(account.google_ads_customer_id) === customerId),
  );
}

function accountCanAdoptBundle(account: AdAccountRow, bundle: SourceBundle): boolean {
  if (!bundle.shopify || !isVisiblePristineShell(account)) return false;
  const domain = normalizeShopDomain(bundle.shopify.shopify_domain);
  const customerId = bundle.google
    ? canonicalGoogleCustomerId(bundle.google.windsor_account_id)
    : null;
  const currency = bundleCurrency(bundle);
  if (!domain || !currency || account.client_id !== bundle.clientId || account.currency !== currency) {
    return false;
  }
  if (account.shopify_url && normalizeShopDomain(account.shopify_url) !== domain) return false;
  if (
    account.google_ads_customer_id &&
    (!customerId || canonicalGoogleCustomerId(account.google_ads_customer_id) !== customerId)
  ) {
    return false;
  }
  return true;
}

function accountCanRestageBundle(account: AdAccountRow, bundle: SourceBundle): boolean {
  const currency = bundleCurrency(bundle);
  const domain = bundle.shopify ? normalizeShopDomain(bundle.shopify.shopify_domain) : null;
  const customerId = bundle.google
    ? canonicalGoogleCustomerId(bundle.google.windsor_account_id)
    : null;
  if (!currency || account.client_id !== bundle.clientId || account.currency !== currency) {
    return false;
  }
  if (account.reporting_role === "shopify_anchor") {
    return Boolean(
      domain &&
        normalizeShopDomain(account.shopify_url ?? "") === domain &&
        Boolean(account.google_ads_customer_id) === Boolean(customerId) &&
        (!customerId || account.google_ads_customer_id === customerId),
    );
  }
  if (account.reporting_role === "google_spend") {
    return Boolean(
      !bundle.shopify &&
        customerId &&
        !account.shopify_url &&
        account.google_ads_customer_id === customerId,
    );
  }
  return false;
}

function bundleLabel(bundle: SourceBundle): string {
  const parts = [
    bundle.shopify ? normalizeShopDomain(bundle.shopify.shopify_domain) : null,
    bundle.google ? canonicalGoogleCustomerId(bundle.google.windsor_account_id) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" + ");
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function reconnectEventEvidence(
  event: OnboardingEventRow,
  clientId: string,
): { connectionId: string; shopifyDomain: string } | null {
  if (
    event.event_type !== "shopify_connected" ||
    event.actor_type !== "invite" ||
    event.actor_id !== clientId ||
    !event.details ||
    typeof event.details !== "object" ||
    Array.isArray(event.details)
  ) {
    return null;
  }
  const details = event.details as Record<string, unknown>;
  const connectionId = details.connection_id;
  const shopifyDomain = details.shopify_domain;
  if (
    details.target_source !== "legacy" ||
    typeof connectionId !== "string" ||
    !UUID.test(connectionId) ||
    typeof shopifyDomain !== "string" ||
    !normalizeShopDomain(shopifyDomain)
  ) {
    return null;
  }
  return { connectionId, shopifyDomain };
}

async function buildClientReportingCutoverQueue(
  snapshot: ClientReportingCutoverSnapshot,
): Promise<BuiltQueue> {
  const actions = new Map<string, CutoverAction>();
  const candidates: ReportingCutoverCandidate[] = [];
  const clientsById = new Map(snapshot.clients.map((client) => [client.id, client]));
  const internalIds = new Set(
    snapshot.profiles.filter((profile) => profile.role === "admin").map((profile) => profile.id),
  );
  const rolloutByClient = new Map(
    snapshot.rolloutStates.map((rollout) => [rollout.client_id, rollout]),
  );
  const accountsById = new Map(snapshot.adAccounts.map((account) => [account.id, account]));
  const credentials = new Set(snapshot.shopifyCredentials.map((row) => row.connection_id));
  const connectedShopify = snapshot.shopifyConnections.filter(
    (connection) => connection.status === "connected",
  );
  const connectedGoogle = snapshot.googleConnections.filter(
    (connection) => connection.status === "connected",
  );
  const healthyShopify = connectedShopify.filter((connection) =>
    validShopify(connection, credentials),
  );
  // The immutable Google billing baseline is currently EUR-only. Keep
  // non-EUR sources visible in client readiness, but never offer an action
  // that would create an identity which cannot complete its billing lifecycle.
  const healthyGoogle = connectedGoogle.filter(
    (connection) => validGoogle(connection) && connection.currency === "EUR",
  );
  // Lifecycle projection needs the immutable identity even after a source is
  // disconnected, so an unhealthy staged reservation can still be abandoned.
  // Candidate and sync loops remain explicitly connected/healthy filtered.
  const shopifyById = new Map(
    snapshot.shopifyConnections.map((connection) => [connection.id, connection]),
  );
  const googleById = new Map(
    snapshot.googleConnections.map((connection) => [connection.id, connection]),
  );
  const activeBindings = snapshot.bindings.filter((binding) => binding.status === "active");
  const stagedBindings = snapshot.bindings.filter((binding) => binding.status === "staged");
  const reservedBindings = [...activeBindings, ...stagedBindings];
  const abandonedBindingIds = new Set(
    snapshot.anchorEvents
      .filter((event) => event.event_type === "source_abandoned")
      .map((event) => event.binding_id),
  );
  const promotedBindingIds = new Set(
    snapshot.anchorEvents
      .filter((event) => event.event_type === "source_added")
      .map((event) => event.binding_id),
  );
  const replacementRequiredClients = new Set<string>();
  const abandonedAccountIds = new Set(
    snapshot.bindings
      .filter(
        (binding) =>
          binding.status === "revoked" && abandonedBindingIds.has(binding.id),
      )
      .map((binding) => binding.ad_account_id),
  );
  const bindingByShopify = new Map(
    reservedBindings.flatMap((binding) =>
      binding.shopify_connection_id ? [[binding.shopify_connection_id, binding] as const] : [],
    ),
  );
  const bindingByGoogle = new Map(
    reservedBindings.flatMap((binding) =>
      binding.google_ads_connection_id
        ? [[binding.google_ads_connection_id, binding] as const]
        : [],
    ),
  );
  const googleIdsByShopify = new Map<string, string[]>();
  const mappedShopifyByGoogle = new Map<string, string>();
  for (const mapping of snapshot.mappings) {
    const ids = googleIdsByShopify.get(mapping.shopify_connection_id) ?? [];
    ids.push(mapping.google_ads_connection_id);
    googleIdsByShopify.set(mapping.shopify_connection_id, ids);
    mappedShopifyByGoogle.set(mapping.google_ads_connection_id, mapping.shopify_connection_id);
  }

  const addCandidate = async (
    bundle: SourceBundle,
    action: ProvisionCandidateAction | UpgradeAction,
    existingAccountName: string | null,
    explicit: boolean,
    message: string,
  ) => {
    const client = clientsById.get(bundle.clientId);
    const rollout = rolloutByClient.get(bundle.clientId);
    const reportingCutoverTime = rollout?.reporting_cutover_at
      ? Date.parse(rollout.reporting_cutover_at)
      : Number.NaN;
    const postCutover = Boolean(
      rollout?.operational_surface === "v2_active" &&
        rollout.reporting_cutover_at &&
        Number.isFinite(reportingCutoverTime),
    );
    if (
      !client ||
      client.approval_status !== "approved" ||
      internalIds.has(client.id) ||
      rollout?.operational_surface === "rollback_legacy" ||
      (postCutover &&
        !activeBindings.some((binding) => binding.client_id === bundle.clientId))
    ) {
      return;
    }
    // An exact reconnect that replaces an already-active Google binding is
    // not a fresh source. 0056 intentionally has no overlapping replacement
    // lifecycle; keep the old authority active and expose no unsafe action.
    if (postCutover && action.kind === "upgrade") {
      replacementRequiredClients.add(bundle.clientId);
      return;
    }
    if (!postCutover && action.kind === "restage") return;
    const resolvedAction: ProvisionAction | UpgradeAction =
      action.kind === "upgrade"
        ? action
        : { ...action, clientId: bundle.clientId, postCutover };
    const key =
      action.kind === "upgrade"
        ? [action.kind, action.bindingId, action.shopifyConnectionId, action.reconnectSessionId]
        : [
            action.kind,
            action.shopifyConnectionId,
            action.googleAdsConnectionId,
            action.shopifyAnchorBindingId,
            action.existingAdAccountId,
            postCutover ? rollout?.reporting_cutover_at ?? null : null,
            bundle.shopify?.updated_at ?? null,
            bundle.google?.updated_at ?? null,
          ];
    const id = await opaqueActionId(key);
    actions.set(id, resolvedAction);
    candidates.push({
      id,
      kind: action.kind,
      clientName: client.full_name,
      clientEmail: client.email,
      sourceLabel: bundleLabel(bundle),
      existingAccountName,
      requiresExplicitReview: explicit,
      message: postCutover
        ? `${message} It will remain staged and non-operational until its explicit 90-day sync and promotion.`
        : message,
    });
  };

  const addBundleCandidates = async (bundle: SourceBundle) => {
    if (!bundleCurrency(bundle)) return;
    const clientAccounts = snapshot.adAccounts.filter(
      (account) => account.client_id === bundle.clientId,
    );
    const identityOwners = clientAccounts.filter((account) =>
      accountOwnsBundleIdentity(account, bundle),
    );
    const exactAdoptions = identityOwners.filter((account) =>
      accountCanAdoptBundle(account, bundle),
    );
    const exactRestages = identityOwners.filter(
      (account) =>
        abandonedAccountIds.has(account.id) &&
        !snapshot.billingStarts.some((row) => row.ad_account_id === account.id) &&
        !snapshot.billingEnds.some((row) => row.ad_account_id === account.id) &&
        accountCanRestageBundle(account, bundle),
    );
    if (identityOwners.length > 0) {
      if (identityOwners.length === 1 && exactAdoptions.length === 1) {
        const account = exactAdoptions[0];
        await addCandidate(
          bundle,
          {
            kind: "adopt",
            shopifyConnectionId: bundle.shopify?.id ?? null,
            googleAdsConnectionId: bundle.google?.id ?? null,
            shopifyAnchorBindingId: bundle.anchorBinding?.id ?? null,
            existingAdAccountId: account.id,
          },
          account.store_name,
          true,
          "Adopt the exact pristine pending reporting identity. The database rechecks all history before writing.",
        );
      } else if (identityOwners.length === 1 && exactRestages.length === 1) {
        const account = exactRestages[0];
        await addCandidate(
          bundle,
          {
            kind: "restage",
            shopifyConnectionId: bundle.shopify?.id ?? null,
            googleAdsConnectionId: bundle.google?.id ?? null,
            shopifyAnchorBindingId: bundle.anchorBinding?.id ?? null,
            existingAdAccountId: account.id,
          },
          account.store_name,
          true,
          "Explicitly reuse this exact abandoned normalized identity after revalidating its current connections and mapping.",
        );
      }
      return;
    }

    await addCandidate(
      bundle,
      {
        kind: "provision",
        shopifyConnectionId: bundle.shopify?.id ?? null,
        googleAdsConnectionId: bundle.google?.id ?? null,
        shopifyAnchorBindingId: bundle.anchorBinding?.id ?? null,
        existingAdAccountId: null,
      },
      null,
      false,
      "Create a purpose-bound reporting identity without changing financial history.",
    );

    // Empty legacy shells are never inferred from a display name. They remain
    // separate, explicitly reviewed alternatives to normal provisioning.
    for (const account of clientAccounts.filter(
      (candidate) =>
        !candidate.shopify_url &&
        !candidate.google_ads_customer_id &&
        accountCanAdoptBundle(candidate, bundle),
    )) {
      await addCandidate(
        bundle,
        {
          kind: "adopt",
          shopifyConnectionId: bundle.shopify?.id ?? null,
          googleAdsConnectionId: bundle.google?.id ?? null,
          shopifyAnchorBindingId: bundle.anchorBinding?.id ?? null,
          existingAdAccountId: account.id,
        },
        account.store_name,
        true,
        "Explicitly adopt this empty pending shell. No display-name match is inferred; confirm the identity manually.",
      );
    }
  };

  const upgradedShopifyIds = new Set<string>();
  for (const oldBinding of activeBindings) {
    if (
      !oldBinding.google_ads_connection_id ||
      oldBinding.shopify_connection_id ||
      oldBinding.shopify_anchor_binding_id
    ) {
      continue;
    }
    const account = accountsById.get(oldBinding.ad_account_id);
    const google = googleById.get(oldBinding.google_ads_connection_id);
    if (!account || account.reporting_role !== "legacy_hybrid" || !google || !validGoogle(google)) {
      continue;
    }
    const reconnects = snapshot.sessions
      .filter(
        (session) =>
          session.mode === "reconnect" &&
          ["submitted", "reviewed", "active"].includes(session.status) &&
          session.claimed_user_id === oldBinding.client_id &&
          session.target_client_id === oldBinding.client_id &&
          session.reconnect_legacy_ad_account_id === oldBinding.ad_account_id &&
          session.reconnect_shopify_connection_id === null &&
          session.reconnect_completed_at,
      )
      .sort((left, right) =>
        (right.reconnect_completed_at ?? "").localeCompare(left.reconnect_completed_at ?? ""),
      );
    // A legacy-target reconnect deliberately keeps
    // reconnect_shopify_connection_id NULL. Its immutable shopify_connected
    // event is the purpose-bound connection proof consumed by the 0055 RPC.
    // Never choose between multiple sessions/events or accept malformed proof.
    if (reconnects.length !== 1) continue;
    const reconnect = reconnects[0];
    const events = snapshot.onboardingEvents.filter(
      (event) => event.session_id === reconnect.id && event.event_type === "shopify_connected",
    );
    if (events.length !== 1) continue;
    const evidence = reconnectEventEvidence(events[0], oldBinding.client_id);
    const shopify = evidence ? shopifyById.get(evidence.connectionId) : null;
    if (
      !evidence ||
      !shopify ||
      bindingByShopify.has(shopify.id) ||
      !validShopify(shopify, credentials) ||
      shopify.client_id !== oldBinding.client_id ||
      normalizeShopDomain(evidence.shopifyDomain) !==
        normalizeShopDomain(shopify.shopify_domain) ||
      normalizeShopDomain(account.shopify_url ?? "") !== normalizeShopDomain(shopify.shopify_domain) ||
      canonicalGoogleCustomerId(account.google_ads_customer_id) !==
        canonicalGoogleCustomerId(google.windsor_account_id) ||
      account.currency !== google.currency
    ) {
      continue;
    }
    upgradedShopifyIds.add(shopify.id);
    await addCandidate(
      { clientId: oldBinding.client_id, shopify, google, anchorBinding: null },
      {
        kind: "upgrade",
        bindingId: oldBinding.id,
        shopifyConnectionId: shopify.id,
        reconnectSessionId: reconnect.id,
      },
      account.store_name,
      false,
      "Upgrade the existing Google-only binding with its completed exact-store reconnect evidence.",
    );
  }

  const handledGoogleIds = new Set<string>();
  for (const shopify of healthyShopify) {
    if (bindingByShopify.has(shopify.id) || upgradedShopifyIds.has(shopify.id)) continue;
    const mapped = (googleIdsByShopify.get(shopify.id) ?? [])
      .map((id) => googleById.get(id))
      .filter((google): google is GoogleRow => Boolean(google));
    if (mapped.some((google) => bindingByGoogle.has(google.id))) continue;
    const unboundHealthyGoogle = mapped.filter(
      (google) =>
        !bindingByGoogle.has(google.id) && validGoogle(google) && google.currency === "EUR",
    );
    const google = unboundHealthyGoogle.length === 1 ? unboundHealthyGoogle[0] : null;
    if (google) handledGoogleIds.add(google.id);
    await addBundleCandidates({ clientId: shopify.client_id, shopify, google, anchorBinding: null });
  }

  for (const google of healthyGoogle) {
    if (bindingByGoogle.has(google.id) || handledGoogleIds.has(google.id)) continue;
    const mappedShopifyId = mappedShopifyByGoogle.get(google.id);
    if (mappedShopifyId) {
      const anchorBinding = bindingByShopify.get(mappedShopifyId);
      if (!anchorBinding) continue;
      await addBundleCandidates({
        clientId: google.client_id,
        shopify: null,
        google,
        anchorBinding,
      });
      continue;
    }
    await addBundleCandidates({
      clientId: google.client_id,
      shopify: null,
      google,
      anchorBinding: null,
    });
  }

  const todayMinus90 = isoDay(-90);
  const yesterday = isoDay(-1);
  const receiptIsReady = (binding: BindingRow, sourceType: string, currency: string) => {
    const receipt = snapshot.syncStates.find(
      (row) => row.binding_id === binding.id && row.source_type === sourceType,
    );
    return Boolean(
      receipt &&
        receipt.last_success_at > binding.bound_at &&
        receipt.last_success_from <= todayMinus90 &&
        receipt.last_success_to >= yesterday &&
        receipt.source_currency === currency,
    );
  };
  const workflows: ReportingCutoverClient[] = [];
  for (const client of snapshot.clients) {
    if (client.approval_status !== "approved" || internalIds.has(client.id)) continue;
    const rollout = rolloutByClient.get(client.id);
    const shopifySources = connectedShopify.filter((source) => source.client_id === client.id);
    const googleSources = connectedGoogle.filter((source) => source.client_id === client.id);
    const sourceCount = shopifySources.length + googleSources.length;
    if (sourceCount === 0) continue;

    const reportingCutoverTime = rollout?.reporting_cutover_at
      ? Date.parse(rollout.reporting_cutover_at)
      : Number.NaN;
    const validCutover = Boolean(
      rollout?.operational_surface === "v2_active" &&
        rollout.reporting_cutover_at &&
        Number.isFinite(reportingCutoverTime),
    );
    const rollback = rollout?.operational_surface === "rollback_legacy";
    const inconsistentMarker = Boolean(
      rollout?.reporting_cutover_at &&
        (rollout.operational_surface !== "v2_active" || !Number.isFinite(reportingCutoverTime)),
    );
    const clientActiveBindings = activeBindings.filter(
      (binding) => binding.client_id === client.id,
    );
    const clientStagedBindings = stagedBindings.filter(
      (binding) => binding.client_id === client.id,
    );
    const authoritativeBindings = validCutover
      ? clientActiveBindings.filter((binding) => {
          const boundAt = Date.parse(binding.bound_at);
          return (
            Number.isFinite(boundAt) &&
            (boundAt <= reportingCutoverTime || promotedBindingIds.has(binding.id))
          );
        })
      : clientActiveBindings;
    const unsafePostCutoverActive =
      validCutover && authoritativeBindings.length !== clientActiveBindings.length;
    const authoritativeBindingsHealthy =
      !validCutover ||
      (authoritativeBindings.length > 0 &&
        authoritativeBindings.every((binding) => {
          const shopify = binding.shopify_connection_id
            ? shopifyById.get(binding.shopify_connection_id)
            : null;
          const google = binding.google_ads_connection_id
            ? googleById.get(binding.google_ads_connection_id)
            : null;
          return Boolean(
            (shopify || google) &&
              (!binding.shopify_connection_id ||
                (shopify && validShopify(shopify, credentials))) &&
              (!binding.google_ads_connection_id || (google && validGoogle(google))),
          );
        }));

    const coveredShopify = new Map<string, number>();
    const coveredGoogle = new Map<string, number>();
    for (const binding of authoritativeBindings) {
      if (binding.shopify_connection_id) {
        coveredShopify.set(
          binding.shopify_connection_id,
          (coveredShopify.get(binding.shopify_connection_id) ?? 0) + 1,
        );
      }
      if (binding.google_ads_connection_id) {
        coveredGoogle.set(
          binding.google_ads_connection_id,
          (coveredGoogle.get(binding.google_ads_connection_id) ?? 0) + 1,
        );
      }
    }
    const boundSourceCount =
      shopifySources.filter((source) => coveredShopify.get(source.id) === 1).length +
      googleSources.filter((source) => coveredGoogle.get(source.id) === 1).length;
    const healthy =
      shopifySources.every((source) => validShopify(source, credentials)) &&
      googleSources.every(validGoogle);
    const billingCurrencySupported = googleSources.every(
      (source) => source.currency === "EUR",
    );
    const sourceCoverageExact =
      healthy &&
      billingCurrencySupported &&
      boundSourceCount === sourceCount &&
      [...coveredShopify.keys()].every((id) =>
        shopifySources.some((source) => source.id === id),
      ) &&
      [...coveredGoogle.keys()].every((id) =>
        googleSources.some((source) => source.id === id),
      );
    const shopifyRequired = sourceCoverageExact && shopifySources.length === 0;
    const exactCoverage =
      sourceCoverageExact &&
      authoritativeBindings.some((binding) => binding.shopify_connection_id);

    let syncedSourceCount = validCutover ? boundSourceCount : 0;
    if (!validCutover) {
      for (const binding of authoritativeBindings) {
        const shopify = binding.shopify_connection_id
          ? shopifyById.get(binding.shopify_connection_id)
          : null;
        const google = binding.google_ads_connection_id
          ? googleById.get(binding.google_ads_connection_id)
          : null;
        if (shopify && receiptIsReady(binding, "shopify", shopify.shopify_currency)) {
          syncedSourceCount += 1;
        }
        if (google?.currency && receiptIsReady(binding, "google_ads", google.currency)) {
          syncedSourceCount += 1;
        }
      }
    }
    const syncReady = exactCoverage && syncedSourceCount === sourceCount;

    const stagedSources: ReportingStagedSource[] = [];
    for (const binding of clientStagedBindings) {
      const account = accountsById.get(binding.ad_account_id);
      const shopify = binding.shopify_connection_id
        ? shopifyById.get(binding.shopify_connection_id)
        : null;
      const google = binding.google_ads_connection_id
        ? googleById.get(binding.google_ads_connection_id)
        : null;
      const stagedSourceCount = Number(Boolean(shopify)) + Number(Boolean(google));
      const stagedHealthy = Boolean(
        account &&
          stagedSourceCount > 0 &&
          (!shopify || validShopify(shopify, credentials)) &&
          (!google || (validGoogle(google) && google.currency === "EUR")),
      );
      let stagedSyncedSourceCount = 0;
      if (shopify && receiptIsReady(binding, "shopify", shopify.shopify_currency)) {
        stagedSyncedSourceCount += 1;
      }
      if (google?.currency && receiptIsReady(binding, "google_ads", google.currency)) {
        stagedSyncedSourceCount += 1;
      }
      const stagedSyncComplete =
        stagedHealthy && stagedSyncedSourceCount === stagedSourceCount;
      const customerId = google
        ? canonicalGoogleCustomerId(google.windsor_account_id)
        : null;
      const billingStart = google
        ? snapshot.billingStarts.find(
            (row) =>
              row.ad_account_id === binding.ad_account_id &&
              row.google_ads_customer_id === customerId &&
              row.currency === account?.currency,
          )
        : null;
      const billingEnd = google
        ? snapshot.billingEnds.find(
            (row) =>
              row.ad_account_id === binding.ad_account_id &&
              row.google_ads_customer_id === customerId &&
              row.currency === account?.currency,
          )
        : null;
      const billingReady = Boolean(
        !google ||
          (billingStart &&
            !billingEnd &&
            account &&
            ["active", "suspended"].includes(account.status)),
      );
      const hasAnyBillingStart = snapshot.billingStarts.some(
        (row) => row.ad_account_id === binding.ad_account_id,
      );

      let syncActionId: string | null = null;
      let promoteActionId: string | null = null;
      let abandonActionId: string | null = null;
      if (validCutover && !rollback && !inconsistentMarker && stagedHealthy) {
        syncActionId = await opaqueActionId([
          "staged_sync",
          binding.id,
          binding.bound_at,
          shopify?.updated_at ?? null,
          google?.updated_at ?? null,
        ]);
        actions.set(syncActionId, { kind: "staged_sync", bindingId: binding.id });
        if (stagedSyncComplete && billingReady) {
          promoteActionId = await opaqueActionId([
            "promote",
            binding.id,
            binding.bound_at,
            account?.status ?? null,
            billingStart ? `${billingStart.google_ads_customer_id}:${billingStart.currency}` : null,
            ...snapshot.syncStates
              .filter((row) => row.binding_id === binding.id)
              .map(
                (row) =>
                  `${row.source_type}:${row.last_success_at}:${row.last_success_from}:${row.last_success_to}:${row.source_currency}`,
              )
              .sort(),
          ]);
          actions.set(promoteActionId, { kind: "promote", bindingId: binding.id });
        }
      }
      if (
        validCutover &&
        !rollback &&
        !inconsistentMarker &&
        (!hasAnyBillingStart || billingEnd)
      ) {
        abandonActionId = await opaqueActionId([
          "abandon",
          binding.id,
          binding.bound_at,
          hasAnyBillingStart ? "billing_ended" : "unbilled",
        ]);
        actions.set(abandonActionId, { kind: "abandon", bindingId: binding.id });
      }

      const sourceLabel =
        [
          shopify ? normalizeShopDomain(shopify.shopify_domain) : null,
          google ? canonicalGoogleCustomerId(google.windsor_account_id) : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" + ") || account?.store_name || binding.id;
      const message = !stagedHealthy
        ? "This source is staged but non-operational. Repair its exact connection identity and health before syncing."
        : !stagedSyncComplete
          ? "Staged and non-operational. Run the exact 90-day sync before any billing start or promotion."
          : google && billingEnd
            ? "Billing is terminal for this staged identity. It cannot promote; abandon it explicitly."
            : google && !billingStart
              ? "The 90-day sync is complete. Start the immutable Google billing baseline, then promote."
              : google && !billingReady
                ? "Billing has started, but its account status is not promotable. Repair billing state before promotion."
                : "The staged source has complete receipts and billing evidence. It is still non-operational until Promote succeeds.";
      stagedSources.push({
        bindingId: binding.id,
        sourceLabel,
        syncedSourceCount: stagedSyncedSourceCount,
        sourceCount: stagedSourceCount,
        billingReady,
        syncActionId,
        promoteActionId,
        abandonActionId,
        message,
      });
    }

    const activationSession = snapshot.sessions.find(
      (session) => session.id === rollout?.onboarding_session_id,
    );
    const activationSessionReady = Boolean(
      activationSession &&
        activationSession.claimed_user_id === client.id &&
        ["submitted", "reviewed", "active"].includes(activationSession.status) &&
        Array.isArray(activationSession.requested_assets) &&
        activationSession.requested_assets.length > 0,
    );
    let syncActionId: string | null = null;
    let activateActionId: string | null = null;
    if (
      !validCutover &&
      !rollback &&
      !inconsistentMarker &&
      exactCoverage
    ) {
      const adAccountIds = [
        ...new Set(authoritativeBindings.map((binding) => binding.ad_account_id)),
      ].sort();
      syncActionId = await opaqueActionId([
        "sync",
        client.id,
        todayMinus90,
        yesterday,
        ...authoritativeBindings
          .map((binding) => `${binding.id}:${binding.bound_at}`)
          .sort(),
      ]);
      actions.set(syncActionId, { kind: "sync", clientId: client.id, adAccountIds });
      if (
        syncReady &&
        activationSessionReady &&
        ["v2_ready_for_cutover", "v2_active"].includes(rollout?.operational_surface ?? "")
      ) {
        activateActionId = await opaqueActionId([
          "activate",
          client.id,
          rollout?.onboarding_session_id ?? null,
          ...snapshot.syncStates
            .filter((row) =>
              authoritativeBindings.some((binding) => binding.id === row.binding_id),
            )
            .map(
              (row) =>
                `${row.binding_id}:${row.source_type}:${row.last_success_at}:${row.last_success_from}:${row.last_success_to}:${row.source_currency}`,
            )
            .sort(),
        ]);
        actions.set(activateActionId, { kind: "activate", clientId: client.id });
      }
    }

    const activationSessionBlocked =
      !validCutover && exactCoverage && syncReady && !activationSessionReady;
    const replacementRequired =
      validCutover && replacementRequiredClients.has(client.id);
    const status: ReportingCutoverClient["status"] = rollback ||
      inconsistentMarker ||
      unsafePostCutoverActive ||
      !authoritativeBindingsHealthy ||
      !billingCurrencySupported ||
      (validCutover && !exactCoverage && !replacementRequired) ||
      shopifyRequired ||
      activationSessionBlocked
      ? "blocked"
      : replacementRequired
        ? "replacement_required"
        : validCutover
          ? "active"
          : !exactCoverage
            ? "bindings_required"
            : syncReady
              ? "ready_to_activate"
              : "ready_to_sync";
    const message = rollback
      ? "Legacy rollback overrides the reporting marker."
      : inconsistentMarker
        ? "Reporting marker and operational surface disagree; no write is available."
        : unsafePostCutoverActive
          ? "A post-cutover active binding has no immutable source_added promotion event. Existing authority stays fail-closed until it is repaired."
          : !authoritativeBindingsHealthy
            ? "An authoritative reporting binding no longer has its exact healthy connected source. Reporting remains blocked until that authority is repaired."
          : !billingCurrencySupported
            ? "Google staged reporting currently requires EUR because the immutable billing baseline is EUR-only. No staging or activation action is available."
            : validCutover && !exactCoverage && !healthy
              ? "The existing reporting authority remains active, but a new connected source is blocked until it is verified and healthy; then it can be staged explicitly."
            : shopifyRequired
              ? "Reporting activation requires at least one connected Shopify store anchor."
              : activationSessionBlocked
                ? "The rollout has no reviewed asset onboarding session. Reporting activation is withheld until that evidence is repaired."
                : replacementRequired
                  ? "The client remains V2 active on its existing authority. This exact reconnect is a replacement, not a fresh source, and requires the separate staged replacement lifecycle (0057)."
                  : validCutover && stagedSources.length > 0
                    ? `The existing V2 reporting authority remains active. ${stagedSources.length} source${stagedSources.length === 1 ? " is" : "s are"} staged and non-operational until explicit sync, billing (when applicable), and promotion.`
                    : validCutover && !exactCoverage
                      ? "The existing V2 reporting authority remains active. A connected source is outside authority and must be staged explicitly."
                      : validCutover
                        ? "Reporting cutover is active."
                        : !exactCoverage
                          ? "Bind every healthy connected source exactly once."
                          : syncReady
                            ? "The 90-day receipts are complete; reporting can be activated."
                            : "Run the explicit 90-day source sync before activation.";
    workflows.push({
      id: client.id,
      name: client.full_name,
      email: client.email,
      status,
      sourceCount,
      boundSourceCount,
      syncedSourceCount,
      reportingCutoverAt: validCutover ? rollout?.reporting_cutover_at ?? null : null,
      syncActionId,
      activateActionId,
      stagedSources,
      message,
    });
  }

  candidates.sort(
    (left, right) =>
      compareText(left.clientName, right.clientName) ||
      compareText(left.sourceLabel, right.sourceLabel) ||
      compareText(left.kind, right.kind),
  );
  workflows.sort((left, right) => compareText(left.name, right.name));
  return { available: true, candidates, clients: workflows, actions };
}

export async function projectClientReportingCutover(
  snapshot: ClientReportingCutoverSnapshot,
): Promise<ClientReportingCutoverQueue> {
  const { available, candidates, clients } = await buildClientReportingCutoverQueue(snapshot);
  return { available, candidates, clients };
}

async function loadSnapshot(service: Service): Promise<ClientReportingCutoverSnapshot> {
  const [
    clients,
    profiles,
    rolloutStates,
    adAccounts,
    shopify,
    shopifyCredentials,
    google,
    mappings,
    bindings,
    syncStates,
    sessions,
    onboardingEvents,
    anchorEvents,
    billingStarts,
    billingEnds,
  ] = await Promise.all([
    service.from("portal_clients").select("id, full_name, email, approval_status"),
    service.from("profiles").select("id, role"),
    service
      .from("client_rollout_states")
      .select(
        "client_id, operational_surface, onboarding_session_id, reporting_cutover_at, reporting_cutover_by, reporting_cutover_reason",
      ),
    service
      .from("ad_accounts")
      .select(
        "id, client_id, store_name, google_ads_customer_id, shopify_url, status, reporting_role, currency, shopify_connected, shopify_client_id, shopify_scopes, shopify_token_last4, shopify_connected_at, google_ads_connected_email, google_ads_connected",
      ),
    service
      .from("client_shopify_connections")
      .select(
        "id, session_id, client_id, status, shopify_name, shopify_domain, shopify_currency, last_verified_at, last_error_code, updated_at",
      ),
    service.from("client_shopify_credentials").select("connection_id"),
    service
      .from("client_google_ads_connections")
      .select(
        "id, session_id, client_id, status, windsor_account_id, account_name, currency, time_zone, last_verified_at, last_error_code, updated_at",
      ),
    service
      .from("client_asset_mappings")
      .select("session_id, shopify_connection_id, google_ads_connection_id"),
    service
      .from("client_reporting_bindings")
      .select(
        "id, client_id, ad_account_id, shopify_connection_id, google_ads_connection_id, shopify_anchor_binding_id, status, bound_at",
      ),
    service
      .from("client_reporting_sync_states")
      .select(
        "binding_id, source_type, last_success_at, last_success_from, last_success_to, source_currency, row_count",
      ),
    service
      .from("client_onboarding_sessions")
      .select(
        "id, created_by, mode, requested_assets, status, target_client_id, claimed_user_id, reconnect_legacy_ad_account_id, reconnect_shopify_connection_id, reconnect_completed_at",
      ),
    service
      .from("client_onboarding_events")
      .select("session_id, event_type, actor_type, actor_id, details, created_at"),
    service
      .from("client_reporting_anchor_events")
      .select(
        "binding_id, prior_binding_id, ad_account_id, event_type, idempotency_key, actor_id, reason, details, created_at",
      ),
    service
      .from("ad_account_billing_starts")
      .select("ad_account_id, google_ads_customer_id, currency"),
    service
      .from("ad_account_billing_ends")
      .select("ad_account_id, google_ads_customer_id, currency"),
  ]);
  const error = [
    clients,
    profiles,
    rolloutStates,
    adAccounts,
    shopify,
    shopifyCredentials,
    google,
    mappings,
    bindings,
    syncStates,
    sessions,
    onboardingEvents,
    anchorEvents,
    billingStarts,
    billingEnds,
  ].find((result) => result.error)?.error;
  if (error) {
    throw new ClientOnboardingError(
      "database_error",
      "The Phase 2 reporting migration is unavailable; no cutover write was attempted.",
      503,
    );
  }
  return {
    clients: (clients.data ?? []) as ClientRow[],
    profiles: (profiles.data ?? []) as ProfileRow[],
    rolloutStates: (rolloutStates.data ?? []) as RolloutRow[],
    adAccounts: (adAccounts.data ?? []) as AdAccountRow[],
    shopifyConnections: (shopify.data ?? []) as ShopifyRow[],
    shopifyCredentials: (shopifyCredentials.data ?? []) as ShopifyCredentialRow[],
    googleConnections: (google.data ?? []) as GoogleRow[],
    mappings: (mappings.data ?? []) as MappingRow[],
    bindings: (bindings.data ?? []) as BindingRow[],
    syncStates: (syncStates.data ?? []) as SyncRow[],
    sessions: (sessions.data ?? []) as SessionRow[],
    onboardingEvents: (onboardingEvents.data ?? []) as OnboardingEventRow[],
    anchorEvents: (anchorEvents.data ?? []) as AnchorEventRow[],
    billingStarts: (billingStarts.data ?? []) as BillingStartRow[],
    billingEnds: (billingEnds.data ?? []) as BillingEndRow[],
  };
}

function serviceOrThrow(): Service {
  const service = createServiceClient();
  if (!service) {
    throw new ClientOnboardingError(
      "server_not_configured",
      "Server-side reporting cutover is not configured.",
      503,
    );
  }
  return service;
}

function databaseWriteError(error: { code?: string } | null | undefined): ClientOnboardingError {
  if (["42P01", "42703", "42883", "PGRST202", "PGRST204"].includes(error?.code ?? "")) {
    return new ClientOnboardingError(
      "database_error",
      "The Phase 2 reporting migration is unavailable; no cutover write was attempted.",
      503,
    );
  }
  if (error?.code === "42501") {
    return new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  if (["22023", "23503", "23505", "23514", "P0002"].includes(error?.code ?? "")) {
    return new ClientOnboardingError(
      "invalid_state",
      "Reporting sources changed during review. Refresh and audit the workflow again.",
      409,
    );
  }
  return new ClientOnboardingError(
    "database_error",
    "The reporting cutover action failed and remains inactive.",
    500,
  );
}

async function executeCutoverAction(
  service: Service,
  action: CutoverAction,
  actionId: string,
  adminId: string,
): Promise<{ action: CutoverAction["kind"] }> {
  if (action.kind === "sync") {
    try {
      await refreshReportingSourcesNow(action.adAccountIds, {
        client: service,
        from: isoDay(-90),
        to: isoDay(-1),
      });
    } catch (error) {
      throw databaseWriteError(error as { code?: string });
    }
    return { action: action.kind };
  }

  if (action.kind === "activate") {
    const { data, error } = await service.rpc("activate_client_reporting_cutover", {
      p_client_id: action.clientId,
      p_admin_id: adminId,
      p_reason: ACTIVATE_REASON,
    });
    if (error) throw databaseWriteError(error);
    if (data !== action.clientId) throw databaseWriteError(null);
    return { action: action.kind };
  }

  if (action.kind === "staged_sync") {
    try {
      await refreshStagedReportingSourceNow(action.bindingId, {
        client: service,
        from: isoDay(-90),
        to: isoDay(-1),
      });
    } catch (error) {
      throw databaseWriteError(error as { code?: string });
    }
    return { action: action.kind };
  }

  const idempotencyKey = `anchor:${actionId.slice(3)}`;
  if (action.kind === "promote" || action.kind === "abandon") {
    const rpcName =
      action.kind === "promote"
        ? "promote_client_reporting_source"
        : "abandon_client_reporting_source";
    const { data, error } = await service.rpc(rpcName, {
      p_binding_id: action.bindingId,
      p_admin_id: adminId,
      p_idempotency_key: idempotencyKey,
      p_reason: action.kind === "promote" ? PROMOTE_REASON : ABANDON_REASON,
    });
    if (error) throw databaseWriteError(error);
    if (data !== action.bindingId) throw databaseWriteError(null);
    return { action: action.kind };
  }

  if (action.kind === "upgrade") {
    const { data, error } = await service.rpc(
      "upgrade_client_reporting_google_binding_to_pair",
      {
        p_binding_id: action.bindingId,
        p_shopify_connection_id: action.shopifyConnectionId,
        p_reconnect_session_id: action.reconnectSessionId,
        p_idempotency_key: idempotencyKey,
        p_admin_id: adminId,
        p_reason: UPGRADE_REASON,
      },
    );
    if (error) throw databaseWriteError(error);
    if (typeof data !== "string" || !UUID.test(data)) throw databaseWriteError(null);
    return { action: action.kind };
  }

  if (action.postCutover) {
    const { data, error } = await service.rpc("stage_client_reporting_source", {
      p_client_id: action.clientId,
      p_shopify_connection_id: action.shopifyConnectionId,
      p_google_ads_connection_id: action.googleAdsConnectionId,
      p_shopify_anchor_binding_id: action.shopifyAnchorBindingId,
      p_existing_ad_account_id: action.existingAdAccountId,
      p_idempotency_key: idempotencyKey,
      p_admin_id: adminId,
      p_reason:
        action.kind === "restage"
          ? RESTAGE_REASON
          : action.kind === "adopt"
            ? ADOPT_REASON
            : STAGE_REASON,
    });
    if (error) throw databaseWriteError(error);
    if (typeof data !== "string" || !UUID.test(data)) throw databaseWriteError(null);
    return { action: action.kind };
  }

  const { data, error } = await service.rpc("provision_client_reporting_anchor", {
    p_shopify_connection_id: action.shopifyConnectionId,
    p_google_ads_connection_id: action.googleAdsConnectionId,
    p_shopify_anchor_binding_id: action.shopifyAnchorBindingId,
    p_existing_ad_account_id: action.existingAdAccountId,
    p_idempotency_key: idempotencyKey,
    p_admin_id: adminId,
    p_reason: action.kind === "adopt" ? ADOPT_REASON : PROVISION_REASON,
  });
  if (error) throw databaseWriteError(error);
  if (typeof data !== "string" || !UUID.test(data)) throw databaseWriteError(null);
  return { action: action.kind };
}

function automaticProvisionSessionId(
  action: ProvisionAction,
  snapshot: ClientReportingCutoverSnapshot,
): string | null {
  const mappingSessions = snapshot.mappings
    .filter((mapping) =>
      (action.shopifyConnectionId === null ||
        mapping.shopify_connection_id === action.shopifyConnectionId) &&
      (action.googleAdsConnectionId === null ||
        mapping.google_ads_connection_id === action.googleAdsConnectionId),
    )
    .map((mapping) => mapping.session_id);
  const connectionSessions = [
    action.shopifyConnectionId
      ? snapshot.shopifyConnections.find(
          (connection) => connection.id === action.shopifyConnectionId,
        )?.session_id
      : null,
    action.googleAdsConnectionId
      ? snapshot.googleConnections.find(
          (connection) => connection.id === action.googleAdsConnectionId,
        )?.session_id
      : null,
  ];
  const sessionIds = [
    ...new Set(
      (mappingSessions.length > 0 ? mappingSessions : connectionSessions).filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  return sessionIds.length === 1 ? sessionIds[0] : null;
}

function automaticProvisionIsSafe(
  action: ProvisionAction,
  snapshot: ClientReportingCutoverSnapshot,
): boolean {
  if (action.postCutover || !["provision", "adopt"].includes(action.kind)) return false;
  const shopify = action.shopifyConnectionId
    ? snapshot.shopifyConnections.find(
        (connection) => connection.id === action.shopifyConnectionId,
      ) ?? null
    : null;
  const google = action.googleAdsConnectionId
    ? snapshot.googleConnections.find(
        (connection) => connection.id === action.googleAdsConnectionId,
      ) ?? null
    : null;
  if (
    (shopify && shopify.client_id !== action.clientId) ||
    (google && google.client_id !== action.clientId)
  ) {
    return false;
  }

  const mappedPair = Boolean(
    shopify &&
      google &&
      snapshot.mappings.some(
        (mapping) =>
          mapping.shopify_connection_id === shopify.id &&
          mapping.google_ads_connection_id === google.id,
      ),
  );
  if (shopify && google && !mappedPair) return false;

  if (action.kind === "adopt") {
    const account = action.existingAdAccountId
      ? snapshot.adAccounts.find((candidate) => candidate.id === action.existingAdAccountId)
      : null;
    const anchor = action.shopifyAnchorBindingId
      ? snapshot.bindings.find((binding) => binding.id === action.shopifyAnchorBindingId) ?? null
      : null;
    const bundle: SourceBundle = {
      clientId: action.clientId,
      shopify,
      google,
      anchorBinding: anchor,
    };
    // Empty-shell adoption remains a deliberate admin operation. Automation
    // is limited to an account whose canonical Shopify or Google identity is
    // already the exact identity selected by the reviewed mapping.
    if (!account || !accountOwnsBundleIdentity(account, bundle) || !accountCanAdoptBundle(account, bundle)) {
      return false;
    }
  }

  const activeBindings = snapshot.bindings.filter(
    (binding) => binding.client_id === action.clientId && binding.status === "active",
  );
  if (shopify && !google) {
    // A client whose Google spend already reports through an existing account
    // (an active google-only binding) must not get a parallel Shopify-only
    // shell: that splits one store's spend and sales across two ad accounts.
    // Anchoring the Shopify identity to the existing account is an admin
    // decision, never an automatic provision.
    if (
      activeBindings.some(
        (binding) =>
          binding.google_ads_connection_id !== null &&
          binding.shopify_connection_id === null,
      )
    ) {
      return false;
    }
    const unboundGoogle = snapshot.googleConnections.filter(
      (connection) =>
        connection.client_id === action.clientId &&
        connection.status === "connected" &&
        !activeBindings.some(
          (binding) => binding.google_ads_connection_id === connection.id,
        ),
    );
    return unboundGoogle.every((connection) =>
      snapshot.mappings.some(
        (mapping) =>
          mapping.shopify_connection_id === shopify.id &&
          mapping.google_ads_connection_id === connection.id,
      ),
    );
  }
  if (google && !shopify && !action.shopifyAnchorBindingId) {
    return !snapshot.shopifyConnections.some(
      (connection) =>
        connection.client_id === action.clientId && connection.status === "connected",
    );
  }
  return Boolean(shopify || google);
}

/**
 * Materialise only unambiguous, reviewed onboarding mappings. This does not
 * activate reporting cutover or billing; the reporting sync that called it
 * remains responsible for writing the requested daily window.
 */
export async function provisionReviewedClientReportingSources(
  service: Service,
): Promise<{ attempted: number; provisioned: number; failed: number }> {
  const snapshot = await loadSnapshot(service);
  const queue = await buildClientReportingCutoverQueue(snapshot);
  const adminIds = new Set(
    snapshot.profiles
      .filter((profile) => profile.role === "admin")
      .map((profile) => profile.id),
  );
  const rows = queue.candidates.flatMap((candidate) => {
    const action = queue.actions.get(candidate.id);
    return action && (action.kind === "provision" || action.kind === "adopt")
      ? [{ candidate, action }]
      : [];
  });
  const signatureCount = new Map<string, number>();
  for (const { action } of rows) {
    const signature = [
      action.clientId,
      action.shopifyConnectionId,
      action.googleAdsConnectionId,
      action.shopifyAnchorBindingId,
    ].join(":");
    signatureCount.set(signature, (signatureCount.get(signature) ?? 0) + 1);
  }

  let attempted = 0;
  let provisioned = 0;
  let failed = 0;
  for (const { candidate, action } of rows.slice(0, 25)) {
    const signature = [
      action.clientId,
      action.shopifyConnectionId,
      action.googleAdsConnectionId,
      action.shopifyAnchorBindingId,
    ].join(":");
    if (
      signatureCount.get(signature) !== 1 ||
      !automaticProvisionIsSafe(action, snapshot)
    ) {
      continue;
    }
    const sessionId = automaticProvisionSessionId(action, snapshot);
    const session = sessionId
      ? snapshot.sessions.find((candidateSession) => candidateSession.id === sessionId)
      : null;
    if (
      !session ||
      !["reviewed", "active"].includes(session.status) ||
      session.claimed_user_id !== action.clientId ||
      typeof session.created_by !== "string" ||
      !adminIds.has(session.created_by)
    ) {
      continue;
    }
    attempted += 1;
    try {
      await executeCutoverAction(service, action, candidate.id, session.created_by);
      provisioned += 1;
    } catch {
      // One stale candidate cannot prevent healthy clients from syncing. The
      // authoritative RPC is idempotent and revalidates every source under lock.
      failed += 1;
    }
  }
  return { attempted, provisioned, failed };
}

/**
 * Owner policy (2026-08-18): besides Sync and Issue Invoices there are no
 * clicks. A client whose bindings prove exact coverage advances through the
 * cutover queue's own offers without an admin touch — the 90-day source sync
 * runs, and once receipts are complete the activation marker follows in the
 * same pass, so the portal lights up the moment reporting does. The reviewer
 * of record is the admin who created the client's still-valid onboarding
 * session; clients the queue does not offer, or whose session cannot vouch
 * for them, stay put.
 */
export async function advanceEligibleClientReportingCutovers(
  service: Service,
): Promise<{
  syncsAttempted: number;
  syncsCompleted: number;
  activationsAttempted: number;
  activated: number;
  failed: number;
}> {
  const outcome = {
    syncsAttempted: 0,
    syncsCompleted: 0,
    activationsAttempted: 0,
    activated: 0,
    failed: 0,
  };

  const eligibleActions = async () => {
    const snapshot = await loadSnapshot(service);
    const queue = await buildClientReportingCutoverQueue(snapshot);
    const adminIds = new Set(
      snapshot.profiles
        .filter((profile) => profile.role === "admin")
        .map((profile) => profile.id),
    );
    return [...queue.actions.entries()].flatMap(([actionId, action]) => {
      if (action.kind !== "activate" && action.kind !== "sync") return [];
      const rollout = snapshot.rolloutStates.find(
        (state) => state.client_id === action.clientId,
      );
      const session = rollout?.onboarding_session_id
        ? snapshot.sessions.find(
            (candidate) => candidate.id === rollout.onboarding_session_id,
          )
        : null;
      // Mirror of the queue's activationSessionReady, plus the admin-creator
      // requirement: without a session that can vouch for the client, the
      // automatic path never touches it (and never loops on its sync).
      if (
        !session ||
        typeof session.created_by !== "string" ||
        !adminIds.has(session.created_by) ||
        session.claimed_user_id !== action.clientId ||
        !["submitted", "reviewed", "active"].includes(session.status) ||
        !Array.isArray(session.requested_assets) ||
        session.requested_assets.length === 0
      ) {
        return [];
      }
      return [{ actionId, action, adminId: session.created_by }];
    });
  };

  const run = async (
    entry: Awaited<ReturnType<typeof eligibleActions>>[number],
  ): Promise<boolean> => {
    try {
      await executeCutoverAction(
        service,
        entry.action,
        entry.actionId,
        entry.adminId,
      );
      return true;
    } catch (error) {
      outcome.failed += 1;
      console.error(
        `Automatic reporting cutover ${entry.action.kind} failed for client ${entry.action.clientId}:`,
        error,
      );
      return false;
    }
  };

  const executed = new Set<string>();
  const firstPass = await eligibleActions();
  for (const entry of firstPass) {
    executed.add(entry.actionId);
    if (entry.action.kind === "sync") {
      outcome.syncsAttempted += 1;
      if (await run(entry)) outcome.syncsCompleted += 1;
    } else {
      outcome.activationsAttempted += 1;
      if (await run(entry)) outcome.activated += 1;
    }
  }

  // A completed 90-day sync often makes activation possible immediately —
  // recompute once so a fresh client converges in a single pass instead of
  // waiting for the next hourly cycle. Action ids are content-addressed, so
  // anything already executed this pass is skipped by identity.
  if (outcome.syncsCompleted > 0) {
    for (const entry of await eligibleActions()) {
      if (entry.action.kind !== "activate" || executed.has(entry.actionId)) {
        continue;
      }
      outcome.activationsAttempted += 1;
      if (await run(entry)) outcome.activated += 1;
    }
  }

  return outcome;
}

export async function listClientReportingCutoverQueue(): Promise<ClientReportingCutoverQueue> {
  await requireClientOnboardingAdmin();
  const service = serviceOrThrow();
  try {
    return await projectClientReportingCutover(await loadSnapshot(service));
  } catch (error) {
    if (error instanceof ClientOnboardingError && error.status === 503) {
      return { available: false, candidates: [], clients: [] };
    }
    throw error;
  }
}

/** Authenticates before reading the opaque action id or constructing service_role. */
export async function executeClientReportingCutoverRequest(request: Request) {
  const admin = await requireClientOnboardingAdmin();
  const body = await readSmallJson(request, 512);
  if (
    !isExactRecord(body, ["actionId"]) ||
    typeof body.actionId !== "string" ||
    !ACTION_ID.test(body.actionId)
  ) {
    throw new ClientOnboardingError(
      "invalid_request",
      "Send exactly one valid reporting workflow action.",
      400,
    );
  }

  const service = serviceOrThrow();
  const queue = await buildClientReportingCutoverQueue(await loadSnapshot(service));
  const action = queue.actions.get(body.actionId);
  if (!action) {
    throw new ClientOnboardingError(
      "invalid_state",
      "This reporting workflow action is stale or no longer eligible. Refresh and review it again.",
      409,
    );
  }
  return executeCutoverAction(service, action, body.actionId, admin.id);
}
