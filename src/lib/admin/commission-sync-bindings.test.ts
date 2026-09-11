import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which store a Google account's spend belongs to, read from the database.
 *
 * The pure rules are proven in commission-sync.test.ts against hand-built rows.
 * What those tests cannot see is the half only a real query shape gets wrong:
 * which binding statuses are read, which anchor event counts as evidence and
 * under WHICH column it is keyed, and whether either read can come back
 * silently short. Get any of that wrong and an account resolves to no store,
 * which the ledger reads as "bill the whole Google account" - another store's
 * campaigns included.
 */
vi.mock("server-only", () => ({}));
vi.mock("../google-ads/client", () => ({ searchGoogleAdsAsAgency: vi.fn() }));

import {
  googleSourceBindingsForAccounts,
  ledgerStoreDomainsByAccount,
} from "./commission-sync-bindings";

type Row = Record<string, unknown>;
type Call = { table: string; columns: string; filters: unknown[][] };

const ACCOUNT = "acct-1";
const STORE = "shop-1";

let fixture: Record<string, Row[]>;
let calls: Call[];

function binding(over: Row = {}): Row {
  return {
    id: "binding-1",
    ad_account_id: ACCOUNT,
    shopify_connection_id: null,
    shopify_anchor_binding_id: null,
    status: "active",
    bound_at: "2026-08-01T00:00:00.000Z",
    revoked_at: null,
    ...over,
  };
}

/** A builder that answers like PostgREST: filters applied, then capped. */
function client() {
  return {
    from(table: string) {
      const call: Call = { table, columns: "", filters: [] };
      calls.push(call);
      let rows = [...(fixture[table] ?? [])];
      let cap = Number.POSITIVE_INFINITY;
      const builder = {
        select(columns: string) {
          call.columns = columns;
          return builder;
        },
        in(column: string, values: unknown[]) {
          call.filters.push(["in", column, values]);
          rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push(["eq", column, value]);
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        gt(column: string, value: string) {
          call.filters.push(["gt", column, value]);
          rows = rows.filter((row) => String(row[column]) > value);
          return builder;
        },
        order(column: string, options: { ascending: boolean }) {
          call.filters.push(["order", column]);
          rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])));
          if (!options.ascending) rows.reverse();
          return builder;
        },
        not(column: string, _operator: string, _value: unknown) {
          call.filters.push(["not", column]);
          rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
          return builder;
        },
        limit(count: number) {
          cap = count;
          return builder;
        },
        then<T>(resolve: (value: { data: Row[]; error: null }) => T) {
          return Promise.resolve({ data: rows.slice(0, cap), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

// The stub is structural, not a Supabase client: this function only ever calls
// the builder methods above.
const resolve = () => ledgerStoreDomainsByAccount(client() as never, [ACCOUNT]);

beforeEach(() => {
  calls = [];
  fixture = {
    client_reporting_bindings: [],
    client_reporting_anchor_events: [],
    client_shopify_connections: [
      { id: STORE, shopify_domain: "kinu-ito.myshopify.com", primary_domain: "kinu-ito.com" },
    ],
  };
});

describe("resolving a billable account's store from the database", () => {
  it("reads revoked bindings too, and keys each event on the right column", async () => {
    // The three query shapes in one assertion. Reading only 'active' loses a
    // retired account's store; keying 'handed_over' on binding_id instead of
    // prior_binding_id finds nothing at all, and "nothing" here does not mean
    // "no filter" - it means the whole shared account is billed to one store.
    fixture.client_reporting_bindings = [
      binding({
        status: "revoked",
        shopify_connection_id: STORE,
        revoked_at: "2026-09-01T00:00:00.000Z",
      }),
    ];
    await resolve();

    const bindingRead = calls.find((call) => call.table === "client_reporting_bindings");
    expect(bindingRead?.filters).toContainEqual([
      "in",
      "status",
      ["active", "staged", "revoked"],
    ]);
    const events = calls.filter((call) => call.table === "client_reporting_anchor_events");
    expect(events).toHaveLength(2);
    expect(events[0]!.filters).toContainEqual([
      "in",
      "event_type",
      ["store_retired", "source_retired", "source_abandoned"],
    ]);
    expect(events[0]!.filters).toContainEqual(["in", "binding_id", ["binding-1"]]);
    expect(events[1]!.filters).toContainEqual(["eq", "event_type", "handed_over"]);
    expect(events[1]!.filters).toContainEqual(["in", "prior_binding_id", ["binding-1"]]);
  });

  it("keeps a retired account filtered to the store it spent for", async () => {
    // A retired child names its store through the anchor, and that anchor is
    // itself revoked by now - so reading anchors as 'active' only would lose
    // the store just as surely.
    fixture.client_reporting_bindings = [
      binding({
        status: "revoked",
        shopify_anchor_binding_id: "anchor-1",
        revoked_at: "2026-09-01T00:00:00.000Z",
      }),
      binding({
        id: "anchor-1",
        ad_account_id: "anchor-account",
        status: "revoked",
        shopify_connection_id: STORE,
      }),
    ];
    fixture.client_reporting_anchor_events = [
      {
        id: "event-1",
        binding_id: "binding-1",
        prior_binding_id: null,
        event_type: "source_retired",
      },
    ];

    const { storeDomainsByAccount, retiredBoundAccountIds } = await resolve();
    expect(storeDomainsByAccount.get(ACCOUNT)).toContain("kinu-ito.com");
    expect(retiredBoundAccountIds.has(ACCOUNT)).toBe(true);
  });

  it("accepts a handover's evidence, which names the binding it superseded", async () => {
    fixture.client_reporting_bindings = [
      binding({
        status: "revoked",
        shopify_connection_id: STORE,
        revoked_at: "2026-09-01T00:00:00.000Z",
      }),
    ];
    fixture.client_reporting_anchor_events = [
      {
        id: "event-1",
        binding_id: "successor",
        prior_binding_id: "binding-1",
        event_type: "handed_over",
      },
    ];

    const { storeDomainsByAccount } = await resolve();
    expect(storeDomainsByAccount.get(ACCOUNT)).toContain("kinu-ito.com");
  });

  it("leaves an ordinary unbind exactly as it was", async () => {
    // No event names this binding, so it stays silent and the account is NOT
    // marked retired: it reads whole, as it did before any of this existed.
    // Attributing it to the store it just left would rewrite live commissions
    // down to campaigns that store no longer runs.
    fixture.client_reporting_bindings = [
      binding({
        status: "revoked",
        shopify_connection_id: STORE,
        revoked_at: "2026-09-01T00:00:00.000Z",
      }),
    ];

    const { storeDomainsByAccount, retiredBoundAccountIds } = await resolve();
    expect(storeDomainsByAccount.has(ACCOUNT)).toBe(false);
    expect(retiredBoundAccountIds.has(ACCOUNT)).toBe(false);
  });

  it("pages the binding history instead of stopping at PostgREST's cap", async () => {
    // Widening the read to three statuses tied it to lifetime history, which
    // never shrinks: binding rows are refused deletion. PostgREST answers a
    // query matching more than db-max-rows with the first page, HTTP 200 and no
    // error, so a capped read is indistinguishable from a complete one - and
    // the account whose live binding fell off the end is billed whole.
    const filler = Array.from({ length: 1_000 }, (_unused, index) =>
      binding({
        id: `binding-${String(index).padStart(4, "0")}`,
        status: "revoked",
        revoked_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    fixture.client_reporting_bindings = [
      ...filler,
      binding({ id: "binding-zzz", shopify_connection_id: STORE }),
    ];

    const { storeDomainsByAccount } = await resolve();
    expect(calls.filter((call) => call.table === "client_reporting_bindings")).toHaveLength(2);
    expect(storeDomainsByAccount.get(ACCOUNT)).toContain("kinu-ito.com");
  });
});

describe("which Google source answers for an account", () => {
  // The billing gate that suppresses accrual on a non-EUR source reads this.
  const googleBinding = (over: Row = {}): Row =>
    binding({ google_ads_connection_id: "google-1", ...over });

  it("prefers the live binding and ignores what it replaced", async () => {
    fixture.client_reporting_bindings = [
      googleBinding({ id: "old", status: "revoked", google_ads_connection_id: "google-old" }),
      googleBinding({ id: "new" }),
    ];
    fixture.client_reporting_anchor_events = [
      { id: "event-1", binding_id: "old", prior_binding_id: null, event_type: "source_retired" },
    ];

    const rows = await googleSourceBindingsForAccounts(client() as never, [ACCOUNT]);
    expect(rows).toEqual([
      { ad_account_id: ACCOUNT, google_ads_connection_id: "google-1" },
    ]);
  });

  it("still answers for a retired source, so the non-EUR gate holds", async () => {
    // Retiring a non-EUR source must not quietly re-enable accrual on spend
    // the EUR-only invoice chain can never book.
    fixture.client_reporting_bindings = [
      googleBinding({ id: "retired", status: "revoked" }),
    ];
    fixture.client_reporting_anchor_events = [
      { id: "event-1", binding_id: "retired", prior_binding_id: null, event_type: "source_retired" },
    ];

    const rows = await googleSourceBindingsForAccounts(client() as never, [ACCOUNT]);
    expect(rows).toEqual([
      { ad_account_id: ACCOUNT, google_ads_connection_id: "google-1" },
    ]);
  });

  it("says nothing for an ordinary unbind", async () => {
    fixture.client_reporting_bindings = [
      googleBinding({ id: "unbound", status: "revoked" }),
    ];

    expect(await googleSourceBindingsForAccounts(client() as never, [ACCOUNT])).toEqual([]);
  });
});
