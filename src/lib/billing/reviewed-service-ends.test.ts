import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ensureServiceEndCycleSkip, serviceEndBlocksNewInvoice } from "./reviewed-service-ends";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
const clientId = "927cbac3-8121-456b-9d19-1e7d5c62184a";
describe("approved historical service end", () => {
  it("keeps September 29 inclusive and blocks later days indefinitely", () => {
    expect(serviceEndBlocksNewInvoice(clientId, "2026-09-29")).toBe(false);
    expect(serviceEndBlocksNewInvoice(clientId, "2026-09-30")).toBe(true);
    expect(serviceEndBlocksNewInvoice(clientId, "2030-01-01")).toBe(true);
    expect(serviceEndBlocksNewInvoice("another-client", "2030-01-01")).toBe(false);
  });
  it("creates a database-enforced skip for every future week", async () => {
    const rpc = vi.fn(async () => ({ data: [{ client_id: clientId, period_start: "2026-10-12", period_end: "2026-10-18" }], error: null }));
    const service = { rpc } as unknown as SupabaseClient<Database>;
    expect(await ensureServiceEndCycleSkip(service, clientId, "2026-10-12", "2026-10-18")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("skip_billing_cycle", expect.objectContaining({ p_client_id: clientId, p_period_start: "2026-10-12", p_period_end: "2026-10-18" }));
  });
  it("does not skip the partial closing week or another client", async () => {
    const rpc = vi.fn();
    const service = { rpc } as unknown as SupabaseClient<Database>;
    expect(await ensureServiceEndCycleSkip(service, clientId, "2026-09-28", "2026-10-04")).toBe(false);
    expect(await ensureServiceEndCycleSkip(service, "another", "2026-10-12", "2026-10-18")).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("blocks billing if the receipt cannot be persisted", async () => {
    const service = { rpc: vi.fn(async () => ({ data: null, error: { message: "Database unavailable" } })) } as unknown as SupabaseClient<Database>;
    await expect(ensureServiceEndCycleSkip(service, clientId, "2026-10-12", "2026-10-18")).rejects.toThrow("Issuance is blocked");
  });
});
