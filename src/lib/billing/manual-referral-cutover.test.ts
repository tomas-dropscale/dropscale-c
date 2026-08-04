import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type {
  Database,
  ManualReferralBillingConfig,
} from "@/lib/supabase/types";
import {
  evaluateManualReferralCutover,
  loadManualReferralCutoverGate,
  manualReferralCutoverPreviewBlocker,
} from "./manual-referral-cutover";

const CONFIG: ManualReferralBillingConfig = {
  singleton: true,
  v3_cutover_monday: "2026-07-27",
  created_at: "2026-07-29T09:00:00.000Z",
};

function clientReturning(result: {
  data: ManualReferralBillingConfig | null;
  error: { message: string } | null;
}) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return {
    client: { from } as unknown as SupabaseClient<Database>,
    from,
    select,
    eq,
    maybeSingle,
  };
}

describe("manual referral v3 cutover", () => {
  it("blocks a closed Monday before the immutable cutover", () => {
    const gate = evaluateManualReferralCutover("2026-07-20", CONFIG);
    expect(gate).toEqual({
      allowed: false,
      reason: "pre_cutover",
      v3CutoverMonday: "2026-07-27",
    });
    expect(manualReferralCutoverPreviewBlocker(gate)).toMatchObject({
      code: "pre_v3_cutover",
      severity: "error",
    });
  });

  it("allows the cutover Monday and later Mondays", () => {
    expect(evaluateManualReferralCutover("2026-07-27", CONFIG)).toEqual({
      allowed: true,
      reason: "allowed",
      v3CutoverMonday: "2026-07-27",
    });
    expect(evaluateManualReferralCutover("2026-08-03", CONFIG).allowed).toBe(
      true,
    );
  });

  it("fails closed for a missing or malformed singleton", () => {
    const missing = evaluateManualReferralCutover("2026-07-27", null);
    expect(missing).toMatchObject({
      allowed: false,
      reason: "missing",
    });
    expect(manualReferralCutoverPreviewBlocker(missing)).toMatchObject({
      code: "referral_cutover_unavailable",
      severity: "error",
    });
    expect(
      evaluateManualReferralCutover("2026-07-27", {
        ...CONFIG,
        v3_cutover_monday: "2026-07-28",
      }),
    ).toMatchObject({ allowed: false, reason: "invalid" });
    expect(
      evaluateManualReferralCutover("2026-07-27", {
        ...CONFIG,
        singleton: false,
      }),
    ).toMatchObject({ allowed: false, reason: "invalid" });
  });

  it("reads the exact singleton and converts database errors into a closed gate", async () => {
    const success = clientReturning({ data: CONFIG, error: null });
    await expect(
      loadManualReferralCutoverGate(success.client, "2026-07-20"),
    ).resolves.toMatchObject({ allowed: false, reason: "pre_cutover" });
    expect(success.from).toHaveBeenCalledWith(
      "manual_referral_billing_config",
    );
    expect(success.select).toHaveBeenCalledWith(
      "singleton, v3_cutover_monday, created_at",
    );
    expect(success.eq).toHaveBeenCalledWith("singleton", true);

    const failure = clientReturning({
      data: null,
      error: { message: "permission denied" },
    });
    await expect(
      loadManualReferralCutoverGate(failure.client, "2026-07-27"),
    ).resolves.toEqual({
      allowed: false,
      reason: "unavailable",
      v3CutoverMonday: null,
    });
  });

  it("does not invent a blocker on or after the cutover", () => {
    expect(
      manualReferralCutoverPreviewBlocker(
        evaluateManualReferralCutover("2026-07-27", CONFIG),
      ),
    ).toBeNull();
  });
});
