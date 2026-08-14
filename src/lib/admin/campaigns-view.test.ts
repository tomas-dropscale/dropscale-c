import { describe, expect, it } from "vitest";

import {
  campaignActionBindingIds,
  dailyBudgetDraft,
  dailyBudgetWithinLimit,
  filterCampaignClients,
  normalizeDailyBudgetInput,
  projectAdminCampaignsView,
  projectCampaignClients,
  storeRealRoas,
  type CampaignActionHistory,
  type CampaignViewClient,
} from "./campaigns-view";
import type { CampaignActionViewState } from "./campaign-actions";
import type { AdminCampaignsOverview } from "./campaigns";

const clients: CampaignViewClient[] = [
  {
    id: "client-1",
    name: "Northwind Commerce",
    email: "performance@northwind.example",
    currency: "EUR",
    revenue: 240,
    adSpend: 100,
    realRoas: 2.4,
    stores: [
      {
        id: "store-1",
        name: "Northwind Home",
        domain: "northwind-home.com",
        currency: "EUR",
        realRoas: 2.4,
        rollupSpend: 100,
        rollupComplete: true,
        campaignState: "ready",
        campaigns: [
          {
            bindingId: "binding-1",
            adAccountId: "account-1",
            providerCampaignId: "77",
            name: "DGEN · Summer",
            status: "active",
            spend: 100,
            dailyBudget: "50.000000",
            currency: "EUR",
            type: "DGEN",
            shoppingFeed: false,
            googleRoas: 2.4,
            actionable: true,
          },
        ],
      },
    ],
  },
  {
    id: "client-2",
    name: "Atlas Studio",
    email: "team@atlas.example",
    currency: "EUR",
    revenue: null,
    adSpend: 0,
    realRoas: null,
    stores: [
      {
        id: "store-2",
        name: "Atlas Objects",
        domain: "atlas-objects.test",
        currency: "EUR",
        realRoas: null,
        rollupSpend: 0,
        rollupComplete: true,
        campaignState: "empty",
        campaigns: [],
      },
    ],
  },
];

describe("Campaigns view model", () => {
  it.each(["northwind", "PERFORMANCE@", "Northwind Home", "HOME.COM", " atlas "])(
    "filters clients by client, email, store or domain: %s",
    (query) => {
      const result = filterCampaignClients(clients, query);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(query.trim().toLowerCase() === "atlas" ? "client-2" : "client-1");
    },
  );

  it("projects scales by exact account and provider campaign identity", () => {
    const history: CampaignActionHistory[] = [
      {
        id: "newer",
        adAccountId: "account-1",
        providerCampaignId: "77",
        campaignName: "DGEN · Summer",
        action: "budget_changed",
        outcome: "succeeded",
        previousDailyBudget: 60,
        nextDailyBudget: 75,
        currency: "EUR",
        occurredAt: "2026-08-14T10:00:00.000Z",
        actorName: "Bruno Oliveira",
      },
      {
        id: "other-account",
        adAccountId: "account-2",
        providerCampaignId: "77",
        campaignName: "Same provider id, different account",
        action: "budget_changed",
        outcome: "succeeded",
        previousDailyBudget: 10,
        nextDailyBudget: 20,
        currency: "EUR",
        occurredAt: "2026-08-15T10:00:00.000Z",
        actorName: "Bruno Oliveira",
      },
      {
        id: "older",
        adAccountId: "account-1",
        providerCampaignId: "77",
        campaignName: "DGEN · Summer",
        action: "budget_changed",
        outcome: "succeeded",
        previousDailyBudget: 50,
        nextDailyBudget: 60,
        currency: "EUR",
        occurredAt: "2026-08-13T10:00:00.000Z",
        actorName: "Ana Costa",
      },
    ];

    const campaign = projectCampaignClients(clients, history)[0].stores[0].campaigns[0];
    expect(campaign.scaleHistory.map((entry) => entry.id)).toEqual(["newer", "older"]);
    expect(campaign.lastScaledAt).toBe("2026-08-14T10:00:00.000Z");
  });

  it("does not call a budget reduction or a status change a scale", () => {
    const history: CampaignActionHistory[] = [
      {
        id: "reduction",
        adAccountId: "account-1",
        providerCampaignId: "77",
        campaignName: "DGEN · Summer",
        action: "budget_changed",
        outcome: "succeeded",
        previousDailyBudget: 75,
        nextDailyBudget: 50,
        currency: "EUR",
        occurredAt: "2026-08-14T11:00:00.000Z",
        actorName: "Bruno Oliveira",
      },
      {
        id: "pause",
        adAccountId: "account-1",
        providerCampaignId: "77",
        campaignName: "DGEN · Summer",
        action: "campaign_paused",
        outcome: "succeeded",
        previousDailyBudget: null,
        nextDailyBudget: null,
        currency: "EUR",
        occurredAt: "2026-08-14T12:00:00.000Z",
        actorName: "Bruno Oliveira",
      },
    ];

    const campaign = projectCampaignClients(clients, history)[0].stores[0].campaigns[0];
    expect(campaign.scaleHistory).toEqual([]);
    expect(campaign.lastScaledAt).toBeNull();
  });

  it("keeps editable budgets as exact micros-backed decimal strings", () => {
    expect(normalizeDailyBudgetInput("0012,5")).toBe("12.5");
    expect(normalizeDailyBudgetInput("0")).toBeNull();
    expect(normalizeDailyBudgetInput("12.3456789")).toBeNull();
    expect(dailyBudgetDraft("49.999999")).toBe("49.999999");
    expect(dailyBudgetWithinLimit("0.999999")).toBe(false);
    expect(dailyBudgetWithinLimit("1")).toBe(true);
    expect(dailyBudgetWithinLimit("1000000")).toBe(true);
    expect(dailyBudgetWithinLimit("1000000.000001")).toBe(false);
  });

  it("only computes store Real ROAS from available Shopify rollup revenue and spend", () => {
    expect(storeRealRoas(200, 80)).toBe(2.5);
    expect(storeRealRoas(null, 80)).toBeNull();
    expect(storeRealRoas(200, 0)).toBeNull();
  });

  it("makes exact reporting-bound campaigns actionable without product policy setup", () => {
    const bindingId = "00000000-0000-4000-8000-000000000001";
    const overview = {
      configured: true,
      internal: [],
      totals: {
        spend: 100,
        commission: 10,
        activeCampaigns: 2,
        connectedAccounts: 1,
        revenue: 200,
        profit: 50,
        roas: 2,
        rollupSpend: 100,
      },
      clients: [{
        clientId: "client-1",
        clientName: "Northwind Commerce",
        clientEmail: "performance@northwind.example",
        inHst: true,
        spend: 100,
        commission: 10,
        revenue: 200,
        rollupSpend: 80,
        realRoas: 2.5,
        currency: "EUR",
        currencies: ["EUR"],
        rollupComplete: true,
        accounts: [{
          account: {
            id: "store-1",
            store_name: "Northwind Home",
            shopify_url: "https://Northwind-Home.com/products/example",
            currency: "EUR",
          },
          connected: true,
          failed: false,
          authRevoked: false,
          campaignState: "ready",
          spend: 100,
          commission: 10,
          rollupRevenue: 200,
          rollupSpend: 80,
          rollupComplete: true,
          rollupRequired: true,
          campaigns: [
            {
              id: "campaign-live",
              reportingBindingId: bindingId,
              googleAdsConnectionId: "connection-1",
              ad_account_id: "account-1",
              providerCampaignId: "77",
              name: "DGEN · Summer",
              status: "active",
              spend: 100,
              daily_budget: 50,
              advertisingChannelType: "DEMAND_GEN",
              shoppingFeed: true,
              googleRoas: 2.4,
            },
            {
              id: "campaign-legacy",
              reportingBindingId: null,
              googleAdsConnectionId: null,
              ad_account_id: "legacy-account",
              providerCampaignId: "88",
              name: "Legacy",
              status: "active",
              spend: 0,
              daily_budget: 10,
              advertisingChannelType: "SEARCH",
              shoppingFeed: false,
              googleRoas: 0,
            },
          ],
        }],
      }],
    } as unknown as AdminCampaignsOverview;
    const state = {
      history: [{
        id: "operation-1",
        status: "succeeded",
        requested_by: "admin-1",
        ad_account_id: "account-1",
        provider_campaign_id: "77",
        campaign_name: "DGEN · Summer",
        action: "budget_changed",
        previous_daily_budget_micros: "50000000",
        next_daily_budget_micros: "60000000",
        currency: "EUR",
        completed_at: "2026-08-14T10:00:00.000Z",
      }],
      actorNames: new Map([["admin-1", "Ana Costa"]]),
    } as unknown as CampaignActionViewState;

    expect(campaignActionBindingIds(overview)).toEqual([bindingId]);
    const projected = projectAdminCampaignsView(overview, state);
    expect(projected.clients[0]).toMatchObject({
      currency: "EUR",
      revenue: 200,
      adSpend: 80,
      realRoas: 2.5,
    });
    expect(projected.clients[0].stores[0]).toMatchObject({
      domain: "northwind-home.com",
      currency: "EUR",
      realRoas: 2.5,
      campaigns: [
        {
          bindingId,
          dailyBudget: "50",
          shoppingFeed: true,
          actionable: true,
        },
        {
          bindingId: "",
          actionable: false,
        },
      ],
    });
    expect(projected.history).toEqual([
      expect.objectContaining({
        id: "operation-1",
        adAccountId: "account-1",
        providerCampaignId: "77",
        previousDailyBudget: 50,
        nextDailyBudget: 60,
        actorName: "Ana Costa",
      }),
    ]);

    overview.clients[0].rollupSpend = 0;
    overview.clients[0].realRoas = null;
    expect(
      projectAdminCampaignsView(overview as unknown as AdminCampaignsOverview, state).clients[0]
        .realRoas,
    ).toBeNull();
  });
});
