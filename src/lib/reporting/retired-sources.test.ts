import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { retiredAccountIdsByAnchorBinding } from "./retired-sources";

type Row = Record<string, unknown>;

function service(
  bindings: Row[],
  events: Row[],
  errors: { bindings?: unknown; events?: unknown } = {},
) {
  const chain = (data: Row[], error: unknown) => {
    const q: Record<string, ReturnType<typeof vi.fn>> & {
      then?: Promise<unknown>["then"];
    } = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      in: vi.fn(),
    };
    q.select.mockReturnValue(q);
    q.eq.mockReturnValue(q);
    q.is.mockReturnValue(q);
    q.in.mockReturnValue(q);
    q.then = (resolve, reject) => Promise.resolve({ data, error }).then(resolve, reject);
    return q;
  };
  const from = vi.fn((table: string) =>
    table === "client_reporting_bindings"
      ? chain(bindings, errors.bindings ?? null)
      : chain(events, errors.events ?? null),
  );
  return { from };
}

function revokedChild(id: string, adAccountId: string, anchorBindingId: string): Row {
  return {
    id,
    client_id: "client-1",
    ad_account_id: adAccountId,
    shopify_connection_id: null,
    shopify_anchor_binding_id: anchorBindingId,
    status: "revoked",
  };
}

/** The immutable evidence a handover leaves: its event names the binding it retired. */
function handedOver(priorBindingId: string): Row {
  return { prior_binding_id: priorBindingId, event_type: "handed_over" };
}

describe("retired reporting accounts by anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("groups handed-over accounts under the anchor binding they last reported for", async () => {
    const svc = service(
      [
        revokedChild("b1", "acct-handed", "anchor-a"),
        revokedChild("b2", "acct-other-handed", "anchor-b"),
      ],
      [handedOver("b1"), handedOver("b2")],
    );
    await expect(
      retiredAccountIdsByAnchorBinding(svc as never, "client-1", ["anchor-a", "anchor-b"]),
    ).resolves.toEqual(
      new Map([
        ["anchor-a", ["acct-handed"]],
        ["anchor-b", ["acct-other-handed"]],
      ]),
    );
    // The evidence is asked for by the exact revoked bindings, never fleet-wide.
    const eventsQuery = svc.from.mock.results[1]!.value;
    expect(eventsQuery.eq).toHaveBeenCalledWith("event_type", "handed_over");
    expect(eventsQuery.in).toHaveBeenCalledWith("prior_binding_id", ["b1", "b2"]);
  });

  it("keeps an abandoned staged source out: same row shape, no handover evidence", async () => {
    // 0056 closes a billed staged source's meter BEFORE it may be abandoned,
    // so an abandoned experiment looks exactly like a retired account on the
    // bindings and billing tables. Only the handover event tells them apart.
    const svc = service(
      [
        revokedChild("b1", "acct-handed", "anchor-a"),
        revokedChild("b2", "acct-abandoned", "anchor-a"),
      ],
      [handedOver("b1")],
    );
    await expect(
      retiredAccountIdsByAnchorBinding(svc as never, "client-1", ["anchor-a"]),
    ).resolves.toEqual(new Map([["anchor-a", ["acct-handed"]]]));
  });

  it("ignores rows outside the requested anchors or client, and pairs, defensively", async () => {
    const svc = service(
      [
        revokedChild("b1", "acct-handed", "anchor-a"),
        { ...revokedChild("b2", "acct-foreign", "anchor-a"), client_id: "client-2" },
        revokedChild("b3", "acct-elsewhere", "anchor-unknown"),
        { ...revokedChild("b4", "acct-pair", "anchor-a"), shopify_connection_id: "shopify-1" },
      ],
      [handedOver("b1"), handedOver("b2"), handedOver("b3"), handedOver("b4")],
    );
    await expect(
      retiredAccountIdsByAnchorBinding(svc as never, "client-1", ["anchor-a"]),
    ).resolves.toEqual(new Map([["anchor-a", ["acct-handed"]]]));
  });

  it("never reads evidence for a client with no revoked children", async () => {
    const svc = service([], []);
    await expect(
      retiredAccountIdsByAnchorBinding(svc as never, "client-1", ["anchor-a"]),
    ).resolves.toEqual(new Map());
    expect(svc.from).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a client with no anchors and fails closed on errors", async () => {
    const empty = service([], []);
    await expect(
      retiredAccountIdsByAnchorBinding(empty as never, "client-1", []),
    ).resolves.toEqual(new Map());
    expect(empty.from).not.toHaveBeenCalled();

    await expect(
      retiredAccountIdsByAnchorBinding(
        service([], [], { bindings: { message: "boom" } }) as never,
        "client-1",
        ["anchor-a"],
      ),
    ).rejects.toThrow("The retired reporting bindings are unavailable.");
    await expect(
      retiredAccountIdsByAnchorBinding(
        service([revokedChild("b1", "acct", "anchor-a")], [], {
          events: { message: "boom" },
        }) as never,
        "client-1",
        ["anchor-a"],
      ),
    ).rejects.toThrow("The handover evidence is unavailable.");
  });
});
