import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ReportingShopifyConnectionRepository,
  StoredShopifyConnectionCredential,
} from "@/lib/client-onboarding/shopify-connections";
import { createReportingShopifyRepository } from "@/lib/client-onboarding/shopify-repository";
import { normalizeShopDomain } from "@/lib/shopify/client";
import { normalizeGoogleAdsCustomerId } from "@/lib/windsor/client";

type BindingRow = {
  id: string;
  client_id: string;
  ad_account_id: string;
  shopify_connection_id: string | null;
  google_ads_connection_id: string | null;
  shopify_anchor_binding_id: string | null;
  status: string;
};

type AccountRow = {
  id: string;
  client_id: string;
  currency: string;
  shopify_url: string | null;
  google_ads_customer_id: string | null;
};

type ShopifyRow = {
  id: string;
  client_id: string;
  status: string;
  shopify_shop_id: string;
  shopify_name: string;
  shopify_domain: string;
  primary_domain: string | null;
  shopify_currency: string;
  last_verified_at: string | null;
  last_error_code: string | null;
};

type GoogleRow = {
  id: string;
  client_id: string;
  status: string;
  windsor_account_id: string;
  account_name: string;
  currency: string | null;
  time_zone: string | null;
  data_source_id: string | null;
  last_verified_at: string | null;
  last_error_code: string | null;
};

type MappingRow = {
  shopify_connection_id: string;
  google_ads_connection_id: string;
};

type QueryResult = { data: unknown; error: unknown };

export type ReportingSourceResolutionErrorCode =
  | "database_error"
  | "invalid_binding"
  | "credential_error";

export class ReportingSourceResolutionError extends Error {
  constructor(
    readonly code: ReportingSourceResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReportingSourceResolutionError";
  }
}

export type CanonicalReportingSource = {
  bindingId: string;
  clientId: string;
  adAccountId: string;
  kind: "shopify" | "google_ads" | "shopify_google";
  group: {
    id: string;
    shopifyAnchorBindingId: string | null;
    shopifyAnchorAdAccountId: string | null;
  };
  shopify: {
    connectionId: string;
    shopId: string;
    shopifyName: string;
    domain: string;
    primaryDomain: string | null;
    currency: string;
    credential: {
      shopifyClientId: string;
      clientSecretCiphertext: string;
    } | null;
    /**
     * The connection's recorded health-probe failure (last_error_code), when
     * present. A latched probe failure — often a transient outage caught by an
     * admin Test click — must DEGRADE this one family (its sync fails and the
     * stored figures carry) instead of invalidating the whole store's
     * resolution, which used to blank the client's portal and freeze every
     * family's sync until a successful re-test.
     */
    healthError: string | null;
  } | null;
  googleAds: {
    connectionId: string;
    windsorAccountId: string;
    accountId: string;
    customerId: string;
    accountName: string;
    currency: string | null;
    timeZone: string | null;
    dataSourceId: string | null;
    /** Same contract as shopify.healthError — degrade, never blank. */
    healthError: string | null;
  } | null;
};

export type ResolveReportingSourcesInput = {
  service: SupabaseClient;
  shopifyRepository?: Pick<ReportingShopifyConnectionRepository, "loadCredential">;
  clientIds?: string[];
  adAccountIds?: string[];
  includeShopifyCredentials?: boolean;
};

type ResolveReportingSourcesByStatusInput = ResolveReportingSourcesInput & {
  bindingIds?: string[];
};

export type ResolveStagedReportingSourceInput = Omit<
  ResolveReportingSourcesInput,
  "clientIds" | "adAccountIds"
> & {
  bindingId: string;
};

const BINDING_COLUMNS =
  "id, client_id, ad_account_id, shopify_connection_id, google_ads_connection_id, shopify_anchor_binding_id, status";

function rows<T>(result: QueryResult): T[] {
  if (result.error || !Array.isArray(result.data)) {
    throw new ReportingSourceResolutionError(
      "database_error",
      "Reporting sources could not be loaded.",
    );
  }
  return result.data as T[];
}

function invalid(message: string): never {
  throw new ReportingSourceResolutionError("invalid_binding", message);
}

function uniqueIds(rows: BindingRow[], key: keyof BindingRow): string[] {
  return [
    ...new Set(
      rows.flatMap((row) => {
        const value = row[key];
        return typeof value === "string" ? [value] : [];
      }),
    ),
  ];
}

function assertUnique(value: string, seen: Set<string>, label: string) {
  if (seen.has(value)) invalid(`A selected binding repeats its ${label}.`);
  seen.add(value);
}

function exactGoogleCustomerId(value: string | null): {
  accountId: string;
  customerId: string;
} {
  if (!value || !/^\d{10}$/.test(value)) {
    invalid("A bound legacy Google Ads identity is invalid.");
  }
  try {
    return normalizeGoogleAdsCustomerId(value);
  } catch {
    invalid("A bound Google Ads identity is invalid.");
  }
}

function checkedShopifyCredential(
  connection: ShopifyRow,
  credential: StoredShopifyConnectionCredential,
) {
  if (
    credential.connectionId !== connection.id ||
    credential.shopifyShopId !== connection.shopify_shop_id ||
    normalizeShopDomain(credential.shopifyDomain) !== connection.shopify_domain ||
    !credential.shopifyClientId.trim() ||
    !credential.clientSecretCiphertext.trim()
  ) {
    throw new ReportingSourceResolutionError(
      "credential_error",
      "A bound Shopify credential does not match its reporting source.",
    );
  }
  return credential;
}

function hasValidShopifyMetadata(connection: ShopifyRow) {
  return (
    connection.shopify_name.trim().length > 0 &&
    /^[A-Z]{3}$/.test(connection.shopify_currency) &&
    normalizeShopDomain(connection.shopify_domain) === connection.shopify_domain
  );
}

/**
 * Resolves every active V2 binding to the immutable ad_accounts identity that
 * owns its reporting rows. This function performs no upstream reads or writes.
 */
async function resolveReportingSourcesByStatus({
  service,
  shopifyRepository,
  clientIds,
  adAccountIds,
  bindingIds,
  includeShopifyCredentials = true,
}: ResolveReportingSourcesByStatusInput,
  bindingStatus: "active" | "staged",
): Promise<CanonicalReportingSource[]> {
  if (clientIds?.length === 0 || adAccountIds?.length === 0 || bindingIds?.length === 0) return [];

  let bindingsQuery = service
    .from("client_reporting_bindings")
    .select(BINDING_COLUMNS)
    .eq("status", bindingStatus);
  if (clientIds) bindingsQuery = bindingsQuery.in("client_id", [...new Set(clientIds)]);
  if (adAccountIds) {
    bindingsQuery = bindingsQuery.in("ad_account_id", [...new Set(adAccountIds)]);
  }
  if (bindingIds) bindingsQuery = bindingsQuery.in("id", [...new Set(bindingIds)]);

  const bindingsResult = (await bindingsQuery) as unknown as QueryResult;
  const bindings = rows<BindingRow>(bindingsResult);
  if (bindings.length === 0) return [];

  const selectedBindingIds = new Set(bindings.map((binding) => binding.id));
  const missingAnchorIds = [
    ...new Set(
      bindings.flatMap((binding) =>
        binding.shopify_anchor_binding_id &&
        !selectedBindingIds.has(binding.shopify_anchor_binding_id)
          ? [binding.shopify_anchor_binding_id]
          : [],
      ),
    ),
  ];
  const anchorBindings = missingAnchorIds.length
    ? rows<BindingRow>(
        (await service
          .from("client_reporting_bindings")
          .select(BINDING_COLUMNS)
          .eq("status", "active")
          .in("id", missingAnchorIds)) as unknown as QueryResult,
      )
    : [];
  if (
    anchorBindings.length !== missingAnchorIds.length ||
    anchorBindings.some((binding) => !missingAnchorIds.includes(binding.id))
  ) {
    invalid("A filtered Google Ads source has a missing or duplicate Shopify anchor.");
  }

  const contextBindings = [...bindings, ...anchorBindings];
  const accountIds = uniqueIds(contextBindings, "ad_account_id");
  const selectedShopifyIds = uniqueIds(bindings, "shopify_connection_id");
  const contextShopifyIds = uniqueIds(contextBindings, "shopify_connection_id");
  const googleIds = uniqueIds(bindings, "google_ads_connection_id");

  const [accountsResult, shopifyResult, googleResult, mappingsResult] =
    await Promise.all([
      service
        .from("ad_accounts")
        .select("id, client_id, currency, shopify_url, google_ads_customer_id")
        .in("id", accountIds),
      contextShopifyIds.length
        ? service
            .from("client_shopify_connections")
            .select(
              "id, client_id, status, shopify_shop_id, shopify_name, shopify_domain, primary_domain, shopify_currency, last_verified_at, last_error_code",
            )
            .in("id", contextShopifyIds)
        : Promise.resolve({ data: [], error: null }),
      googleIds.length
        ? service
            .from("client_google_ads_connections")
            .select(
              "id, client_id, status, windsor_account_id, account_name, currency, time_zone, data_source_id, last_verified_at, last_error_code",
            )
            .in("id", googleIds)
        : Promise.resolve({ data: [], error: null }),
      googleIds.length
        ? service
            .from("client_asset_mappings")
            .select("shopify_connection_id, google_ads_connection_id")
            .in("google_ads_connection_id", googleIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

  const accounts = new Map(
    rows<AccountRow>(accountsResult as unknown as QueryResult).map((row) => [row.id, row]),
  );
  const shopifyConnections = new Map(
    rows<ShopifyRow>(shopifyResult as unknown as QueryResult).map((row) => [row.id, row]),
  );
  const googleConnections = new Map(
    rows<GoogleRow>(googleResult as unknown as QueryResult).map((row) => [row.id, row]),
  );
  const mappings = rows<MappingRow>(mappingsResult as unknown as QueryResult);
  const bindingsById = new Map(contextBindings.map((row) => [row.id, row]));
  const mappingsByGoogle = new Map<string, MappingRow[]>();
  for (const mapping of mappings) {
    const current = mappingsByGoogle.get(mapping.google_ads_connection_id) ?? [];
    current.push(mapping);
    mappingsByGoogle.set(mapping.google_ads_connection_id, current);
  }

  const seenAccounts = new Set<string>();
  const seenShopify = new Set<string>();
  const seenGoogle = new Set<string>();

  for (const binding of bindings) {
    if (binding.status !== bindingStatus) invalid("A binding outside the selected lifecycle was returned.");
    assertUnique(binding.ad_account_id, seenAccounts, "ad account");
    if (binding.shopify_connection_id) {
      assertUnique(binding.shopify_connection_id, seenShopify, "Shopify source");
    }
    if (binding.google_ads_connection_id) {
      assertUnique(binding.google_ads_connection_id, seenGoogle, "Google Ads source");
    }
  }

  // Validate public identities before loading any encrypted credential.
  const validated = bindings.map((binding) => {
    const account = accounts.get(binding.ad_account_id);
    if (!account || account.client_id !== binding.client_id) {
      invalid("A binding does not match its canonical ad account owner.");
    }
    if (!/^[A-Z]{3}$/.test(account.currency)) {
      invalid("A binding has an invalid canonical reporting currency.");
    }
    if (!binding.shopify_connection_id && !binding.google_ads_connection_id) {
      invalid("A selected binding has no reporting source.");
    }

    const shopify = binding.shopify_connection_id
      ? shopifyConnections.get(binding.shopify_connection_id)
      : null;
    const google = binding.google_ads_connection_id
      ? googleConnections.get(binding.google_ads_connection_id)
      : null;

    // A latched health-probe failure (last_error_code) deliberately does NOT
    // invalidate the binding: it is carried as healthError so only that
    // family's sync degrades to its stored figures. Treating it as fatal made
    // one failed admin Test during a transient outage blank the whole client
    // portal and freeze every sync until a successful re-test.
    if (
      shopify &&
      (shopify.status !== "connected" ||
        shopify.client_id !== binding.client_id ||
        !shopify.last_verified_at ||
        !hasValidShopifyMetadata(shopify) ||
        normalizeShopDomain(account.shopify_url ?? "") !== shopify.shopify_domain)
    ) {
      invalid("A bound Shopify source does not match its canonical ad account.");
    }
    if (binding.shopify_connection_id && !shopify) {
      invalid("A bound Shopify source is missing.");
    }

    let googleIdentity: ReturnType<typeof normalizeGoogleAdsCustomerId> | null = null;
    if (google) {
      // The Google billing currency must be VERIFIED, not equal to the account's
      // reporting currency: the sync converts every Google money column with the
      // day's ECB rate (see syncReportingSourceWindow), so a store reporting in
      // EUR can carry a Google account that bills in USD. Equality here used to
      // stand in for that conversion — and made binding such an account halt the
      // whole store's resolution, Shopify family included.
      if (
        google.status !== "connected" ||
        google.client_id !== binding.client_id ||
        !google.last_verified_at ||
        !google.currency ||
        !/^[A-Z]{3}$/.test(google.currency) ||
        !google.time_zone?.trim()
      ) {
        invalid("A bound Google Ads source does not match its owner.");
      }
      const legacy = exactGoogleCustomerId(account.google_ads_customer_id);
      try {
        googleIdentity = normalizeGoogleAdsCustomerId(google.windsor_account_id);
      } catch {
        invalid("A bound Google Ads identity is invalid.");
      }
      if (googleIdentity.customerId !== legacy.customerId) {
        invalid("A bound Google Ads source does not match its canonical ad account.");
      }
    } else if (binding.google_ads_connection_id) {
      invalid("A bound Google Ads source is missing.");
    }

    const googleMappings = binding.google_ads_connection_id
      ? mappingsByGoogle.get(binding.google_ads_connection_id) ?? []
      : [];
    if (googleMappings.length > 1) {
      invalid("A bound Google Ads source has multiple Shopify mappings.");
    }

    let anchor: BindingRow | null = null;
    if (binding.shopify_anchor_binding_id) {
      anchor = bindingsById.get(binding.shopify_anchor_binding_id) ?? null;
      if (
        !anchor ||
        anchor.id === binding.id ||
        binding.shopify_connection_id ||
        !binding.google_ads_connection_id ||
        anchor.client_id !== binding.client_id ||
        !anchor.shopify_connection_id ||
        anchor.shopify_anchor_binding_id
      ) {
        invalid("A Google Ads child has an invalid Shopify anchor.");
      }
      const anchorAccount = accounts.get(anchor.ad_account_id);
      const anchorShopify = shopifyConnections.get(anchor.shopify_connection_id);
      if (
        anchor.status !== "active" ||
        !anchorAccount ||
        anchorAccount.client_id !== binding.client_id ||
        !anchorShopify ||
        anchorShopify.status !== "connected" ||
        anchorShopify.client_id !== binding.client_id ||
        !anchorShopify.last_verified_at ||
        !hasValidShopifyMetadata(anchorShopify) ||
        normalizeShopDomain(anchorAccount.shopify_url ?? "") !==
          anchorShopify.shopify_domain
      ) {
        invalid("A Google Ads child has an inconsistent Shopify anchor.");
      }
      if (
        googleMappings.length !== 1 ||
        googleMappings[0].shopify_connection_id !== anchor.shopify_connection_id
      ) {
        invalid("A Google Ads child does not match its Shopify anchor mapping.");
      }
    } else if (binding.shopify_connection_id && binding.google_ads_connection_id) {
      if (
        googleMappings.length !== 1 ||
        googleMappings[0].shopify_connection_id !== binding.shopify_connection_id
      ) {
        invalid("A paired reporting binding does not match its asset mapping.");
      }
    } else if (binding.google_ads_connection_id && googleMappings.length !== 0) {
      invalid("A mapped Google Ads source has no Shopify anchor.");
    }

    return { binding, shopify, google, googleIdentity, anchor };
  });

  const credentialByShopify = new Map<string, StoredShopifyConnectionCredential>();
  if (includeShopifyCredentials && selectedShopifyIds.length > 0) {
    const repository = shopifyRepository ?? createReportingShopifyRepository();
    try {
      const credentials = await Promise.all(
        selectedShopifyIds.map(async (id) => {
          const connection = shopifyConnections.get(id);
          if (!connection) invalid("A bound Shopify source is missing.");
          const credential = checkedShopifyCredential(
            connection,
            await repository.loadCredential(id),
          );
          return [id, credential] as const;
        }),
      );
      for (const [id, credential] of credentials) credentialByShopify.set(id, credential);
    } catch (error) {
      if (error instanceof ReportingSourceResolutionError) throw error;
      throw new ReportingSourceResolutionError(
        "credential_error",
        "A bound Shopify credential could not be loaded.",
      );
    }
  }

  return validated
    .map(({ binding, shopify, google, googleIdentity, anchor }): CanonicalReportingSource => {
      const shopifyCredential = binding.shopify_connection_id
        ? credentialByShopify.get(binding.shopify_connection_id)
        : null;
      if (
        includeShopifyCredentials &&
        binding.shopify_connection_id &&
        !shopifyCredential
      ) {
        throw new ReportingSourceResolutionError(
          "credential_error",
          "A bound Shopify credential is missing.",
        );
      }

      const shopifyAnchor = anchor ?? (shopify ? binding : null);
      return {
        bindingId: binding.id,
        clientId: binding.client_id,
        adAccountId: binding.ad_account_id,
        kind: shopify && google ? "shopify_google" : shopify ? "shopify" : "google_ads",
        group: {
          id: shopifyAnchor?.id ?? binding.id,
          shopifyAnchorBindingId: shopifyAnchor?.id ?? null,
          shopifyAnchorAdAccountId: shopifyAnchor?.ad_account_id ?? null,
        },
        shopify: shopify
          ? {
              connectionId: shopify.id,
              shopId: shopify.shopify_shop_id,
              shopifyName: shopify.shopify_name.trim(),
              domain: shopify.shopify_domain,
              primaryDomain: shopify.primary_domain,
              currency: shopify.shopify_currency,
              credential: shopifyCredential
                ? {
                    shopifyClientId: shopifyCredential.shopifyClientId,
                    clientSecretCiphertext: shopifyCredential.clientSecretCiphertext,
                  }
                : null,
              healthError: shopify.last_error_code,
            }
          : null,
        googleAds:
          google && googleIdentity
            ? {
                connectionId: google.id,
                windsorAccountId: google.windsor_account_id,
                ...googleIdentity,
                accountName: google.account_name,
                currency: google.currency,
                timeZone: google.time_zone,
                dataSourceId: google.data_source_id,
                healthError: google.last_error_code,
              }
            : null,
      };
    })
    .sort((left, right) => left.adAccountId.localeCompare(right.adAccountId));
}

/** Resolve normal reporting authority. Staged bindings are never admitted. */
export function resolveReportingSources(
  input: ResolveReportingSourcesInput,
): Promise<CanonicalReportingSource[]> {
  return resolveReportingSourcesByStatus(input, "active");
}

/**
 * Resolve one exact staged binding for the service-only pre-promotion sync.
 * The normal resolver above has no status option, so runtime/portal callers
 * cannot accidentally widen authority to staged identities.
 */
export async function resolveStagedReportingSource({
  bindingId,
  ...input
}: ResolveStagedReportingSourceInput): Promise<CanonicalReportingSource> {
  const sources = await resolveReportingSourcesByStatus(
    { ...input, bindingIds: [bindingId] },
    "staged",
  );
  if (sources.length !== 1 || sources[0]?.bindingId !== bindingId) {
    invalid("The exact staged reporting binding could not be resolved.");
  }
  return sources[0];
}
