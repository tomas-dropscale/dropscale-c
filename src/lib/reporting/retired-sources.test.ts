import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { retiredAccountIdsByAnchorBinding } from "./retired-sources";

type Row = Record<string, unknown>;

function service(
  bindings: Row[],
  events: Row[],
  errors: { bindings?: unknown; events?: unknown; lineage?: unknown } = {},
  lineage: Row[] = [],
) {
  // One chain per call, answering by the query it actually built: the lineage
  // walk filters event_type with .in(), the evidence reads with .eq().
  const chain = (answer: (usedEqEventType: boolean) => { data: Row[]; error: unknown }) => {
    let eqEventType = false;
    const q: Record<string, ReturnType<typeof vi.fn>> & {
      then?: Promise<unknown>["then"];
    } = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      in: vi.fn(),
    };
    q.select.mockReturnValue(q);
    q.eq.mockImplementation((column: string) => {
      if (column === "event_type") eqEventType = true;
      return q;
    });
    q.is.mockReturnValue(q);
    q.in.mockReturnValue(q);
    q.then = (resolve, reject) => Promise.resolve(answer(eqEventType)).then(resolve, reject);
    return q;
  };
  const from = vi.fn((table: string) =>
    table === "client_reporting_bindings"
      ? chain(() => ({ data: bindings, error: errors.bindings ?? null }))
      : chain((usedEq) =>
          usedEq
            ? { data: events, error: errors.events ?? null }
            : { data: lineage, error: errors.lineage ?? null },
        ),
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
    // [0] is the anchor lineage walk, [1] the revoked children, [2] the evidence.
    const eventsQuery = svc.from.mock.results[2]!.value;
    expect(eventsQuery.eq).toHaveBeenCalledWith("event_type", "handed_over");
    expect(eventsQuery.in).toHaveBeenCalledWith("prior_binding_id", ["b1", "b2"]);
  });

  it("keeps the history of a Google account the client closed, under the store that spent it", async () => {
    // A retirement names the binding itself, where a handover names the
    // binding it moved. Both mean the same thing to a store: this account is
    // gone, and what it spent stays here.
    const svc = service(
      [revokedChild("b1", "acct-closed", "anchor-a")],
      [{ binding_id: "b1", event_type: "source_retired" }],
    );
    await expect(
      retiredAccountIdsByAnchorBinding(svc as never, "client-1", ["anchor-a"]),
    ).resolves.toEqual(new Map([["anchor-a", ["acct-closed"]]]));
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
    // The lineage walk and the children read; no evidence is asked for.
    expect(svc.from).toHaveBeenCalledTimes(2);
  });

  it("keeps a child retired under a store's PREVIOUS anchor binding", async () => {
    // Retiring a pair's Google side (0100) - and a store handover before it -
    // revokes the pair binding and mints a replacement with a NEW id. A child
    // retired earlier still names the old binding for ever, so without the
    // lineage its recorded spend would leave the store's totals silently.
    const svc = service(
      [revokedChild("b1", "acct-closed", "old-anchor")],
      [{ binding_id: "b1", event_type: "source_retired" }],
      {},
      [{ binding_id: "anchor-a", prior_binding_id: "old-anchor", event_type: "source_retired" }],
    );
    await expect(
      retiredAccountIdsByAnchorBinding(svc as never, "client-1", ["anchor-a"]),
    ).resolves.toEqual(new Map([["anchor-a", ["acct-closed"]]]));
    // Reported under the anchor the caller asked about, never the retired one.
    const childrenAt = svc.from.mock.calls.findIndex(
      ([table]) => table === "client_reporting_bindings",
    );
    const childrenQuery = svc.from.mock.results[childrenAt]!.value;
    expect(childrenQuery.in).toHaveBeenCalledWith(
      "shopify_anchor_binding_id",
      expect.arrayContaining(["anchor-a", "old-anchor"]),
    );
  });

  it("follows a RESTAGED store back to the anchor its children were retired under", async () => {
    // 0097 retires a store and leaves its identity reusable on purpose. When
    // the shop reconnects and the admin restages it, 0056 mints a new binding
    // whose event supersedes the old one - the same edge a handover and a pair
    // retirement leave. Following only two of the three loses the history.
    const svc = service(
      [revokedChild("b1", "acct-closed", "old-anchor")],
      [{ binding_id: "b1", event_type: "source_retired" }],
      {},
      [{ binding_id: "anchor-a", prior_binding_id: "old-anchor", event_type: "restaged" }],
    );
    await expect(
      retiredAccountIdsByAnchorBinding(svc as never, "client-1", ["anchor-a"]),
    ).resolves.toEqual(new Map([["anchor-a", ["acct-closed"]]]));
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
