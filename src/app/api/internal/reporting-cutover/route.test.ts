import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class ClientOnboardingError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  class ClientShopifyConnectionError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  class ShopifyReportingError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly retryable = false,
    ) {
      super(message);
    }
  }
  class WindsorError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  const maybeSingle = vi.fn();
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const rpc = vi.fn();
  return {
    ClientOnboardingError,
    ClientShopifyConnectionError,
    ShopifyReportingError,
    WindsorError,
    validate: vi.fn(),
    execute: vi.fn(),
    rollback: vi.fn(),
    testShopify: vi.fn(),
    repository: {},
    createRepository: vi.fn(),
    createServiceClient: vi.fn(),
    checkGoogle: vi.fn(),
    query,
    maybeSingle,
    rpc,
  };
});

vi.mock("@/lib/client-onboarding/http", () => ({
  readSmallJson: (request: Request) => request.json(),
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
}));
vi.mock("@/lib/client-onboarding/reporting-cutover", () => ({
  validatePurposeBoundReportingCutoverContext: mocks.validate,
  executePurposeBoundReportingCutoverStep: mocks.execute,
  executePurposeBoundReportingCutoverRollback: mocks.rollback,
}));
vi.mock("@/lib/client-onboarding/sessions", () => ({
  ClientOnboardingError: mocks.ClientOnboardingError,
}));
vi.mock("@/lib/client-onboarding/shopify-connections", () => ({
  ClientShopifyConnectionError: mocks.ClientShopifyConnectionError,
  testStoredReportingShopifyStore: mocks.testShopify,
}));
vi.mock("@/lib/client-onboarding/shopify-repository", () => ({
  createReportingShopifyRepository: mocks.createRepository,
}));
vi.mock("@/lib/client-onboarding/shopify", () => ({
  ShopifyReportingError: mocks.ShopifyReportingError,
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));
vi.mock("@/lib/windsor/client", () => ({
  WindsorError: mocks.WindsorError,
  checkGoogleAdsAccountHealth: mocks.checkGoogle,
}));

import { POST } from "./route";

const TOKEN = "a".repeat(64);
const ADMIN = "71000000-0000-4000-8000-000000000001";
const C12 = "71000000-0000-4000-8000-000000000012";
const C12_SHOPIFY = "71000000-0000-4000-8000-000000000112";
const C16 = "71000000-0000-4000-8000-000000000016";
const C16_SHOPIFY = "71000000-0000-4000-8000-000000000116";
const C16_GOOGLE = "71000000-0000-4000-8000-000000000216";
const URL = "https://dropscale.app/api/internal/reporting-cutover";

function contextSecret() {
  return JSON.stringify({
    token: TOKEN,
    adminId: ADMIN,
    c12ClientId: C12,
    c12ShopifyConnectionId: C12_SHOPIFY,
    c16ClientId: C16,
    c16ShopifyConnectionId: C16_SHOPIFY,
    c16GoogleConnectionId: C16_GOOGLE,
  });
}

function request(
  body: unknown,
  options: { token?: string; origin?: string } = {},
) {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token ?? TOKEN}`,
      "content-type": "application/json",
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REPORTING_CUTOVER_CONTEXT", contextSecret());
  mocks.validate.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({ action: "provision" });
  mocks.rollback.mockResolvedValue({ action: "rollback" });
  mocks.testShopify.mockResolvedValue({ ok: true });
  mocks.createRepository.mockReturnValue(mocks.repository);
  mocks.maybeSingle.mockResolvedValue({
    data: {
      id: C16_GOOGLE,
      client_id: C16,
      windsor_account_id: "123-456-7890",
    },
    error: null,
  });
  mocks.rpc.mockResolvedValue({ data: C16_GOOGLE, error: null });
  mocks.createServiceClient.mockReturnValue({
    from: vi.fn(() => mocks.query),
    rpc: mocks.rpc,
  });
  mocks.checkGoogle.mockResolvedValue({
    ok: true,
    code: "healthy",
    account: {
      currency: "EUR",
      timeZone: "Europe/Lisbon",
    },
    checkedAt: "2026-08-14T05:00:00.000Z",
  });
});

describe("temporary purpose-bound reporting cutover route", () => {
  it("authenticates before reading the body or constructing service-role", async () => {
    const bodyRead = vi.fn(async () => ({ done: true as const, value: undefined }));
    const unauthorised = {
      headers: new Headers({ authorization: "Bearer wrong" }),
      body: { getReader: () => ({ read: bodyRead }) },
    } as unknown as NextRequest;

    const result = await POST(unauthorised);

    expect(result.status).toBe(401);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and request-controlled IDs before any cutover work", async () => {
    expect(
      (await POST(request({ step: "c12_provision" }, { origin: "https://attacker.invalid" })))
        .status,
    ).toBe(403);
    expect(
      (
        await POST(
          request({ step: "c12_provision", clientId: "attacker-controlled" }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.testShopify).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("tests the fixed C12 Shopify source immediately before exact provisioning", async () => {
    const result = await POST(request({ step: "c12_provision" }));

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ ok: true, step: "c12_provision" });
    const expectedContext = {
      adminId: ADMIN,
      clientId: C12,
      shopifyConnectionIds: [C12_SHOPIFY],
      googleAdsConnectionIds: [],
    };
    expect(mocks.validate).toHaveBeenCalledWith(expectedContext);
    expect(mocks.testShopify).toHaveBeenCalledWith({
      connectionId: C12_SHOPIFY,
      adminId: ADMIN,
      repository: mocks.repository,
    });
    expect(mocks.execute).toHaveBeenCalledWith(expectedContext, "provision");
    expect(mocks.testShopify.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.execute.mock.invocationCallOrder[0],
    );
  });

  it("tests fixed C16 Shopify and Windsor identities before the gated upgrade", async () => {
    mocks.execute.mockResolvedValue({ action: "upgrade" });

    const result = await POST(request({ step: "c16_upgrade" }));

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ ok: true, step: "c16_upgrade" });
    const expectedContext = {
      adminId: ADMIN,
      clientId: C16,
      shopifyConnectionIds: [C16_SHOPIFY],
      googleAdsConnectionIds: [C16_GOOGLE],
      prerequisiteClientId: C12,
    };
    expect(mocks.validate).toHaveBeenCalledWith(expectedContext);
    expect(mocks.testShopify).toHaveBeenCalledWith({
      connectionId: C16_SHOPIFY,
      adminId: ADMIN,
      repository: mocks.repository,
    });
    expect(mocks.checkGoogle).toHaveBeenCalledWith("123-456-7890");
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "record_client_google_ads_reporting_identity",
      {
        p_connection_id: C16_GOOGLE,
        p_currency: "EUR",
        p_time_zone: "Europe/Lisbon",
        p_admin_id: ADMIN,
        p_verified_at: "2026-08-14T05:00:00.000Z",
      },
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "record_client_google_ads_health", {
      p_connection_id: C16_GOOGLE,
      p_admin_id: ADMIN,
      p_ok: true,
      p_tested_at: "2026-08-14T05:00:00.000Z",
      p_error_code: null,
    });
    expect(mocks.execute).toHaveBeenCalledWith(expectedContext, "upgrade");
    expect(mocks.checkGoogle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.execute.mock.invocationCallOrder[0],
    );
  });

  it("stops C16 before source tests when the C12 prerequisite is rejected", async () => {
    mocks.validate.mockRejectedValue(
      new mocks.ClientOnboardingError("invalid_state", "not active", 409),
    );

    const result = await POST(request({ step: "c16_upgrade" }));

    expect(result.status).toBe(409);
    expect(mocks.testShopify).not.toHaveBeenCalled();
    expect(mocks.checkGoogle).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps emergency rollback independent from unhealthy source checks", async () => {
    const result = await POST(request({ step: "c16_rollback" }));

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ ok: true, step: "c16_rollback" });
    expect(mocks.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: ADMIN, clientId: C16 }),
    );
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.testShopify).not.toHaveBeenCalled();
    expect(mocks.checkGoogle).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the one-shot Worker context is missing or malformed", async () => {
    vi.stubEnv("REPORTING_CUTOVER_CONTEXT", "not-json");

    const result = await POST(request({ step: "c12_sync" }));

    expect(result.status).toBe(503);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });
});
