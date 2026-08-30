import "server-only";

import { ClientOnboardingError } from "@/lib/client-onboarding/sessions";
import { normalizeShopDomain } from "@/lib/shopify/client";
import { FX_SUPPORTED_CURRENCIES } from "../shopify/fx";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Rebuild a client's reporting bindings from the sources it actually has.
 *
 * Unbinding a source is a one-way door before cutover. The binding goes away
 * but the ad account keeps the Shopify domain and the Google customer id, and
 * the projection only ever re-offers an owned identity when the owning account
 * is a pristine pending shell (adopt) or an abandoned staged one (restage). A
 * live account with billing and history is neither, so the projection returns
 * without offering anything: no candidate, no explanation, and reconnecting
 * does not help because the connection was never the problem.
 *
 * The repair needs no new identity. The accounts already carry the exact
 * domains and customer ids the connections report, so the sources can simply be
 * rebound onto them. Which account hosts what follows from who owns the
 * identity, because one account may back at most one reserved binding:
 *
 *   - one account owns both    -> a single paired binding
 *   - two accounts split them  -> a Shopify anchor plus a Google spend child
 *   - only the store is owned  -> the anchor alone, and normal provisioning
 *                                 offers the Google child afterwards
 *
 * Every write goes through commit_client_reporting_binding, which re-proves the
 * domain, the customer id, the explicit mapping and the billing identity
 * against the account before it writes. A mismatch is refused there rather than
 * trusted here.
 *
 * Deliberately limited to clients who are not yet live on V2. Revoking an
 * operational binding is reserved for a staged replacement lifecycle that does
 * not exist yet, and this is a repair, not a way around that.
 */

const REVOKE_REASON =
  "Rebinding this client's reporting sources onto the accounts that already own their identities.";
const PAIR_REASON =
  "Exact rebind of a store and its mapped Google Ads account onto the account owning both identities.";
const ANCHOR_REASON = "Exact rebind of a store onto the account owning its Shopify identity.";
const CHILD_REASON =
  "Exact rebind of a mapped Google Ads account as the spend child of its rebound Shopify anchor.";

type Service = NonNullable<ReturnType<typeof createServiceClient>>;

export type RebindOutcome = {
  rebound: Array<{ store: string; googleAccount: string | null; shape: string }>;
  skipped: Array<{ reason: string }>;
};

function serviceOrThrow(): Service {
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

type AccountRow = {
  id: string;
  store_name: string;
  google_ads_customer_id: string | null;
  shopify_url: string | null;
  currency: string;
};
type BindingRow = {
  id: string;
  ad_account_id: string;
  shopify_connection_id: string | null;
  google_ads_connection_id: string | null;
  shopify_anchor_binding_id: string | null;
  status: string;
  idempotency_key: string;
};
type ShopifyRow = {
  id: string;
  status: string;
  shopify_name: string;
  shopify_domain: string;
  last_verified_at: string | null;
  last_error_code: string | null;
};
type GoogleRow = {
  id: string;
  windsor_account_id: string;
  account_name: string | null;
  admin_label: string | null;
  currency: string | null;
  time_zone: string | null;
  last_verified_at: string | null;
  last_error_code: string | null;
  status: string;
};

/** The same identifier the ad account stores, so the two can be compared. */
function canonicalCustomerId(value: string | null): string | null {
  if (!value || !/^[0-9\s-]+$/.test(value)) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

/** The same bar the reporting projection uses before it trusts a source. */
function usableShopify(row: ShopifyRow, credentials: Set<string>): boolean {
  return Boolean(
    row.status === "connected" &&
      row.last_verified_at &&
      !row.last_error_code &&
      credentials.has(row.id) &&
      normalizeShopDomain(row.shopify_domain),
  );
}

function usableGoogle(row: GoogleRow): boolean {
  // Any VERIFIED, ECB-CONVERTIBLE billing currency is bindable for reporting —
  // the sync converts Google money columns to the account's reporting currency
  // with the day's ECB rate. A currency outside the ECB reference set (TWD,
  // AED, …) must be refused HERE, where it becomes a visible skip reason: bound,
  // it would make every hourly sync throw FxError forever, and on a fresh
  // binding that failure stops the whole window write, Shopify included.
  // Billing activation stays EUR-only and enforces that on its own paths; a
  // non-EUR account reports but does not bill until those are extended.
  return Boolean(
    row.status === "connected" &&
      row.last_verified_at &&
      !row.last_error_code &&
      canonicalCustomerId(row.windsor_account_id) &&
      row.currency &&
      FX_SUPPORTED_CURRENCIES.has(row.currency) &&
      row.time_zone?.trim(),
  );
}

type Commit = {
  adAccountId: string;
  shopifyConnectionId: string | null;
  googleAdsConnectionId: string | null;
  /** A child binding takes the id the anchor commit before it returned. */
  underPrecedingAnchor: boolean;
  keySuffix: "pair" | "anchor" | "child";
  reason: string;
};

type Shape = {
  ad_account_id: string;
  shopify_connection_id: string | null;
  google_ads_connection_id: string | null;
  child: boolean;
};

/** What a binding contributes to a store's shape, for comparing plan to reality. */
function shapeOf(binding: Shape): string {
  return [
    binding.ad_account_id,
    binding.shopify_connection_id ?? "",
    binding.google_ads_connection_id ?? "",
    binding.child ? "child" : "root",
  ].join("|");
}

export async function rebindClientReportingSources(input: {
  clientId: string;
  adminId: string;
}): Promise<RebindOutcome> {
  const service = serviceOrThrow();

  const { data: rollout } = await service
    .from("client_rollout_states")
    .select("operational_surface, reporting_cutover_at")
    .eq("client_id", input.clientId)
    .maybeSingle();
  const state = rollout as {
    operational_surface?: string;
    reporting_cutover_at?: string | null;
  } | null;
  if (state?.operational_surface === "v2_active" && state.reporting_cutover_at) {
    throw new ClientOnboardingError(
      "invalid_state",
      "This client is live on V2 reporting, so its bindings cannot be rebuilt here.",
      409,
    );
  }

  const [accountsResult, bindingsResult, shopifyResult, googleResult, mappingsResult] =
    await Promise.all([
      service
        .from("ad_accounts")
        .select("id, store_name, google_ads_customer_id, shopify_url, currency")
        .eq("client_id", input.clientId),
      service
        .from("client_reporting_bindings")
        .select(
          "id, ad_account_id, shopify_connection_id, google_ads_connection_id, shopify_anchor_binding_id, status, idempotency_key",
        )
        .eq("client_id", input.clientId),
      service
        .from("client_shopify_connections")
        .select("id, status, shopify_name, shopify_domain, last_verified_at, last_error_code")
        .eq("client_id", input.clientId),
      service
        .from("client_google_ads_connections")
        .select(
          "id, windsor_account_id, account_name, admin_label, currency, time_zone, last_verified_at, last_error_code, status",
        )
        .eq("client_id", input.clientId),
      service
        .from("client_asset_mappings")
        .select("shopify_connection_id, google_ads_connection_id"),
    ]);
  const failure = [
    accountsResult,
    bindingsResult,
    shopifyResult,
    googleResult,
    mappingsResult,
  ].find((result) => result.error);
  if (failure) {
    throw new ClientOnboardingError(
      "database_error",
      "The client's reporting sources could not be read.",
      500,
    );
  }

  const accounts = (accountsResult.data ?? []) as AccountRow[];
  const bindings = (bindingsResult.data ?? []) as BindingRow[];
  const shopifyRows = (shopifyResult.data ?? []) as ShopifyRow[];
  const googleRows = (googleResult.data ?? []) as GoogleRow[];
  const usedKeys = new Set(bindings.map((binding) => binding.idempotency_key));
  const reserved = bindings.filter((binding) => ["active", "staged"].includes(binding.status));
  if (reserved.some((binding) => binding.status === "staged")) {
    throw new ClientOnboardingError(
      "invalid_state",
      "This client has a staged reporting source. Finish or abandon its staged lifecycle before rebuilding bindings.",
      409,
    );
  }

  const { data: credentialRows } = await service
    .from("client_shopify_credentials")
    .select("connection_id")
    .in(
      "connection_id",
      shopifyRows.map((row) => row.id),
    );
  const credentials = new Set(
    ((credentialRows ?? []) as Array<{ connection_id: string }>).map((row) => row.connection_id),
  );

  const googleById = new Map(googleRows.map((row) => [row.id, row]));
  const googleByStore = new Map<string, string>();
  for (const mapping of (mappingsResult.data ?? []) as Array<{
    shopify_connection_id: string;
    google_ads_connection_id: string;
  }>) {
    googleByStore.set(mapping.shopify_connection_id, mapping.google_ads_connection_id);
  }

  const outcome: RebindOutcome = { rebound: [], skipped: [] };
  const nextKey = (base: string): string => {
    let key = base;
    for (let attempt = 2; usedKeys.has(key); attempt += 1) key = `${base}.${attempt}`;
    usedKeys.add(key);
    return key;
  };

  for (const shopify of shopifyRows.filter((row) => row.status === "connected")) {
    const domain = normalizeShopDomain(shopify.shopify_domain);
    if (!usableShopify(shopify, credentials) || !domain) {
      outcome.skipped.push({
        reason: `${shopify.shopify_name} is not a usable reporting source yet; it needs a verified store credential.`,
      });
      continue;
    }

    const storeOwners = accounts.filter(
      (account) => account.shopify_url && normalizeShopDomain(account.shopify_url) === domain,
    );
    if (storeOwners.length !== 1) {
      outcome.skipped.push({
        reason:
          storeOwners.length === 0
            ? `No existing account carries ${domain}, so it is provisioned normally rather than rebound.`
            : `${storeOwners.length} accounts carry ${domain}. Resolve that duplicate before rebinding.`,
      });
      continue;
    }
    const storeOwner = storeOwners[0];

    const mappedId = googleByStore.get(shopify.id);
    let google = mappedId ? googleById.get(mappedId) ?? null : null;
    let googleOwner: AccountRow | null = null;
    if (google && !usableGoogle(google)) {
      outcome.skipped.push({
        reason: `${google.admin_label?.trim() || google.account_name || google.windsor_account_id} is not a usable reporting source yet; it needs a verified billing identity (currency and time zone), so ${domain} keeps its store source alone.`,
      });
      google = null;
    }
    if (google) {
      const customerId = canonicalCustomerId(google.windsor_account_id);
      const owners = accounts.filter(
        (account) => canonicalCustomerId(account.google_ads_customer_id) === customerId,
      );
      if (owners.length > 1) {
        outcome.skipped.push({
          reason: `${owners.length} accounts carry Google customer ${customerId}. Resolve that duplicate before rebinding.`,
        });
        google = null;
      } else {
        googleOwner = owners[0] ?? null;
      }
    }
    // A spend child reports in ITS OWN account's currency, so a child owner in
    // another currency than the anchor would split one store's daily_metrics
    // across two currencies — the store scope then fails every rollup read.
    // The sync's FX pass normalizes connection→account, never account→account,
    // so this must be refused here, visibly, before any binding is committed.
    if (
      google &&
      googleOwner &&
      googleOwner.id !== storeOwner.id &&
      googleOwner.currency !== storeOwner.currency
    ) {
      outcome.skipped.push({
        reason: `${googleOwner.store_name} reports in ${googleOwner.currency} but ${domain}'s anchor account reports in ${storeOwner.currency}. Align the account currencies before rebinding, so ${domain} keeps its store source alone.`,
      });
      google = null;
      googleOwner = null;
    }

    const commits: Commit[] =
      google && googleOwner && googleOwner.id === storeOwner.id
        ? [
            {
              adAccountId: storeOwner.id,
              shopifyConnectionId: shopify.id,
              googleAdsConnectionId: google.id,
              underPrecedingAnchor: false,
              keySuffix: "pair",
              reason: PAIR_REASON,
            },
          ]
        : [
            {
              adAccountId: storeOwner.id,
              shopifyConnectionId: shopify.id,
              googleAdsConnectionId: null,
              underPrecedingAnchor: false,
              keySuffix: "anchor",
              reason: ANCHOR_REASON,
            },
            ...(google && googleOwner
              ? [
                  {
                    adAccountId: googleOwner.id,
                    shopifyConnectionId: null,
                    googleAdsConnectionId: google.id,
                    underPrecedingAnchor: true,
                    keySuffix: "child" as const,
                    reason: CHILD_REASON,
                  },
                ]
              : []),
          ];

    // Everything already holding one of these sources, and everything holding
    // an account this plan needs, has to give way: a source, an account and an
    // anchor may each back only one reserved binding at a time.
    const roots = reserved.filter(
      (binding) =>
        binding.shopify_connection_id === shopify.id ||
        (google && binding.google_ads_connection_id === google.id) ||
        commits.some((commit) => commit.adAccountId === binding.ad_account_id),
    );
    const rootIds = new Set(roots.map((binding) => binding.id));
    const children = reserved.filter(
      (binding) =>
        binding.shopify_anchor_binding_id &&
        rootIds.has(binding.shopify_anchor_binding_id) &&
        !rootIds.has(binding.id),
    );

    const current = [...children, ...roots]
      .map((binding) =>
        shapeOf({ ...binding, child: Boolean(binding.shopify_anchor_binding_id) }),
      )
      .sort();
    const desired = commits
      .map((commit) =>
        shapeOf({
          ad_account_id: commit.adAccountId,
          shopify_connection_id: commit.shopifyConnectionId,
          google_ads_connection_id: commit.googleAdsConnectionId,
          child: commit.underPrecedingAnchor,
        }),
      )
      .sort();
    if (current.length === desired.length && current.every((row, at) => row === desired[at])) {
      continue;
    }

    // Children first: an anchor refuses to be revoked while one still points at it.
    for (const binding of [...children, ...roots]) {
      const { data, error } = await service.rpc("revoke_client_reporting_binding", {
        p_binding_id: binding.id,
        p_admin_id: input.adminId,
        p_idempotency_key: nextKey(`rebind:${shopify.id}:revoke-${binding.id}`),
        p_reason: REVOKE_REASON,
      });
      if (error || data !== binding.id) {
        throw new ClientOnboardingError(
          "invalid_state",
          `An existing binding could not be released, so ${domain} was left as it was: ${
            error?.message ?? "the write was not confirmed"
          }`,
          409,
        );
      }
    }

    // The database re-proves every identity before it writes. If a commit
    // fails the store is left unbound, which the queue reports as an unbound
    // source rather than hiding.
    const commitBinding = async (commit: Commit, parentId: string | null): Promise<string> => {
      const { data, error } = await service.rpc("commit_client_reporting_binding", {
        p_ad_account_id: commit.adAccountId,
        p_shopify_connection_id: commit.shopifyConnectionId,
        p_google_ads_connection_id: commit.googleAdsConnectionId,
        p_shopify_anchor_binding_id: parentId,
        p_idempotency_key: nextKey(`rebind:${shopify.id}:${commit.keySuffix}`),
        p_admin_id: input.adminId,
        p_reason: commit.reason,
      });
      if (error || typeof data !== "string") {
        throw new ClientOnboardingError(
          "database_error",
          `${domain} was released but could not be rebound: ${
            error?.message ?? "the write was not confirmed"
          }`,
          500,
        );
      }
      return data;
    };
    const [anchorCommit, ...childCommits] = commits;
    const anchorBindingId = await commitBinding(anchorCommit, null);
    for (const commit of childCommits) {
      await commitBinding(commit, commit.underPrecedingAnchor ? anchorBindingId : null);
    }

    outcome.rebound.push({
      store: domain,
      googleAccount: google ? google.admin_label?.trim() || google.account_name || google.windsor_account_id : null,
      shape:
        commits.length === 1
          ? `paired on ${storeOwner.store_name}`
          : googleOwner
            ? `anchored on ${storeOwner.store_name}, spend on ${googleOwner.store_name}`
            : `anchored on ${storeOwner.store_name}`,
    });
  }

  if (outcome.rebound.length === 0 && outcome.skipped.length === 0) {
    throw new ClientOnboardingError(
      "invalid_state",
      "Every connected source of this client is already bound where it belongs.",
      409,
    );
  }
  return outcome;
}
