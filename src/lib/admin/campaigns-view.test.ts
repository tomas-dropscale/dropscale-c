import { describe, expect, it } from "vitest";

import {
  campaignActionBindingIds,
  dailyBudgetDraft,
  dailyBudgetWithinLimit,
  filterCampaignClients,
  normalizeDailyBudgetInput,
  projectAdminCampaignsView,
  projectCampaignClients,
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
    stores: [
      {
        id: "store-1",
        name: "Northwind Home",
        domain: "northwind-home.com",
        campaigns: [
          {
            bindingId: "binding-1",
            policyId: "policy-1",
            adAccountId: "account-1",
            providerCampaignId: "77",
            name: "DGEN · Summer",
            status: "active",
            spend: 100,
            dailyBudget: "50.000000",
            currency: "EUR",
            type: "DGEN",
            googleRoas: 2.4,
            actionable: true,
            allowedActions: ["budget_changed", "campaign_paused", "campaign_enabled"],
            maxDailyBudget: "100",
          },
        ],
      },
    ],
  },
  {
    id: "client-2",
    name: "Atlas Studio",
    email: "team@atlas.example",
    stores: [
      {
        id: "store-2",
        name: "Atlas Objects",
        domain: "atlas-objects.test",
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
    expect(dailyBudgetWithinLimit("75.00", "75")).toBe(true);
    expect(dailyBudgetWithinLimit("75.01", "75")).toBe(false);
    expect(dailyBudgetWithinLimit("1.00", null)).toBe(false);
  });

  it("projects live campaigns through the latest default-deny binding policy", () => {
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
          spend: 100,
          commission: 10,
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
              googleRoas: 0,
            },
          ],
        }],
      }],
    } as unknown as AdminCampaignsOverview;
    const state = {
      policies: new Map([[bindingId, {
        id: "00000000-0000-4000-8000-000000000099",
        client_reporting_binding_id: bindingId,
        executor: "agency_google",
        allowed_actions: ["budget_changed", "campaign_paused"],
        max_daily_budget_micros: "75000000",
      }]]),
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
    expect(projected.clients[0].stores[0]).toMatchObject({
      domain: "northwind-home.com",
      campaigns: [
        {
          bindingId,
          policyId: expect.any(String),
          dailyBudget: "50",
          allowedActions: ["budget_changed", "campaign_paused"],
          maxDailyBudget: "75",
          actionable: true,
        },
        {
          bindingId: "",
          policyId: null,
          allowedActions: [],
          maxDailyBudget: null,
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
  });
});
