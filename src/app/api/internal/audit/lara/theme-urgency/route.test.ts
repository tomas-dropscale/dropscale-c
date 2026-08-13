import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sponsor: vi.fn(),
  dryRun: vi.fn(),
  oneShot: vi.fn(),
}));

vi.mock("@/lib/audit/connections", () => ({
  getAuditMachineSponsor: mocks.sponsor,
}));
vi.mock("@/lib/audit/lara-theme-urgency-live-repair", () => {
  class LaraThemeUrgencyRepairError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    buildLaraThemeUrgencyDryRun: mocks.dryRun,
    runLaraThemeUrgencyRepairOneShot: mocks.oneShot,
    LaraThemeUrgencyRepairError,
  };
});
vi.mock("@/lib/audit/lara-theme-urgency-live-contract", () => {
  class LaraThemeUrgencyLiveContractError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return { LaraThemeUrgencyLiveContractError };
});
vi.mock("@/lib/audit/lara-theme-urgency-live-runtime", () => {
  class LaraThemeUrgencyLiveRuntimeError extends Error {
    constructor(
      public readonly code: string,
      message = code,
      public readonly retryable = false,
      public readonly diagnostic: unknown = null,
    ) {
      super(message);
    }
  }
  return {
    LARA_THEME_URGENCY_SAFE_REST_INTEGRITY_CLASSES: [
      "json_no_exact_bounded_candidate",
      "liquid_no_exact_literal_or_crlf_candidate",
    ],
    LARA_THEME_URGENCY_SAFE_REST_INTEGRITY_FILENAMES: [
      "blocks/ai_gen_block_a974a97.liquid",
      "templates/index.json",
      "sections/main-product.liquid",
      "templates/product.json",
      "sections/collection-list.liquid",
      "sections/featured-collection.liquid",
      "sections/featured-product.liquid",
      "config/settings_data.json",
    ],
    LaraThemeUrgencyLiveRuntimeError,
  };
});
vi.mock("@/lib/audit/shopify-lara", () => ({
  LARA_AUDIT_CONNECTION: {
    connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
    shopDomain: "jwmtjg-fm.myshopify.com",
    shopId: "gid://shopify/Shop/95462097276",
  },
}));

import { NextRequest } from "next/server";
import { LaraThemeUrgencyLiveRuntimeError } from "@/lib/audit/lara-theme-urgency-live-runtime";
import { POST } from "./route";

const URL = "https://dropscale.app/api/internal/audit/lara/theme-urgency";
const DIGEST = "a".repeat(64);
const DRY_RUN = {
  mode: "dry-run",
  writesAttempted: 0,
  repairRunId: "cb1a4cdd-989d-4a4d-91ce-e8b1bb461cbc",
  backupRunId: "7cd77f30-6334-4b6a-8420-e48e4af30e29",
  materialDigestSha256: "b".repeat(64),
  planDigestSha256: DIGEST,
  sourceSnapshotDigestSha256: "c".repeat(64),
  operationCount: 3,
  operationFilenames: [],
  exactReplacementCount: 7,
  kaching: {
    separateBooleanPlanEligible: false,
    urgencyBatchWriteIncluded: false,
    handling: { status: "deferred_no_write" },
  },
  vendorMutationIncluded: false,
};

function request(body: unknown, secret = "test-cron-secret", origin?: string) {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  mocks.sponsor.mockResolvedValue("10000000-0000-4000-8000-000000000001");
  mocks.dryRun.mockResolvedValue(DRY_RUN);
  mocks.oneShot.mockResolvedValue({
    runId: "cb1a4cdd-989d-4a4d-91ce-e8b1bb461cbc",
    state: "completed",
    stage: "repair",
    status: "verified",
    planDigestSha256: DIGEST,
    backupRunId: "7cd77f30-6334-4b6a-8420-e48e4af30e29",
    verifiedFiles: 3,
    kachingStatus: "deferred_no_write",
  });
});
describe("the exact machine-only Lara theme route", () => {
  it("rejects unauthorised and cross-origin requests before runtime work", async () => {
    expect((await POST(request({ action: "dry-run" }, "wrong"))).status).toBe(401);
    expect(
      (
        await POST(
          request({ action: "dry-run" }, "test-cron-secret", "https://evil.invalid"),
        )
      ).status,
    ).toBe(403);
    expect(mocks.dryRun).not.toHaveBeenCalled();
    expect(mocks.oneShot).not.toHaveBeenCalled();
  });

  it("returns the server-generated dry run and makes no write call", async () => {
    const result = await POST(request({ action: "dry-run" }));
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ ok: true, ...DRY_RUN });
    expect(mocks.dryRun).toHaveBeenCalledOnce();
    expect(mocks.oneShot).not.toHaveBeenCalled();
  });

  it("runs the fixed durable one-shot with no request-controlled targets or bodies", async () => {
    const result = await POST(
      request({
        action: "apply",
        confirmation: "apply-lara-exact-theme-copy-with-durable-backup",
      }),
    );
    expect(result.status).toBe(200);
    expect(mocks.sponsor).toHaveBeenCalledWith({
      connectionId: "a023c7e2-a96b-4f04-bc6e-0165e23332c3",
      shopifyDomain: "jwmtjg-fm.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/95462097276",
    });
    expect(mocks.oneShot).toHaveBeenCalledWith({
      requestedBy: "10000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects request-controlled themes, files, bodies, plan and run ids", async () => {
    for (const extra of [
      { themeId: "gid://shopify/OnlineStoreTheme/999" },
      { filename: "layout/theme.liquid" },
      { body: "attacker supplied" },
      { plan: { operations: [] } },
      { runId: "attacker-controlled" },
      { kachingDisabled: true },
    ]) {
      const result = await POST(
        request({
          action: "apply",
          confirmation: "apply-lara-exact-theme-copy-with-durable-backup",
          ...extra,
        }),
      );
      expect(result.status).toBe(400);
    }
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.oneShot).not.toHaveBeenCalled();
  });

  it("reports resumable work as 202 and a terminal Shopify block as 502", async () => {
    mocks.oneShot.mockResolvedValueOnce({
      runId: "cb1a4cdd-989d-4a4d-91ce-e8b1bb461cbc",
      state: "in_progress",
      stage: "repair",
    });
    const pending = await POST(
      request({
        action: "apply",
        confirmation: "apply-lara-exact-theme-copy-with-durable-backup",
      }),
    );
    expect(pending.status).toBe(202);

    mocks.oneShot.mockResolvedValueOnce({
      runId: "cb1a4cdd-989d-4a4d-91ce-e8b1bb461cbc",
      state: "failed",
      stage: "repair",
      status: "manual_intervention_required",
      errorCode: "theme_write_exemption_unavailable",
    });
    const failed = await POST(
      request({
        action: "apply",
        confirmation: "apply-lara-exact-theme-copy-with-durable-backup",
      }),
    );
    expect(failed.status).toBe(502);
  });

  it("returns only an allowlisted filename and discrepancy class for REST integrity failures", async () => {
    const filename = "templates/index.json" as const;
    mocks.dryRun.mockRejectedValueOnce(
      new LaraThemeUrgencyLiveRuntimeError(
        "invalid_rest_asset_integrity",
        "SECRET_BODY size=123 checksum=deadbeef updatedAt=secret",
        false,
        {
          filename,
          discrepancyClass: "json_no_exact_bounded_candidate",
        },
      ),
    );

    const result = await POST(request({ action: "dry-run" }));
    expect(result.status).toBe(409);
    const body = await result.json();
    expect(body).toEqual({
      error: "invalid_rest_asset_integrity",
      diagnostic: {
        filename,
        discrepancyClass: "json_no_exact_bounded_candidate",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /SECRET_BODY|size|checksum|updatedAt|deadbeef|123/,
    );
  });

  it("drops malformed or non-allowlisted REST integrity diagnostics", async () => {
    for (const diagnostic of [
      {
        filename: "layout/theme.liquid",
        discrepancyClass: "liquid_no_exact_literal_or_crlf_candidate",
      },
      {
        filename: "templates/index.json",
        discrepancyClass: "arbitrary_detail",
      },
      {
        filename: "templates/index.json",
        discrepancyClass: "json_no_exact_bounded_candidate",
        body: "SECRET_BODY",
      },
    ]) {
      mocks.dryRun.mockRejectedValueOnce(
        new LaraThemeUrgencyLiveRuntimeError(
          "invalid_rest_asset_integrity",
          "SECRET_BODY",
          false,
          diagnostic as never,
        ),
      );
      const result = await POST(request({ action: "dry-run" }));
      expect(result.status).toBe(409);
      await expect(result.json()).resolves.toEqual({
        error: "invalid_rest_asset_integrity",
      });
    }
  });
});
