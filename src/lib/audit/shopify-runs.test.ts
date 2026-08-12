import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eqId: vi.fn(),
  eqDomain: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import {
  claimAuditShopifyRun,
  completeAuditShopifyRun,
  enqueueAuditShopifyRun,
  failAuditShopifyRun,
  getAuditShopifyRun,
  renewAuditShopifyRun,
} from "./shopify-runs";
import type { AuditShopifyRun } from "@/lib/supabase/types";

const RUN_ID = "40000000-0000-4000-8000-000000000010";
const CONNECTION_ID = "40000000-0000-4000-8000-000000000002";
const LEASE_TOKEN = "40000000-0000-4000-8000-000000000011";
const DOMAIN = "jwmtjg-fm.myshopify.com";
const HASH = "a".repeat(64);

function run(overrides: Partial<AuditShopifyRun> = {}): AuditShopifyRun {
  return {
    id: RUN_ID,
    connection_id: CONNECTION_ID,
    requested_by: "40000000-0000-4000-8000-000000000001",
    requested_actor_type: "admin",
    shopify_domain: DOMAIN,
    state: "running",
    requested_source: "admin.baseline",
    requested_note: null,
    schema_hash: HASH,
    manifest_hash: HASH,
    checkpoint: {},
    artifact: null,
    attempt_count: 1,
    retry_count: 0,
    max_retries: 3,
    next_attempt_at: null,
    lease_token: LEASE_TOKEN,
    lease_generation: 1,
    lease_acquired_at: "2026-08-12T12:00:00Z",
    lease_renewed_at: "2026-08-12T12:00:00Z",
    lease_expires_at: "2026-08-12T12:05:00Z",
    error_code: null,
    created_at: "2026-08-12T12:00:00Z",
    updated_at: "2026-08-12T12:00:00Z",
    started_at: "2026-08-12T12:00:00Z",
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createServiceClient.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eqId });
  mocks.eqId.mockReturnValue({ eq: mocks.eqDomain });
  mocks.eqDomain.mockReturnValue({ maybeSingle: mocks.maybeSingle });
});

describe("durable Shopify audit run DAL", () => {
  it("queues an exact, empty-checkpoint run", async () => {
    mocks.rpc.mockResolvedValue({ data: RUN_ID, error: null });
    await expect(
      enqueueAuditShopifyRun({
        runId: RUN_ID,
        connectionId: CONNECTION_ID,
        requestedBy: "40000000-0000-4000-8000-000000000001",
        shopDomain: DOMAIN,
        source: "admin.baseline",
        note: "Lara authorised baseline",
        schemaHash: HASH,
        manifestHash: HASH,
      }),
    ).resolves.toBe(RUN_ID);
    expect(mocks.rpc).toHaveBeenCalledWith("enqueue_audit_shopify_run", {
      p_run_id: RUN_ID,
      p_connection_id: CONNECTION_ID,
      p_requested_by: "40000000-0000-4000-8000-000000000001",
      p_shopify_domain: DOMAIN,
      p_requested_source: "admin.baseline",
      p_requested_note: "Lara authorised baseline",
      p_schema_hash: HASH,
      p_manifest_hash: HASH,
      p_max_retries: 3,
      p_checkpoint: {},
      p_actor_type: "admin",
    });
  });

  it("reuses the database-selected active run for the same manifest", async () => {
    const existingRunId = "40000000-0000-4000-8000-000000000099";
    mocks.rpc.mockResolvedValue({ data: existingRunId, error: null });
    await expect(
      enqueueAuditShopifyRun({
        runId: RUN_ID,
        connectionId: CONNECTION_ID,
        requestedBy: "40000000-0000-4000-8000-000000000001",
        shopDomain: DOMAIN,
        source: "admin.baseline",
        note: null,
        schemaHash: HASH,
        manifestHash: HASH,
      }),
    ).resolves.toBe(existingRunId);
  });

  it("claims only the exact run and domain", async () => {
    mocks.rpc.mockResolvedValue({ data: [run()], error: null });
    await expect(
      claimAuditShopifyRun({
        runId: RUN_ID,
        shopDomain: DOMAIN,
        leaseToken: LEASE_TOKEN,
      }),
    ).resolves.toMatchObject({ id: RUN_ID, shopify_domain: DOMAIN });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_audit_shopify_run", {
      p_lease_token: LEASE_TOKEN,
      p_run_id: RUN_ID,
      p_shopify_domain: DOMAIN,
      p_lease_seconds: 300,
    });
  });

  it("loads only the exact run/domain when reconciling a contended claim", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: run(), error: null });
    await expect(
      getAuditShopifyRun({ runId: RUN_ID, shopDomain: DOMAIN }),
    ).resolves.toMatchObject({ id: RUN_ID, shopify_domain: DOMAIN });
    expect(mocks.from).toHaveBeenCalledWith("audit_shopify_runs");
    expect(mocks.eqId).toHaveBeenCalledWith("id", RUN_ID);
    expect(mocks.eqDomain).toHaveBeenCalledWith("shopify_domain", DOMAIN);
  });

  it("renews the current fenced lease with bounded progress", async () => {
    mocks.rpc.mockResolvedValue({ data: [run()], error: null });
    await expect(
      renewAuditShopifyRun({
        run: run(),
        leaseToken: LEASE_TOKEN,
        checkpoint: { requestCount: 3 },
      }),
    ).resolves.toMatchObject({ state: "running" });
    expect(mocks.rpc).toHaveBeenCalledWith("renew_audit_shopify_run", {
      p_run_id: RUN_ID,
      p_shopify_domain: DOMAIN,
      p_lease_token: LEASE_TOKEN,
      p_lease_generation: 1,
      p_checkpoint: { requestCount: 3 },
      p_lease_seconds: 300,
    });
  });

  it("completes with the current lease generation and sanitized artifact", async () => {
    const completed = run({
      state: "completed",
      artifact: { schemaVersion: "shopify-audit-baseline-v1" },
      lease_token: null,
      lease_acquired_at: null,
      lease_renewed_at: null,
      lease_expires_at: null,
      completed_at: "2026-08-12T12:01:00Z",
    });
    mocks.rpc.mockResolvedValue({ data: [completed], error: null });
    await expect(
      completeAuditShopifyRun({
        run: run(),
        leaseToken: LEASE_TOKEN,
        artifact: { schemaVersion: "shopify-audit-baseline-v1" },
      }),
    ).resolves.toMatchObject({ state: "completed" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_audit_shopify_run",
      expect.objectContaining({
        p_run_id: RUN_ID,
        p_shopify_domain: DOMAIN,
        p_lease_token: LEASE_TOKEN,
        p_lease_generation: 1,
      }),
    );
  });

  it("records only a sanitized error code and retry decision", async () => {
    mocks.rpc.mockResolvedValue({
      data: [run({ state: "queued", error_code: "query_rate_limited" })],
      error: null,
    });
    await failAuditShopifyRun({
      run: run(),
      leaseToken: LEASE_TOKEN,
      errorCode: "query_rate_limited",
      retryable: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fail_audit_shopify_run",
      expect.objectContaining({
        p_error_code: "query_rate_limited",
        p_retryable: true,
      }),
    );
  });
});
