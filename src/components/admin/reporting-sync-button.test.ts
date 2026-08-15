import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));

import { requestReportingSync } from "./reporting-sync-button";

describe("requestReportingSync", () => {
  it("refreshes persisted partial results before surfacing a classified 502", async () => {
    const refresh = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Store reporting could not be fully refreshed." }), {
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
    ).rejects.toThrow("Store reporting could not be fully refreshed.");

    expect(refresh).toHaveBeenCalledOnce();
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
