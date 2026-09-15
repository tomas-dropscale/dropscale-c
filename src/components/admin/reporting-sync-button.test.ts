import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/lib/portal/range", async () => import("../../lib/portal/range"));

import { presetSelection } from "../../lib/portal/range";
import { requestGlobalReportingSync, requestReportingSync } from "./reporting-sync-button";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestedRange(fetcher: ReturnType<typeof vi.fn>, call: number) {
  const body = JSON.parse(String(fetcher.mock.calls[call]?.[1]?.body)) as {
    scope: string;
    range: { key: string; from: string; to: string };
  };
  return body;
}

describe("requestGlobalReportingSync", () => {
  const now = new Date("2026-09-15T09:49:00.000Z");
  const d7 = presetSelection("d7", now);
  const today = presetSelection("today", now);

  it("refreshes the last 7 days and then today, one leg after the other", async () => {
    // The today leg must not start until the d7 leg has answered: the point of
    // running them in sequence is one portfolio-wide refresh on Windsor at a
    // time. The first response is held back to prove the second waits.
    const refresh = vi.fn();
    let releaseRolling: (response: Response) => void = () => {};
    const fetcher = vi.fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => { releaseRolling = resolve; }),
      )
      .mockResolvedValueOnce(jsonResponse({ stores: [{ refreshed: 3 }] }));

    const sync = requestGlobalReportingSync(refresh, fetcher, now);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestedRange(fetcher, 0)).toEqual({ scope: "all", range: d7 });

    releaseRolling(jsonResponse({ stores: [{ refreshed: 3 }] }));
    await expect(sync).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestedRange(fetcher, 1)).toEqual({ scope: "all", range: today });
    expect(today.from).toBe(today.to);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("still refreshes today when the rolling leg fails, and reports that failure", async () => {
    const refresh = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: "Reporting sync reached its route budget; remaining stores were not launched.",
        stores: [],
      }, 502))
      .mockResolvedValueOnce(jsonResponse({ stores: [{ refreshed: 3 }] }));

    await expect(requestGlobalReportingSync(refresh, fetcher, now)).rejects.toThrow("route budget");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestedRange(fetcher, 1).range).toEqual(today);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reads a route-budget or partial today leg with persisted successes as a partial refresh", async () => {
    const refresh = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stores: [{ refreshed: 3 }] }))
      .mockResolvedValueOnce(jsonResponse({
        error: "Some reporting families could not be fully refreshed.",
        campaigns: { refreshed: 2, partial: 1, failed: 0 },
      }, 502));

    await expect(requestGlobalReportingSync(refresh, fetcher, now)).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);

    // The same partial answer with nothing persisted is still the error it reads as.
    fetcher
      .mockResolvedValueOnce(jsonResponse({ stores: [{ refreshed: 3 }] }))
      .mockResolvedValueOnce(jsonResponse({
        error: "Some reporting families could not be fully refreshed.",
        campaigns: { refreshed: 0, partial: 0, failed: 2 },
      }, 502));
    await expect(requestGlobalReportingSync(refresh, fetcher, now)).rejects.toThrow(
      "could not be fully refreshed",
    );
  });
});

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
