import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/lib/portal/range", async () => import("../../lib/portal/range"));

import { requestReportingSync } from "./reporting-sync-button";

describe("requestReportingSync", () => {
  it("refreshes persisted successes without surfacing a generic partial error", async () => {
    const refresh = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: "Store reporting could not be fully refreshed.",
        result: { refreshed: 2, partial: 1, failed: 0 },
      }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      requestReportingSync(
        {
          scope: "campaigns",
          range: { key: "d7", from: "2026-08-09", to: "2026-08-15" },
        },
        refresh,
        fetcher,
      ),
    ).resolves.toBeUndefined();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("treats a route-budget 502 with persisted store successes as a partial refresh", async () => {
    const refresh = vi.fn();
    const budget = {
      error: "Reporting sync reached its route budget; remaining stores were not launched.",
      campaigns: { refreshed: 0, failed: 1 },
      stores: [{ refreshed: 3, partial: 0, failed: 0 }],
    };
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(budget), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      requestReportingSync(
        { scope: "all", range: { key: "d7", from: "2026-08-09", to: "2026-08-15" } },
        refresh,
        fetcher,
      ),
    ).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();

    // The same 502 with nothing persisted is still the hard error it reads as.
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...budget, stores: [] }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      requestReportingSync(
        { scope: "all", range: { key: "d7", from: "2026-08-09", to: "2026-08-15" } },
        refresh,
        fetcher,
      ),
    ).rejects.toThrow("route budget");
  });

  it("does not refresh when no server response arrives", async () => {
    const refresh = vi.fn();
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      requestReportingSync(
        {
          scope: "campaigns",
          range: { key: "today", from: "2026-08-15", to: "2026-08-15" },
        },
        refresh,
        fetcher,
      ),
    ).rejects.toThrow("network down");

    expect(refresh).not.toHaveBeenCalled();
  });
});
