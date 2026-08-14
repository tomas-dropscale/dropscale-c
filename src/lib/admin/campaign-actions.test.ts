import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createServiceClient: vi.fn(),
  rpc: vi.fn(),
  resolveReportingSources: vi.fn(),
  readGoogleCampaignControlState: vi.fn(),
  updateGoogleCampaignBudget: vi.fn(),
  updateGoogleCampaignStatus: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-onboarding/http", () => ({
  isExactRecord: (
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
  ) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return (
      required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key))
    );
  },
  readSmallJson: (request: Request) => request.json(),
}));
vi.mock("@/lib/client-onboarding/sessions", () => {
  class ClientOnboardingError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return { ClientOnboardingError, requireClientOnboardingAdmin: mocks.requireAdmin };
});
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/reporting/sources", () => ({
  resolveReportingSources: mocks.resolveReportingSources,
}));
vi.mock("@/lib/google-ads/campaign-control", () => ({
  GoogleCampaignControlError: class extends Error {},
  readGoogleCampaignControlState: mocks.readGoogleCampaignControlState,
  updateGoogleCampaignBudget: mocks.updateGoogleCampaignBudget,
  updateGoogleCampaignStatus: mocks.updateGoogleCampaignStatus,
}));
vi.mock("@/lib/google-ads/client", () => ({
  GoogleAdsMutationError: class extends Error {},
  GoogleAdsQueryError: class extends Error {},
}));

import {
  campaignCurrencyUnitsToMicros,
  campaignMicrosToCurrencyUnits,
  executeCampaignActionRequest,
  listCampaignActionActivity,
  projectCampaignActionHistory,
} from "./campaign-actions";
import type { CampaignActionOperation } from "@/lib/supabase/types";

function actionRequest(body: unknown, origin = "https://dropscale.app") {
  const request = new Request("https://dropscale.app/api/admin/campaign-actions", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "nextUrl", {
    value: new URL(request.url),
  });
  return request as never;
}

const validActionBody = {
  requestId: "33333333-3333-4333-8333-333333333333",
  bindingId: "22222222-2222-4222-8222-222222222222",
  providerCampaignId: "123456789",
  action: "pause",
  expectedStatus: "active",
};

const internalPolicy = {
  id: "77777777-7777-4777-8777-777777777777",
  client_reporting_binding_id: validActionBody.bindingId,
  allowed_actions: ["budget_changed", "campaign_enabled", "campaign_paused"],
  max_daily_budget_micros: 1_000_000_000_000,
  revision: 1,
};

function setupStatusActionAuthority(
  policyResponses: Array<typeof internalPolicy | null> = [internalPolicy],
) {
  const responses = [
    { data: null, error: null },
    { data: null, error: null },
    {
      data: {
        id: validActionBody.bindingId,
        client_id: "55555555-5555-4555-8555-555555555555",
        ad_account_id: "44444444-4444-4444-8444-444444444444",
        google_ads_connection_id: "66666666-6666-4666-8666-666666666666",
        status: "active",
      },
      error: null,
    },
    ...policyResponses.map((policy) => ({ data: policy, error: null })),
  ];
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ["select", "eq", "order", "limit"]) {
    builder[name] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => responses.shift());
  mocks.createServiceClient.mockReturnValue({
    from: vi.fn(() => builder),
    rpc: mocks.rpc,
  });
  mocks.requireAdmin.mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  mocks.resolveReportingSources.mockResolvedValue([
    {
      bindingId: validActionBody.bindingId,
      clientId: "55555555-5555-4555-8555-555555555555",
      adAccountId: "44444444-4444-4444-8444-444444444444",
      googleAds: {
        connectionId: "66666666-6666-4666-8666-666666666666",
        customerId: "1234567890",
        currency: "EUR",
        timeZone: "Europe/Lisbon",
      },
    },
  ]);
  const state = {
    campaignName: "Summer Scale",
    status: "active",
    currency: "EUR",
    timeZone: "Europe/Lisbon",
    budgetMicros: 25_000_000,
  };
  mocks.readGoogleCampaignControlState.mockResolvedValue(state);
  mocks.updateGoogleCampaignStatus.mockResolvedValue({
    before: state,
    after: { ...state, status: "paused" },
    requestId: "google-request-1",
  });
}

describe("campaign action request boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it("authenticates before reading action input or constructing service_role", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("unauthorised"));
    const request = actionRequest(validActionBody);
    const reader = vi.spyOn(request, "json");

    await expect(executeCampaignActionRequest(request)).rejects.toThrow("unauthorised");
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("rejects cross-origin action input before reading it", async () => {
    mocks.requireAdmin.mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const request = actionRequest(validActionBody, "https://evil.example");
    const reader = vi.spyOn(request, "json");

    await expect(executeCampaignActionRequest(request)).rejects.toMatchObject({ status: 403 });
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("reads an old requested target once and seals an unreadable result as uncertain", async () => {
    const stale = {
      id: validActionBody.requestId,
      idempotency_key: `campaign-action:${validActionBody.requestId}`,
      execution_claim_id: "99999999-9999-4999-8999-999999999999",
      client_reporting_binding_id: validActionBody.bindingId,
      provider_campaign_id: validActionBody.providerCampaignId,
      google_ads_customer_id: "1234567890",
      google_time_zone: "Europe/Lisbon",
      currency: "EUR",
      requested_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      action: "campaign_paused",
      previous_status: "active",
      next_status: "paused",
      previous_daily_budget_micros: null,
      next_daily_budget_micros: null,
      status: "requested",
      requested_at: "2000-01-01T00:00:00.000Z",
    } as CampaignActionOperation;
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ["select", "eq"]) builder[name] = vi.fn(() => builder);
    builder.maybeSingle = vi.fn().mockResolvedValue({ data: stale, error: null });
    mocks.requireAdmin.mockResolvedValue({ id: stale.requested_by });
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn(() => builder),
      rpc: mocks.rpc,
    });
    mocks.rpc.mockResolvedValue({ data: { status: "uncertain" }, error: null });
    mocks.readGoogleCampaignControlState.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      executeCampaignActionRequest(actionRequest(validActionBody)),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_campaign_action",
      expect.objectContaining({
        p_execution_claim_id: stale.execution_claim_id,
        p_outcome: "uncertain",
      }),
    );
    expect(mocks.readGoogleCampaignControlState).toHaveBeenCalledWith(
      stale.google_ads_customer_id,
      stale.provider_campaign_id,
    );
    expect(mocks.updateGoogleCampaignStatus).not.toHaveBeenCalled();
  });

  it("recovers a stale request as succeeded when the exact target is already verified", async () => {
    const stale = {
      id: validActionBody.requestId,
      idempotency_key: `campaign-action:${validActionBody.requestId}`,
      execution_claim_id: "99999999-9999-4999-8999-999999999999",
      client_reporting_binding_id: validActionBody.bindingId,
      provider_campaign_id: validActionBody.providerCampaignId,
      google_ads_customer_id: "1234567890",
      google_time_zone: "Europe/Lisbon",
      currency: "EUR",
      requested_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      action: "campaign_paused",
      previous_status: "active",
      next_status: "paused",
      previous_daily_budget_micros: null,
      next_daily_budget_micros: null,
      status: "requested",
      requested_at: "2000-01-01T00:00:00.000Z",
    } as CampaignActionOperation;
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ["select", "eq"]) builder[name] = vi.fn(() => builder);
    builder.maybeSingle = vi.fn().mockResolvedValue({ data: stale, error: null });
    mocks.requireAdmin.mockResolvedValue({ id: stale.requested_by });
    mocks.createServiceClient.mockReturnValue({ from: vi.fn(() => builder), rpc: mocks.rpc });
    mocks.readGoogleCampaignControlState.mockResolvedValueOnce({
      status: "paused",
      currency: "EUR",
      timeZone: "Europe/Lisbon",
      budgetMicros: 25_000_000,
      budgetPeriod: "DAILY",
      sharedBudget: false,
    });
    mocks.rpc.mockResolvedValueOnce({ data: { status: "succeeded" }, error: null });

    await expect(
      executeCampaignActionRequest(actionRequest(validActionBody)),
    ).resolves.toEqual({ status: "succeeded" });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_campaign_action",
      expect.objectContaining({
        p_execution_claim_id: stale.execution_claim_id,
        p_outcome: "succeeded",
        p_observed_status: "paused",
      }),
    );
    expect(mocks.updateGoogleCampaignStatus).not.toHaveBeenCalled();
  });

  it("records the request before one provider mutation and seals verified evidence", async () => {
    setupStatusActionAuthority();
    mocks.rpc
      .mockImplementationOnce((_: string, args: { p_execution_claim_id: string }) =>
        Promise.resolve({
          data: {
            status: "requested",
            execution_claim_id: args.p_execution_claim_id,
          },
          error: null,
        }),
      )
      .mockResolvedValueOnce({ data: { status: "succeeded" }, error: null });

    await expect(
      executeCampaignActionRequest(actionRequest(validActionBody)),
    ).resolves.toEqual({ status: "succeeded" });

    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "start_campaign_action",
      expect.objectContaining({
        p_operation_id: validActionBody.requestId,
        p_client_reporting_binding_id: validActionBody.bindingId,
        p_provider_campaign_id: validActionBody.providerCampaignId,
        p_action: "campaign_paused",
        p_previous_status: "active",
        p_next_status: "paused",
      }),
    );
    expect(mocks.updateGoogleCampaignStatus).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_campaign_action",
      expect.objectContaining({
        p_outcome: "succeeded",
        p_observed_status: "paused",
      }),
    );
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateGoogleCampaignStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.updateGoogleCampaignStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rpc.mock.invocationCallOrder[1],
    );
  });

  it("creates the invisible internal controls on the first verified action", async () => {
    setupStatusActionAuthority([null]);
    mocks.rpc
      .mockResolvedValueOnce({ data: internalPolicy, error: null })
      .mockImplementationOnce((_: string, args: { p_execution_claim_id: string }) =>
        Promise.resolve({
          data: { status: "requested", execution_claim_id: args.p_execution_claim_id },
          error: null,
        }),
      )
      .mockResolvedValueOnce({ data: { status: "succeeded" }, error: null });

    await expect(
      executeCampaignActionRequest(actionRequest(validActionBody)),
    ).resolves.toEqual({ status: "succeeded" });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "set_campaign_action_policy", {
      p_policy_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      p_idempotency_key: `campaign-controls:${validActionBody.bindingId}`,
      p_client_reporting_binding_id: validActionBody.bindingId,
      p_expected_policy_id: null,
      p_allowed_actions: ["budget_changed", "campaign_enabled", "campaign_paused"],
      p_max_daily_budget_micros: 1_000_000_000_000,
      p_admin_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      p_reason: "Internal admin campaign controls.",
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "start_campaign_action",
      expect.objectContaining({ p_action: "campaign_paused" }),
    );
    expect(mocks.updateGoogleCampaignStatus).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.updateGoogleCampaignStatus.mock.invocationCallOrder[0],
    );
  });

  it("accepts the exact winning controls row after a concurrent first action", async () => {
    setupStatusActionAuthority([null, internalPolicy]);
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "40001" } })
      .mockImplementationOnce((_: string, args: { p_execution_claim_id: string }) =>
        Promise.resolve({
          data: { status: "requested", execution_claim_id: args.p_execution_claim_id },
          error: null,
        }),
      )
      .mockResolvedValueOnce({ data: { status: "succeeded" }, error: null });

    await expect(
      executeCampaignActionRequest(actionRequest(validActionBody)),
    ).resolves.toEqual({ status: "succeeded" });

    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(mocks.updateGoogleCampaignStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing restrictive internal row fail-closed", async () => {
    setupStatusActionAuthority([{
      ...internalPolicy,
      allowed_actions: ["budget_changed"],
    }]);

    await expect(
      executeCampaignActionRequest(actionRequest(validActionBody)),
    ).rejects.toMatchObject({ status: 403 });

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updateGoogleCampaignStatus).not.toHaveBeenCalled();
    expect(mocks.updateGoogleCampaignBudget).not.toHaveBeenCalled();
  });

  it("retries an idempotent completion without repeating the Google mutation", async () => {
    setupStatusActionAuthority();
    mocks.rpc
      .mockImplementationOnce((_: string, args: { p_execution_claim_id: string }) =>
        Promise.resolve({
          data: { status: "requested", execution_claim_id: args.p_execution_claim_id },
          error: null,
        }),
      )
      .mockResolvedValueOnce({ data: null, error: { code: "XX000" } })
      .mockResolvedValueOnce({ data: { status: "succeeded" }, error: null });

    await expect(
      executeCampaignActionRequest(actionRequest(validActionBody)),
    ).resolves.toEqual({ status: "succeeded" });

    expect(mocks.updateGoogleCampaignStatus).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("never touches Google when the atomic start belongs to another claim", async () => {
    setupStatusActionAuthority();
    mocks.rpc.mockResolvedValueOnce({
      data: {
        status: "requested",
        execution_claim_id: "99999999-9999-4999-8999-999999999999",
      },
      error: null,
    });

    await expect(
      executeCampaignActionRequest(actionRequest(validActionBody)),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.updateGoogleCampaignStatus).not.toHaveBeenCalled();
    expect(mocks.updateGoogleCampaignBudget).not.toHaveBeenCalled();
  });
});

describe("campaign budget fixed-point conversion", () => {
  it("round-trips exact integer micros without floats", () => {
    expect(campaignCurrencyUnitsToMicros("1250.125001")).toBe(1_250_125_001);
    expect(campaignMicrosToCurrencyUnits("1250125001")).toBe("1250.125001");
    expect(campaignMicrosToCurrencyUnits(1_000_000)).toBe("1");
    expect(campaignMicrosToCurrencyUnits("1.5")).toBeNull();
  });
});

describe("campaign action history projection", () => {
  it("uses exact provider evidence and actor names", () => {
    const operation = {
      id: "33333333-3333-4333-8333-333333333333",
      client_id: "55555555-5555-4555-8555-555555555555",
      ad_account_id: "44444444-4444-4444-8444-444444444444",
      provider_campaign_id: "123456789",
      campaign_name: "Scale campaign",
      action: "budget_changed",
      status: "succeeded",
      previous_daily_budget_micros: "25000000",
      next_daily_budget_micros: "30000000",
      currency: "EUR",
      completed_at: "2026-08-14T09:00:00+00:00",
      requested_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } as CampaignActionOperation;

    expect(
      projectCampaignActionHistory(
        [operation],
        new Map([[operation.requested_by, "Agency Operator"]]),
      ),
    ).toEqual([
      {
        id: operation.id,
        adAccountId: operation.ad_account_id,
        providerCampaignId: "123456789",
        campaignName: "Scale campaign",
        action: "budget_changed",
        outcome: "succeeded",
        previousDailyBudget: 25,
        nextDailyBudget: 30,
        currency: "EUR",
        occurredAt: "2026-08-14T09:00:00+00:00",
        actorName: "Agency Operator",
      },
    ]);
  });

  it("loads activity through the exact client and physical-account scope", async () => {
    vi.clearAllMocks();
    const operation = {
      id: "33333333-3333-4333-8333-333333333333",
      client_id: "55555555-5555-4555-8555-555555555555",
      ad_account_id: "44444444-4444-4444-8444-444444444444",
      provider_campaign_id: "123456789",
      campaign_name: "Scale campaign",
      action: "campaign_paused",
      status: "succeeded",
      previous_daily_budget_micros: null,
      next_daily_budget_micros: null,
      currency: "EUR",
      completed_at: "2026-08-14T09:00:00+00:00",
      requested_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } as CampaignActionOperation;
    const operations: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ["select", "eq", "in", "order", "or"]) {
      operations[name] = vi.fn(() => operations);
    }
    operations.limit = vi.fn().mockResolvedValue({ data: [operation], error: null });
    const profiles: Record<string, ReturnType<typeof vi.fn>> = {
      select: vi.fn(),
      in: vi.fn(),
    };
    profiles.select.mockReturnValue(profiles);
    profiles.in.mockResolvedValue({
      data: [{ id: operation.requested_by, full_name: "Agency Operator", email: "a@example.com" }],
      error: null,
    });
    mocks.requireAdmin.mockResolvedValue({ id: operation.requested_by });
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "campaign_action_operations" ? operations : profiles,
      ),
    });

    await expect(
      listCampaignActionActivity(
        "55555555-5555-4555-8555-555555555555",
        [operation.ad_account_id, operation.ad_account_id],
        { from: "2026-08-14", to: "2026-08-14" },
      ),
    ).resolves.toEqual({
      history: [
        expect.objectContaining({
          id: operation.id,
          actorName: "Agency Operator",
          action: "campaign_paused",
          occurredAt: "2026-08-14T09:00:00+00:00",
        }),
      ],
      truncated: false,
    });
    expect(operations.eq).toHaveBeenCalledWith(
      "client_id",
      "55555555-5555-4555-8555-555555555555",
    );
    expect(operations.in).toHaveBeenCalledWith("ad_account_id", [operation.ad_account_id]);
    expect(operations.or).toHaveBeenCalledWith(
      "and(completed_at.gte.2026-08-13T23:00:00.000Z,completed_at.lt.2026-08-14T23:00:00.000Z),and(completed_at.is.null,requested_at.gte.2026-08-13T23:00:00.000Z,requested_at.lt.2026-08-14T23:00:00.000Z)",
    );
    expect(operations.eq).not.toHaveBeenCalledWith("status", "succeeded");
  });

  it("keeps the page available and reports when verified activity exceeds 1,000 rows", async () => {
    vi.clearAllMocks();
    const clientId = "55555555-5555-4555-8555-555555555555";
    const accountId = "44444444-4444-4444-8444-444444444444";
    const actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rows = Array.from({ length: 1_001 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      client_id: clientId,
      ad_account_id: accountId,
      provider_campaign_id: String(index + 1),
      campaign_name: `Campaign ${index + 1}`,
      action: "campaign_paused",
      status: "succeeded",
      previous_daily_budget_micros: null,
      next_daily_budget_micros: null,
      currency: "EUR",
      requested_at: "2026-08-14T08:59:00.000Z",
      completed_at: "2026-08-14T09:00:00.000Z",
      requested_by: actorId,
    })) as CampaignActionOperation[];
    const operations: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ["select", "eq", "in", "order", "or"]) {
      operations[name] = vi.fn(() => operations);
    }
    operations.limit = vi.fn()
      .mockResolvedValueOnce({ data: rows.slice(0, 1_000), error: null })
      .mockResolvedValueOnce({ data: rows.slice(1_000), error: null });
    const profiles: Record<string, ReturnType<typeof vi.fn>> = {
      select: vi.fn(),
      in: vi.fn(),
    };
    profiles.select.mockReturnValue(profiles);
    profiles.in.mockResolvedValue({
      data: [{ id: actorId, full_name: "Agency Operator", email: "a@example.com" }],
      error: null,
    });
    mocks.requireAdmin.mockResolvedValue({ id: actorId });
    mocks.createServiceClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "campaign_action_operations" ? operations : profiles,
      ),
    });

    const result = await listCampaignActionActivity(clientId, [accountId]);

    expect(result.history).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
    expect(operations.or).toHaveBeenCalledTimes(1);
  });
});
