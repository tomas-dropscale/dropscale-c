import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isExactRecord, readSmallJson } from "@/lib/client-onboarding/http";
import {
  ClientOnboardingError,
  requireClientOnboardingAdmin,
} from "@/lib/client-onboarding/sessions";
import { normalizeShopDomain } from "@/lib/shopify/client";
import { createServiceClient } from "@/lib/supabase/service";

type ClientRow = {
  id: string;
  full_name: string;
  email: string;
  approval_status: string;
};
type ProfileRow = { id: string; role: string };
type RolloutRow = { client_id: string; operational_surface: string };
type AdAccountRow = {
  id: string;
  client_id: string;
  store_name: string;
  google_ads_customer_id: string | null;
  shopify_url: string | null;
  status: string;
};
type ShopifyRow = {
  id: string;
  client_id: string;
  status: string;
  shopify_name: string;
  shopify_domain: string;
};
type GoogleRow = {
  id: string;
  client_id: string;
  status: string;
  windsor_account_id: string;
  account_name: string;
  last_error_code: string | null;
};
type MappingRow = {
  id: string;
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

export type ReportingBindingSnapshot = {
  clients: ClientRow[];
  profiles: ProfileRow[];
  rolloutStates: RolloutRow[];
  adAccounts: AdAccountRow[];
  shopifyConnections: ShopifyRow[];
  googleConnections: GoogleRow[];
  mappings: MappingRow[];
  bindings: BindingRow[];
};

export type ReportingBindingQueueStatus =
  | "eligible"
  | "bound"
  | "no_exact_legacy_match"
  | "agency_access_required"
  | "ambiguous_legacy_match"
  | "waiting_for_shopify_anchor"
  | "legacy_already_bound"
  | "legacy_identity_reserved"
  | "client_not_approved"
  | "internal_owner";

export type ReportingBindingQueueItem = {
  id: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  rolloutSurface: string;
  assetKind: "shopify" | "google_ads" | "shopify_google";
  shopify: { id: string; name: string; domain: string } | null;
  googleAds: { id: string; name: string; customerId: string } | null;
  legacyAccount: {
    id: string;
    name: string;
    shopifyDomain: string | null;
    googleAdsCustomerId: string | null;
  } | null;
  status: ReportingBindingQueueStatus;
  message: string;
  canCommit: boolean;
};

export type ReportingBindingQueue = {
  available: boolean;
  items: ReportingBindingQueueItem[];
};

type BindingProposal = {
  adAccountId: string;
  shopifyConnectionId: string | null;
  googleAdsConnectionId: string | null;
  shopifyAnchorBindingId: string | null;
};

type BuiltQueue = ReportingBindingQueue & {
  proposals: Map<string, BindingProposal>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANDIDATE_ID = /^(?:shopify|google|pair):[0-9a-f:-]{36,73}$/i;
const BIND_REASON = "Admin-reviewed exact V2-to-existing reporting match";

function canonicalGoogleCustomerId(value: string | null): string | null {
  if (!value || !/^[0-9\s-]+$/.test(value)) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function publicLegacy(account: AdAccountRow | undefined) {
  if (!account) return null;
  return {
    id: account.id,
    name: account.store_name,
    shopifyDomain: account.shopify_url
      ? normalizeShopDomain(account.shopify_url)
      : null,
    googleAdsCustomerId: canonicalGoogleCustomerId(account.google_ads_customer_id),
  };
}

function buildReportingBindingQueue(snapshot: ReportingBindingSnapshot): BuiltQueue {
  const clients = new Map(snapshot.clients.map((client) => [client.id, client]));
  const internalOwnerIds = new Set(
    snapshot.profiles.filter((profile) => profile.role === "admin").map((profile) => profile.id),
  );
  const rollout = new Map(
    snapshot.rolloutStates.map((state) => [state.client_id, state.operational_surface]),
  );
  const accounts = snapshot.adAccounts;
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const connectedShopify = snapshot.shopifyConnections
    .filter((connection) => connection.status === "connected")
    .sort((left, right) => compareText(left.shopify_name, right.shopify_name));
  const connectedGoogle = snapshot.googleConnections
    .filter((connection) => connection.status === "connected")
    .sort((left, right) => compareText(left.account_name, right.account_name));
  const shopifyById = new Map(connectedShopify.map((connection) => [connection.id, connection]));
  const googleById = new Map(connectedGoogle.map((connection) => [connection.id, connection]));
  const activeBindings = snapshot.bindings.filter((binding) => binding.status === "active");
  const bindingByAccount = new Map(
    activeBindings.map((binding) => [binding.ad_account_id, binding]),
  );
  const bindingByShopify = new Map(
    activeBindings.flatMap((binding) =>
      binding.shopify_connection_id ? [[binding.shopify_connection_id, binding] as const] : [],
    ),
  );
  const bindingByGoogle = new Map(
    activeBindings.flatMap((binding) =>
      binding.google_ads_connection_id
        ? [[binding.google_ads_connection_id, binding] as const]
        : [],
    ),
  );
  const mappedGoogleIds = new Set(
    snapshot.mappings.map((mapping) => mapping.google_ads_connection_id),
  );
  const mappingsByShopify = new Map<string, GoogleRow[]>();
  for (const mapping of snapshot.mappings) {
    const shopify = shopifyById.get(mapping.shopify_connection_id);
    const google = googleById.get(mapping.google_ads_connection_id);
    if (!shopify || !google || shopify.client_id !== google.client_id) continue;
    const mapped = mappingsByShopify.get(shopify.id) ?? [];
    mapped.push(google);
    mappingsByShopify.set(shopify.id, mapped);
  }

  const shopifyMatches = (connection: ShopifyRow) => {
    const domain = normalizeShopDomain(connection.shopify_domain);
    if (!domain) return [];
    return accounts.filter(
      (account) =>
        account.client_id === connection.client_id &&
        account.shopify_url !== null &&
        normalizeShopDomain(account.shopify_url) === domain,
    );
  };
  const googleMatches = (connection: GoogleRow) => {
    const customerId = canonicalGoogleCustomerId(connection.windsor_account_id);
    if (!customerId) return [];
    return accounts.filter(
      (account) =>
        account.client_id === connection.client_id &&
        canonicalGoogleCustomerId(account.google_ads_customer_id) === customerId,
    );
  };

  // When an unmapped Google source and Shopify source both exactly match one
  // hybrid legacy row, keep one write path and preserve the financial source
  // first. Mapped Google sources remain on the stricter pair/anchor path.
  const unmappedGoogleByAccount = new Map<string, GoogleRow[]>();
  for (const google of connectedGoogle) {
    if (mappedGoogleIds.has(google.id) || bindingByGoogle.has(google.id)) continue;
    const matches = googleMatches(google);
    if (matches.length !== 1 || bindingByAccount.has(matches[0].id)) continue;
    const candidates = unmappedGoogleByAccount.get(matches[0].id) ?? [];
    candidates.push(google);
    unmappedGoogleByAccount.set(matches[0].id, candidates);
  }
  const preferredUnmappedGoogleByAccount = new Map(
    [...unmappedGoogleByAccount]
      .filter(([, candidates]) => candidates.length === 1)
      .map(([accountId, candidates]) => [accountId, candidates[0].id]),
  );
  const ambiguousUnmappedGoogleAccountIds = new Set(
    [...unmappedGoogleByAccount]
      .filter(([, candidates]) => candidates.length > 1)
      .map(([accountId]) => accountId),
  );

  const items: ReportingBindingQueueItem[] = [];
  const proposals = new Map<string, BindingProposal>();
  const proposedAccountIds = new Set<string>();
  const handledGoogle = new Set<string>();

  const base = (clientId: string) => {
    const client = clients.get(clientId);
    return {
      clientId,
      clientName: client?.full_name ?? "Unknown client",
      clientEmail: client?.email ?? "",
      rolloutSurface: rollout.get(clientId) ?? "legacy_only",
    };
  };
  const add = (
    item: Omit<ReportingBindingQueueItem, "canCommit">,
    proposal?: BindingProposal,
  ) => {
    const approved = clients.get(item.clientId)?.approval_status === "approved";
    const internal = internalOwnerIds.has(item.clientId);
    const accountReserved = proposal
      ? proposedAccountIds.has(proposal.adAccountId)
      : false;
    const eligibleProposal = approved && !internal && !accountReserved ? proposal : undefined;
    const ownerBlock = proposal
      ? internal
        ? {
            status: "internal_owner" as const,
            message: "Internal and admin-owned reporting identities are excluded from cutover.",
          }
        : !approved
          ? {
              status: "client_not_approved" as const,
              message: "Approve and restore this client before binding reporting sources.",
            }
          : accountReserved
            ? {
                status: "legacy_identity_reserved" as const,
                message: "Another exact source already owns this reporting identity proposal.",
              }
            : null
      : null;
    items.push({
      ...item,
      ...ownerBlock,
      canCommit: Boolean(eligibleProposal),
    });
    if (eligibleProposal) {
      proposals.set(item.id, eligibleProposal);
      proposedAccountIds.add(eligibleProposal.adAccountId);
    }
  };

  for (const shopify of connectedShopify) {
    const mappedGoogle = (mappingsByShopify.get(shopify.id) ?? []).sort((left, right) =>
      compareText(left.account_name, right.account_name),
    );
    const shopBinding = bindingByShopify.get(shopify.id);
    const matches = shopifyMatches(shopify);
    const shop = {
      id: shopify.id,
      name: shopify.shopify_name,
      domain: shopify.shopify_domain,
    };

    if (shopBinding) {
      add({
        id: `shopify:${shopify.id}`,
        ...base(shopify.client_id),
        assetKind: "shopify",
        shopify: shop,
        googleAds: null,
        legacyAccount: publicLegacy(accountsById.get(shopBinding.ad_account_id)),
        status: "bound",
        message: "This Shopify source is already bound to its existing reporting identity.",
      });
    } else if (matches.length === 0) {
      add({
        id: `shopify:${shopify.id}`,
        ...base(shopify.client_id),
        assetKind: "shopify",
        shopify: shop,
        googleAds: null,
        legacyAccount: null,
        status: "no_exact_legacy_match",
        message: "No same-owner legacy account has this exact myshopify.com domain.",
      });
    } else if (matches.length > 1) {
      add({
        id: `shopify:${shopify.id}`,
        ...base(shopify.client_id),
        assetKind: "shopify",
        shopify: shop,
        googleAds: null,
        legacyAccount: null,
        status: "ambiguous_legacy_match",
        message: "More than one same-owner legacy account has this Shopify domain.",
      });
    } else {
      const account = matches[0];
      const pairGoogle = mappedGoogle.find((google) => {
        if (bindingByGoogle.has(google.id)) return false;
        const googleCandidates = googleMatches(google);
        return googleCandidates.length === 1 && googleCandidates[0]?.id === account.id;
      });
      const existingAccountBinding = bindingByAccount.get(account.id);

      if (existingAccountBinding) {
        add({
          id: `shopify:${shopify.id}`,
          ...base(shopify.client_id),
          assetKind: "shopify",
          shopify: shop,
          googleAds: null,
          legacyAccount: publicLegacy(account),
          status: "legacy_already_bound",
          message: "That legacy reporting identity is already owned by another active binding.",
        });
      } else if (pairGoogle) {
        const id = `pair:${shopify.id}:${pairGoogle.id}`;
        handledGoogle.add(pairGoogle.id);
        add(
          {
            id,
            ...base(shopify.client_id),
            assetKind: "shopify_google",
            shopify: shop,
            googleAds: {
              id: pairGoogle.id,
              name: pairGoogle.account_name,
              customerId: canonicalGoogleCustomerId(pairGoogle.windsor_account_id) ?? "",
            },
            legacyAccount: publicLegacy(account),
            status: "eligible",
            message: "Exact same-owner Shopify, Google Ads and mapping match.",
          },
          {
            adAccountId: account.id,
            shopifyConnectionId: shopify.id,
            googleAdsConnectionId: pairGoogle.id,
            shopifyAnchorBindingId: null,
          },
        );
      } else if (ambiguousUnmappedGoogleAccountIds.has(account.id)) {
        add({
          id: `shopify:${shopify.id}`,
          ...base(shopify.client_id),
          assetKind: "shopify",
          shopify: shop,
          googleAds: null,
          legacyAccount: publicLegacy(account),
          status: "ambiguous_legacy_match",
          message: "Multiple unmapped Google sources claim this reporting identity.",
        });
      } else if (preferredUnmappedGoogleByAccount.has(account.id)) {
        add({
          id: `shopify:${shopify.id}`,
          ...base(shopify.client_id),
          assetKind: "shopify",
          shopify: shop,
          googleAds: null,
          legacyAccount: publicLegacy(account),
          status: "legacy_identity_reserved",
          message: "Reserved for the exact unmapped Google source to preserve spend continuity.",
        });
      } else {
        const id = `shopify:${shopify.id}`;
        add(
          {
            id,
            ...base(shopify.client_id),
            assetKind: "shopify",
            shopify: shop,
            googleAds: null,
            legacyAccount: publicLegacy(account),
            status: "eligible",
            message: mappedGoogle.length
              ? "Exact Shopify match. Bind this store anchor before its mapped Google children."
              : "Exact same-owner Shopify match.",
          },
          {
            adAccountId: account.id,
            shopifyConnectionId: shopify.id,
            googleAdsConnectionId: null,
            shopifyAnchorBindingId: null,
          },
        );
      }
    }

    for (const google of mappedGoogle) {
      if (handledGoogle.has(google.id)) continue;
      handledGoogle.add(google.id);
      const binding = bindingByGoogle.get(google.id);
      const customerId = canonicalGoogleCustomerId(google.windsor_account_id) ?? "";
      const googleAsset = { id: google.id, name: google.account_name, customerId };

      if (binding) {
        add({
          id: `google:${google.id}`,
          ...base(google.client_id),
          assetKind: "google_ads",
          shopify: null,
          googleAds: googleAsset,
          legacyAccount: publicLegacy(accountsById.get(binding.ad_account_id)),
          status: "bound",
          message: "This Google Ads source is already bound to its existing reporting identity.",
        });
        continue;
      }

      const matches = googleMatches(google);
      if (matches.length === 0) {
        add({
          id: `google:${google.id}`,
          ...base(google.client_id),
          assetKind: "google_ads",
          shopify: null,
          googleAds: googleAsset,
          legacyAccount: null,
          status: "agency_access_required",
          message:
            "New V2 Google account: confirm agency access before creating any reporting identity.",
        });
        continue;
      }
      if (matches.length > 1) {
        add({
          id: `google:${google.id}`,
          ...base(google.client_id),
          assetKind: "google_ads",
          shopify: null,
          googleAds: googleAsset,
          legacyAccount: null,
          status: "ambiguous_legacy_match",
          message: "More than one same-owner legacy account has this Google customer ID.",
        });
        continue;
      }

      const account = matches[0];
      const anchor = bindingByShopify.get(shopify.id);
      if (!anchor) {
        add({
          id: `google:${google.id}`,
          ...base(google.client_id),
          assetKind: "google_ads",
          shopify: null,
          googleAds: googleAsset,
          legacyAccount: publicLegacy(account),
          status: "waiting_for_shopify_anchor",
          message: "Bind the mapped Shopify store anchor first.",
        });
      } else if (bindingByAccount.has(account.id)) {
        add({
          id: `google:${google.id}`,
          ...base(google.client_id),
          assetKind: "google_ads",
          shopify: null,
          googleAds: googleAsset,
          legacyAccount: publicLegacy(account),
          status: "legacy_already_bound",
          message:
            "That legacy identity is already bound; completing it requires an audited revoke and replacement.",
        });
      } else {
        const id = `google:${google.id}`;
        add(
          {
            id,
            ...base(google.client_id),
            assetKind: "google_ads",
            shopify: null,
            googleAds: googleAsset,
            legacyAccount: publicLegacy(account),
            status: "eligible",
            message: "Exact Google match with an active mapped Shopify anchor.",
          },
          {
            adAccountId: account.id,
            shopifyConnectionId: null,
            googleAdsConnectionId: google.id,
            shopifyAnchorBindingId: anchor.id,
          },
        );
      }
    }
  }

  for (const google of connectedGoogle) {
    if (handledGoogle.has(google.id)) continue;
    const binding = bindingByGoogle.get(google.id);
    const matches = googleMatches(google);
    const googleAsset = {
      id: google.id,
      name: google.account_name,
      customerId: canonicalGoogleCustomerId(google.windsor_account_id) ?? "",
    };

    if (binding) {
      add({
        id: `google:${google.id}`,
        ...base(google.client_id),
        assetKind: "google_ads",
        shopify: null,
        googleAds: googleAsset,
        legacyAccount: publicLegacy(accountsById.get(binding.ad_account_id)),
        status: "bound",
        message: "This Google Ads source is already bound to its existing reporting identity.",
      });
    } else if (matches.length === 0) {
      add({
        id: `google:${google.id}`,
        ...base(google.client_id),
        assetKind: "google_ads",
        shopify: null,
        googleAds: googleAsset,
        legacyAccount: null,
        status: "agency_access_required",
        message:
          "New V2 Google account: confirm agency access before creating any reporting identity.",
      });
    } else if (matches.length > 1) {
      add({
        id: `google:${google.id}`,
        ...base(google.client_id),
        assetKind: "google_ads",
        shopify: null,
        googleAds: googleAsset,
        legacyAccount: null,
        status: "ambiguous_legacy_match",
        message: "More than one same-owner legacy account has this Google customer ID.",
      });
    } else {
      const account = matches[0];
      if (mappedGoogleIds.has(google.id)) {
        add({
          id: `google:${google.id}`,
          ...base(google.client_id),
          assetKind: "google_ads",
          shopify: null,
          googleAds: googleAsset,
          legacyAccount: publicLegacy(account),
          status: "waiting_for_shopify_anchor",
          message: "Resolve this mapping through its explicit Shopify pair or active anchor.",
        });
      } else if (bindingByAccount.has(account.id)) {
        add({
          id: `google:${google.id}`,
          ...base(google.client_id),
          assetKind: "google_ads",
          shopify: null,
          googleAds: googleAsset,
          legacyAccount: publicLegacy(account),
          status: "legacy_already_bound",
          message: "That legacy reporting identity is already owned by another active binding.",
        });
      } else if (ambiguousUnmappedGoogleAccountIds.has(account.id)) {
        add({
          id: `google:${google.id}`,
          ...base(google.client_id),
          assetKind: "google_ads",
          shopify: null,
          googleAds: googleAsset,
          legacyAccount: publicLegacy(account),
          status: "ambiguous_legacy_match",
          message: "Multiple unmapped Google sources claim this reporting identity.",
        });
      } else {
        const id = `google:${google.id}`;
        add(
          {
            id,
            ...base(google.client_id),
            assetKind: "google_ads",
            shopify: null,
            googleAds: googleAsset,
            legacyAccount: publicLegacy(account),
            status: "eligible",
            message: "Exact same-owner Google match with no Shopify mapping.",
          },
          {
            adAccountId: account.id,
            shopifyConnectionId: null,
            googleAdsConnectionId: google.id,
            shopifyAnchorBindingId: null,
          },
        );
      }
    }
  }

  items.sort(
    (left, right) =>
      Number(right.canCommit) - Number(left.canCommit) ||
      compareText(left.clientName, right.clientName) ||
      compareText(left.id, right.id),
  );
  return { available: true, items, proposals };
}

export function projectReportingBindingQueue(
  snapshot: ReportingBindingSnapshot,
): ReportingBindingQueue {
  const { available, items } = buildReportingBindingQueue(snapshot);
  return { available, items };
}

async function loadSnapshot(service: SupabaseClient): Promise<ReportingBindingSnapshot> {
  const [clients, profiles, rolloutStates, adAccounts, shopify, google, mappings, bindings] =
    await Promise.all([
      service.from("portal_clients").select("id, full_name, email, approval_status"),
      service.from("profiles").select("id, role"),
      service.from("client_rollout_states").select("client_id, operational_surface"),
      service
        .from("ad_accounts")
        .select("id, client_id, store_name, google_ads_customer_id, shopify_url, status"),
      service
        .from("client_shopify_connections")
        .select("id, client_id, status, shopify_name, shopify_domain"),
      service
        .from("client_google_ads_connections")
        .select("id, client_id, status, windsor_account_id, account_name, last_error_code"),
      service
        .from("client_asset_mappings")
        .select("id, shopify_connection_id, google_ads_connection_id"),
      service
        .from("client_reporting_bindings")
        .select(
          "id, client_id, ad_account_id, shopify_connection_id, google_ads_connection_id, shopify_anchor_binding_id, status, bound_at",
        ),
    ]);

  const error = [
    clients,
    profiles,
    rolloutStates,
    adAccounts,
    shopify,
    google,
    mappings,
    bindings,
  ].find((result) => result.error)?.error;
  if (error) {
    throw new ClientOnboardingError(
      "database_error",
      "The reporting binding queue could not be audited.",
      500,
    );
  }

  return {
    clients: (clients.data ?? []) as ClientRow[],
    profiles: (profiles.data ?? []) as ProfileRow[],
    rolloutStates: (rolloutStates.data ?? []) as RolloutRow[],
    adAccounts: (adAccounts.data ?? []) as AdAccountRow[],
    shopifyConnections: (shopify.data ?? []) as ShopifyRow[],
    googleConnections: (google.data ?? []) as GoogleRow[],
    mappings: (mappings.data ?? []) as MappingRow[],
    bindings: (bindings.data ?? []) as BindingRow[],
  };
}

function serviceOrThrow() {
  const service = createServiceClient();
  if (!service) {
    throw new ClientOnboardingError(
      "server_not_configured",
      "Server-side reporting bindings are not configured.",
      503,
    );
  }
  // The generated types are updated in the same migration release. Keeping
  // this boundary untyped avoids exposing the service client to the browser.
  return service as unknown as SupabaseClient;
}

export async function listClientReportingBindingQueue(): Promise<ReportingBindingQueue> {
  await requireClientOnboardingAdmin();
  const service = serviceOrThrow();
  try {
    return projectReportingBindingQueue(await loadSnapshot(service));
  } catch (error) {
    if (error instanceof ClientOnboardingError && error.code === "database_error") {
      return { available: false, items: [] };
    }
    throw error;
  }
}

async function bindingIdempotencyKey(proposal: BindingProposal) {
  const source = [
    proposal.adAccountId,
    proposal.shopifyConnectionId ?? "-",
    proposal.googleAdsConnectionId ?? "-",
    proposal.shopifyAnchorBindingId ?? "-",
  ].join(":");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
  );
  return `bind:v2:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function databaseWriteError(code: string | undefined) {
  if (code === "42501") {
    return new ClientOnboardingError("forbidden", "Forbidden.", 403);
  }
  if (["22023", "23503", "23505", "23514", "P0002"].includes(code ?? "")) {
    return new ClientOnboardingError(
      "invalid_state",
      "The reporting sources changed during review. Refresh and audit the match again.",
      409,
    );
  }
  return new ClientOnboardingError(
    "database_error",
    "The reporting binding could not be committed.",
    500,
  );
}

/** Authenticates before reading any candidate ID or constructing service_role. */
export async function commitClientReportingBindingRequest(request: Request) {
  const admin = await requireClientOnboardingAdmin();
  const body = await readSmallJson(request, 1_024);
  if (
    !isExactRecord(body, ["candidateId"]) ||
    typeof body.candidateId !== "string" ||
    body.candidateId.length > 120 ||
    !CANDIDATE_ID.test(body.candidateId)
  ) {
    throw new ClientOnboardingError(
      "invalid_request",
      "Send exactly one valid reporting binding candidate.",
      400,
    );
  }

  const service = serviceOrThrow();
  const queue = buildReportingBindingQueue(await loadSnapshot(service));
  const proposal = queue.proposals.get(body.candidateId);
  if (!proposal || !UUID.test(proposal.adAccountId)) {
    throw new ClientOnboardingError(
      "invalid_state",
      "This source is not an exact eligible match. Refresh and review its blocker.",
      409,
    );
  }

  const { data, error } = await service.rpc("commit_client_reporting_binding", {
    p_ad_account_id: proposal.adAccountId,
    p_shopify_connection_id: proposal.shopifyConnectionId,
    p_google_ads_connection_id: proposal.googleAdsConnectionId,
    p_shopify_anchor_binding_id: proposal.shopifyAnchorBindingId,
    p_idempotency_key: await bindingIdempotencyKey(proposal),
    p_admin_id: admin.id,
    p_reason: BIND_REASON,
  });
  if (error) throw databaseWriteError(error.code);
  if (typeof data !== "string" || !UUID.test(data)) {
    throw new ClientOnboardingError(
      "database_error",
      "The binding was processed but its receipt was incomplete. Refresh before retrying.",
      500,
    );
  }
  return { bindingId: data };
}
