import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  clientReportingAuthority: vi.fn(),
  resolveReportingSources: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  requireClientOnboardingAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/portal/client-rollout", () => ({
  clientReportingAuthority: mocks.clientReportingAuthority,
}));
vi.mock("@/lib/reporting/sources", () => ({
  resolveReportingSources: mocks.resolveReportingSources,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/shopify/client", () => ({
  normalizeShopDomain: (value: string) =>
    value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
}));

import { listAdminCommissionClients } from "./client-commissions";

type Table =
  | "portal_clients"
  | "profiles"
  | "ad_accounts"
  | "ad_account_commission_terms";
type Result = { data: Record<string, unknown>[] | null; error: { message: string } | null };

const ADMIN = "40000000-0000-4000-8000-000000000001";
const ALPHA = "40000000-0000-4000-8000-000000000002";
const BETA = "40000000-0000-4000-8000-000000000003";
let results: Record<Table, Result>;

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "anchor-account",
    client_id: ALPHA,
    store_name: "Physical anchor",
    google_ads_customer_id: null,
    status: "active",
    currency: "EUR",
    shopify_url: "https://alpha.myshopify.com/admin",
    commission_rate: 10,
    list_commission_rate: 10,
    revenue_share_enabled: false,
    ...overrides,
  };
}

function term(overrides: Record<string, unknown> = {}) {
  return {
    id: "term-1",
    ad_account_id: "google-one",
    effective_from: "2026-08-10",
    revision: 1,
    supersedes_id: null,
    decision_id: "decision-1",
    list_rate: 10,
    reviewed_by: ADMIN,
    created_at: "2026-08-10T10:00:00.000Z",
    sealed_at: "2026-08-10T10:00:00.000Z",
    ...overrides,
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: "anchor-binding",
    clientId: ALPHA,
    adAccountId: "anchor-account",
    kind: "shopify",
    group: {
      id: "anchor-binding",
      shopifyAnchorBindingId: "anchor-binding",
      shopifyAnchorAdAccountId: "anchor-account",
    },
    shopify: {
      connectionId: "shopify-1",
      shopId: "gid://shopify/Shop/1",
      shopifyName: "Logical Alpha Store",
      domain: "alpha.myshopify.com",
      primaryDomain: "alpha.example",
      currency: "EUR",
      credential: null,
    },
    googleAds: null,
    ...overrides,
  };
}

describe("admin client commission catalogue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    results = {
      portal_clients: {
        data: [
          {
            id: BETA,
            full_name: "Beta",
            email: "beta@example.com",
            approval_status: "pending",
          },
          {
            id: ALPHA,
            full_name: "Alpha",
            email: "alpha@example.com",
            approval_status: "approved",
          },
          {
            id: ADMIN,
            full_name: "Staff",
            email: "staff@example.com",
            approval_status: "approved",
          },
        ],
        error: null,
      },
      profiles: { data: [{ id: ADMIN, role: "admin" }], error: null },
      ad_accounts: {
        data: [
          account(),
          account({
            id: "google-one",
            store_name: "Physical Google One",
            google_ads_customer_id: "1234567890",
            commission_rate: 9.5,
          }),
          account({
            id: "google-two",
            store_name: "Physical Google Two",
            google_ads_customer_id: "9876543210",
          }),
          account({
            id: "google-unallocated",
            store_name: "Physical Unallocated Google",
            google_ads_customer_id: "2222222222",
          }),
          account({
            id: "beta-store",
            client_id: BETA,
            store_name: "Beta Legacy Store",
            google_ads_customer_id: "1111111111",
          }),
          account({ id: "staff-store", client_id: ADMIN, store_name: "Internal" }),
        ],
        error: null,
      },
      ad_account_commission_terms: {
        data: [
          term(),
          term({
            id: "term-2",
            ad_account_id: "google-one",
            effective_from: "2099-08-17",
            revision: 1,
            supersedes_id: "term-1",
            decision_id: "decision-2",
            list_rate: 11,
          }),
          term({
            id: "term-3",
            ad_account_id: "google-one",
            effective_from: "2099-08-17",
            revision: 2,
            supersedes_id: "term-2",
            decision_id: "decision-3",
            list_rate: "12.5",
          }),
        ],
        error: null,
      },
    };
    mocks.requireAdmin.mockResolvedValue({ id: ADMIN, role: "admin" });
    mocks.clientReportingAuthority.mockImplementation(async (clientId: string) =>
      clientId === ALPHA ? "v2" : "legacy",
    );
    mocks.resolveReportingSources.mockResolvedValue([
      source(),
      source({
        bindingId: "google-binding-one",
        adAccountId: "google-one",
        kind: "google_ads",
        shopify: null,
        googleAds: {
          connectionId: "google-connection-one",
          windsorAccountId: "123-456-7890",
          accountId: "123-456-7890",
          customerId: "1234567890",
          accountName: "Google EU",
          currency: "EUR",
          timeZone: "Europe/Lisbon",
          dataSourceId: "source-one",
        },
      }),
      source({
        bindingId: "google-binding-two",
        adAccountId: "google-two",
        kind: "google_ads",
        shopify: null,
        googleAds: {
          connectionId: "google-connection-two",
          windsorAccountId: "987-654-3210",
          accountId: "987-654-3210",
          customerId: "9876543210",
          accountName: "Google US",
          currency: "EUR",
          timeZone: "Europe/Lisbon",
          dataSourceId: "source-two",
        },
      }),
      source({
        bindingId: "google-binding-unallocated",
        adAccountId: "google-unallocated",
        kind: "google_ads",
        group: {
          id: "google-binding-unallocated",
          shopifyAnchorBindingId: null,
          shopifyAnchorAdAccountId: null,
        },
        shopify: null,
        googleAds: {
          connectionId: "google-connection-unallocated",
          windsorAccountId: "222-222-2222",
          accountId: "222-222-2222",
          customerId: "2222222222",
          accountName: "Google Unallocated",
          currency: "EUR",
          timeZone: "Europe/Lisbon",
          dataSourceId: "source-unallocated",
        },
      }),
    ]);
    mocks.from.mockImplementation((table: Table) => ({
      select: (columns: string) => {
        mocks.select(table, columns);
        return Promise.resolve(results[table]);
      },
    }));
    mocks.createServiceClient.mockReturnValue({ from: mocks.from });
  });

  it("authenticates first and resolves V2 authority without Shopify credentials", async () => {
    await listAdminCommissionClients();

    expect(mocks.requireAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createServiceClient.mock.invocationCallOrder[0],
    );
    expect(mocks.select.mock.calls).toEqual([
      ["portal_clients", "id, full_name, email, approval_status"],
      ["profiles", "id, role"],
      [
        "ad_accounts",
        "id, client_id, store_name, google_ads_customer_id, status, currency, shopify_url, commission_rate, list_commission_rate, revenue_share_enabled",
      ],
      [
        "ad_account_commission_terms",
        "id, ad_account_id, effective_from, revision, supersedes_id, decision_id, list_rate, reviewed_by, created_at, sealed_at",
      ],
    ]);
    expect(mocks.clientReportingAuthority).toHaveBeenCalledWith(ALPHA);
    expect(mocks.clientReportingAuthority).toHaveBeenCalledWith(BETA);
    expect(mocks.resolveReportingSources).toHaveBeenCalledWith({
      service: expect.any(Object),
      clientIds: [ALPHA],
      includeShopifyCredentials: false,
    });
  });

  it("projects V2 anchors, grouped children and standalone Google billing separately", async () => {
    const catalogue = await listAdminCommissionClients();

    expect(catalogue.map((client) => client.name)).toEqual(["Alpha", "Beta"]);
    expect(catalogue[0].stores).toHaveLength(1);
    expect(catalogue[0].stores[0]).toMatchObject({
      id: "anchor-account",
      name: "Logical Alpha Store",
      domain: "alpha.example",
    });
    expect(catalogue[0].stores[0].billingAccounts.map((entry) => entry.name)).toEqual([
      "Google EU",
      "Google US",
    ]);
    expect(catalogue[0].stores[0].billingAccounts[0]).toMatchObject({
      id: "google-one",
      kind: "google_ads",
      googleAdsCustomerId: "1234567890",
      commissionRate: 9.5,
      listCommissionRate: 10,
      expectedTermId: "term-3",
      scheduledListCommissionRate: 12.5,
      scheduledEffectiveFrom: "2099-08-17",
    });
    expect(catalogue[0].stores[0].billingAccounts[1]).toMatchObject({
      id: "google-two",
      expectedTermId: null,
      listCommissionRate: 10,
      scheduledListCommissionRate: null,
    });
    expect(catalogue[0].unallocatedBillingAccounts).toEqual([
      expect.objectContaining({
        id: "google-unallocated",
        name: "Google Unallocated",
        googleAdsCustomerId: "2222222222",
        expectedTermId: null,
      }),
    ]);
    expect(catalogue[1].stores[0]).toMatchObject({
      id: "beta-store",
      name: "Beta Legacy Store",
    });
    expect(catalogue[1].stores[0].billingAccounts).toHaveLength(1);
    expect(catalogue[1].stores[0].billingAccounts[0].kind).toBe("legacy");
    expect(catalogue[1].unallocatedBillingAccounts).toEqual([]);
  });

  it("does not construct a service client after failed authorisation", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(Object.assign(new Error("Forbidden."), { status: 403 }));

    await expect(listAdminCommissionClients()).rejects.toMatchObject({ status: 403 });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("keeps an authorized Google-only V2 client editable without inventing a store", async () => {
    const standalone = source({
      bindingId: "google-only-binding",
      adAccountId: "google-unallocated",
      kind: "google_ads",
      group: {
        id: "google-only-binding",
        shopifyAnchorBindingId: null,
        shopifyAnchorAdAccountId: null,
      },
      shopify: null,
      googleAds: {
        connectionId: "google-only-connection",
        windsorAccountId: "222-222-2222",
        accountId: "222-222-2222",
        customerId: "2222222222",
        accountName: "Google Only",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
        dataSourceId: "source-only",
      },
    });
    results.ad_accounts.data = results.ad_accounts.data!.filter(
      (row) => row.client_id !== ALPHA || row.id === "google-unallocated",
    );
    mocks.resolveReportingSources.mockResolvedValueOnce([standalone]);

    const catalogue = await listAdminCommissionClients();
    const alpha = catalogue.find((client) => client.id === ALPHA)!;

    expect(alpha.stores).toEqual([]);
    expect(alpha.unallocatedBillingAccounts).toEqual([
      expect.objectContaining({ id: "google-unallocated", name: "Google Only" }),
    ]);
  });

  it("fails closed instead of hiding a billable V2 Google account without an active source", async () => {
    results.ad_accounts.data!.push(
      account({
        id: "google-without-active-source",
        store_name: "Unrepresented Google billing",
        google_ads_customer_id: "3333333333",
        status: "suspended",
      }),
    );

    await expect(listAdminCommissionClients()).rejects.toThrow(/inconsistent/i);
  });

  it("fails closed on unavailable authority, data, topology or term chains", async () => {
    mocks.clientReportingAuthority.mockResolvedValueOnce("unavailable");
    await expect(listAdminCommissionClients()).rejects.toThrow(/unavailable/i);

    results.ad_account_commission_terms.error = { message: "down" };
    await expect(listAdminCommissionClients()).rejects.toThrow(/unavailable/i);
    results.ad_account_commission_terms.error = null;

    mocks.resolveReportingSources.mockResolvedValueOnce([
      source({
        group: {
          id: "standalone",
          shopifyAnchorBindingId: null,
          shopifyAnchorAdAccountId: null,
        },
      }),
    ]);
    await expect(listAdminCommissionClients()).rejects.toThrow(/inconsistent/i);

    results.ad_account_commission_terms.data = [
      term({ id: "term-2", revision: 2, supersedes_id: "missing" }),
    ];
    await expect(listAdminCommissionClients()).rejects.toThrow(/inconsistent/i);
  });
});
