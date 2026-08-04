import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { BillingIssueLease, Database } from "@/lib/supabase/types";
import {
  acquireBillingIssueLease,
  BillingIssueLeaseLostError,
  recordBillingIssueError,
  releaseBillingIssueLease,
  renewBillingIssueLease,
} from "./issue-lease";

const CLIENT = "10000000-0000-4000-8000-000000000001";
const ADMIN = "10000000-0000-4000-8000-000000000002";
const TOKEN = "10000000-0000-4000-8000-000000000003";

const ROW: BillingIssueLease = {
  lease_token: TOKEN,
  client_id: CLIENT,
  fencing_token: 7,
  period_start: "2026-07-20",
  issued_by: ADMIN,
  acquired_at: "2026-08-03T10:00:00.000Z",
  renewed_at: "2026-08-03T10:01:00.000Z",
  lease_expires_at: "2026-08-03T10:06:00.000Z",
  released_at: null,
};

function clientWithRpc(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SupabaseClient<Database>;
}

describe("billing issue lease client", () => {
  it("retries a lost acquire response with the exact same idempotency token", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: "connection reset" },
      })
      .mockResolvedValueOnce({ data: [ROW], error: null });

    await expect(
      acquireBillingIssueLease(clientWithRpc(rpc), {
        clientId: CLIENT,
        periodStart: ROW.period_start,
        issuedBy: ADMIN,
        leaseToken: TOKEN,
      }),
    ).resolves.toMatchObject({
      clientId: CLIENT,
      leaseToken: TOKEN,
      fencingToken: 7,
    });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });

  it("returns null for normal contention without inventing a generation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    await expect(
      acquireBillingIssueLease(clientWithRpc(rpc), {
        clientId: CLIENT,
        periodStart: ROW.period_start,
        issuedBy: ADMIN,
        leaseToken: TOKEN,
      }),
    ).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed when renewal cannot prove the exact fence", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    await expect(
      renewBillingIssueLease(clientWithRpc(rpc), {
        clientId: CLIENT,
        leaseToken: TOKEN,
        fencingToken: 7,
        periodStart: ROW.period_start,
        issuedBy: ADMIN,
        leaseExpiresAt: ROW.lease_expires_at,
      }),
    ).rejects.toBeInstanceOf(BillingIssueLeaseLostError);
  });

  it("retries an idempotent release and keeps the exact fence arguments", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: "timeout" } })
      .mockResolvedValueOnce({ data: true, error: null });
    await expect(
      releaseBillingIssueLease(clientWithRpc(rpc), {
        clientId: CLIENT,
        leaseToken: TOKEN,
        fencingToken: 7,
        periodStart: ROW.period_start,
        issuedBy: ADMIN,
        leaseExpiresAt: ROW.lease_expires_at,
      }),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });

  it("passes the exact generation into the atomic issue-error RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
    await expect(
      recordBillingIssueError(
        clientWithRpc(rpc),
        {
          clientId: CLIENT,
          leaseToken: TOKEN,
          fencingToken: 7,
          periodStart: ROW.period_start,
          issuedBy: ADMIN,
          leaseExpiresAt: ROW.lease_expires_at,
        },
        "20000000-0000-4000-8000-000000000010",
        "x".repeat(1_100),
      ),
    ).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledWith("record_billing_issue_error", {
      p_client_id: CLIENT,
      p_lease_token: TOKEN,
      p_fencing_token: 7,
      p_invoice_id: "20000000-0000-4000-8000-000000000010",
      p_issue_error: "x".repeat(1_000),
    });
  });
});
