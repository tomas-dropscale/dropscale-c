import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  activeWorkspaceId: vi.fn(),
  fetchAccounts: vi.fn(),
  reportingMetricScope: vi.fn(),
  refreshAccountsNow: vi.fn(),
}));

vi.mock("@/lib/portal/workspace", () => ({
  activeWorkspaceId: mocks.activeWorkspaceId,
}));
vi.mock("@/lib/portal/data", () => ({
  fetchAccounts: mocks.fetchAccounts,
  reportingMetricScope: mocks.reportingMetricScope,
}));
vi.mock("@/lib/metrics/recompute", () => ({
  refreshAccountsNow: mocks.refreshAccountsNow,
}));

import { POST } from "./route";

describe("portal metrics refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeWorkspaceId.mockResolvedValue("client-1");
    mocks.fetchAccounts.mockResolvedValue([{ id: "anchor-1" }, { id: "anchor-2" }]);
    mocks.reportingMetricScope.mockResolvedValue({
      metricAccountIds: ["anchor-1", "child-1"],
    });
    mocks.refreshAccountsNow.mockResolvedValue(undefined);
  });

  it("authenticates before resolving any reporting source", async () => {
    mocks.activeWorkspaceId.mockResolvedValue(null);

    const response = await POST(
      new NextRequest("http://localhost/api/metrics/refresh", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(mocks.fetchAccounts).not.toHaveBeenCalled();
    expect(mocks.refreshAccountsNow).not.toHaveBeenCalled();
  });

  it("narrows browser ids to public stores and expands their physical metric sources", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/metrics/refresh", {
        method: "POST",
        body: JSON.stringify({ accountIds: ["anchor-1", "forged-child"] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reportingMetricScope).toHaveBeenCalledWith(
      [{ id: "anchor-1" }],
      { includeUnallocated: false },
    );
    expect(mocks.refreshAccountsNow).toHaveBeenCalledWith(["anchor-1", "child-1"]);
  });

  it("includes unallocated Google sources only for a full-client refresh", async () => {
    mocks.reportingMetricScope.mockResolvedValue({
      metricAccountIds: ["anchor-1", "child-1", "google-unallocated"],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/metrics/refresh", {
        method: "POST",
        body: JSON.stringify({
          accountIds: ["anchor-1", "anchor-2"],
          includeUnallocated: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reportingMetricScope).toHaveBeenCalledWith(
      [{ id: "anchor-1" }, { id: "anchor-2" }],
      { includeUnallocated: true },
    );
    expect(mocks.refreshAccountsNow).toHaveBeenCalledWith([
      "anchor-1",
      "child-1",
      "google-unallocated",
    ]);
  });

  it("does not widen a partial refresh when the browser asks for unallocated spend", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/metrics/refresh", {
        method: "POST",
        body: JSON.stringify({
          accountIds: ["anchor-1", "forged-child"],
          includeUnallocated: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reportingMetricScope).toHaveBeenCalledWith(
      [{ id: "anchor-1" }],
      { includeUnallocated: false },
    );
  });

  it("does not expose internal refresh errors to the browser", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.refreshAccountsNow.mockRejectedValue(
      new Error("credential ciphertext and upstream response must stay private"),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/metrics/refresh", { method: "POST" }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Refresh failed." });
    expect(consoleError).toHaveBeenCalledWith("metrics refresh failed", {
      errorName: "Error",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("ciphertext");
    consoleError.mockRestore();
  });
});
