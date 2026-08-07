import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchWithReadRetry } from "./fetch-retry";

const ok = new Response("ok");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithReadRetry", () => {
  it("absorbs a dropped connection on a read and succeeds on retry", async () => {
    const stub = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Network connection lost."))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", stub);

    const response = await fetchWithReadRetry("https://db.example/rest/v1/x");

    expect(response).toBe(ok);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and surfaces the real error", async () => {
    const stub = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Network connection lost."));
    vi.stubGlobal("fetch", stub);

    await expect(
      fetchWithReadRetry("https://db.example/rest/v1/x"),
    ).rejects.toThrow(/network connection lost/i);
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it("never replays a body-bearing request — writes keep failing loudly", async () => {
    const stub = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Network connection lost."));
    vi.stubGlobal("fetch", stub);

    await expect(
      fetchWithReadRetry("https://db.example/rest/v1/rpc/issue", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow();
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("does not retry an HTTP error response — only wire failures", async () => {
    const server500 = new Response("boom", { status: 500 });
    const stub = vi.fn<typeof fetch>().mockResolvedValue(server500);
    vi.stubGlobal("fetch", stub);

    const response = await fetchWithReadRetry("https://db.example/rest/v1/x");

    expect(response).toBe(server500);
    expect(stub).toHaveBeenCalledTimes(1);
  });
});
