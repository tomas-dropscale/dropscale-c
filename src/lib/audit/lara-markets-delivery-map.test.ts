import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectLaraMarketsDeliveryMap,
  LARA_DELIVERY_GROUP_ZONES_QUERY,
  LARA_DELIVERY_PROFILES_QUERY,
  LARA_MARKET_REGIONS_QUERY,
  LARA_MARKET_SHIPPING_OPTIONS_QUERY,
  LARA_MARKETS_CORE_QUERY,
  LARA_MARKETS_DELIVERY_QUERY_MANIFEST,
  LARA_MARKETS_SHOP_CONTEXT_QUERY,
  LARA_SHOP_LOCALES_QUERY,
  LARA_WEB_PRESENCES_QUERY,
  laraMarketsDeliveryManifestSha256,
  summariseLaraMarketsDeliveryArtifact,
} from "./lara-markets-delivery-map";
import { LARA_AUDIT_CONNECTION } from "./shopify-lara";

type MapperRuntime = Parameters<typeof collectLaraMarketsDeliveryMap>[0]["runtime"];

const MARKET_HR = "gid://shopify/Market/101";
const MARKET_PT = "gid://shopify/Market/102";
const PRESENCE = "gid://shopify/MarketWebPresence/201";
const PROFILE = "gid://shopify/DeliveryProfile/301";
const GROUP = "gid://shopify/DeliveryLocationGroup/401";

function pageInfo(hasNextPage = false, endCursor: string | null = null) {
  return { hasNextPage, endCursor };
}

function shopContext(marketDrivenShipping = false) {
  return {
    shop: {
      id: LARA_AUDIT_CONNECTION.shopId,
      myshopifyDomain: LARA_AUDIT_CONNECTION.shopDomain,
      currencyCode: "EUR",
      enabledPresentmentCurrencies: ["EUR"],
      primaryDomain: {
        id: "gid://shopify/Domain/1",
        host: "www.lararovinj.com",
        url: "https://www.lararovinj.com/?private=discarded#fragment",
        sslEnabled: true,
      },
      features: {
        marketDrivenShipping,
        subCountryMarketsEnabled: false,
        unifiedMarkets: true,
      },
      currencySettings: {
        nodes: [{ currencyCode: "EUR", currencyName: "Euro", enabled: true }],
        pageInfo: pageInfo(),
      },
    },
  };
}

function markets() {
  const currencySettings = {
    baseCurrency: { currencyCode: "EUR", currencyName: "Euro", enabled: true },
    localCurrencies: false,
    roundingEnabled: false,
  };
  return {
    markets: {
      nodes: [
        {
          id: MARKET_HR,
          handle: "croatia",
          name: "Croatia",
          status: "ACTIVE",
          type: "REGION",
          currencySettings,
          conditions: { conditionTypes: ["REGION"] },
        },
        {
          id: MARKET_PT,
          handle: "portugal",
          name: "Portugal",
          status: "ACTIVE",
          type: "REGION",
          currencySettings,
          conditions: { conditionTypes: ["REGION"] },
        },
      ],
      pageInfo: pageInfo(),
    },
  };
}

function regions(marketId: string) {
  const countryCode = marketId === MARKET_HR ? "HR" : "PT";
  const id = marketId === MARKET_HR ? 501 : 502;
  return {
    market: {
      id: marketId,
      conditions: {
        conditionTypes: ["REGION"],
        regionsCondition: {
          applicationLevel: "LEVEL_1",
          regions: {
            nodes: [
              {
                __typename: "MarketRegionCountry",
                id: `gid://shopify/MarketRegionCountry/${id}`,
                name: countryCode === "HR" ? "Croatia" : "Portugal",
                code: countryCode,
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      },
    },
  };
}

function webPresences() {
  return {
    webPresences: {
      nodes: [
        {
          id: PRESENCE,
          domain: {
            id: "gid://shopify/Domain/1",
            host: "www.lararovinj.com",
            url: "https://www.lararovinj.com/",
            sslEnabled: true,
          },
          subfolderSuffix: null,
          defaultLocale: {
            locale: "hr",
            name: "Croatian",
            primary: true,
            published: true,
          },
          alternateLocales: [
            {
              locale: "pt-PT",
              name: "Portuguese",
              primary: false,
              published: true,
            },
          ],
          rootUrls: [
            { locale: "hr", url: "https://www.lararovinj.com/" },
            { locale: "pt-PT", url: "https://www.lararovinj.com/pt-pt/" },
          ],
          markets: {
            nodes: [{ id: MARKET_HR }, { id: MARKET_PT }],
            pageInfo: pageInfo(),
          },
        },
      ],
      pageInfo: pageInfo(),
    },
  };
}

function locales() {
  return {
    shopLocales: [
      {
        locale: "hr",
        name: "Croatian",
        primary: true,
        published: true,
        marketWebPresences: [{ id: PRESENCE }],
      },
      {
        locale: "pt-PT",
        name: "Portuguese",
        primary: false,
        published: true,
        marketWebPresences: [{ id: PRESENCE }],
      },
    ],
  };
}

function inheritedMarketShipping(marketId: string) {
  return { market: { id: marketId, delivery: { shipping: null } } };
}

function explicitMarketShipping(marketId: string) {
  const hr = marketId === MARKET_HR;
  return {
    market: {
      id: marketId,
      delivery: {
        shipping: {
          isEnabled: true,
          optionDefinitionsCount: { count: 1, precision: "EXACT" },
          optionDefinitions: {
            edges: [
              {
                cursor: `option-${marketId}`,
                node: {
                  __typename: "DeliveryFlatRateOptionDefinition",
                  id: `gid://shopify/DeliveryFlatRateOptionDefinition/${hr ? 601 : 602}`,
                  currency: "EUR",
                  description: null,
                  freeDeliveryMinimumValue: null,
                  isActive: true,
                  name: hr ? "DPD besplatna dostava" : "Portugal standard",
                  rateGroups: {
                    nodes: [
                      {
                        id: `gid://shopify/DeliveryFlatRateGroup/${hr ? 701 : 702}`,
                        conditions: {
                          collectionsCount: null,
                          originLocationsCount: { count: 1, precision: "EXACT" },
                        },
                        rate: {
                          id: `gid://shopify/DeliveryFlatRate/${hr ? 801 : 802}`,
                          price: { amount: hr ? "0.00" : "4.95", currencyCode: "EUR" },
                          transitTimeMinSeconds: null,
                          transitTimeMaxSeconds: null,
                        },
                      },
                    ],
                    pageInfo: pageInfo(),
                  },
                },
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      },
    },
  };
}

function profiles() {
  return {
    deliveryProfiles: {
      nodes: [
        {
          id: PROFILE,
          name: "General shipping",
          default: true,
          activeMethodDefinitionsCount: 1,
          locationsWithoutRatesCount: 0,
          originLocationCount: 1,
          zoneCountryCount: 1,
          version: 7,
          profileLocationGroups: [
            {
              locationGroup: {
                id: GROUP,
                locationsCount: { count: 1, precision: "EXACT" },
              },
            },
          ],
        },
      ],
      pageInfo: pageInfo(),
    },
  };
}

function groupZones() {
  return {
    deliveryProfile: {
      id: PROFILE,
      profileLocationGroups: [
        {
          locationGroup: { id: GROUP },
          locationGroupZones: {
            edges: [
              {
                cursor: "zone-1",
                node: {
                  zone: {
                    id: "gid://shopify/DeliveryZone/901",
                    name: "Croatia",
                    countries: [
                      {
                        code: { countryCode: "HR", restOfWorld: false },
                        provinces: [],
                      },
                    ],
                  },
                  methodDefinitionCounts: {
                    rateDefinitionsCount: 1,
                    participantDefinitionsCount: 0,
                  },
                  methodDefinitions: {
                    nodes: [
                      {
                        id: "gid://shopify/DeliveryMethodDefinition/1001",
                        name: "DPD",
                        description: null,
                        active: true,
                        methodConditions: [],
                        rateProvider: {
                          __typename: "DeliveryRateDefinition",
                          id: "gid://shopify/DeliveryRateDefinition/1101",
                          price: { amount: "0.00", currencyCode: "EUR" },
                        },
                      },
                    ],
                    pageInfo: pageInfo(),
                  },
                },
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      ],
    },
  };
}

function makeRuntime(input: {
  marketDrivenShipping?: boolean;
  explicitMarketShipping?: boolean;
  scopes?: string[];
} = {}) {
  const calls: Array<{ document: string; variables: Record<string, unknown> }> = [];
  const queryImplementation = async (
    document: string,
    variables: Record<string, unknown> = {},
  ): Promise<unknown> => {
    calls.push({ document, variables });
    if (document === LARA_MARKETS_SHOP_CONTEXT_QUERY) {
      return shopContext(input.marketDrivenShipping);
    }
    if (document === LARA_MARKETS_CORE_QUERY) return markets();
    if (document === LARA_MARKET_REGIONS_QUERY) {
      return regions(String(variables.marketId));
    }
    if (document === LARA_WEB_PRESENCES_QUERY) return webPresences();
    if (document === LARA_SHOP_LOCALES_QUERY) return locales();
    if (document === LARA_MARKET_SHIPPING_OPTIONS_QUERY) {
      return input.explicitMarketShipping
        ? explicitMarketShipping(String(variables.marketId))
        : inheritedMarketShipping(String(variables.marketId));
    }
    if (document === LARA_DELIVERY_PROFILES_QUERY) return profiles();
    if (document === LARA_DELIVERY_GROUP_ZONES_QUERY) return groupZones();
    throw new Error("Unexpected query document.");
  };
  const runtime = {
    ...LARA_AUDIT_CONNECTION,
    grantedScopes: input.scopes ?? ["read_markets", "read_locales", "read_shipping"],
    query: queryImplementation as MapperRuntime["query"],
  } satisfies MapperRuntime;
  return { runtime, calls };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("the fixed Lara Markets and delivery map", () => {
  it("maps legacy delivery as source of truth and proves HR DPD versus absent PT rates", async () => {
    const { runtime } = makeRuntime();
    const artifact = await collectLaraMarketsDeliveryMap({
      runtime,
      now: () => new Date("2026-08-12T20:00:00.000Z"),
    });

    expect(artifact.auditStatus).toBe("complete");
    expect(artifact.sourceOfTruth).toBe("legacy_delivery_profiles");
    expect(artifact.sourceOfTruthComplete).toBe(true);
    expect(artifact.modules.legacyDelivery.sourceRole).toBe("authoritative_legacy");
    expect(artifact.relevantCoverage.croatia.legacyZones).toHaveLength(1);
    expect(artifact.relevantCoverage.croatia.legacyZones[0].activeMethods[0]).toMatchObject({
      name: "DPD",
      providerType: "flat",
      price: { amount: "0.00", currencyCode: "EUR" },
    });
    expect(artifact.relevantCoverage.portugal.legacyZones).toEqual([]);
    expect(artifact.carrierReferences.dpd).toHaveLength(1);
    expect(artifact.carrierReferences.croatianPost).toEqual([]);
    expect(artifact.shopContext.primaryDomain.url).toBe("https://www.lararovinj.com");
    expect(artifact.privacy).toMatchObject({
      customersQueried: false,
      ordersQueried: false,
      locationAddressesQueried: false,
      locationNamesQueried: false,
      carrierCallbackUrlsQueried: false,
      rawSecretsPersisted: false,
      brandVendorInScope: false,
      brandVendorPolicy: "accepted_non_issue_out_of_scope",
    });

    const summary = summariseLaraMarketsDeliveryArtifact(artifact);
    expect(summary).toMatchObject({
      auditStatus: "complete",
      sourceOfTruth: "legacy_delivery_profiles",
      sourceOfTruthScope: "merchant_owned_shipping_configuration",
      assessmentBoundary: "admin_configuration_not_checkout_quote",
      inheritedMarketShippingPresent: true,
      marketDrivenShipping: false,
      marketCount: 2,
      activeMarketCount: 2,
      legacyProfileCount: 1,
      legacyZoneCount: 1,
      legacyMethodCount: 1,
      brandVendorPolicy: "accepted_non_issue_out_of_scope",
    });
  });

  it("switches authority to Market.delivery.shipping when the shop feature is active", async () => {
    const { runtime } = makeRuntime({
      marketDrivenShipping: true,
      explicitMarketShipping: true,
    });
    const artifact = await collectLaraMarketsDeliveryMap({ runtime });

    expect(artifact.sourceOfTruth).toBe("market_delivery");
    expect(artifact.modules.legacyDelivery.sourceRole).toBe("legacy_or_app_snapshot");
    expect(artifact.sourceOfTruthComplete).toBe(true);
    expect(artifact.relevantCoverage.croatia.explicitMarketShipping[0]).toMatchObject({
      marketId: MARKET_HR,
      isEnabled: true,
      activeOptionCount: 1,
      optionNames: ["DPD besplatna dostava"],
    });
    expect(artifact.carrierReferences.dpd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "market_shipping",
          ownerId: MARKET_HR,
          matchedValues: ["DPD besplatna dostava"],
        }),
      ]),
    );
  });

  it("records missing scopes module by module without broadening the read", async () => {
    const { runtime, calls } = makeRuntime({ scopes: [] });
    const artifact = await collectLaraMarketsDeliveryMap({ runtime });

    expect(artifact.auditStatus).toBe("partial");
    expect(artifact.sourceOfTruthComplete).toBe(false);
    expect(artifact.modules.markets.status).toBe("skipped_missing_scope");
    expect(artifact.modules.webPresences.status).toBe("skipped_missing_scope");
    expect(artifact.modules.locales.status).toBe("skipped_missing_scope");
    expect(artifact.modules.marketShipping.status).toBe("skipped_missing_scope");
    expect(artifact.modules.legacyDelivery.status).toBe("skipped_missing_scope");
    expect(calls.map((call) => call.document)).toEqual([
      LARA_MARKETS_SHOP_CONTEXT_QUERY,
    ]);
  });

  it("reads locales with read_locales alone and never reaches the read_markets-only association field", async () => {
    const { runtime, calls } = makeRuntime({ scopes: ["read_locales"] });
    const artifact = await collectLaraMarketsDeliveryMap({ runtime });

    expect(artifact.modules.locales.status).toBe("complete");
    expect(artifact.modules.locales.items.map((locale) => locale.locale)).toEqual([
      "hr",
      "pt-PT",
    ]);
    expect(calls.map((call) => call.document)).toEqual([
      LARA_MARKETS_SHOP_CONTEXT_QUERY,
      LARA_SHOP_LOCALES_QUERY,
    ]);
    expect(LARA_SHOP_LOCALES_QUERY).not.toContain("marketWebPresences");
  });

  it("treats Shopify's nullable empty web-presence root as a complete empty set", async () => {
    const { runtime } = makeRuntime();
    const originalQuery = runtime.query;
    runtime.query = (async <TData>(
      document: string,
      variables: Record<string, unknown> = {},
    ) => {
      if (document === LARA_WEB_PRESENCES_QUERY) {
        return { webPresences: null } as TData;
      }
      return originalQuery<TData>(document, variables);
    }) as MapperRuntime["query"];
    const artifact = await collectLaraMarketsDeliveryMap({ runtime });

    expect(artifact.modules.webPresences).toMatchObject({
      status: "complete",
      itemCount: 0,
      items: [],
    });
  });

  it("rejects a runtime that is not hard-pinned to the exact Lara connection", async () => {
    const { runtime } = makeRuntime();
    await expect(
      collectLaraMarketsDeliveryMap({
        runtime: { ...runtime, shopId: "gid://shopify/Shop/1" },
      }),
    ).rejects.toMatchObject({ code: "invalid_runtime" });
  });

  it("fails closed on a repeated pagination cursor", async () => {
    let shopPages = 0;
    const queryImplementation = async (
      document: string,
      variables: Record<string, unknown> = {},
    ): Promise<unknown> => {
      if (document !== LARA_MARKETS_SHOP_CONTEXT_QUERY) {
        throw new Error(`Unexpected query ${document} ${JSON.stringify(variables)}`);
      }
      shopPages += 1;
      const data = shopContext(false);
      data.shop.currencySettings.nodes = shopPages === 1
        ? data.shop.currencySettings.nodes
        : [];
      data.shop.currencySettings.pageInfo = pageInfo(true, "same-cursor");
      return data;
    };
    const runtime = {
      ...LARA_AUDIT_CONNECTION,
      grantedScopes: [],
      query: queryImplementation as MapperRuntime["query"],
    } satisfies MapperRuntime;

    await expect(collectLaraMarketsDeliveryMap({ runtime })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    expect(shopPages).toBe(2);
  });

  it("contains only fixed read queries and hashes every bounded contract decision", async () => {
    const documents = Object.values(LARA_MARKETS_DELIVERY_QUERY_MANIFEST);
    expect(documents).toHaveLength(8);
    for (const document of documents) {
      const lower = document.toLowerCase();
      expect(lower).toMatch(/^#graphql\s+query\b/);
      expect(lower).not.toMatch(/\bmutation\b|\bsubscription\b/);
      expect(lower).not.toMatch(/\bcustomers?\b|\borders?\b/);
      expect(lower).not.toMatch(/\b(address|email|phone|callbackurl)\b/);
    }
    expect(LARA_MARKETS_CORE_QUERY).toContain("sortKey: ID");
    expect(LARA_WEB_PRESENCES_QUERY).toContain("webPresences(first: 10");
    expect(LARA_WEB_PRESENCES_QUERY).toContain("markets(first: 25)");
    expect(LARA_MARKET_SHIPPING_OPTIONS_QUERY).toContain("rateGroups(first: 10)");
    expect(LARA_MARKET_SHIPPING_OPTIONS_QUERY).toContain("rates(first: 25)");
    expect(LARA_WEB_PRESENCES_QUERY).not.toContain("first: 250");
    expect(await laraMarketsDeliveryManifestSha256()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed instead of replaying credentialed URLs from a corrupt durable artifact", async () => {
    const { runtime } = makeRuntime();
    const artifact = await collectLaraMarketsDeliveryMap({ runtime });
    artifact.relevantCoverage.portugal.rootUrls = [
      { locale: "pt-PT", url: "https://user:password@www.lararovinj.com/pt" },
    ];

    expect(summariseLaraMarketsDeliveryArtifact(artifact)).toBeNull();
  });
});
