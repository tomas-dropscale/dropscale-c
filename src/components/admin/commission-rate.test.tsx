import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureSave: vi.fn(),
  refresh: vi.fn(),
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));
vi.mock("@/components/admin/inline-rename", () => ({
  InlineRename: ({
    onSave,
    children,
  }: {
    onSave: (value: string) => Promise<string | null>;
    children: ReactNode;
  }) => {
    mocks.captureSave(onSave);
    return <div>{children}</div>;
  },
}));

import { CommissionRate, parseCommissionRateDraft } from "./commission-rate";

describe("CommissionRate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({
      data: [{ id: "term-2", ad_account_id: "billing-1", list_rate: 12.5 }],
      error: null,
    });
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it("accepts only percentages with at most two decimal places", () => {
    expect(parseCommissionRateDraft("0")).toBe(0);
    expect(parseCommissionRateDraft(" 9.5 ")).toBe(9.5);
    expect(parseCommissionRateDraft("100.00")).toBe(100);
    for (const value of ["", "-1", "100.01", "9.999", ".5", "1e1", "ten"]) {
      expect(parseCommissionRateDraft(value)).toBeNull();
    }
  });

  it("shows current, effective, referral and scheduled provenance", () => {
    const standard = renderToStaticMarkup(
      <CommissionRate
        accountId="billing-1"
        rate={10}
        listRate={10}
        expectedTermId={null}
      />,
    );
    const referredAndScheduled = renderToStaticMarkup(
      <CommissionRate
        accountId="billing-1"
        rate={9.5}
        listRate={10}
        expectedTermId="term-1"
        scheduledListRate={12.5}
        scheduledEffectiveFrom="2026-08-17"
      />,
    );

    expect(standard).toContain("10% effective");
    expect(standard).toContain("10% current list");
    expect(standard).toContain("manual list is effective");
    expect(referredAndScheduled).toContain("9.5% effective");
    expect(referredAndScheduled).toContain("0.5 pp referral discount");
    expect(referredAndScheduled).toContain("12.5% scheduled · 17 Aug 2026");
  });

  it("schedules through the audited per-account RPC with a null first-term CAS", async () => {
    renderToStaticMarkup(
      <CommissionRate
        accountId="billing-1"
        rate={10}
        listRate={10}
        expectedTermId={null}
      />,
    );
    const save = mocks.captureSave.mock.calls.at(-1)?.[0] as (
      value: string,
    ) => Promise<string | null>;

    await expect(save("12.5")).resolves.toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith("schedule_ad_account_commission_rate", {
      p_account_id: "billing-1",
      p_list_rate: 12.5,
      p_expected_term_id: null,
      p_decision_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("uses the absolute term head for CAS when replacing a scheduled decision", async () => {
    renderToStaticMarkup(
      <CommissionRate
        accountId="billing-1"
        rate={10}
        listRate={10}
        expectedTermId="future-term"
        scheduledListRate={11}
        scheduledEffectiveFrom="2026-08-17"
      />,
    );
    const save = mocks.captureSave.mock.calls.at(-1)?.[0] as (
      value: string,
    ) => Promise<string | null>;

    await expect(save("12.5")).resolves.toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "schedule_ad_account_commission_rate",
      expect.objectContaining({
        p_account_id: "billing-1",
        p_expected_term_id: "future-term",
      }),
    );
  });

  it("rejects invalid, stale or unverifiable decisions without refreshing", async () => {
    renderToStaticMarkup(
      <CommissionRate
        accountId="billing-1"
        rate={10}
        listRate={10}
        expectedTermId="term-1"
      />,
    );
    const save = mocks.captureSave.mock.calls.at(-1)?.[0] as (
      value: string,
    ) => Promise<string | null>;

    await expect(save("101")).resolves.toMatch(/0 to 100/i);
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "The account commission term changed. Refresh and review it again." },
    });
    await expect(save("11")).resolves.toMatch(/changed/i);

    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(save("11")).resolves.toMatch(/could not be verified/i);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
