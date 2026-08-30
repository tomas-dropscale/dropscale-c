import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/shopify-repository", () => ({
  createReportingShopifyRepository: vi.fn(),
}));
vi.mock("@/lib/shopify/client", () => ({
  normalizeShopDomain: (value: string) => {
    const domain = value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
  },
}));
vi.mock("@/lib/windsor/client", () => ({
  normalizeGoogleAdsCustomerId: (value: string) => {
    const candidate = value.trim();
    if (!/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(candidate)) throw new Error("invalid");
    const customerId = candidate.replaceAll("-", "");
    return {
      customerId,
      accountId: `${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6)}`,
    };
  },
}));

import type { ReportingShopifyConnectionRepository } from "@/lib/client-onboarding/shopify-connections";
import { createReportingShopifyRepository } from "@/lib/client-onboarding/shopify-repository";
import { resolveReportingSources, resolveStagedReportingSource } from "./sources";

const CLIENT = "60000000-0000-4000-8000-000000000001";
const OTHER_CLIENT = "60000000-0000-4000-8000-000000000002";
const ACCOUNT = "60000000-0000-4000-8000-000000000010";
const CHILD_ACCOUNT = "60000000-0000-4000-8000-000000000011";
const SHOPIFY = "60000000-0000-4000-8000-000000000020";
const GOOGLE = "60000000-0000-4000-8000-000000000030";
const CHILD_GOOGLE = "60000000-0000-4000-8000-000000000031";
const BINDING = "60000000-0000-4000-8000-000000000040";
const CHILD_BINDING = "60000000-0000-4000-8000-000000000041";

type Snapshot = {
  client_reporting_bindings: Array<{
    id: string;
    client_id: string;
    ad_account_id: string;
    shopify_connection_id: string | null;
    google_ads_connection_id: string | null;
    shopify_anchor_binding_id: string | null;
    status: string;
  }>;
  ad_accounts: Array<{
    id: string;
    client_id: string;
    currency: string;
    shopify_url: string | null;
    google_ads_customer_id: string | null;
  }>;
  client_shopify_connections: Array<{
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
  }>;
  client_google_ads_connections: Array<{
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
  }>;
  client_asset_mappings: Array<{
    shopify_connection_id: string;
    google_ads_connection_id: string;
  }>;
};

function snapshot(): Snapshot {
  return {
    client_reporting_bindings: [
      {
        id: BINDING,
        client_id: CLIENT,
        ad_account_id: ACCOUNT,
        shopify_connection_id: SHOPIFY,
        google_ads_connection_id: GOOGLE,
        shopify_anchor_binding_id: null,
        status: "active",
      },
      {
        id: CHILD_BINDING,
        client_id: CLIENT,
        ad_account_id: CHILD_ACCOUNT,
        shopify_connection_id: null,
        google_ads_connection_id: CHILD_GOOGLE,
        shopify_anchor_binding_id: BINDING,
        status: "active",
      },
    ],
    ad_accounts: [
      {
        id: ACCOUNT,
        client_id: CLIENT,
        currency: "EUR",
        shopify_url: "https://northwind.myshopify.com/admin",
        google_ads_customer_id: "1112223333",
      },
      {
        id: CHILD_ACCOUNT,
        client_id: CLIENT,
        currency: "EUR",
        shopify_url: null,
        google_ads_customer_id: "4445556666",
      },
    ],
    client_shopify_connections: [
      {
        id: SHOPIFY,
        client_id: CLIENT,
        status: "connected",
        shopify_shop_id: "gid://shopify/Shop/1",
        shopify_name: "Northwind Home",
        shopify_domain: "northwind.myshopify.com",
        primary_domain: "northwind.example",
        shopify_currency: "EUR",
        last_verified_at: "2026-08-14T00:00:00.000Z",
        last_error_code: null,
      },
    ],
    client_google_ads_connections: [
      {
        id: GOOGLE,
        client_id: CLIENT,
        status: "connected",
        windsor_account_id: "111-222-3333",
        account_name: "Main Ads",
        currency: "EUR",
        time_zone: "Europe/Lisbon",
        data_source_id: "main-source",
        last_verified_at: "2026-08-14T00:00:00.000Z",
        last_error_code: null,
      },
      {
        id: CHILD_GOOGLE,
        client_id: CLIENT,
        status: "connected",
        windsor_account_id: "444-555-6666",
        account_name: "Child Ads",
        currency: "EUR",
        time_zone: "Europe/Lisbon",
        data_source_id: "child-source",
        last_verified_at: "2026-08-14T00:00:00.000Z",
        last_error_code: null,
      },
    ],
    client_asset_mappings: [
      {
        shopify_connection_id: SHOPIFY,
        google_ads_connection_id: GOOGLE,
      },
      {
        shopify_connection_id: SHOPIFY,
        google_ads_connection_id: CHILD_GOOGLE,
      },
    ],
  };
}

type ObservedFilter = {
  table: keyof Snapshot;
  method: "eq" | "in";
  column: string;
  value: unknown;
};

function serviceFor(
  data: Snapshot,
  failTable?: keyof Snapshot,
  observedFilters: ObservedFilter[] = [],
  observedTables: Array<keyof Snapshot> = [],
) {
  return {
    from: vi.fn((table: keyof Snapshot) => {
      observedTables.push(table);
      return {
        select: vi.fn(() => {
          let selectedRows = [...data[table]] as unknown[];
          const query = {
            eq: vi.fn((column: string, value: unknown) => {
              observedFilters.push({ table, method: "eq", column, value });
              selectedRows = selectedRows.filter(
                (row) => (row as Record<string, unknown>)[column] === value,
              );
              return query;
            }),
            in: vi.fn((column: string, value: unknown[]) => {
              observedFilters.push({ table, method: "in", column, value });
              selectedRows = selectedRows.filter((row) =>
                value.includes((row as Record<string, unknown>)[column]),
              );
              return query;
            }),
            then: (resolve: (result: { data: unknown[]; error: unknown }) => void) => {
              resolve({
                data: selectedRows,
                error: table === failTable ? { code: "database_error" } : null,
              });
            },
          };
          return query;
        }),
      };
    }),
  } as unknown as SupabaseClient;
}

const loadCredential = vi.fn(async () => ({
  connectionId: SHOPIFY,
  shopifyShopId: "gid://shopify/Shop/1",
  shopifyDomain: "northwind.myshopify.com",
  shopifyClientId: "shopify-client",
  clientSecretCiphertext: "encrypted-secret",
}));

function repository(): Pick<ReportingShopifyConnectionRepository, "loadCredential"> {
  return { loadCredential };
}

describe("runtime V2 reporting source resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves one Shopify fact owner and groups mapped Google children under it", async () => {
    const sources = await resolveReportingSources({
      service: serviceFor(snapshot()),
      shopifyRepository: repository(),
    });

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      bindingId: BINDING,
      adAccountId: ACCOUNT,
      kind: "shopify_google",
      group: {
        id: BINDING,
        shopifyAnchorBindingId: BINDING,
        shopifyAnchorAdAccountId: ACCOUNT,
      },
      shopify: {
        connectionId: SHOPIFY,
        shopifyName: "Northwind Home",
        domain: "northwind.myshopify.com",
        primaryDomain: "northwind.example",
        currency: "EUR",
        credential: {
          shopifyClientId: "shopify-client",
          clientSecretCiphertext: "encrypted-secret",
        },
      },
      googleAds: {
        connectionId: GOOGLE,
        accountId: "111-222-3333",
        customerId: "1112223333",
      },
    });
    expect(sources[1]).toMatchObject({
      bindingId: CHILD_BINDING,
      adAccountId: CHILD_ACCOUNT,
      kind: "google_ads",
      group: {
        id: BINDING,
        shopifyAnchorBindingId: BINDING,
        shopifyAnchorAdAccountId: ACCOUNT,
      },
      shopify: null,
      googleAds: {
        connectionId: CHILD_GOOGLE,
        customerId: "4445556666",
      },
    });
    expect(loadCredential).toHaveBeenCalledTimes(1);
    expect(loadCredential).toHaveBeenCalledWith(SHOPIFY);
  });

  it("keeps normal authority active-only and resolves one exact staged binding explicitly", async () => {
    const data = snapshot();
    data.client_reporting_bindings = [
      { ...data.client_reporting_bindings[0], status: "staged" },
    ];
    data.ad_accounts = [data.ad_accounts[0]];
    data.client_google_ads_connections = [data.client_google_ads_connections[0]];
    data.client_asset_mappings = [data.client_asset_mappings[0]];
    const observedFilters: ObservedFilter[] = [];
    const service = serviceFor(data, undefined, observedFilters);

    await expect(
      resolveReportingSources({ service, shopifyRepository: repository() }),
    ).resolves.toEqual([]);
    const staged = await resolveStagedReportingSource({
      service,
      bindingId: BINDING,
      shopifyRepository: repository(),
    });

    expect(staged).toMatchObject({
      bindingId: BINDING,
      adAccountId: ACCOUNT,
      kind: "shopify_google",
    });
    expect(
      observedFilters.filter((filter) => filter.table === "client_reporting_bindings"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "eq", column: "status", value: "active" }),
        expect.objectContaining({ method: "eq", column: "status", value: "staged" }),
        expect.objectContaining({ method: "in", column: "id", value: [BINDING] }),
      ]),
    );
  });

  it("resolves a staged Google child only through its exact active Shopify anchor", async () => {
    const data = snapshot();
    data.client_reporting_bindings[1].status = "staged";
    const staged = await resolveStagedReportingSource({
      service: serviceFor(data),
      bindingId: CHILD_BINDING,
      shopifyRepository: repository(),
    });

    expect(staged).toMatchObject({
      bindingId: CHILD_BINDING,
      kind: "google_ads",
      group: {
        id: BINDING,
        shopifyAnchorBindingId: BINDING,
        shopifyAnchorAdAccountId: ACCOUNT,
      },
    });
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("resolves an unmapped Google-only binding without loading Shopify secrets", async () => {
    const data = snapshot();
    data.client_reporting_bindings = [
      {
        ...data.client_reporting_bindings[1],
        shopify_anchor_binding_id: null,
      },
    ];
    data.ad_accounts = [data.ad_accounts[1]];
    data.client_shopify_connections = [];
    data.client_google_ads_connections = [data.client_google_ads_connections[1]];
    data.client_asset_mappings = [];

    const sources = await resolveReportingSources({
      service: serviceFor(data),
      shopifyRepository: repository(),
    });

    expect(sources).toEqual([
      expect.objectContaining({
        bindingId: CHILD_BINDING,
        kind: "google_ads",
        group: {
          id: CHILD_BINDING,
          shopifyAnchorBindingId: null,
          shopifyAnchorAdAccountId: null,
        },
        shopify: null,
      }),
    ]);
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("returns Shopify metadata without constructing or loading credentials", async () => {
    const sources = await resolveReportingSources({
      service: serviceFor(snapshot()),
      includeShopifyCredentials: false,
      adAccountIds: [ACCOUNT],
    });

    expect(sources).toHaveLength(1);
    expect(sources[0].shopify).toEqual({
      connectionId: SHOPIFY,
      shopId: "gid://shopify/Shop/1",
      shopifyName: "Northwind Home",
      domain: "northwind.myshopify.com",
      primaryDomain: "northwind.example",
      currency: "EUR",
      credential: null,
    });
    expect(createReportingShopifyRepository).not.toHaveBeenCalled();
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("applies client and ad-account filters with AND semantics", async () => {
    const observedFilters: ObservedFilter[] = [];
    const sources = await resolveReportingSources({
      service: serviceFor(snapshot(), undefined, observedFilters),
      shopifyRepository: repository(),
      clientIds: [CLIENT, CLIENT],
      adAccountIds: [ACCOUNT, ACCOUNT],
    });

    expect(sources).toHaveLength(1);
    expect(sources[0].adAccountId).toBe(ACCOUNT);
    expect(
      observedFilters.filter((filter) => filter.table === "client_reporting_bindings"),
    ).toEqual([
      {
        table: "client_reporting_bindings",
        method: "eq",
        column: "status",
        value: "active",
      },
      {
        table: "client_reporting_bindings",
        method: "in",
        column: "client_id",
        value: [CLIENT],
      },
      {
        table: "client_reporting_bindings",
        method: "in",
        column: "ad_account_id",
        value: [ACCOUNT],
      },
    ]);
  });

  it("resolves a filtered Google child without loading its Shopify anchor secret", async () => {
    const sources = await resolveReportingSources({
      service: serviceFor(snapshot()),
      shopifyRepository: repository(),
      adAccountIds: [CHILD_ACCOUNT],
    });

    expect(sources).toEqual([
      expect.objectContaining({
        bindingId: CHILD_BINDING,
        adAccountId: CHILD_ACCOUNT,
        group: {
          id: BINDING,
          shopifyAnchorBindingId: BINDING,
          shopifyAnchorAdAccountId: ACCOUNT,
        },
        shopify: null,
      }),
    ]);
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("fails closed when a filtered Google child points to another client's anchor", async () => {
    const data = snapshot();
    data.client_reporting_bindings[0] = {
      ...data.client_reporting_bindings[0],
      client_id: OTHER_CLIENT,
    };

    await expect(
      resolveReportingSources({
        service: serviceFor(data),
        shopifyRepository: repository(),
        clientIds: [CLIENT],
        adAccountIds: [CHILD_ACCOUNT],
      }),
    ).rejects.toMatchObject({ code: "invalid_binding" });
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("returns no sources or queries for an empty filter", async () => {
    for (const filters of [{ clientIds: [] }, { adAccountIds: [] }]) {
      const observedTables: Array<keyof Snapshot> = [];
      await expect(
        resolveReportingSources({
          service: serviceFor(snapshot(), undefined, [], observedTables),
          shopifyRepository: repository(),
          ...filters,
        }),
      ).resolves.toEqual([]);
      expect(observedTables).toEqual([]);
    }
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("fails closed when the filtered bindings query fails", async () => {
    await expect(
      resolveReportingSources({
        service: serviceFor(snapshot(), "client_reporting_bindings"),
        shopifyRepository: repository(),
        clientIds: [CLIENT],
        adAccountIds: [ACCOUNT],
      }),
    ).rejects.toMatchObject({ code: "database_error" });
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("fails closed when a source owner differs from the binding owner", async () => {
    const data = snapshot();
    data.client_google_ads_connections[0] = {
      ...data.client_google_ads_connections[0],
      client_id: OTHER_CLIENT,
    };

    await expect(
      resolveReportingSources({
        service: serviceFor(data),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_binding",
    });
  });

  it("fails closed when a mapped Google source has no active Shopify anchor", async () => {
    const data = snapshot();
    data.client_reporting_bindings = [
      {
        ...data.client_reporting_bindings[1],
        shopify_anchor_binding_id: null,
      },
    ];
    data.ad_accounts = [data.ad_accounts[1]];
    data.client_shopify_connections = [];
    data.client_google_ads_connections = [data.client_google_ads_connections[1]];
    data.client_asset_mappings = [data.client_asset_mappings[1]];

    await expect(
      resolveReportingSources({
        service: serviceFor(data),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_binding",
    });
  });

  it("fails closed when an active source id is repeated", async () => {
    const data = snapshot();
    data.client_reporting_bindings[1] = {
      ...data.client_reporting_bindings[1],
      google_ads_connection_id: GOOGLE,
      shopify_anchor_binding_id: null,
    };
    data.ad_accounts[1] = {
      ...data.ad_accounts[1],
      google_ads_customer_id: "1112223333",
    };
    data.client_asset_mappings = [];

    await expect(
      resolveReportingSources({
        service: serviceFor(data),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({
      code: "invalid_binding",
    });
  });

  it("fails closed when the repository credential belongs to another shop", async () => {
    loadCredential.mockResolvedValueOnce({
      connectionId: SHOPIFY,
      shopifyShopId: "gid://shopify/Shop/other",
      shopifyDomain: "northwind.myshopify.com",
      shopifyClientId: "shopify-client",
      clientSecretCiphertext: "encrypted-secret",
    });

    await expect(
      resolveReportingSources({
        service: serviceFor(snapshot()),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({
      code: "credential_error",
    });
  });

  it("fails closed when Shopify projection metadata is invalid", async () => {
    const data = snapshot();
    data.client_shopify_connections[0] = {
      ...data.client_shopify_connections[0],
      shopify_name: "   ",
      shopify_currency: "eur",
    };

    await expect(
      resolveReportingSources({
        service: serviceFor(data),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({ code: "invalid_binding" });
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("allows Shopify shopMoney in another currency for the daily FX pass", async () => {
    const data = snapshot();
    data.client_shopify_connections[0] = {
      ...data.client_shopify_connections[0],
      shopify_currency: "JPY",
    };

    const sources = await resolveReportingSources({
      service: serviceFor(data),
      shopifyRepository: repository(),
    });

    expect(sources.find((source) => source.shopify)?.shopify?.currency).toBe("JPY");
    expect(sources.find((source) => source.googleAds)?.googleAds?.currency).toBe("EUR");
  });

  it("resolves a Google source billing in another currency for the daily FX pass", async () => {
    // A Google account billing in USD on a EUR-reporting store is a valid
    // source: the sync converts its money columns with the day's ECB rate,
    // exactly like Shopify shopMoney in another currency. Equality here used
    // to stand in for that conversion — and binding such an account halted the
    // whole store's resolution, Shopify family included.
    const data = snapshot();
    data.client_google_ads_connections[0] = {
      ...data.client_google_ads_connections[0],
      currency: "USD",
    };

    const sources = await resolveReportingSources({
      service: serviceFor(data),
      shopifyRepository: repository(),
    });

    expect(sources.find((source) => source.googleAds)?.googleAds?.currency).toBe("USD");
    expect(sources.find((source) => source.shopify)?.shopify?.currency).toBe("EUR");
  });

  it("fails closed when a bound Google source has no verified currency", async () => {
    const data = snapshot();
    data.client_google_ads_connections[0] = {
      ...data.client_google_ads_connections[0],
      currency: null,
    };

    await expect(
      resolveReportingSources({
        service: serviceFor(data),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({ code: "invalid_binding" });
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid canonical reporting currency", async () => {
    const data = snapshot();
    data.ad_accounts[0] = { ...data.ad_accounts[0], currency: "eur" };

    await expect(
      resolveReportingSources({
        service: serviceFor(data),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({ code: "invalid_binding" });
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("fails closed before upstream access when Google reporting identity is incomplete", async () => {
    const data = snapshot();
    data.client_google_ads_connections[0] = {
      ...data.client_google_ads_connections[0],
      time_zone: null,
    };

    await expect(
      resolveReportingSources({
        service: serviceFor(data),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({ code: "invalid_binding" });
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it("fails closed on a partial database read", async () => {
    await expect(
      resolveReportingSources({
        service: serviceFor(snapshot(), "ad_accounts"),
        shopifyRepository: repository(),
      }),
    ).rejects.toMatchObject({
      code: "database_error",
    });
  });
});
