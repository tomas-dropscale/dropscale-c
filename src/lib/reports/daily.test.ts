import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdAccount, Database } from "@/lib/supabase/types";
import type { DailyMetricRow } from "@/lib/metrics/queries";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  rates: vi.fn(), campaigns: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/metrics/recompute", () => ({
  refreshAccountsNow: mocks.refresh, RECOMPUTE_INTERVAL_MS: 0,
}));
vi.mock("@/lib/google-ads/crypto", () => ({ decryptToken: vi.fn(async () => "test-token") }));
vi.mock("@/lib/google-ads/env", () => ({ hasGoogleAdsEnv: () => true }));
vi.mock("@/lib/google-ads/portal", () => ({ fetchLiveCampaignsDetailed: mocks.campaigns }));
vi.mock("@/lib/admin/google-attribution", () => import("../admin/google-attribution"));
vi.mock("@/lib/reports/euro", () => import("./euro"));
vi.mock("@/lib/metrics/queries", () => import("../metrics/queries"));
vi.mock("@/lib/portal/range", () => import("../portal/range"));
vi.mock("@/lib/shopify/fx", async () => ({
  ...await import("../shopify/fx"), fxDailyRates: mocks.rates,
}));

import { buildDailyReport } from "./daily";

const DAY = "2026-09-21";
const account = (id: string, currency: string, extra: Partial<AdAccount> = {}) => ({
  id, client_id: "hugo", store_name: id, currency, commission_rate: 10,
  shopify_url: `${id}.myshopify.com`, google_ads_connected: false, ...extra,
}) as AdAccount;

function metric(id: string, extra: Partial<DailyMetricRow> = {}): DailyMetricRow {
  return {
    ad_account_id: id, day: DAY, ad_spend: 0, impressions: 0, clicks: 0,
    conversions: 0, conversion_value: 0, revenue: 0, orders_count: 0, units_sold: 0,
    attributed_orders: null, attributed_revenue: null, refunds_amount: 0,
    product_cost: 0, payment_fees: 0, shipping_cost: 0, revenue_share_base: 0,
    revenue_share_amount: 0, computed_at: `${DAY}T23:00:00Z`, ...extra,
  };
}

function service(accounts: AdAccount[], metrics: DailyMetricRow[]) {
  const tables: Record<string, unknown[]> = {
    portal_clients: [{ id: "hugo", full_name: "Hugo Marinho", email: "test@example.com" }],
    profiles: [], ad_accounts: accounts, daily_metrics: metrics,
  };
  return { from: (table: string) => {
    if (!(table in tables)) throw new Error(`Unexpected table: ${table}`);
    const query = {
      select: () => query, eq: () => query, in: () => query, order: () => query,
      then: (resolve: (data: unknown) => unknown) => Promise.resolve({ data: tables[table] }).then(resolve),
    };
    return query;
  } } as unknown as SupabaseClient<Database>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rates.mockResolvedValue([[DAY, 1 / 1.149]]);
  mocks.campaigns.mockResolvedValue([]);
});

describe("daily Discord report in euros", () => {
  it("reports Rosa D'ouro's two EUR orders as 84.90, while converting USD spend and costs", async () => {
    const original = metric("rosa", {
      revenue: 97.5501, revenue_store: 84.9, store_currency: "EUR", refunds_store: 0,
      attributed_revenue: 97.5501, attributed_revenue_store: 84.9, attributed_orders: 2,
      ad_spend: 65.82, orders_count: 2, units_sold: 2, impressions: 9500, clicks: 590,
      product_cost: 11.49, payment_fees: 2.298, shipping_cost: 3.447,
      revenue_share_amount: 1.149,
    });
    const before = structuredClone(original);
    const report = await buildDailyReport(service([account("rosa", "USD")], [original]), DAY, {
      includeCampaigns: false,
    });
    expect(report).toMatchObject({ moeda: "EUR", moedas_mistas: false, moedas: ["EUR"] });
    const client = report.clientes[0];
    expect(client.moeda).toBe("EUR");
    expect(client.lojas[0]).toMatchObject({
      moeda: "EUR", receita: 84.9, receita_bruta: 84.9, receita_google: 84.9,
      encomendas: 2, gasto: 57.28, custo_produtos: 10, taxas_pagamento: 2, envio: 3,
      revenue_share: 1, taxa_dropscale: 5.73, custos_totais: 72.28, lucro_liquido: 12.62,
      aov: 42.45, custo_por_encomenda: 28.64, roas: 1.48, mer: 1.48,
      cliques: 590, impressoes: 9500,
    });
    expect(client.totais.receita).toBe(84.9);
    expect(client.comissao_agencia).toBe(6.73);
    expect(original).toEqual(before);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.rates).toHaveBeenCalledTimes(1);
  });

  it("converts each store before summing mixed-currency client totals and deriving ratios", async () => {
    mocks.rates.mockResolvedValue([[DAY, 0.5]]);
    const report = await buildDailyReport(service(
      [account("eur", "EUR"), account("usd", "USD")],
      [metric("eur", { revenue: 40, ad_spend: 10, orders_count: 1 }),
        metric("usd", { revenue: 100, ad_spend: 20, orders_count: 2 })],
    ), DAY, { includeCampaigns: false });
    expect(report.clientes[0].totais).toMatchObject({ receita: 90, gasto: 20, roas: 4.5, aov: 30 });
    expect(report.moedas_mistas).toBe(false);
    expect(mocks.rates).toHaveBeenCalledTimes(1);
  });

  it("preserves EUR refunds and unknown attribution without requiring an FX service", async () => {
    mocks.rates.mockRejectedValue(new Error("FX down"));
    const report = await buildDailyReport(service([account("eur", "EUR")], [metric("eur", {
      revenue: 100, refunds_amount: 20, ad_spend: 40, orders_count: 2,
    })]), DAY, { includeCampaigns: false });
    expect(report.clientes[0].lojas[0]).toMatchObject({
      receita_bruta: 100, devolucoes: 20, receita: 80, roas: 2,
      receita_google: null, roas_google: null, conversoes: null,
    });
    expect(mocks.rates).not.toHaveBeenCalled();
  });

  it("uses original store-currency revenue, refunds and attribution even with a different reporting currency", async () => {
    mocks.rates.mockImplementation(async (base: string) => [[DAY, base === "GBP" ? 1.2 : 0.8]]);
    const report = await buildDailyReport(service([account("store", "USD")], [metric("store", {
      revenue: 999, refunds_amount: 999, attributed_revenue: 999, attributed_orders: 1,
      store_currency: "GBP", revenue_store: 100, refunds_store: 10, attributed_revenue_store: 80,
      ad_spend: 100,
    })]), DAY, { includeCampaigns: false });
    expect(report.clientes[0].lojas[0]).toMatchObject({
      receita_bruta: 120, devolucoes: 12, receita: 108, receita_google: 96, gasto: 80,
    });
  });

  it("converts live campaign spend too, with the source currency checked by the Google reader", async () => {
    mocks.rates.mockResolvedValue([[DAY, 0.8]]);
    mocks.campaigns.mockResolvedValue([{ id: "campaign", name: "PMax", status: "active",
      spend: 100, conversions: 3, startDate: DAY }]);
    const report = await buildDailyReport(service([account("usd", "USD", {
      google_ads_connected: true, google_ads_customer_id: "1234567890",
      google_ads_refresh_token: "encrypted-test-token",
    })], [metric("usd")]), DAY);
    expect(report.clientes[0].lojas[0].campanhas[0]).toMatchObject({ gasto: 80, conversoes: 3 });
    expect(mocks.campaigns).toHaveBeenCalledWith("1234567890", "test-token", "usd",
      { key: "custom", from: DAY, to: DAY }, "USD");
  });

  it("uses the last prior fixing on a weekend, never a later rate", async () => {
    mocks.rates.mockResolvedValue([["2026-09-18", 0.8], ["2026-09-21", 0.9]]);
    const report = await buildDailyReport(service([account("usd", "USD")],
      [metric("usd", { day: "2026-09-20", revenue: 100 })]), "2026-09-20", { includeCampaigns: false });
    expect(report.clientes[0].totais.receita).toBe(80);
    expect(mocks.rates).toHaveBeenCalledWith("USD", "EUR", "2026-09-06", "2026-09-20");
  });

  it.each([
    { rates: [] }, { rates: [["2026-09-22", 0.8]] },
    { rates: [[DAY, 0]] }, { rates: [[DAY, NaN]] },
  ])(
    "fails instead of labelling dollars as euros when no valid prior rate exists ($rates)", async ({ rates }) => {
      mocks.rates.mockResolvedValue(rates);
      await expect(buildDailyReport(service([account("usd", "USD")],
        [metric("usd", { revenue: 100 })]), DAY, { includeCampaigns: false })).rejects.toThrow("No valid");
    },
  );

  it("propagates an FX outage instead of returning the unconverted report", async () => {
    mocks.rates.mockRejectedValue(new Error("FX unavailable"));
    await expect(buildDailyReport(service([account("usd", "USD")], [metric("usd")]), DAY,
      { includeCampaigns: false })).rejects.toThrow("FX unavailable");
  });
});
