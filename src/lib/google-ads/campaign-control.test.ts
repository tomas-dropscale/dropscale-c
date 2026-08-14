import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./client", () => ({
  mutateGoogleAdsAsAgency: vi.fn(),
  searchGoogleAdsAsAgency: vi.fn(),
}));

import {
  readGoogleCampaignControlState,
  updateGoogleCampaignBudget,
  updateGoogleCampaignStatus,
} from "./campaign-control";

const CUSTOMER = "1234567890";
const CAMPAIGN = "987654321";

afterEach(() => {
  vi.restoreAllMocks();
});

function row({
  status = "ENABLED",
  budgetMicros = "50000000",
  explicitlyShared = false,
  referenceCount = "1",
  period = "DAILY",
}: {
  status?: string;
  budgetMicros?: string;
  explicitlyShared?: boolean;
  referenceCount?: string;
  period?: string;
} = {}) {
  return {
    customer: { id: CUSTOMER, currencyCode: "EUR", timeZone: "Europe/Lisbon" },
    campaign: {
      id: CAMPAIGN,
      resourceName: `customers/${CUSTOMER}/campaigns/${CAMPAIGN}`,
      name: "DGEN · Summer scale",
      status,
      campaignBudget: `customers/${CUSTOMER}/campaignBudgets/4444`,
    },
    campaignBudget: {
      id: "4444",
      resourceName: `customers/${CUSTOMER}/campaignBudgets/4444`,
      amountMicros: budgetMicros,
      explicitlyShared,
      referenceCount,
      period,
      totalAmountMicros: null,
    },
  };
}

describe("Google campaign control", () => {
  it("reads one exact campaign and keeps micros exact", async () => {
    const search = vi.fn().mockResolvedValue([row()]);
    const state = await readGoogleCampaignControlState(CUSTOMER, CAMPAIGN, { search });

    expect(state).toMatchObject({
      customerId: CUSTOMER,
      campaignId: CAMPAIGN,
      campaignName: "DGEN · Summer scale",
      status: "active",
      currency: "EUR",
      dailyBudget: 50,
      budgetMicros: 50_000_000,
      sharedBudget: false,
      budgetPeriod: "DAILY",
      timeZone: "Europe/Lisbon",
    });
    expect(search).toHaveBeenCalledWith(
      CUSTOMER,
      expect.stringContaining(`WHERE campaign.id = ${CAMPAIGN}`),
    );
  });

  it("validates, mutates and freshly verifies an isolated daily budget", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([row({ budgetMicros: "75000000" })]);
    const mutate = vi.fn()
      .mockResolvedValueOnce({ requestId: null, results: [] })
      .mockResolvedValueOnce({
        requestId: "provider-request",
        results: [{
          campaignBudget: {
            resourceName: `customers/${CUSTOMER}/campaignBudgets/4444`,
            amountMicros: "75000000",
          },
        }],
      });

    const receipt = await updateGoogleCampaignBudget(
      {
        customerId: CUSTOMER,
        campaignId: CAMPAIGN,
        expectedBudgetMicros: 50_000_000,
        nextBudgetMicros: 75_000_000,
        maxBudgetMicros: 100_000_000,
        expectedCurrency: "EUR",
        expectedTimeZone: "Europe/Lisbon",
      },
      { search, mutate },
    );

    expect(receipt.before.dailyBudget).toBe(50);
    expect(receipt.after.dailyBudget).toBe(75);
    expect(receipt.requestId).toBe("provider-request");
    expect(mutate).toHaveBeenNthCalledWith(
      1,
      CUSTOMER,
      "campaignBudgets",
      [{
        update: {
          resourceName: `customers/${CUSTOMER}/campaignBudgets/4444`,
          amountMicros: "75000000",
        },
        updateMask: "amount_micros",
      }],
      { validateOnly: true },
    );
    expect(mutate).toHaveBeenNthCalledWith(
      2,
      CUSTOMER,
      "campaignBudgets",
      expect.any(Array),
      { validateOnly: false },
    );
  });

  it("rejects shared budgets before calling the mutate endpoint", async () => {
    const search = vi.fn().mockResolvedValue([
      row({ explicitlyShared: true, referenceCount: "2" }),
    ]);
    const mutate = vi.fn();

    await expect(
      updateGoogleCampaignBudget(
        {
          customerId: CUSTOMER,
          campaignId: CAMPAIGN,
          expectedBudgetMicros: 50_000_000,
          nextBudgetMicros: 75_000_000,
          maxBudgetMicros: 100_000_000,
          expectedCurrency: "EUR",
          expectedTimeZone: "Europe/Lisbon",
        },
        { search, mutate },
      ),
    ).rejects.toMatchObject({ code: "shared_budget" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("fails closed when Google omits shared-budget evidence", async () => {
    const missingReference = row();
    delete (missingReference.campaignBudget as Partial<typeof missingReference.campaignBudget>)
      .referenceCount;
    await expect(
      readGoogleCampaignControlState(CUSTOMER, CAMPAIGN, {
        search: vi.fn().mockResolvedValue([missingReference]),
      }),
    ).rejects.toMatchObject({ code: "provider_mismatch" });
  });

  it("rejects a custom-period budget and a reporting-identity mismatch", async () => {
    const customSearch = vi.fn().mockResolvedValue([row({ period: "CUSTOM_PERIOD" })]);
    const mutate = vi.fn();
    await expect(
      updateGoogleCampaignBudget(
        {
          customerId: CUSTOMER,
          campaignId: CAMPAIGN,
          expectedBudgetMicros: 50_000_000,
          nextBudgetMicros: 75_000_000,
          maxBudgetMicros: 100_000_000,
          expectedCurrency: "EUR",
          expectedTimeZone: "Europe/Lisbon",
        },
        { search: customSearch, mutate },
      ),
    ).rejects.toMatchObject({ code: "campaign_unavailable" });

    const identitySearch = vi.fn().mockResolvedValue([row()]);
    await expect(
      updateGoogleCampaignBudget(
        {
          customerId: CUSTOMER,
          campaignId: CAMPAIGN,
          expectedBudgetMicros: 50_000_000,
          nextBudgetMicros: 75_000_000,
          maxBudgetMicros: 100_000_000,
          expectedCurrency: "EUR",
          expectedTimeZone: "America/New_York",
        },
        { search: identitySearch, mutate },
      ),
    ).rejects.toMatchObject({ code: "provider_mismatch" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("validates, mutates and verifies a pause", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([row({ status: "PAUSED" })]);
    const mutate = vi.fn()
      .mockResolvedValueOnce({ requestId: null, results: [] })
      .mockResolvedValueOnce({
        requestId: "pause-request",
        results: [{
          campaign: {
            resourceName: `customers/${CUSTOMER}/campaigns/${CAMPAIGN}`,
            status: "PAUSED",
          },
        }],
      });

    const receipt = await updateGoogleCampaignStatus(
      {
        customerId: CUSTOMER,
        campaignId: CAMPAIGN,
        expectedStatus: "active",
        nextStatus: "paused",
        expectedCurrency: "EUR",
        expectedTimeZone: "Europe/Lisbon",
      },
      { search, mutate },
    );

    expect(receipt.after.status).toBe("paused");
    expect(mutate).toHaveBeenNthCalledWith(
      1,
      CUSTOMER,
      "campaigns",
      [{
        update: {
          resourceName: `customers/${CUSTOMER}/campaigns/${CAMPAIGN}`,
          status: "PAUSED",
        },
        updateMask: "status",
      }],
      { validateOnly: true },
    );
  });

  it("marks an unverified post-mutation state indeterminate", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([row()]);
    const mutate = vi.fn()
      .mockResolvedValueOnce({ requestId: null, results: [] })
      .mockResolvedValueOnce({
        requestId: "pause-request",
        results: [{
          campaign: {
            resourceName: `customers/${CUSTOMER}/campaigns/${CAMPAIGN}`,
            status: "PAUSED",
          },
        }],
      });

    await expect(
      updateGoogleCampaignStatus(
        {
          customerId: CUSTOMER,
          campaignId: CAMPAIGN,
          expectedStatus: "active",
          nextStatus: "paused",
          expectedCurrency: "EUR",
          expectedTimeZone: "Europe/Lisbon",
        },
        { search, mutate },
      ),
    ).rejects.toMatchObject({ code: "provider_mismatch", indeterminate: true });
  });

  it("rechecks daily and isolated budget evidence after the mutate", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([
        row({ budgetMicros: "75000000", explicitlyShared: true, referenceCount: "2" }),
      ]);
    const mutate = vi.fn()
      .mockResolvedValueOnce({ requestId: null, results: [] })
      .mockResolvedValueOnce({
        requestId: "provider-request",
        results: [{
          campaignBudget: {
            resourceName: `customers/${CUSTOMER}/campaignBudgets/4444`,
            amountMicros: "75000000",
          },
        }],
      });

    await expect(
      updateGoogleCampaignBudget(
        {
          customerId: CUSTOMER,
          campaignId: CAMPAIGN,
          expectedBudgetMicros: 50_000_000,
          nextBudgetMicros: 75_000_000,
          maxBudgetMicros: 100_000_000,
          expectedCurrency: "EUR",
          expectedTimeZone: "Europe/Lisbon",
        },
        { search, mutate },
      ),
    ).rejects.toMatchObject({ code: "provider_mismatch", indeterminate: true });
  });

  it("never starts the actual mutation after the bounded execution deadline", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const search = vi.fn().mockResolvedValue([row()]);
    const mutate = vi.fn().mockImplementationOnce(async () => {
      now += 2 * 60 * 1_000 + 1;
      return { requestId: null, results: [] };
    });

    await expect(
      updateGoogleCampaignBudget(
        {
          customerId: CUSTOMER,
          campaignId: CAMPAIGN,
          expectedBudgetMicros: 50_000_000,
          nextBudgetMicros: 75_000_000,
          maxBudgetMicros: 100_000_000,
          expectedCurrency: "EUR",
          expectedTimeZone: "Europe/Lisbon",
        },
        { search, mutate },
      ),
    ).rejects.toMatchObject({ code: "execution_expired", indeterminate: false });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      CUSTOMER,
      "campaignBudgets",
      expect.any(Array),
      { validateOnly: true },
    );
    clock.mockRestore();
  });

  it("fails closed when the provider returns another campaign identity", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        ...row(),
        campaign: { ...row().campaign, id: "111" },
      },
    ]);

    await expect(
      readGoogleCampaignControlState(CUSTOMER, CAMPAIGN, { search }),
    ).rejects.toMatchObject({
      code: "provider_mismatch",
    });
  });
});
