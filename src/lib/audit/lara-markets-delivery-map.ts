import "server-only";

import { AUDIT_SHOPIFY_API_VERSION } from "./shopify";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";
import type { AuditShopifyRuntime } from "./shopify-runtime";

export const LARA_MARKETS_DELIVERY_SCHEMA_VERSION =
  "lara-markets-delivery-map.v2" as const;

const MARKET_PAGE_SIZE = 50;
const MARKET_PAGE_CAP = 10;
const MARKET_REGION_PAGE_SIZE = 100;
const MARKET_REGION_PAGE_CAP = 10;
// Keep nested requested query cost safely below Shopify's per-query ceiling.
// Completeness is explicit if Lara ever exceeds either bounded connection.
const WEB_PRESENCE_PAGE_SIZE = 10;
const WEB_PRESENCE_PAGE_CAP = 10;
const WEB_PRESENCE_MARKET_LIMIT = 25;
const CURRENCY_PAGE_SIZE = 100;
const CURRENCY_PAGE_CAP = 10;
const DELIVERY_PROFILE_PAGE_SIZE = 50;
const DELIVERY_PROFILE_PAGE_CAP = 10;
const MAX_LOCATION_GROUPS_PER_PROFILE = 100;
const MAX_TOTAL_PROFILE_LOCATION_GROUPS = 500;
const MAX_ZONES_PER_LOCATION_GROUP = 100;
const MAX_TOTAL_ZONES = 1_000;
const LEGACY_METHOD_PAGE_SIZE = 250;
const MAX_TOTAL_LEGACY_METHODS = 5_000;
const MARKET_OPTION_RATE_GROUP_LIMIT = 10;
const MARKET_OPTION_RATE_LIMIT = 25;
const MAX_MARKET_OPTIONS_PER_MARKET = 100;
const MAX_TOTAL_MARKET_OPTIONS = 1_000;
const MAX_CONDITIONS_PER_METHOD = 20;
const MAX_PARTICIPANT_SERVICES = 100;
const MAX_CARRIER_SERVICES_PER_GROUP = 100;
const MAX_COUNTRIES_PER_ZONE = 300;
const MAX_PROVINCES_PER_ZONE = 5_000;
const MAX_RELEVANT_SUMMARY_ROWS = 100;
const MAX_STRING = 1_000;
// `complete_audit_shopify_run` accepts at most 8 MiB. Keep headroom for JSONB
// representation and future database-side metadata.
const MAX_ARTIFACT_BYTES = 7_500_000;

export const LARA_MARKETS_SHOP_CONTEXT_QUERY = `#graphql
  query LaraMarketsDeliveryShopContext($after: String) {
    shop {
      id
      myshopifyDomain
      currencyCode
      enabledPresentmentCurrencies
      primaryDomain { id host url sslEnabled }
      features {
        marketDrivenShipping
        subCountryMarketsEnabled
        unifiedMarkets
      }
      currencySettings(first: ${CURRENCY_PAGE_SIZE}, after: $after) {
        nodes { currencyCode currencyName enabled }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const LARA_MARKETS_CORE_QUERY = `#graphql
  query LaraMarketsDeliveryMarkets($after: String) {
    markets(first: ${MARKET_PAGE_SIZE}, after: $after, sortKey: ID) {
      nodes {
        id
        handle
        name
        status
        type
        currencySettings {
          baseCurrency { currencyCode currencyName enabled }
          localCurrencies
          roundingEnabled
        }
        conditions { conditionTypes }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const LARA_MARKET_REGIONS_QUERY = `#graphql
  query LaraMarketsDeliveryMarketRegions($marketId: ID!, $after: String) {
    market(id: $marketId) {
      id
      conditions {
        conditionTypes
        regionsCondition {
          applicationLevel
          regions(first: ${MARKET_REGION_PAGE_SIZE}, after: $after) {
            nodes {
              __typename
              id
              name
              ... on MarketRegionCountry { code }
              ... on MarketRegionSubdivision { code country { code } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
`;

export const LARA_WEB_PRESENCES_QUERY = `#graphql
  query LaraMarketsDeliveryWebPresences($after: String) {
    webPresences(first: ${WEB_PRESENCE_PAGE_SIZE}, after: $after) {
      nodes {
        id
        domain { id host url sslEnabled }
        subfolderSuffix
        defaultLocale { locale name primary published }
        alternateLocales { locale name primary published }
        rootUrls { locale url }
        markets(first: ${WEB_PRESENCE_MARKET_LIMIT}) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const LARA_SHOP_LOCALES_QUERY = `#graphql
  query LaraMarketsDeliveryShopLocales {
    shopLocales {
      locale
      name
      primary
      published
    }
  }
`;

export const LARA_MARKET_SHIPPING_OPTIONS_QUERY = `#graphql
  query LaraMarketsDeliveryMarketShipping($marketId: ID!, $after: String) {
    market(id: $marketId) {
      id
      delivery {
        shipping {
          isEnabled
          optionDefinitionsCount { count precision }
          optionDefinitions(first: 1, after: $after) {
            edges {
              cursor
              node {
                __typename
                id
                currency
                description
                freeDeliveryMinimumValue { amount currencyCode }
                isActive
                ... on DeliveryFlatRateOptionDefinition {
                  name
                  rateGroups(first: ${MARKET_OPTION_RATE_GROUP_LIMIT}) {
                    nodes {
                      id
                      conditions {
                        collectionsCount { count precision }
                        originLocationsCount { count precision }
                      }
                      rate {
                        id
                        price { amount currencyCode }
                        transitTimeMinSeconds
                        transitTimeMaxSeconds
                      }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
                ... on DeliveryValueBasedOptionDefinition {
                  name
                  rateGroups(first: ${MARKET_OPTION_RATE_GROUP_LIMIT}) {
                    nodes {
                      id
                      conditions {
                        collectionsCount { count precision }
                        originLocationsCount { count precision }
                      }
                      rates(first: ${MARKET_OPTION_RATE_LIMIT}) {
                        nodes {
                          id
                          minValue { amount currencyCode }
                          maxValue { amount currencyCode }
                          price { amount currencyCode }
                          transitTimeMinSeconds
                          transitTimeMaxSeconds
                        }
                        pageInfo { hasNextPage endCursor }
                      }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
                ... on DeliveryWeightBasedOptionDefinition {
                  name
                  rateGroups(first: ${MARKET_OPTION_RATE_GROUP_LIMIT}) {
                    nodes {
                      id
                      conditions {
                        collectionsCount { count precision }
                        originLocationsCount { count precision }
                      }
                      rates(first: ${MARKET_OPTION_RATE_LIMIT}) {
                        nodes {
                          id
                          minWeight { value unit }
                          maxWeight { value unit }
                          price { amount currencyCode }
                          transitTimeMinSeconds
                          transitTimeMaxSeconds
                        }
                        pageInfo { hasNextPage endCursor }
                      }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
                ... on DeliveryCarrierCalculatedOptionDefinition {
                  rateGroups(first: ${MARKET_OPTION_RATE_GROUP_LIMIT}) {
                    nodes {
                      id
                      conditions {
                        collectionsCount { count precision }
                        originLocationsCount { count precision }
                      }
                      absoluteAdjustment { amount currencyCode }
                      percentageAdjustment
                      autoIncludeNewServices
                      carrierService {
                        id
                        name
                        formattedName
                        active
                        supportsServiceDiscovery
                      }
                      serviceConfiguration { name status }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
`;

export const LARA_DELIVERY_PROFILES_QUERY = `#graphql
  query LaraMarketsDeliveryProfiles($after: String) {
    deliveryProfiles(first: ${DELIVERY_PROFILE_PAGE_SIZE}, after: $after) {
      nodes {
        id
        name
        default
        activeMethodDefinitionsCount
        locationsWithoutRatesCount
        originLocationCount
        zoneCountryCount
        version
        profileLocationGroups {
          locationGroup {
            id
            locationsCount { count precision }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const LARA_DELIVERY_GROUP_ZONES_QUERY = `#graphql
  query LaraMarketsDeliveryGroupZone(
    $profileId: ID!
    $locationGroupId: ID!
    $after: String
  ) {
    deliveryProfile(id: $profileId) {
      id
      profileLocationGroups(locationGroupId: $locationGroupId) {
        locationGroup { id }
        locationGroupZones(first: 1, after: $after) {
          edges {
            cursor
            node {
              zone {
                id
                name
                countries {
                  code { countryCode restOfWorld }
                  provinces { code }
                }
              }
              methodDefinitionCounts {
                rateDefinitionsCount
                participantDefinitionsCount
              }
              methodDefinitions(first: ${LEGACY_METHOD_PAGE_SIZE}, sortKey: ID) {
                nodes {
                  id
                  name
                  description
                  active
                  methodConditions {
                    id
                    field
                    operator
                    conditionCriteria {
                      __typename
                      ... on MoneyV2 { amount currencyCode }
                      ... on Weight { value unit }
                    }
                  }
                  rateProvider {
                    __typename
                    ... on DeliveryRateDefinition {
                      id
                      price { amount currencyCode }
                    }
                    ... on DeliveryParticipant {
                      id
                      adaptToNewServicesFlag
                      fixedFee { amount currencyCode }
                      percentageOfRateFee
                      carrierService {
                        id
                        name
                        formattedName
                        active
                        supportsServiceDiscovery
                      }
                      participantServices { name active }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const LARA_MARKETS_DELIVERY_QUERY_MANIFEST = Object.freeze({
  shopContext: LARA_MARKETS_SHOP_CONTEXT_QUERY,
  markets: LARA_MARKETS_CORE_QUERY,
  marketRegions: LARA_MARKET_REGIONS_QUERY,
  webPresences: LARA_WEB_PRESENCES_QUERY,
  shopLocales: LARA_SHOP_LOCALES_QUERY,
  marketShipping: LARA_MARKET_SHIPPING_OPTIONS_QUERY,
  deliveryProfiles: LARA_DELIVERY_PROFILES_QUERY,
  deliveryGroupZones: LARA_DELIVERY_GROUP_ZONES_QUERY,
});

type QueryRuntime = Pick<
  AuditShopifyRuntime,
  "connectionId" | "shopDomain" | "shopId" | "grantedScopes" | "query"
>;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type CountValue = { count: number; precision: string };
type CurrencySetting = {
  currencyCode: string;
  currencyName: string;
  enabled: boolean;
};
type Money = { amount: string; currencyCode: string };
type WeightValue = { value: number; unit: string };

type ShopContextData = {
  shop: {
    id: string;
    myshopifyDomain: string;
    currencyCode: string;
    enabledPresentmentCurrencies: string[];
    primaryDomain: {
      id: string;
      host: string;
      url: string;
      sslEnabled: boolean;
    };
    features: {
      marketDrivenShipping: boolean;
      subCountryMarketsEnabled: boolean;
      unifiedMarkets: boolean;
    };
    currencySettings: {
      nodes: CurrencySetting[];
      pageInfo: PageInfo;
    };
  };
};

type MarketCoreNode = {
  id: string;
  handle: string;
  name: string;
  status: string;
  type: string;
  currencySettings: {
    baseCurrency: CurrencySetting;
    localCurrencies: boolean;
    roundingEnabled: boolean;
  } | null;
  conditions: { conditionTypes: string[] } | null;
};

type MarketsData = {
  markets: { nodes: MarketCoreNode[]; pageInfo: PageInfo };
};

type MarketRegionNode = {
  __typename: string;
  id: string;
  name: string;
  code?: string;
  country?: { code: string };
};

type MarketRegionsData = {
  market: {
    id: string;
    conditions: {
      conditionTypes: string[];
      regionsCondition: {
        applicationLevel: string | null;
        regions: { nodes: MarketRegionNode[]; pageInfo: PageInfo };
      } | null;
    } | null;
  } | null;
};

type WebPresenceData = {
  webPresences: {
    nodes: Array<{
      id: string;
      domain: {
        id: string;
        host: string;
        url: string;
        sslEnabled: boolean;
      } | null;
      subfolderSuffix: string | null;
      defaultLocale: ShopLocaleNode;
      alternateLocales: ShopLocaleNode[];
      rootUrls: Array<{ locale: string; url: string }>;
      markets: { nodes: Array<{ id: string }>; pageInfo: PageInfo } | null;
    }>;
    pageInfo: PageInfo;
  } | null;
};

type ShopLocaleNode = {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
};

type ShopLocalesData = {
  shopLocales: ShopLocaleNode[];
};

type RateGroupConditionsRaw = {
  collectionsCount: CountValue | null;
  originLocationsCount: CountValue;
};

type MarketOptionRaw = {
  __typename: string;
  id: string;
  currency: string;
  description: string | null;
  freeDeliveryMinimumValue: Money | null;
  isActive: boolean;
  name?: string;
  rateGroups?: {
    nodes: Array<Record<string, unknown>>;
    pageInfo: PageInfo;
  } | null;
};

type MarketShippingData = {
  market: {
    id: string;
    delivery: {
      shipping: {
        isEnabled: boolean;
        optionDefinitionsCount: CountValue;
        optionDefinitions: {
          edges: Array<{ cursor: string; node: MarketOptionRaw }>;
          pageInfo: PageInfo;
        };
      } | null;
    };
  } | null;
};

type DeliveryProfileRaw = {
  id: string;
  name: string;
  default: boolean;
  activeMethodDefinitionsCount: number;
  locationsWithoutRatesCount: number;
  originLocationCount: number;
  zoneCountryCount: number;
  version: number;
  profileLocationGroups: Array<{
    locationGroup: { id: string; locationsCount: CountValue | null };
  }>;
};

type DeliveryProfilesData = {
  deliveryProfiles: { nodes: DeliveryProfileRaw[]; pageInfo: PageInfo };
};

type LegacyMethodRaw = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  methodConditions: Array<{
    id: string;
    field: string;
    operator: string;
    conditionCriteria:
      | ({ __typename: "MoneyV2" } & Money)
      | ({ __typename: "Weight" } & WeightValue)
      | { __typename: string };
  }>;
  rateProvider: Record<string, unknown> & { __typename: string };
};

type DeliveryGroupZoneData = {
  deliveryProfile: {
    id: string;
    profileLocationGroups: Array<{
      locationGroup: { id: string };
      locationGroupZones: {
        edges: Array<{
          cursor: string;
          node: {
            zone: {
              id: string;
              name: string;
              countries: Array<{
                code: { countryCode: string | null; restOfWorld: boolean };
                provinces: Array<{ code: string }>;
              }>;
            };
            methodDefinitionCounts: {
              rateDefinitionsCount: number;
              participantDefinitionsCount: number;
            };
            methodDefinitions: {
              nodes: LegacyMethodRaw[];
              pageInfo: PageInfo;
            };
          };
        }>;
        pageInfo: PageInfo;
      };
    }>;
  } | null;
};

export type LaraMarketRegionSnapshot =
  | {
      type: "country";
      id: string;
      name: string;
      countryCode: string;
    }
  | {
      type: "subdivision";
      id: string;
      name: string;
      countryCode: string;
      subdivisionCode: string;
    };

export type LaraMarketSnapshot = {
  id: string;
  handle: string;
  name: string;
  status: string;
  type: string;
  conditionTypes: string[];
  regionsApplicationLevel: string | null;
  regions: LaraMarketRegionSnapshot[];
  currencySettings: {
    baseCurrency: CurrencySetting;
    localCurrencies: boolean;
    roundingEnabled: boolean;
  } | null;
};

export type LaraWebPresenceSnapshot = {
  id: string;
  domain: {
    id: string;
    host: string;
    url: string;
    sslEnabled: boolean;
  } | null;
  subfolderSuffix: string | null;
  defaultLocale: ShopLocaleNode;
  alternateLocales: ShopLocaleNode[];
  rootUrls: Array<{ locale: string; url: string }>;
  marketIds: string[];
  marketAssociationComplete: boolean;
};

type RateGroupConditions = {
  appliesToAllProducts: boolean;
  collectionCount: CountValue | null;
  originLocationCount: CountValue;
};

type Transit = {
  minSeconds: number | null;
  maxSeconds: number | null;
};

export type LaraMarketShippingOptionSnapshot = {
  id: string;
  type:
    | "flat"
    | "value_based"
    | "weight_based"
    | "carrier_calculated";
  name: string | null;
  description: string | null;
  currency: string;
  isActive: boolean;
  freeDeliveryMinimumValue: Money | null;
  nestedConnectionsComplete: boolean;
  rateGroups: Array<
    | {
        type: "flat";
        id: string;
        conditions: RateGroupConditions;
        rate: { id: string; price: Money; transit: Transit };
      }
    | {
        type: "value_based";
        id: string;
        conditions: RateGroupConditions;
        rates: Array<{
          id: string;
          minValue: Money;
          maxValue: Money | null;
          price: Money;
          transit: Transit;
        }>;
      }
    | {
        type: "weight_based";
        id: string;
        conditions: RateGroupConditions;
        rates: Array<{
          id: string;
          minWeight: WeightValue;
          maxWeight: WeightValue | null;
          price: Money;
          transit: Transit;
        }>;
      }
    | {
        type: "carrier_calculated";
        id: string;
        conditions: RateGroupConditions;
        absoluteAdjustment: Money | null;
        percentageAdjustment: number | null;
        autoIncludeNewServices: boolean;
        carrierService: {
          id: string;
          name: string | null;
          formattedName: string | null;
          active: boolean;
          supportsServiceDiscovery: boolean;
        };
        services: Array<{ name: string; status: string }>;
      }
  >;
};

export type LaraMarketShippingSnapshot = {
  marketId: string;
  inheritance: "explicit" | "inherited";
  isEnabled: boolean | null;
  optionDefinitionsCount: CountValue | null;
  optionPagesRead: number;
  nestedConnectionsComplete: boolean;
  options: LaraMarketShippingOptionSnapshot[];
};

export type LaraLegacyMethodSnapshot = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  conditions: Array<{
    id: string;
    field: string;
    operator: string;
    criterion:
      | { type: "money"; value: Money }
      | { type: "weight"; value: WeightValue };
  }>;
  provider:
    | { type: "flat"; id: string; price: Money }
    | {
        type: "participant";
        id: string;
        adaptToNewServices: boolean;
        fixedFee: Money | null;
        percentageOfRateFee: number;
        carrierService: {
          id: string;
          name: string | null;
          formattedName: string | null;
          active: boolean;
          supportsServiceDiscovery: boolean;
        };
        services: Array<{ name: string; active: boolean }>;
      };
};

export type LaraLegacyDeliveryProfileSnapshot = {
  id: string;
  name: string;
  default: boolean;
  activeMethodDefinitionsCount: number;
  locationsWithoutRatesCount: number;
  originLocationCount: number;
  zoneCountryCount: number;
  version: number;
  locationGroups: Array<{
    id: string;
    locationsCount: CountValue | null;
    zones: Array<{
      id: string;
      name: string;
      countries: Array<{
        countryCode: string | null;
        restOfWorld: boolean;
        provinceCodes: string[];
      }>;
      rateDefinitionsCount: number;
      participantDefinitionsCount: number;
      methodConnectionComplete: boolean;
      methods: LaraLegacyMethodSnapshot[];
    }>;
  }>;
};

type ModuleState = {
  status: "complete" | "partial" | "skipped_missing_scope";
  requiredAllOf: string[];
  requiredAnyOf: string[];
  pagesRead: number;
  itemCount: number;
  completenessIssues: string[];
};

export type LaraRelevantCoverageRow = {
  countryCode: "PT" | "HR";
  marketIds: string[];
  activeMarketIds: string[];
  webPresenceIds: string[];
  rootUrls: Array<{ locale: string; url: string }>;
  explicitMarketShipping: Array<{
    marketId: string;
    isEnabled: boolean;
    activeOptionCount: number;
    optionNames: string[];
  }>;
  inheritedMarketShippingIds: string[];
  legacyZones: Array<{
    coverage: "explicit_country" | "rest_of_world";
    profileId: string;
    locationGroupId: string;
    zoneId: string;
    zoneName: string;
    activeMethods: Array<{
      id: string;
      name: string;
      providerType: "flat" | "participant";
      price: Money | null;
      carrierName: string | null;
    }>;
  }>;
};

export type LaraCarrierReference = {
  source: "market_shipping" | "legacy_delivery_profile";
  ownerId: string;
  optionOrMethodId: string;
  matchedValues: string[];
};

export type LaraMarketsDeliverySummary = {
  auditStatus: "complete" | "partial";
  completionIssues: string[];
  sourceOfTruth: "market_delivery" | "legacy_delivery_profiles";
  sourceOfTruthScope: "merchant_owned_shipping_configuration";
  sourceOfTruthComplete: boolean;
  assessmentBoundary: "admin_configuration_not_checkout_quote";
  inheritedMarketShippingPresent: boolean;
  marketDrivenShipping: boolean;
  moduleStatuses: Record<
    "shopCurrencies" | "markets" | "webPresences" | "locales" | "marketShipping" | "legacyDelivery",
    ModuleState["status"]
  >;
  shopCurrencyCode: string;
  enabledPresentmentCurrencies: string[];
  marketCount: number;
  activeMarketCount: number;
  webPresenceCount: number;
  publishedLocales: string[];
  marketShippingOptionCount: number;
  legacyProfileCount: number;
  legacyZoneCount: number;
  legacyMethodCount: number;
  portugal: LaraRelevantCoverageRow;
  croatia: LaraRelevantCoverageRow;
  croatianPostReferences: LaraCarrierReference[];
  dpdReferences: LaraCarrierReference[];
  brandVendorPolicy: "accepted_non_issue_out_of_scope";
};

export type LaraMarketsDeliveryArtifact = {
  schemaVersion: typeof LARA_MARKETS_DELIVERY_SCHEMA_VERSION;
  auditStatus: "complete" | "partial";
  completionIssues: string[];
  generatedAt: string;
  apiVersion: typeof AUDIT_SHOPIFY_API_VERSION;
  queryManifestSha256: string;
  shop: typeof LARA_AUDIT_CONNECTION;
  sourceOfTruth: "market_delivery" | "legacy_delivery_profiles";
  sourceOfTruthScope: "merchant_owned_shipping_configuration";
  sourceOfTruthComplete: boolean;
  assessmentBoundary: "admin_configuration_not_checkout_quote";
  inheritedMarketShippingPresent: boolean;
  shopContext: {
    currencyCode: string;
    enabledPresentmentCurrencies: string[];
    primaryDomain: {
      id: string;
      host: string;
      url: string;
      sslEnabled: boolean;
    };
    features: {
      marketDrivenShipping: boolean;
      subCountryMarketsEnabled: boolean;
      unifiedMarkets: boolean;
    };
  };
  modules: {
    shopCurrencies: ModuleState & { settings: CurrencySetting[] };
    markets: ModuleState & { items: LaraMarketSnapshot[] };
    webPresences: ModuleState & { items: LaraWebPresenceSnapshot[] };
    locales: ModuleState & { items: ShopLocaleNode[] };
    marketShipping: ModuleState & { items: LaraMarketShippingSnapshot[] };
    legacyDelivery: ModuleState & {
      sourceRole: "authoritative_legacy" | "legacy_or_app_snapshot";
      items: LaraLegacyDeliveryProfileSnapshot[];
    };
  };
  relevantCoverage: { portugal: LaraRelevantCoverageRow; croatia: LaraRelevantCoverageRow };
  carrierReferences: {
    croatianPost: LaraCarrierReference[];
    dpd: LaraCarrierReference[];
  };
  completeness: {
    shopIdentity: true;
    shopCurrencies: boolean;
    markets: boolean;
    marketRegions: boolean;
    webPresences: boolean;
    locales: boolean;
    marketShipping: boolean;
    legacyDeliveryProfiles: boolean;
    legacyLocationGroups: boolean;
    legacyZones: boolean;
    legacyRates: boolean;
    sourceOfTruth: boolean;
  };
  limits: {
    marketPages: number;
    marketRegionsPerMarket: number;
    webPresencePages: number;
    currencyPages: number;
    deliveryProfilePages: number;
    locationGroupsPerProfile: number;
    zonesPerLocationGroup: number;
    legacyMethodsPerZonePage: number;
    marketRateGroupsPerOption: number;
    marketRatesPerGroup: number;
    webPresenceMarketsPerPresence: number;
    maxArtifactBytes: number;
  };
  privacy: {
    customersQueried: false;
    ordersQueried: false;
    locationAddressesQueried: false;
    locationNamesQueried: false;
    carrierCallbackUrlsQueried: false;
    rawSecretsPersisted: false;
    brandVendorInScope: false;
    brandVendorPolicy: "accepted_non_issue_out_of_scope";
  };
};

export class LaraMarketsDeliveryMapError extends Error {
  constructor(
    public readonly code:
      | "invalid_runtime"
      | "shop_identity_mismatch"
      | "invalid_shop_context"
      | "invalid_market_data"
      | "invalid_web_presence_data"
      | "invalid_locale_data"
      | "invalid_market_shipping_data"
      | "invalid_delivery_profile_data"
      | "invalid_delivery_zone_data"
      | "pagination_cap"
      | "invalid_cursor"
      | "capacity_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "LaraMarketsDeliveryMapError";
  }
}

function mapError(
  code: LaraMarketsDeliveryMapError["code"],
  message: string,
): LaraMarketsDeliveryMapError {
  return new LaraMarketsDeliveryMapError(code, message);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const bytes = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function laraMarketsDeliveryManifestSha256(): Promise<string> {
  const queries = Object.entries(LARA_MARKETS_DELIVERY_QUERY_MANIFEST)
    .map(([name, document]) => `${name}\n${document.trim()}`)
    .join("\n---\n");
  return sha256Hex(
    `${queries}\n---\n${canonicalJson({
      apiVersion: AUDIT_SHOPIFY_API_VERSION,
      connection: LARA_AUDIT_CONNECTION,
      schemaVersion: LARA_MARKETS_DELIVERY_SCHEMA_VERSION,
      limits: {
        MARKET_PAGE_SIZE,
        MARKET_PAGE_CAP,
        MARKET_REGION_PAGE_SIZE,
        MARKET_REGION_PAGE_CAP,
        WEB_PRESENCE_PAGE_SIZE,
        WEB_PRESENCE_PAGE_CAP,
        WEB_PRESENCE_MARKET_LIMIT,
        CURRENCY_PAGE_SIZE,
        CURRENCY_PAGE_CAP,
        DELIVERY_PROFILE_PAGE_SIZE,
        DELIVERY_PROFILE_PAGE_CAP,
        MAX_LOCATION_GROUPS_PER_PROFILE,
        MAX_TOTAL_PROFILE_LOCATION_GROUPS,
        MAX_ZONES_PER_LOCATION_GROUP,
        MAX_TOTAL_ZONES,
        LEGACY_METHOD_PAGE_SIZE,
        MAX_TOTAL_LEGACY_METHODS,
        MARKET_OPTION_RATE_GROUP_LIMIT,
        MARKET_OPTION_RATE_LIMIT,
        MAX_MARKET_OPTIONS_PER_MARKET,
        MAX_TOTAL_MARKET_OPTIONS,
        MAX_ARTIFACT_BYTES,
      },
      protectedDecisions: {
        brandVendor: "accepted_non_issue_out_of_scope",
        customers: "never_query",
        orders: "never_query",
        locationAddresses: "never_query",
        callbackUrls: "never_query",
      },
    })}`,
  );
}

export async function laraMarketsDeliverySchemaSha256(): Promise<string> {
  return sha256Hex(LARA_MARKETS_DELIVERY_SCHEMA_VERSION);
}

function assertRuntime(runtime: QueryRuntime): void {
  if (
    runtime.connectionId !== LARA_AUDIT_CONNECTION.connectionId ||
    runtime.shopDomain !== LARA_AUDIT_CONNECTION.shopDomain ||
    runtime.shopId !== LARA_AUDIT_CONNECTION.shopId ||
    !Array.isArray(runtime.grantedScopes) ||
    typeof runtime.query !== "function"
  ) {
    throw mapError(
      "invalid_runtime",
      "The mapper is not bound to the exact Lara audit connection.",
    );
  }
}

function hasAllScopes(runtime: QueryRuntime, scopes: string[]): boolean {
  return scopes.every((scope) => runtime.grantedScopes.includes(scope));
}

function hasAnyScope(runtime: QueryRuntime, scopes: string[]): boolean {
  return scopes.length === 0 || scopes.some((scope) => runtime.grantedScopes.includes(scope));
}

function requireString(value: unknown, label: string, max = MAX_STRING): string {
  if (typeof value !== "string" || !value || value.length > max) {
    throw mapError("capacity_exceeded", `Shopify returned invalid ${label}.`);
  }
  return value;
}

function optionalString(value: unknown, label: string, max = MAX_STRING): string | null {
  if (value === null) return null;
  return requireString(value, label, max);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw mapError("capacity_exceeded", `Shopify returned invalid ${label}.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, max = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw mapError("capacity_exceeded", `Shopify returned invalid ${label}.`);
  }
  return value as number;
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw mapError("capacity_exceeded", `Shopify returned invalid ${label}.`);
  }
  return value;
}

function requireGid(value: unknown, type: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]{0,100}$/.test(type)) {
    throw mapError("capacity_exceeded", "Shopify returned an invalid resource type.");
  }
  const id = requireString(value, `${type} ID`, 256);
  if (!new RegExp(`^gid://shopify/${type}/[1-9][0-9]*$`).test(id)) {
    throw mapError("capacity_exceeded", `Shopify returned an invalid ${type} ID.`);
  }
  return id;
}

function requireCountryCode(value: unknown): string {
  const code = requireString(value, "country code", 2);
  if (!/^[A-Z]{2}$/.test(code)) {
    throw mapError("capacity_exceeded", "Shopify returned an invalid country code.");
  }
  return code;
}

function requireCurrency(value: unknown): string {
  const currency = requireString(value, "currency code", 12);
  if (!/^[A-Z0-9]{3,12}$/.test(currency)) {
    throw mapError("capacity_exceeded", "Shopify returned an invalid currency code.");
  }
  return currency;
}

function requireLocale(value: unknown): string {
  const locale = requireString(value, "locale", 64);
  if (!/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(locale)) {
    throw mapError("capacity_exceeded", "Shopify returned an invalid locale.");
  }
  return locale;
}

function sanitizeUrl(value: unknown): string {
  const raw = requireString(value, "public URL", 8_192);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw mapError("capacity_exceeded", "Shopify returned an invalid public URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw mapError("capacity_exceeded", "Shopify returned an unsafe public URL.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/");
}

function money(value: unknown): Money {
  const record = objectRecord(value);
  if (!record) {
    throw mapError("capacity_exceeded", "Shopify returned invalid money.");
  }
  const amount = record?.amount;
  if (
    typeof amount !== "string" ||
    amount.length > 100 ||
    !/^-?\d+(?:\.\d+)?$/.test(amount)
  ) {
    throw mapError("capacity_exceeded", "Shopify returned invalid money.");
  }
  return { amount, currencyCode: requireCurrency(record.currencyCode) };
}

function nullableMoney(value: unknown): Money | null {
  return value === null ? null : money(value);
}

function weight(value: unknown): WeightValue {
  const record = objectRecord(value);
  return {
    value: requireFinite(record?.value, "weight"),
    unit: requireString(record?.unit, "weight unit", 32),
  };
}

function nullableWeight(value: unknown): WeightValue | null {
  return value === null ? null : weight(value);
}

function countValue(value: unknown, nullable = false): CountValue | null {
  if (nullable && value === null) return null;
  const record = objectRecord(value);
  if (!record) throw mapError("capacity_exceeded", "Shopify returned an invalid count.");
  return {
    count: requireInteger(record.count, "count"),
    precision: requireString(record.precision, "count precision", 32),
  };
}

function cursorAfter(pageInfo: PageInfo, prior: string | null, label: string): string | null {
  if (typeof pageInfo?.hasNextPage !== "boolean") {
    throw mapError("invalid_cursor", `Shopify returned invalid ${label} page info.`);
  }
  if (!pageInfo.hasNextPage) return null;
  const next = pageInfo.endCursor;
  if (typeof next !== "string" || !next || next === prior || next.length > 8_192) {
    throw mapError("invalid_cursor", `Shopify returned an invalid ${label} cursor.`);
  }
  return next;
}

function currencySetting(value: unknown): CurrencySetting {
  const record = objectRecord(value);
  return {
    currencyCode: requireCurrency(record?.currencyCode),
    currencyName: requireString(record?.currencyName, "currency name", 200),
    enabled: requireBoolean(record?.enabled, "currency enabled state"),
  };
}

function localeSnapshot(value: unknown): ShopLocaleNode {
  const record = objectRecord(value);
  return {
    locale: requireLocale(record?.locale),
    name: requireString(record?.name, "locale name", 200),
    primary: requireBoolean(record?.primary, "locale primary state"),
    published: requireBoolean(record?.published, "locale published state"),
  };
}

function moduleState(input: {
  status: ModuleState["status"];
  requiredAllOf?: string[];
  requiredAnyOf?: string[];
  pagesRead?: number;
  itemCount?: number;
  completenessIssues?: string[];
}): ModuleState {
  return {
    status: input.status,
    requiredAllOf: input.requiredAllOf ?? [],
    requiredAnyOf: input.requiredAnyOf ?? [],
    pagesRead: input.pagesRead ?? 0,
    itemCount: input.itemCount ?? 0,
    completenessIssues: input.completenessIssues ?? [],
  };
}

async function collectShopContext(runtime: QueryRuntime): Promise<{
  context: LaraMarketsDeliveryArtifact["shopContext"];
  settings: CurrencySetting[];
  pagesRead: number;
}> {
  let after: string | null = null;
  let pagesRead = 0;
  let invariant: Omit<LaraMarketsDeliveryArtifact["shopContext"], never> | null = null;
  const settings: CurrencySetting[] = [];
  const seen = new Set<string>();
  for (;;) {
    if (pagesRead >= CURRENCY_PAGE_CAP) {
      throw mapError("pagination_cap", "The shop currency page cap was reached.");
    }
    const data: ShopContextData = await runtime.query<ShopContextData>(
      LARA_MARKETS_SHOP_CONTEXT_QUERY,
      { after },
    );
    pagesRead += 1;
    const shop = data?.shop;
    if (
      !shop ||
      shop.id !== LARA_AUDIT_CONNECTION.shopId ||
      shop.myshopifyDomain !== LARA_AUDIT_CONNECTION.shopDomain
    ) {
      throw mapError("shop_identity_mismatch", "Shopify returned a different shop.");
    }
    if (!Array.isArray(shop.enabledPresentmentCurrencies) || !shop.currencySettings) {
      throw mapError("invalid_shop_context", "Shopify returned invalid shop currency data.");
    }
    const primaryDomain = {
      id: requireGid(shop.primaryDomain?.id, "Domain"),
      host: requireString(shop.primaryDomain?.host, "primary domain host", 255),
      url: sanitizeUrl(shop.primaryDomain?.url),
      sslEnabled: requireBoolean(shop.primaryDomain?.sslEnabled, "domain SSL state"),
    };
    const current = {
      currencyCode: requireCurrency(shop.currencyCode),
      enabledPresentmentCurrencies: [...new Set(
        shop.enabledPresentmentCurrencies.map(requireCurrency),
      )].sort(),
      primaryDomain,
      features: {
        marketDrivenShipping: requireBoolean(
          shop.features?.marketDrivenShipping,
          "market-driven shipping state",
        ),
        subCountryMarketsEnabled: requireBoolean(
          shop.features?.subCountryMarketsEnabled,
          "sub-country markets state",
        ),
        unifiedMarkets: requireBoolean(
          shop.features?.unifiedMarkets,
          "unified markets state",
        ),
      },
    };
    if (invariant && canonicalJson(invariant) !== canonicalJson(current)) {
      throw mapError("invalid_shop_context", "Shop context changed during collection.");
    }
    invariant = current;
    if (!Array.isArray(shop.currencySettings.nodes)) {
      throw mapError("invalid_shop_context", "Shopify returned invalid currency settings.");
    }
    for (const raw of shop.currencySettings.nodes) {
      const setting = currencySetting(raw);
      if (seen.has(setting.currencyCode)) {
        throw mapError("invalid_shop_context", "Shopify repeated a currency setting.");
      }
      seen.add(setting.currencyCode);
      settings.push(setting);
    }
    const next = cursorAfter(shop.currencySettings.pageInfo, after, "currency");
    if (!next) break;
    after = next;
  }
  if (!invariant) throw mapError("invalid_shop_context", "Shop context was empty.");
  settings.sort((left, right) => left.currencyCode.localeCompare(right.currencyCode));
  return { context: invariant, settings, pagesRead };
}

async function collectMarketRegions(
  runtime: QueryRuntime,
  marketId: string,
): Promise<{
  applicationLevel: string | null;
  conditionTypes: string[];
  regions: LaraMarketRegionSnapshot[];
  pagesRead: number;
}> {
  let after: string | null = null;
  let pagesRead = 0;
  let applicationLevel: string | null = null;
  let conditionTypes: string[] = [];
  const regions: LaraMarketRegionSnapshot[] = [];
  const seen = new Set<string>();
  for (;;) {
    if (pagesRead >= MARKET_REGION_PAGE_CAP) {
      throw mapError("pagination_cap", `The region page cap was reached for ${marketId}.`);
    }
    const data: MarketRegionsData = await runtime.query<MarketRegionsData>(
      LARA_MARKET_REGIONS_QUERY,
      { marketId, after },
    );
    pagesRead += 1;
    const market = data?.market;
    if (!market || market.id !== marketId) {
      throw mapError("invalid_market_data", "Shopify returned a different market.");
    }
    const rawTypes = market.conditions?.conditionTypes ?? [];
    if (!Array.isArray(rawTypes)) {
      throw mapError("invalid_market_data", "Shopify returned invalid market conditions.");
    }
    const currentTypes = rawTypes.map((value) => requireString(value, "condition type", 64)).sort();
    if (pagesRead > 1 && canonicalJson(currentTypes) !== canonicalJson(conditionTypes)) {
      throw mapError("invalid_market_data", "Market conditions changed during collection.");
    }
    conditionTypes = currentTypes;
    const condition = market.conditions?.regionsCondition;
    if (!condition) return { applicationLevel: null, conditionTypes, regions: [], pagesRead };
    const currentLevel = optionalString(
      condition.applicationLevel,
      "region application level",
      64,
    );
    if (pagesRead > 1 && currentLevel !== applicationLevel) {
      throw mapError("invalid_market_data", "Market region level changed during collection.");
    }
    applicationLevel = currentLevel;
    if (!Array.isArray(condition.regions?.nodes)) {
      throw mapError("invalid_market_data", "Shopify returned invalid market regions.");
    }
    for (const raw of condition.regions.nodes) {
      const id = requireGid(raw?.id, raw?.__typename);
      if (seen.has(id)) {
        throw mapError("invalid_market_data", "Shopify repeated a market region.");
      }
      seen.add(id);
      const name = requireString(raw.name, "market region name", 300);
      if (raw.__typename === "MarketRegionCountry") {
        regions.push({
          type: "country",
          id,
          name,
          countryCode: requireCountryCode(raw.code),
        });
      } else if (raw.__typename === "MarketRegionSubdivision") {
        regions.push({
          type: "subdivision",
          id,
          name,
          countryCode: requireCountryCode(raw.country?.code),
          subdivisionCode: requireString(raw.code, "subdivision code", 64),
        });
      } else {
        throw mapError("invalid_market_data", "Shopify returned an unknown market region type.");
      }
    }
    const next = cursorAfter(condition.regions.pageInfo, after, "market region");
    if (!next) break;
    after = next;
  }
  regions.sort((left, right) => left.id.localeCompare(right.id));
  return { applicationLevel, conditionTypes, regions, pagesRead };
}

async function collectMarkets(runtime: QueryRuntime): Promise<{
  items: LaraMarketSnapshot[];
  pagesRead: number;
  regionPagesRead: number;
}> {
  let after: string | null = null;
  let pagesRead = 0;
  const rawMarkets: MarketCoreNode[] = [];
  const seen = new Set<string>();
  for (;;) {
    if (pagesRead >= MARKET_PAGE_CAP) {
      throw mapError("pagination_cap", "The market page cap was reached.");
    }
    const data: MarketsData = await runtime.query<MarketsData>(LARA_MARKETS_CORE_QUERY, {
      after,
    });
    pagesRead += 1;
    if (!data?.markets || !Array.isArray(data.markets.nodes)) {
      throw mapError("invalid_market_data", "Shopify returned invalid markets.");
    }
    for (const market of data.markets.nodes) {
      const id = requireGid(market?.id, "Market");
      if (seen.has(id)) throw mapError("invalid_market_data", "Shopify repeated a market.");
      seen.add(id);
      rawMarkets.push(market);
    }
    const next = cursorAfter(data.markets.pageInfo, after, "market");
    if (!next) break;
    after = next;
  }

  let regionPagesRead = 0;
  const items: LaraMarketSnapshot[] = [];
  for (const raw of rawMarkets) {
    const region = await collectMarketRegions(runtime, raw.id);
    regionPagesRead += region.pagesRead;
    const rawCurrency = raw.currencySettings;
    items.push({
      id: raw.id,
      handle: requireString(raw.handle, "market handle", 255),
      name: requireString(raw.name, "market name", 500),
      status: requireString(raw.status, "market status", 64),
      type: requireString(raw.type, "market type", 64),
      conditionTypes: region.conditionTypes,
      regionsApplicationLevel: region.applicationLevel,
      regions: region.regions,
      currencySettings: rawCurrency
        ? {
            baseCurrency: currencySetting(rawCurrency.baseCurrency),
            localCurrencies: requireBoolean(
              rawCurrency.localCurrencies,
              "market local-currency state",
            ),
            roundingEnabled: requireBoolean(
              rawCurrency.roundingEnabled,
              "market rounding state",
            ),
          }
        : null,
    });
  }
  items.sort((left, right) => left.id.localeCompare(right.id));
  return { items, pagesRead, regionPagesRead };
}

async function collectWebPresences(runtime: QueryRuntime): Promise<{
  items: LaraWebPresenceSnapshot[];
  pagesRead: number;
  issues: string[];
}> {
  let after: string | null = null;
  let pagesRead = 0;
  const items: LaraWebPresenceSnapshot[] = [];
  const seen = new Set<string>();
  const issues: string[] = [];
  for (;;) {
    if (pagesRead >= WEB_PRESENCE_PAGE_CAP) {
      throw mapError("pagination_cap", "The web-presence page cap was reached.");
    }
    const data: WebPresenceData = await runtime.query<WebPresenceData>(
      LARA_WEB_PRESENCES_QUERY,
      { after },
    );
    pagesRead += 1;
    const connection = data?.webPresences;
    if (connection === null && after === null) {
      return { items: [], pagesRead, issues };
    }
    if (!connection || !Array.isArray(connection.nodes)) {
      throw mapError("invalid_web_presence_data", "Shopify returned invalid web presences.");
    }
    for (const raw of connection.nodes) {
      const id = requireGid(raw?.id, "MarketWebPresence");
      if (seen.has(id)) {
        throw mapError("invalid_web_presence_data", "Shopify repeated a web presence.");
      }
      seen.add(id);
      const associationComplete = raw.markets
        ? cursorAfter(
            raw.markets.pageInfo,
            null,
            "web-presence market association",
          ) === null
        : true;
      if (!associationComplete) issues.push(`web_presence_market_association_truncated:${id}`);
      const marketIds = (raw.markets?.nodes ?? []).map((node) => requireGid(node.id, "Market"));
      items.push({
        id,
        domain: raw.domain
          ? {
              id: requireGid(raw.domain.id, "Domain"),
              host: requireString(raw.domain.host, "web-presence domain", 255),
              url: sanitizeUrl(raw.domain.url),
              sslEnabled: requireBoolean(raw.domain.sslEnabled, "domain SSL state"),
            }
          : null,
        subfolderSuffix: optionalString(raw.subfolderSuffix, "subfolder suffix", 255),
        defaultLocale: localeSnapshot(raw.defaultLocale),
        alternateLocales: raw.alternateLocales.map(localeSnapshot).sort((a, b) =>
          a.locale.localeCompare(b.locale),
        ),
        rootUrls: raw.rootUrls
          .map((root) => ({ locale: requireLocale(root.locale), url: sanitizeUrl(root.url) }))
          .sort((a, b) => a.locale.localeCompare(b.locale) || a.url.localeCompare(b.url)),
        marketIds: [...new Set(marketIds)].sort(),
        marketAssociationComplete: associationComplete,
      });
    }
    const next = cursorAfter(connection.pageInfo, after, "web presence");
    if (!next) break;
    after = next;
  }
  items.sort((left, right) => left.id.localeCompare(right.id));
  return { items, pagesRead, issues };
}

async function collectLocales(runtime: QueryRuntime): Promise<ShopLocaleNode[]> {
  const data: ShopLocalesData = await runtime.query<ShopLocalesData>(
    LARA_SHOP_LOCALES_QUERY,
  );
  if (!Array.isArray(data?.shopLocales) || data.shopLocales.length > 1_000) {
    throw mapError("invalid_locale_data", "Shopify returned invalid shop locales.");
  }
  const seen = new Set<string>();
  const items = data.shopLocales.map((raw) => {
    const locale = localeSnapshot(raw);
    if (seen.has(locale.locale)) {
      throw mapError("invalid_locale_data", "Shopify repeated a shop locale.");
    }
    seen.add(locale.locale);
    return locale;
  });
  return items.sort((left, right) => left.locale.localeCompare(right.locale));
}

function transit(raw: Record<string, unknown>): Transit {
  const value = {
    minSeconds:
      raw.transitTimeMinSeconds === null
        ? null
        : requireInteger(raw.transitTimeMinSeconds, "minimum transit time"),
    maxSeconds:
      raw.transitTimeMaxSeconds === null
        ? null
        : requireInteger(raw.transitTimeMaxSeconds, "maximum transit time"),
  };
  if (
    value.minSeconds !== null &&
    value.maxSeconds !== null &&
    value.minSeconds > value.maxSeconds
  ) {
    throw mapError(
      "invalid_market_shipping_data",
      "Shopify returned an inverted transit-time range.",
    );
  }
  return value;
}

function rateGroupConditions(value: unknown): RateGroupConditions {
  const raw = value as RateGroupConditionsRaw;
  const collections = countValue(raw?.collectionsCount, true);
  const locations = countValue(raw?.originLocationsCount);
  if (!locations) throw mapError("invalid_market_shipping_data", "Missing location count.");
  return {
    appliesToAllProducts: collections === null,
    collectionCount: collections,
    originLocationCount: locations,
  };
}

function marketOption(raw: MarketOptionRaw): LaraMarketShippingOptionSnapshot {
  const base = {
    id: requireGid(raw.id, raw.__typename),
    description: optionalString(raw.description, "shipping option description"),
    currency: requireCurrency(raw.currency),
    isActive: requireBoolean(raw.isActive, "shipping option state"),
    freeDeliveryMinimumValue: nullableMoney(raw.freeDeliveryMinimumValue),
  };
  const connection = raw.rateGroups;
  const nestedConnectionsComplete = connection
    ? cursorAfter(connection.pageInfo, null, "shipping rate group") === null
    : true;
  const groups = connection?.nodes ?? [];
  if (!Array.isArray(groups) || groups.length > MARKET_OPTION_RATE_GROUP_LIMIT) {
    throw mapError("invalid_market_shipping_data", "Invalid market shipping rate groups.");
  }

  if (raw.__typename === "DeliveryFlatRateOptionDefinition") {
    return {
      ...base,
      type: "flat",
      name: requireString(raw.name, "flat shipping option name", 500),
      nestedConnectionsComplete,
      rateGroups: groups.map((value) => {
        const group = objectRecord(value);
        const rate = objectRecord(group?.rate);
        if (!group || !rate) {
          throw mapError("invalid_market_shipping_data", "Invalid flat rate group.");
        }
        return {
          type: "flat" as const,
          id: requireGid(group.id, "DeliveryFlatRateGroup"),
          conditions: rateGroupConditions(group.conditions),
          rate: {
            id: requireGid(rate.id, "DeliveryFlatRate"),
            price: money(rate.price),
            transit: transit(rate),
          },
        };
      }),
    };
  }

  if (raw.__typename === "DeliveryValueBasedOptionDefinition") {
    let nestedComplete = nestedConnectionsComplete;
    const rateGroups = groups.map((value) => {
      const group = objectRecord(value);
      const rates = objectRecord(group?.rates);
      if (
        !group ||
        !rates ||
        !Array.isArray(rates.nodes) ||
        rates.nodes.length > MARKET_OPTION_RATE_LIMIT
      ) {
        throw mapError("invalid_market_shipping_data", "Invalid value-based rate group.");
      }
      if (
        cursorAfter(rates.pageInfo as PageInfo, null, "value-based shipping rate") !==
        null
      ) {
        nestedComplete = false;
      }
      return {
        type: "value_based" as const,
        id: requireGid(group.id, "DeliveryValueBasedRateGroup"),
        conditions: rateGroupConditions(group.conditions),
        rates: rates.nodes.map((value) => {
          const rate = objectRecord(value);
          if (!rate) throw mapError("invalid_market_shipping_data", "Invalid value rate.");
          return {
            id: requireGid(rate.id, "DeliveryValueBasedRate"),
            minValue: money(rate.minValue),
            maxValue: nullableMoney(rate.maxValue),
            price: money(rate.price),
            transit: transit(rate),
          };
        }),
      };
    });
    return {
      ...base,
      type: "value_based",
      name: requireString(raw.name, "value-based shipping option name", 500),
      nestedConnectionsComplete: nestedComplete,
      rateGroups,
    };
  }

  if (raw.__typename === "DeliveryWeightBasedOptionDefinition") {
    let nestedComplete = nestedConnectionsComplete;
    const rateGroups = groups.map((value) => {
      const group = objectRecord(value);
      const rates = objectRecord(group?.rates);
      if (
        !group ||
        !rates ||
        !Array.isArray(rates.nodes) ||
        rates.nodes.length > MARKET_OPTION_RATE_LIMIT
      ) {
        throw mapError("invalid_market_shipping_data", "Invalid weight-based rate group.");
      }
      if (
        cursorAfter(rates.pageInfo as PageInfo, null, "weight-based shipping rate") !==
        null
      ) {
        nestedComplete = false;
      }
      return {
        type: "weight_based" as const,
        id: requireGid(group.id, "DeliveryWeightBasedRateGroup"),
        conditions: rateGroupConditions(group.conditions),
        rates: rates.nodes.map((value) => {
          const rate = objectRecord(value);
          if (!rate) throw mapError("invalid_market_shipping_data", "Invalid weight rate.");
          return {
            id: requireGid(rate.id, "DeliveryWeightBasedRate"),
            minWeight: weight(rate.minWeight),
            maxWeight: nullableWeight(rate.maxWeight),
            price: money(rate.price),
            transit: transit(rate),
          };
        }),
      };
    });
    return {
      ...base,
      type: "weight_based",
      name: requireString(raw.name, "weight-based shipping option name", 500),
      nestedConnectionsComplete: nestedComplete,
      rateGroups,
    };
  }

  if (raw.__typename === "DeliveryCarrierCalculatedOptionDefinition") {
    return {
      ...base,
      type: "carrier_calculated",
      name: null,
      nestedConnectionsComplete,
      rateGroups: groups.map((value) => {
        const group = objectRecord(value);
        const carrier = objectRecord(group?.carrierService);
        if (!group || !carrier || !Array.isArray(group.serviceConfiguration)) {
          throw mapError("invalid_market_shipping_data", "Invalid carrier rate group.");
        }
        if (group.serviceConfiguration.length > MAX_CARRIER_SERVICES_PER_GROUP) {
          throw mapError("capacity_exceeded", "Carrier service configuration cap exceeded.");
        }
        return {
          type: "carrier_calculated" as const,
          id: requireGid(group.id, "DeliveryCarrierCalculatedRateGroup"),
          conditions: rateGroupConditions(group.conditions),
          absoluteAdjustment: nullableMoney(group.absoluteAdjustment),
          percentageAdjustment:
            group.percentageAdjustment === null
              ? null
              : requireFinite(group.percentageAdjustment, "carrier percentage adjustment"),
          autoIncludeNewServices: requireBoolean(
            group.autoIncludeNewServices,
            "carrier auto-include state",
          ),
          carrierService: {
            id: requireGid(carrier.id, "DeliveryCarrierService"),
            name: optionalString(carrier.name, "carrier service name", 500),
            formattedName: optionalString(
              carrier.formattedName,
              "formatted carrier service name",
              500,
            ),
            active: requireBoolean(carrier.active, "carrier active state"),
            supportsServiceDiscovery: requireBoolean(
              carrier.supportsServiceDiscovery,
              "carrier service discovery state",
            ),
          },
          services: group.serviceConfiguration.map((value) => {
            const service = objectRecord(value);
            return {
              name: requireString(service?.name, "carrier service name", 500),
              status: requireString(service?.status, "carrier service status", 64),
            };
          }),
        };
      }),
    };
  }
  throw mapError("invalid_market_shipping_data", "Unknown market shipping option type.");
}

async function collectMarketShipping(
  runtime: QueryRuntime,
  markets: LaraMarketSnapshot[],
): Promise<{
  items: LaraMarketShippingSnapshot[];
  pagesRead: number;
  issues: string[];
}> {
  const items: LaraMarketShippingSnapshot[] = [];
  const issues: string[] = [];
  let pagesRead = 0;
  let totalOptions = 0;
  for (const expectedMarket of markets) {
    let after: string | null = null;
    let optionPagesRead = 0;
    let invariant: {
      isEnabled: boolean;
      count: CountValue;
    } | null = null;
    const options: LaraMarketShippingOptionSnapshot[] = [];
    const optionIds = new Set<string>();
    for (;;) {
      if (optionPagesRead >= MAX_MARKET_OPTIONS_PER_MARKET) {
        throw mapError("pagination_cap", "The market shipping option cap was reached.");
      }
      const data: MarketShippingData = await runtime.query<MarketShippingData>(
        LARA_MARKET_SHIPPING_OPTIONS_QUERY,
        { marketId: expectedMarket.id, after },
      );
      optionPagesRead += 1;
      pagesRead += 1;
      const market = data?.market;
      if (!market || market.id !== expectedMarket.id) {
        throw mapError("invalid_market_shipping_data", "Shopify returned another market.");
      }
      const shipping = market.delivery?.shipping;
      if (!shipping) {
        items.push({
          marketId: expectedMarket.id,
          inheritance: "inherited",
          isEnabled: null,
          optionDefinitionsCount: null,
          optionPagesRead,
          nestedConnectionsComplete: true,
          options: [],
        });
        break;
      }
      const count = countValue(shipping.optionDefinitionsCount);
      if (!count) throw mapError("invalid_market_shipping_data", "Missing option count.");
      const current = {
        isEnabled: requireBoolean(shipping.isEnabled, "market shipping state"),
        count,
      };
      if (invariant && canonicalJson(invariant) !== canonicalJson(current)) {
        throw mapError("invalid_market_shipping_data", "Market shipping changed during read.");
      }
      invariant = current;
      if (!Array.isArray(shipping.optionDefinitions?.edges) || shipping.optionDefinitions.edges.length > 1) {
        throw mapError("invalid_market_shipping_data", "Invalid shipping option page.");
      }
      for (const edge of shipping.optionDefinitions.edges) {
        const option = marketOption(edge.node);
        if (optionIds.has(option.id)) {
          throw mapError(
            "invalid_market_shipping_data",
            "Shopify repeated a market shipping option.",
          );
        }
        optionIds.add(option.id);
        options.push(option);
        totalOptions += 1;
        if (totalOptions > MAX_TOTAL_MARKET_OPTIONS) {
          throw mapError("capacity_exceeded", "The total market shipping option cap was reached.");
        }
        if (!option.nestedConnectionsComplete) {
          issues.push(`market_shipping_nested_connection_truncated:${option.id}`);
        }
      }
      const next = cursorAfter(shipping.optionDefinitions.pageInfo, after, "shipping option");
      if (!next) {
        if (options.length !== current.count.count && current.count.precision === "EXACT") {
          throw mapError("invalid_market_shipping_data", "Market shipping count did not reconcile.");
        }
        items.push({
          marketId: expectedMarket.id,
          inheritance: "explicit",
          isEnabled: current.isEnabled,
          optionDefinitionsCount: current.count,
          optionPagesRead,
          nestedConnectionsComplete: options.every(
            (option) => option.nestedConnectionsComplete,
          ),
          options,
        });
        break;
      }
      after = next;
    }
  }
  items.sort((left, right) => left.marketId.localeCompare(right.marketId));
  return { items, pagesRead, issues };
}

function legacyCondition(
  value: LegacyMethodRaw["methodConditions"][number],
): LaraLegacyMethodSnapshot["conditions"][number] {
  const base = {
    id: requireGid(value.id, "DeliveryCondition"),
    field: requireString(value.field, "delivery condition field", 64),
    operator: requireString(value.operator, "delivery condition operator", 64),
  };
  if (value.conditionCriteria.__typename === "MoneyV2") {
    return { ...base, criterion: { type: "money", value: money(value.conditionCriteria) } };
  }
  if (value.conditionCriteria.__typename === "Weight") {
    return { ...base, criterion: { type: "weight", value: weight(value.conditionCriteria) } };
  }
  throw mapError("invalid_delivery_zone_data", "Unknown delivery condition criterion.");
}

function carrierSnapshot(value: unknown): {
  id: string;
  name: string | null;
  formattedName: string | null;
  active: boolean;
  supportsServiceDiscovery: boolean;
} {
  const carrier = objectRecord(value);
  if (!carrier) throw mapError("invalid_delivery_zone_data", "Missing carrier service.");
  return {
    id: requireGid(carrier.id, "DeliveryCarrierService"),
    name: optionalString(carrier.name, "carrier name", 500),
    formattedName: optionalString(carrier.formattedName, "carrier formatted name", 500),
    active: requireBoolean(carrier.active, "carrier active state"),
    supportsServiceDiscovery: requireBoolean(
      carrier.supportsServiceDiscovery,
      "carrier service discovery state",
    ),
  };
}

function legacyMethod(raw: LegacyMethodRaw): LaraLegacyMethodSnapshot {
  if (!Array.isArray(raw.methodConditions) || raw.methodConditions.length > MAX_CONDITIONS_PER_METHOD) {
    throw mapError("capacity_exceeded", "Delivery method condition cap exceeded.");
  }
  const provider = raw.rateProvider;
  if (provider.__typename === "DeliveryRateDefinition") {
    return {
      id: requireGid(raw.id, "DeliveryMethodDefinition"),
      name: requireString(raw.name, "delivery method name", 500),
      description: optionalString(raw.description, "delivery method description"),
      active: requireBoolean(raw.active, "delivery method active state"),
      conditions: raw.methodConditions.map(legacyCondition),
      provider: {
        type: "flat",
        id: requireGid(provider.id, "DeliveryRateDefinition"),
        price: money(provider.price),
      },
    };
  }
  if (provider.__typename === "DeliveryParticipant") {
    if (!Array.isArray(provider.participantServices) || provider.participantServices.length > MAX_PARTICIPANT_SERVICES) {
      throw mapError("capacity_exceeded", "Participant service cap exceeded.");
    }
    return {
      id: requireGid(raw.id, "DeliveryMethodDefinition"),
      name: requireString(raw.name, "delivery method name", 500),
      description: optionalString(raw.description, "delivery method description"),
      active: requireBoolean(raw.active, "delivery method active state"),
      conditions: raw.methodConditions.map(legacyCondition),
      provider: {
        type: "participant",
        id: requireGid(provider.id, "DeliveryParticipant"),
        adaptToNewServices: requireBoolean(
          provider.adaptToNewServicesFlag,
          "participant adapt-to-services state",
        ),
        fixedFee: nullableMoney(provider.fixedFee),
        percentageOfRateFee: requireFinite(
          provider.percentageOfRateFee,
          "participant percentage fee",
        ),
        carrierService: carrierSnapshot(provider.carrierService),
        services: provider.participantServices.map((value) => {
          const service = objectRecord(value);
          return {
            name: requireString(service?.name, "participant service name", 500),
            active: requireBoolean(service?.active, "participant service active state"),
          };
        }),
      },
    };
  }
  throw mapError("invalid_delivery_zone_data", "Unknown legacy delivery provider.");
}

async function collectLegacyGroupZones(input: {
  runtime: QueryRuntime;
  profileId: string;
  locationGroupId: string;
  counters: { zones: number; methods: number; pages: number };
  issues: string[];
}): Promise<LaraLegacyDeliveryProfileSnapshot["locationGroups"][number]["zones"]> {
  let after: string | null = null;
  const zones: LaraLegacyDeliveryProfileSnapshot["locationGroups"][number]["zones"] = [];
  const seen = new Set<string>();
  for (;;) {
    if (zones.length >= MAX_ZONES_PER_LOCATION_GROUP) {
      throw mapError("pagination_cap", "The location-group zone cap was reached.");
    }
    const data: DeliveryGroupZoneData = await input.runtime.query<DeliveryGroupZoneData>(
      LARA_DELIVERY_GROUP_ZONES_QUERY,
      {
        profileId: input.profileId,
        locationGroupId: input.locationGroupId,
        after,
      },
    );
    input.counters.pages += 1;
    const profile = data?.deliveryProfile;
    if (!profile || profile.id !== input.profileId || profile.profileLocationGroups.length !== 1) {
      throw mapError("invalid_delivery_zone_data", "Shopify returned another delivery profile group.");
    }
    const group = profile.profileLocationGroups[0];
    if (group.locationGroup.id !== input.locationGroupId) {
      throw mapError("invalid_delivery_zone_data", "Shopify returned another location group.");
    }
    const connection = group.locationGroupZones;
    if (!connection || !Array.isArray(connection.edges) || connection.edges.length > 1) {
      throw mapError("invalid_delivery_zone_data", "Shopify returned an invalid zone page.");
    }
    for (const edge of connection.edges) {
      const raw = edge.node;
      const id = requireGid(raw.zone.id, "DeliveryZone");
      if (seen.has(id)) throw mapError("invalid_delivery_zone_data", "Shopify repeated a zone.");
      seen.add(id);
      input.counters.zones += 1;
      if (input.counters.zones > MAX_TOTAL_ZONES) {
        throw mapError("capacity_exceeded", "The total delivery-zone cap was reached.");
      }
      if (!Array.isArray(raw.zone.countries) || raw.zone.countries.length > MAX_COUNTRIES_PER_ZONE) {
        throw mapError("capacity_exceeded", "The delivery-zone country cap was reached.");
      }
      const countries = raw.zone.countries.map((country) => {
        if (!Array.isArray(country.provinces) || country.provinces.length > MAX_PROVINCES_PER_ZONE) {
          throw mapError("capacity_exceeded", "The delivery-zone province cap was reached.");
        }
        return {
          countryCode:
            country.code.countryCode === null
              ? null
              : requireCountryCode(country.code.countryCode),
          restOfWorld: requireBoolean(country.code.restOfWorld, "rest-of-world state"),
          provinceCodes: country.provinces
            .map((province) => requireString(province.code, "province code", 64))
            .sort(),
        };
      });
      if (!Array.isArray(raw.methodDefinitions.nodes)) {
        throw mapError("invalid_delivery_zone_data", "Shopify returned invalid methods.");
      }
      input.counters.methods += raw.methodDefinitions.nodes.length;
      if (input.counters.methods > MAX_TOTAL_LEGACY_METHODS) {
        throw mapError("capacity_exceeded", "The total legacy delivery method cap was reached.");
      }
      const methodConnectionComplete =
        cursorAfter(raw.methodDefinitions.pageInfo, null, "legacy delivery method") ===
        null;
      if (!methodConnectionComplete) {
        input.issues.push(`legacy_method_connection_truncated:${id}`);
      }
      const rateDefinitionsCount = requireInteger(
        raw.methodDefinitionCounts.rateDefinitionsCount,
        "rate-definition count",
      );
      const participantDefinitionsCount = requireInteger(
        raw.methodDefinitionCounts.participantDefinitionsCount,
        "participant-definition count",
      );
      if (
        methodConnectionComplete &&
        rateDefinitionsCount + participantDefinitionsCount !==
          raw.methodDefinitions.nodes.length
      ) {
        throw mapError(
          "invalid_delivery_zone_data",
          "Delivery method counts did not reconcile.",
        );
      }
      zones.push({
        id,
        name: requireString(raw.zone.name, "delivery zone name", 500),
        countries,
        rateDefinitionsCount,
        participantDefinitionsCount,
        methodConnectionComplete,
        methods: raw.methodDefinitions.nodes.map(legacyMethod),
      });
    }
    const next = cursorAfter(connection.pageInfo, after, "delivery zone");
    if (!next) break;
    after = next;
  }
  return zones;
}

async function collectLegacyDelivery(runtime: QueryRuntime): Promise<{
  items: LaraLegacyDeliveryProfileSnapshot[];
  pagesRead: number;
  issues: string[];
}> {
  let after: string | null = null;
  let profilePages = 0;
  const rawProfiles: DeliveryProfileRaw[] = [];
  const profileIds = new Set<string>();
  let totalGroups = 0;
  for (;;) {
    if (profilePages >= DELIVERY_PROFILE_PAGE_CAP) {
      throw mapError("pagination_cap", "The delivery-profile page cap was reached.");
    }
    const data: DeliveryProfilesData = await runtime.query<DeliveryProfilesData>(
      LARA_DELIVERY_PROFILES_QUERY,
      { after },
    );
    profilePages += 1;
    if (!data?.deliveryProfiles || !Array.isArray(data.deliveryProfiles.nodes)) {
      throw mapError("invalid_delivery_profile_data", "Shopify returned invalid delivery profiles.");
    }
    for (const profile of data.deliveryProfiles.nodes) {
      const id = requireGid(profile?.id, "DeliveryProfile");
      if (profileIds.has(id)) {
        throw mapError("invalid_delivery_profile_data", "Shopify repeated a delivery profile.");
      }
      profileIds.add(id);
      if (!Array.isArray(profile.profileLocationGroups) || profile.profileLocationGroups.length > MAX_LOCATION_GROUPS_PER_PROFILE) {
        throw mapError("capacity_exceeded", "The profile location-group cap was reached.");
      }
      totalGroups += profile.profileLocationGroups.length;
      if (totalGroups > MAX_TOTAL_PROFILE_LOCATION_GROUPS) {
        throw mapError("capacity_exceeded", "The total profile location-group cap was reached.");
      }
      rawProfiles.push(profile);
    }
    const next = cursorAfter(data.deliveryProfiles.pageInfo, after, "delivery profile");
    if (!next) break;
    after = next;
  }

  const counters = { zones: 0, methods: 0, pages: profilePages };
  const issues: string[] = [];
  const items: LaraLegacyDeliveryProfileSnapshot[] = [];
  for (const raw of rawProfiles) {
    const locationGroups: LaraLegacyDeliveryProfileSnapshot["locationGroups"] = [];
    const groupIds = new Set<string>();
    for (const profileGroup of raw.profileLocationGroups) {
      const id = requireGid(profileGroup.locationGroup?.id, "DeliveryLocationGroup");
      if (groupIds.has(id)) {
        throw mapError("invalid_delivery_profile_data", "Shopify repeated a profile location group.");
      }
      groupIds.add(id);
      const zones = await collectLegacyGroupZones({
        runtime,
        profileId: raw.id,
        locationGroupId: id,
        counters,
        issues,
      });
      locationGroups.push({
        id,
        locationsCount: countValue(profileGroup.locationGroup.locationsCount, true),
        zones,
      });
    }
    items.push({
      id: raw.id,
      name: requireString(raw.name, "delivery profile name", 500),
      default: requireBoolean(raw.default, "default profile state"),
      activeMethodDefinitionsCount: requireInteger(
        raw.activeMethodDefinitionsCount,
        "active method count",
      ),
      locationsWithoutRatesCount: requireInteger(
        raw.locationsWithoutRatesCount,
        "locations-without-rates count",
      ),
      originLocationCount: requireInteger(raw.originLocationCount, "origin location count"),
      zoneCountryCount: requireInteger(raw.zoneCountryCount, "zone-country count"),
      version: requireInteger(raw.version, "delivery profile version"),
      locationGroups,
    });
  }
  items.sort((left, right) => left.id.localeCompare(right.id));
  return { items, pagesRead: counters.pages, issues };
}

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function optionValues(option: LaraMarketShippingOptionSnapshot): string[] {
  const values = [option.name, option.description].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const group of option.rateGroups) {
    if (group.type !== "carrier_calculated") continue;
    if (group.carrierService.name) values.push(group.carrierService.name);
    if (group.carrierService.formattedName) values.push(group.carrierService.formattedName);
    values.push(...group.services.map((service) => service.name));
  }
  return [...new Set(values)];
}

function methodValues(method: LaraLegacyMethodSnapshot): string[] {
  const values = [method.name, method.description].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (method.provider.type === "participant") {
    if (method.provider.carrierService.name) values.push(method.provider.carrierService.name);
    if (method.provider.carrierService.formattedName) {
      values.push(method.provider.carrierService.formattedName);
    }
    values.push(...method.provider.services.map((service) => service.name));
  }
  return [...new Set(values)];
}

function carrierReferences(input: {
  marketShipping: LaraMarketShippingSnapshot[];
  legacy: LaraLegacyDeliveryProfileSnapshot[];
  match: (folded: string) => boolean;
}): LaraCarrierReference[] {
  const results: LaraCarrierReference[] = [];
  for (const market of input.marketShipping) {
    for (const option of market.options) {
      const matchedValues = optionValues(option).filter((value) => input.match(fold(value)));
      if (matchedValues.length) {
        results.push({
          source: "market_shipping",
          ownerId: market.marketId,
          optionOrMethodId: option.id,
          matchedValues,
        });
      }
    }
  }
  for (const profile of input.legacy) {
    for (const group of profile.locationGroups) {
      for (const zone of group.zones) {
        for (const method of zone.methods) {
          const matchedValues = methodValues(method).filter((value) => input.match(fold(value)));
          if (matchedValues.length) {
            results.push({
              source: "legacy_delivery_profile",
              ownerId: profile.id,
              optionOrMethodId: method.id,
              matchedValues,
            });
          }
        }
      }
    }
  }
  if (results.length > MAX_RELEVANT_SUMMARY_ROWS) {
    throw mapError("capacity_exceeded", "The relevant carrier-reference cap was reached.");
  }
  return results.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.ownerId.localeCompare(right.ownerId) ||
      left.optionOrMethodId.localeCompare(right.optionOrMethodId),
  );
}

function relevantCoverage(input: {
  countryCode: "PT" | "HR";
  markets: LaraMarketSnapshot[];
  webPresences: LaraWebPresenceSnapshot[];
  marketShipping: LaraMarketShippingSnapshot[];
  legacy: LaraLegacyDeliveryProfileSnapshot[];
}): LaraRelevantCoverageRow {
  const relevantMarkets = input.markets.filter((market) =>
    market.regions.some((region) => region.countryCode === input.countryCode),
  );
  const marketIds = relevantMarkets.map((market) => market.id).sort();
  const marketSet = new Set(marketIds);
  const presences = input.webPresences.filter((presence) =>
    presence.marketIds.some((marketId) => marketSet.has(marketId)),
  );
  const explicitMarketShipping = input.marketShipping
    .filter(
      (shipping) => marketSet.has(shipping.marketId) && shipping.inheritance === "explicit",
    )
    .map((shipping) => ({
      marketId: shipping.marketId,
      isEnabled: shipping.isEnabled === true,
      activeOptionCount: shipping.options.filter((option) => option.isActive).length,
      optionNames: shipping.options
        .filter((option) => option.isActive)
        .flatMap(optionValues)
        .sort(),
    }));
  const inheritedMarketShippingIds = input.marketShipping
    .filter(
      (shipping) => marketSet.has(shipping.marketId) && shipping.inheritance === "inherited",
    )
    .map((shipping) => shipping.marketId)
    .sort();
  const legacyZones: LaraRelevantCoverageRow["legacyZones"] = [];
  for (const profile of input.legacy) {
    for (const locationGroup of profile.locationGroups) {
      for (const zone of locationGroup.zones) {
        const explicit = zone.countries.some(
          (country) => country.countryCode === input.countryCode && !country.restOfWorld,
        );
        const restOfWorld = zone.countries.some((country) => country.restOfWorld);
        if (!explicit && !restOfWorld) continue;
        legacyZones.push({
          coverage: explicit ? "explicit_country" : "rest_of_world",
          profileId: profile.id,
          locationGroupId: locationGroup.id,
          zoneId: zone.id,
          zoneName: zone.name,
          activeMethods: zone.methods
            .filter((method) => method.active)
            .map((method) => ({
              id: method.id,
              name: method.name,
              providerType: method.provider.type,
              price: method.provider.type === "flat" ? method.provider.price : null,
              carrierName:
                method.provider.type === "participant"
                  ? method.provider.carrierService.formattedName ??
                    method.provider.carrierService.name
                  : null,
            })),
        });
      }
    }
  }
  if (legacyZones.length > MAX_RELEVANT_SUMMARY_ROWS) {
    throw mapError("capacity_exceeded", "The relevant delivery-zone cap was reached.");
  }
  return {
    countryCode: input.countryCode,
    marketIds,
    activeMarketIds: relevantMarkets
      .filter((market) => market.status === "ACTIVE")
      .map((market) => market.id)
      .sort(),
    webPresenceIds: presences.map((presence) => presence.id).sort(),
    rootUrls: [
      ...new Map(
        presences
          .flatMap((presence) => presence.rootUrls)
          .map((root) => [`${root.locale}\u0000${root.url}`, root]),
      ).values(),
    ].sort(
      (left, right) =>
        left.locale.localeCompare(right.locale) || left.url.localeCompare(right.url),
    ),
    explicitMarketShipping,
    inheritedMarketShippingIds,
    legacyZones: legacyZones.sort(
      (left, right) =>
        left.coverage.localeCompare(right.coverage) ||
        left.profileId.localeCompare(right.profileId) ||
        left.locationGroupId.localeCompare(right.locationGroupId) ||
        left.zoneId.localeCompare(right.zoneId),
    ),
  };
}

function boundedRecords(value: unknown, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > max) {
    throw mapError("capacity_exceeded", "Invalid persisted bounded list.");
  }
  return value.map((item) => {
    const record = objectRecord(item);
    if (!record) throw mapError("capacity_exceeded", "Invalid persisted record.");
    return record;
  });
}

function boundedStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw mapError("capacity_exceeded", "Invalid persisted string list.");
  }
  return value.map((item) => requireString(item, "persisted string", maxLength));
}

function parseCoverage(
  value: unknown,
  countryCode: "PT" | "HR",
): LaraRelevantCoverageRow {
  const row = objectRecord(value);
  if (!row || row.countryCode !== countryCode) {
    throw mapError("capacity_exceeded", "Invalid persisted country coverage.");
  }
  const marketIds = boundedStrings(
    row.marketIds,
    MARKET_PAGE_SIZE * MARKET_PAGE_CAP,
    256,
  ).map((id) => requireGid(id, "Market"));
  const activeMarketIds = boundedStrings(
    row.activeMarketIds,
    MARKET_PAGE_SIZE * MARKET_PAGE_CAP,
    256,
  ).map((id) => requireGid(id, "Market"));
  const webPresenceIds = boundedStrings(
    row.webPresenceIds,
    WEB_PRESENCE_PAGE_SIZE * WEB_PRESENCE_PAGE_CAP,
    256,
  ).map((id) => requireGid(id, "MarketWebPresence"));
  const rootUrls = boundedRecords(row.rootUrls, 1_000).map((root) => ({
    locale: requireLocale(root.locale),
    url: sanitizeUrl(root.url),
  }));
  const explicitMarketShipping = boundedRecords(
    row.explicitMarketShipping,
    MARKET_PAGE_SIZE * MARKET_PAGE_CAP,
  ).map((shipping) => ({
    marketId: requireGid(shipping.marketId, "Market"),
    isEnabled: requireBoolean(shipping.isEnabled, "market shipping state"),
    activeOptionCount: requireInteger(
      shipping.activeOptionCount,
      "active option count",
      MAX_MARKET_OPTIONS_PER_MARKET,
    ),
    optionNames: boundedStrings(
      shipping.optionNames,
      MAX_TOTAL_MARKET_OPTIONS * MAX_CARRIER_SERVICES_PER_GROUP,
      MAX_STRING,
    ),
  }));
  const inheritedMarketShippingIds = boundedStrings(
    row.inheritedMarketShippingIds,
    MARKET_PAGE_SIZE * MARKET_PAGE_CAP,
    256,
  ).map((id) => requireGid(id, "Market"));
  const legacyZones = boundedRecords(row.legacyZones, MAX_RELEVANT_SUMMARY_ROWS).map(
    (zone) => {
      if (
        zone.coverage !== "explicit_country" &&
        zone.coverage !== "rest_of_world"
      ) {
        throw mapError("capacity_exceeded", "Invalid persisted zone coverage.");
      }
      const coverage = zone.coverage as "explicit_country" | "rest_of_world";
      return {
        coverage,
        profileId: requireGid(zone.profileId, "DeliveryProfile"),
        locationGroupId: requireGid(
          zone.locationGroupId,
          "DeliveryLocationGroup",
        ),
        zoneId: requireGid(zone.zoneId, "DeliveryZone"),
        zoneName: requireString(zone.zoneName, "delivery zone name", 500),
        activeMethods: boundedRecords(zone.activeMethods, LEGACY_METHOD_PAGE_SIZE).map(
          (method) => {
            if (method.providerType !== "flat" && method.providerType !== "participant") {
              throw mapError("capacity_exceeded", "Invalid persisted provider type.");
            }
            const providerType = method.providerType as "flat" | "participant";
            return {
              id: requireGid(method.id, "DeliveryMethodDefinition"),
              name: requireString(method.name, "delivery method name", 500),
              providerType,
              price: nullableMoney(method.price),
              carrierName: optionalString(method.carrierName, "carrier name", 500),
            };
          },
        ),
      };
    },
  );
  return {
    countryCode,
    marketIds,
    activeMarketIds,
    webPresenceIds,
    rootUrls,
    explicitMarketShipping,
    inheritedMarketShippingIds,
    legacyZones,
  };
}

function parseCarrierReferences(value: unknown): LaraCarrierReference[] {
  return boundedRecords(value, MAX_RELEVANT_SUMMARY_ROWS).map((reference) => {
    if (
      reference.source !== "market_shipping" &&
      reference.source !== "legacy_delivery_profile"
    ) {
      throw mapError("capacity_exceeded", "Invalid persisted carrier source.");
    }
    const ownerId = requireGid(
      reference.ownerId,
      reference.source === "market_shipping" ? "Market" : "DeliveryProfile",
    );
    const optionOrMethodId = requireString(
      reference.optionOrMethodId,
      "shipping option or method ID",
      256,
    );
    if (!/^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]{0,100}\/[1-9][0-9]*$/.test(optionOrMethodId)) {
      throw mapError("capacity_exceeded", "Invalid persisted shipping reference ID.");
    }
    return {
      source: reference.source,
      ownerId,
      optionOrMethodId,
      matchedValues: boundedStrings(reference.matchedValues, 1_000, MAX_STRING),
    };
  });
}

export function summariseLaraMarketsDeliveryArtifact(
  value: unknown,
): LaraMarketsDeliverySummary | null {
  try {
    const artifact = objectRecord(value) as LaraMarketsDeliveryArtifact | null;
    if (
      !artifact ||
      artifact.schemaVersion !== LARA_MARKETS_DELIVERY_SCHEMA_VERSION ||
      artifact.shop?.connectionId !== LARA_AUDIT_CONNECTION.connectionId ||
      artifact.shop?.shopDomain !== LARA_AUDIT_CONNECTION.shopDomain ||
      artifact.shop?.shopId !== LARA_AUDIT_CONNECTION.shopId ||
      !/^[a-f0-9]{64}$/.test(artifact.queryManifestSha256 ?? "") ||
      (artifact.sourceOfTruth !== "market_delivery" &&
        artifact.sourceOfTruth !== "legacy_delivery_profiles") ||
      artifact.sourceOfTruthScope !== "merchant_owned_shipping_configuration" ||
      artifact.assessmentBoundary !== "admin_configuration_not_checkout_quote" ||
      typeof artifact.sourceOfTruthComplete !== "boolean" ||
      typeof artifact.inheritedMarketShippingPresent !== "boolean" ||
      !artifact.modules ||
      !artifact.shopContext ||
      !artifact.relevantCoverage ||
      !artifact.carrierReferences
    ) {
      return null;
    }
    if (artifact.auditStatus !== "complete" && artifact.auditStatus !== "partial") {
      return null;
    }
    const issues = boundedStrings(artifact.completionIssues, 1_000, 1_000);
    const markets = boundedRecords(
      artifact.modules.markets?.items,
      MARKET_PAGE_SIZE * MARKET_PAGE_CAP,
    );
    const presences = boundedRecords(
      artifact.modules.webPresences?.items,
      WEB_PRESENCE_PAGE_SIZE * WEB_PRESENCE_PAGE_CAP,
    );
    const locales = boundedRecords(artifact.modules.locales?.items, 1_000);
    const marketShipping = boundedRecords(
      artifact.modules.marketShipping?.items,
      MARKET_PAGE_SIZE * MARKET_PAGE_CAP,
    );
    const profiles = boundedRecords(
      artifact.modules.legacyDelivery?.items,
      DELIVERY_PROFILE_PAGE_SIZE * DELIVERY_PROFILE_PAGE_CAP,
    );
    let marketShippingOptionCount = 0;
    for (const shipping of marketShipping) {
      marketShippingOptionCount += boundedRecords(
        shipping.options,
        MAX_MARKET_OPTIONS_PER_MARKET,
      ).length;
      if (marketShippingOptionCount > MAX_TOTAL_MARKET_OPTIONS) return null;
    }
    let legacyZoneCount = 0;
    let legacyMethodCount = 0;
    for (const profile of profiles) {
      const groups = boundedRecords(
        profile.locationGroups,
        MAX_LOCATION_GROUPS_PER_PROFILE,
      );
      for (const group of groups) {
        const zones = boundedRecords(group.zones, MAX_ZONES_PER_LOCATION_GROUP);
        legacyZoneCount += zones.length;
        if (legacyZoneCount > MAX_TOTAL_ZONES) return null;
        for (const zone of zones) {
          legacyMethodCount += boundedRecords(
            zone.methods,
            LEGACY_METHOD_PAGE_SIZE,
          ).length;
          if (legacyMethodCount > MAX_TOTAL_LEGACY_METHODS) return null;
        }
      }
    }
    const moduleStatus = (input: unknown): ModuleState["status"] => {
      if (
        input !== "complete" &&
        input !== "partial" &&
        input !== "skipped_missing_scope"
      ) {
        throw mapError("capacity_exceeded", "Invalid persisted module status.");
      }
      return input;
    };
    const features = objectRecord(artifact.shopContext.features);
    if (!features) return null;
    const marketDrivenShipping = requireBoolean(
      features.marketDrivenShipping,
      "market-driven shipping state",
    );
    const moduleStatuses = {
      shopCurrencies: moduleStatus(artifact.modules.shopCurrencies?.status),
      markets: moduleStatus(artifact.modules.markets?.status),
      webPresences: moduleStatus(artifact.modules.webPresences?.status),
      locales: moduleStatus(artifact.modules.locales?.status),
      marketShipping: moduleStatus(artifact.modules.marketShipping?.status),
      legacyDelivery: moduleStatus(artifact.modules.legacyDelivery?.status),
    };
    const expectedSource = marketDrivenShipping
      ? "market_delivery"
      : "legacy_delivery_profiles";
    const expectedSourceComplete = marketDrivenShipping
      ? moduleStatuses.marketShipping === "complete" &&
        moduleStatuses.markets === "complete"
      : moduleStatuses.legacyDelivery === "complete";
    const inheritedMarketShippingPresent = marketShipping.some((shipping) => {
      if (shipping.inheritance !== "explicit" && shipping.inheritance !== "inherited") {
        throw mapError("capacity_exceeded", "Invalid persisted shipping inheritance.");
      }
      return shipping.inheritance === "inherited";
    });
    if (
      artifact.sourceOfTruth !== expectedSource ||
      artifact.sourceOfTruthComplete !== expectedSourceComplete ||
      artifact.inheritedMarketShippingPresent !== inheritedMarketShippingPresent ||
      (artifact.auditStatus === "complete") !== (issues.length === 0)
    ) {
      return null;
    }
    const portugal = parseCoverage(artifact.relevantCoverage.portugal, "PT");
    const croatia = parseCoverage(artifact.relevantCoverage.croatia, "HR");
    const croatianPostReferences = parseCarrierReferences(
      artifact.carrierReferences.croatianPost,
    );
    const dpdReferences = parseCarrierReferences(artifact.carrierReferences.dpd);
    return {
      auditStatus: artifact.auditStatus,
      completionIssues: issues,
      sourceOfTruth: artifact.sourceOfTruth,
      sourceOfTruthScope: "merchant_owned_shipping_configuration",
      sourceOfTruthComplete: artifact.sourceOfTruthComplete,
      assessmentBoundary: "admin_configuration_not_checkout_quote",
      inheritedMarketShippingPresent,
      marketDrivenShipping,
      moduleStatuses,
      shopCurrencyCode: requireCurrency(artifact.shopContext.currencyCode),
      enabledPresentmentCurrencies: boundedStrings(
        artifact.shopContext.enabledPresentmentCurrencies,
        1_000,
        12,
      ).map(requireCurrency),
      marketCount: markets.length,
      activeMarketCount: markets.filter((market) => market.status === "ACTIVE").length,
      webPresenceCount: presences.length,
      publishedLocales: locales
        .filter((locale) => requireBoolean(locale.published, "locale published state"))
        .map((locale) => requireLocale(locale.locale))
        .sort(),
      marketShippingOptionCount,
      legacyProfileCount: profiles.length,
      legacyZoneCount,
      legacyMethodCount,
      portugal,
      croatia,
      croatianPostReferences,
      dpdReferences,
      brandVendorPolicy: "accepted_non_issue_out_of_scope",
    };
  } catch {
    return null;
  }
}

export async function collectLaraMarketsDeliveryMap({
  runtime,
  now = () => new Date(),
}: {
  runtime: QueryRuntime;
  now?: () => Date;
}): Promise<LaraMarketsDeliveryArtifact> {
  assertRuntime(runtime);
  const manifestHash = await laraMarketsDeliveryManifestSha256();
  const shop = await collectShopContext(runtime);
  const completionIssues: string[] = [];

  const hasMarkets = hasAllScopes(runtime, ["read_markets"]);
  const hasLocales = hasAnyScope(runtime, ["read_locales", "read_markets_home"]);
  const hasShipping = hasAllScopes(runtime, ["read_shipping"]);

  let markets: LaraMarketSnapshot[] = [];
  let marketPages = 0;
  let regionPages = 0;
  let marketState: ModuleState;
  if (hasMarkets) {
    const collected = await collectMarkets(runtime);
    markets = collected.items;
    marketPages = collected.pagesRead;
    regionPages = collected.regionPagesRead;
    marketState = moduleState({
      status: "complete",
      requiredAllOf: ["read_markets"],
      pagesRead: marketPages + regionPages,
      itemCount: markets.length,
    });
  } else {
    completionIssues.push("markets:missing_scope:read_markets");
    marketState = moduleState({
      status: "skipped_missing_scope",
      requiredAllOf: ["read_markets"],
      completenessIssues: ["missing_scope:read_markets"],
    });
  }

  let webPresences: LaraWebPresenceSnapshot[] = [];
  let webPresenceState: ModuleState;
  if (hasMarkets) {
    const collected = await collectWebPresences(runtime);
    webPresences = collected.items;
    completionIssues.push(...collected.issues);
    webPresenceState = moduleState({
      status: collected.issues.length ? "partial" : "complete",
      requiredAllOf: ["read_markets"],
      pagesRead: collected.pagesRead,
      itemCount: webPresences.length,
      completenessIssues: collected.issues,
    });
  } else {
    completionIssues.push("web_presences:missing_scope:read_markets");
    webPresenceState = moduleState({
      status: "skipped_missing_scope",
      requiredAllOf: ["read_markets"],
      completenessIssues: ["missing_scope:read_markets"],
    });
  }

  let locales: ShopLocaleNode[] = [];
  let localeState: ModuleState;
  if (hasLocales) {
    locales = await collectLocales(runtime);
    localeState = moduleState({
      status: "complete",
      requiredAnyOf: ["read_locales", "read_markets_home"],
      pagesRead: 1,
      itemCount: locales.length,
    });
  } else {
    completionIssues.push("locales:missing_scope:read_locales_or_read_markets_home");
    localeState = moduleState({
      status: "skipped_missing_scope",
      requiredAnyOf: ["read_locales", "read_markets_home"],
      completenessIssues: ["missing_scope:read_locales_or_read_markets_home"],
    });
  }

  let marketShipping: LaraMarketShippingSnapshot[] = [];
  let marketShippingState: ModuleState;
  if (hasMarkets) {
    const collected = await collectMarketShipping(runtime, markets);
    marketShipping = collected.items;
    completionIssues.push(...collected.issues);
    marketShippingState = moduleState({
      status: collected.issues.length ? "partial" : "complete",
      requiredAllOf: ["read_markets"],
      pagesRead: collected.pagesRead,
      itemCount: marketShipping.reduce((sum, market) => sum + market.options.length, 0),
      completenessIssues: collected.issues,
    });
  } else {
    completionIssues.push("market_shipping:missing_scope:read_markets");
    marketShippingState = moduleState({
      status: "skipped_missing_scope",
      requiredAllOf: ["read_markets"],
      completenessIssues: ["missing_scope:read_markets"],
    });
  }

  let legacyDelivery: LaraLegacyDeliveryProfileSnapshot[] = [];
  let legacyState: ModuleState;
  if (hasShipping) {
    const collected = await collectLegacyDelivery(runtime);
    legacyDelivery = collected.items;
    completionIssues.push(...collected.issues);
    legacyState = moduleState({
      status: collected.issues.length ? "partial" : "complete",
      requiredAllOf: ["read_shipping"],
      pagesRead: collected.pagesRead,
      itemCount: legacyDelivery.length,
      completenessIssues: collected.issues,
    });
  } else {
    completionIssues.push("legacy_delivery:missing_scope:read_shipping");
    legacyState = moduleState({
      status: "skipped_missing_scope",
      requiredAllOf: ["read_shipping"],
      completenessIssues: ["missing_scope:read_shipping"],
    });
  }

  const sourceOfTruth = shop.context.features.marketDrivenShipping
    ? "market_delivery"
    : "legacy_delivery_profiles";
  const sourceOfTruthComplete = shop.context.features.marketDrivenShipping
    ? marketShippingState.status === "complete" && marketState.status === "complete"
    : legacyState.status === "complete";
  if (!sourceOfTruthComplete) completionIssues.push("shipping_source_of_truth_incomplete");

  const portugal = relevantCoverage({
    countryCode: "PT",
    markets,
    webPresences,
    marketShipping,
    legacy: legacyDelivery,
  });
  const croatia = relevantCoverage({
    countryCode: "HR",
    markets,
    webPresences,
    marketShipping,
    legacy: legacyDelivery,
  });
  const croatianPost = carrierReferences({
    marketShipping,
    legacy: legacyDelivery,
    match: (value) =>
      (value.includes("hrvatsk") && value.includes("post")) ||
      value.includes("croatian post"),
  });
  const dpd = carrierReferences({
    marketShipping,
    legacy: legacyDelivery,
    match: (value) => /(^| )dpd( |$)/.test(value),
  });
  const uniqueIssues = [...new Set(completionIssues)].sort();
  const auditStatus = uniqueIssues.length === 0 ? "complete" : "partial";
  const inheritedMarketShippingPresent = marketShipping.some(
    (shipping) => shipping.inheritance === "inherited",
  );

  const artifact: LaraMarketsDeliveryArtifact = {
    schemaVersion: LARA_MARKETS_DELIVERY_SCHEMA_VERSION,
    auditStatus,
    completionIssues: uniqueIssues,
    generatedAt: now().toISOString(),
    apiVersion: AUDIT_SHOPIFY_API_VERSION,
    queryManifestSha256: manifestHash,
    shop: LARA_AUDIT_CONNECTION,
    sourceOfTruth,
    sourceOfTruthScope: "merchant_owned_shipping_configuration",
    sourceOfTruthComplete,
    assessmentBoundary: "admin_configuration_not_checkout_quote",
    inheritedMarketShippingPresent,
    shopContext: shop.context,
    modules: {
      shopCurrencies: {
        ...moduleState({
          status: "complete",
          pagesRead: shop.pagesRead,
          itemCount: shop.settings.length,
        }),
        settings: shop.settings,
      },
      markets: { ...marketState, items: markets },
      webPresences: { ...webPresenceState, items: webPresences },
      locales: { ...localeState, items: locales },
      marketShipping: { ...marketShippingState, items: marketShipping },
      legacyDelivery: {
        ...legacyState,
        sourceRole: shop.context.features.marketDrivenShipping
          ? "legacy_or_app_snapshot"
          : "authoritative_legacy",
        items: legacyDelivery,
      },
    },
    relevantCoverage: { portugal, croatia },
    carrierReferences: { croatianPost, dpd },
    completeness: {
      shopIdentity: true,
      shopCurrencies: true,
      markets: marketState.status === "complete",
      marketRegions: marketState.status === "complete",
      webPresences: webPresenceState.status === "complete",
      locales: localeState.status === "complete",
      marketShipping: marketShippingState.status === "complete",
      legacyDeliveryProfiles: legacyState.status === "complete",
      legacyLocationGroups: legacyState.status === "complete",
      legacyZones: legacyState.status === "complete",
      legacyRates: legacyState.status === "complete",
      sourceOfTruth: sourceOfTruthComplete,
    },
    limits: {
      marketPages: MARKET_PAGE_CAP,
      marketRegionsPerMarket: MARKET_REGION_PAGE_SIZE * MARKET_REGION_PAGE_CAP,
      webPresencePages: WEB_PRESENCE_PAGE_CAP,
      currencyPages: CURRENCY_PAGE_CAP,
      deliveryProfilePages: DELIVERY_PROFILE_PAGE_CAP,
      locationGroupsPerProfile: MAX_LOCATION_GROUPS_PER_PROFILE,
      zonesPerLocationGroup: MAX_ZONES_PER_LOCATION_GROUP,
      legacyMethodsPerZonePage: LEGACY_METHOD_PAGE_SIZE,
      marketRateGroupsPerOption: MARKET_OPTION_RATE_GROUP_LIMIT,
      marketRatesPerGroup: MARKET_OPTION_RATE_LIMIT,
      webPresenceMarketsPerPresence: WEB_PRESENCE_MARKET_LIMIT,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
    },
    privacy: {
      customersQueried: false,
      ordersQueried: false,
      locationAddressesQueried: false,
      locationNamesQueried: false,
      carrierCallbackUrlsQueried: false,
      rawSecretsPersisted: false,
      brandVendorInScope: false,
      brandVendorPolicy: "accepted_non_issue_out_of_scope",
    },
  };
  if (new TextEncoder().encode(JSON.stringify(artifact)).byteLength > MAX_ARTIFACT_BYTES) {
    throw mapError("capacity_exceeded", "The bounded audit artifact is too large.");
  }
  return artifact;
}
