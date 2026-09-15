import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The project configures no "@/" alias for the test runner, so every runtime
// import of the view gets a plain stand-in, as the neighbouring component
// tests do. `money` is deliberately mocked to a euro string: the first thing
// this file asserts is that no such string reaches the markup.
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/page-container", () => ({
  PageContainer: ({
    title,
    description,
    actions,
    children,
  }: {
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      {actions}
      {children}
    </main>
  ),
}));

vi.mock("@/components/finance/finance-ui", () => ({
  StatCard: ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
    <div>
      {label}: {value}
      {hint ? ` (${hint})` : ""}
    </div>
  ),
  ErrorBanner: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("@/components/finance/commission-dialog", () => ({
  CommissionDialog: () => <span>Commission dialog</span>,
}));

vi.mock("@/components/finance/use-finance", () => ({
  useFinance: (initial: unknown, initialRange: unknown) => ({
    data: initial,
    range: initialRange,
    setRange: () => {},
    refresh: () => {},
    loading: false,
    error: null,
    setError: () => {},
  }),
}));

vi.mock("@/lib/finance/queries", () => ({
  totals: () => ({ revenue: 48_210.5, expenses: 12_005.25, profit: 36_205.25, margin: 0.751 }),
}));

vi.mock("@/lib/format-intl", () => ({
  money: (value: number) => `€${Number(value).toFixed(2)}`,
  percent: (value: number) => `${(value * 100).toFixed(1)}%`,
  shortDate: (iso: string) => iso,
}));

vi.mock("@/lib/i18n", () => ({
  fmt: (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (match: string, key: string) =>
      key in values ? String(values[key]) : match,
    ),
}));

// The real English copy, reached by a relative path because the alias is not
// available here: the assertions read the sentences the owner will read.
vi.mock("@/lib/i18n/provider", async () => {
  const { en } = await import("../../lib/i18n/dictionaries");
  return { useI18n: () => ({ locale: "en", d: en, intl: "en-GB" }) };
});

import type { RangeSelection } from "@/lib/portal/range";
import type { AdminOperations } from "@/lib/admin/operations-overview";

import { OverviewView, figuresKey, figuresStore, relativeFromNow } from "./overview-view";

const RANGE: RangeSelection = { key: "d30", from: "2026-08-17", to: "2026-09-15" };

/** A quiet, healthy morning: nothing waiting, everything reporting. */
function operations(over: Partial<AdminOperations> = {}): AdminOperations {
  return {
    needsDecision: {
      pendingClients: 0,
      pendingAccounts: 0,
      accountRequests: 0,
      newCreatives: 0,
      failingConnections: 0,
    },
    reporting: {
      storesBound: 5,
      storesReportingToday: 3,
      storesSilentToday: 2,
      lastMetricAt: "2026-09-15T10:00:00Z",
    },
    snapshots: { fresh: 4, total: 6, oldestSuccessAt: "2026-09-15T08:00:00Z" },
    activeClients: 4,
    ...over,
  };
}

function render(over: Partial<AdminOperations> = {}) {
  return renderToStaticMarkup(
    <OverviewView
      sources={[]}
      initialRange={RANGE}
      firstName="Tomas"
      currentUserId="user-1"
      operations={operations(over)}
    />,
  );
}

describe("the admin overview", () => {
  it("draws no money at all until someone asks for it", () => {
    const html = render();

    // The whole point of the page: opened with people beside him, it shows
    // nothing anyone could read as the agency's revenue.
    expect(html).not.toContain("€");
    expect(html).not.toContain("48210");
    expect(html).not.toContain("12005");
    expect(html).not.toContain("36205");
    expect(html).not.toContain("75.1%");

    // The figures are one click away, and the button starts in the off state.
    expect(html).toContain("Show figures");
    expect(html).not.toContain("Hide figures");
    expect(html).not.toContain("Open the revenue page");

    // Everything that duplicated /admin/revenue is gone from this page.
    expect(html).not.toContain("Revenue vs Expenses");
    expect(html).not.toContain("Where revenue comes from");
    expect(html).not.toContain("Top clients");

    // And the header now describes the page as it actually is.
    expect(html).toContain("Hi, Tomas");
    expect(html).toContain("What needs a decision, and how the reporting is running.");
  });

  it("lists only the counts that are really waiting, each pointing where it is handled", () => {
    const html = render({
      needsDecision: {
        pendingClients: 2,
        pendingAccounts: 0,
        accountRequests: 1,
        newCreatives: 0,
        failingConnections: 3,
      },
    });

    expect(html).toContain("Clients waiting for approval");
    expect(html).toContain("Account requests to review");
    expect(html).toContain("Connections reporting an error");
    expect(html).toContain(">2<");
    expect(html).toContain(">1<");
    expect(html).toContain(">3<");
    expect(html).toContain('href="/admin/clients"');
    expect(html).toContain('href="/admin/reporting"');

    // A zero is not a decision, so it gets no row and no link of its own.
    expect(html).not.toContain("Ad accounts waiting for approval");
    expect(html).not.toContain("New creatives to review");
    expect(html).not.toContain('href="/admin/creatives"');
    expect(html).not.toContain("Nothing is waiting on you.");
  });

  it("says a check it could not read is unknown, and does not call the rest clear", () => {
    const html = render({
      needsDecision: {
        pendingClients: 0,
        pendingAccounts: 0,
        accountRequests: 0,
        newCreatives: 0,
        failingConnections: null,
      },
    });

    expect(html).toContain("Connection health could not be read, so treat it as unknown.");
    // "Nothing is waiting on you" is a claim about every check, and one of them
    // did not answer.
    expect(html).not.toContain("Nothing is waiting on you.");
    // A count nobody could read is never drawn as a row of zero.
    expect(html).not.toContain("Connections reporting an error");
    expect(html).not.toContain(">0<");
  });

  it("keeps the counts that are waiting beside a connection check it could not read", () => {
    const html = render({
      needsDecision: {
        pendingClients: 2,
        pendingAccounts: 0,
        accountRequests: 0,
        newCreatives: 0,
        failingConnections: null,
      },
    });

    expect(html).toContain("Clients waiting for approval");
    expect(html).toContain(">2<");
    expect(html).toContain("Connection health could not be read, so treat it as unknown.");
    expect(html).not.toContain("Connections reporting an error");
  });

  it("says plainly that nothing is waiting rather than showing five zeros", () => {
    const html = render();

    expect(html).toContain("Needs you");
    expect(html).toContain("Nothing is waiting on you.");
    expect(html).not.toContain("Clients waiting for approval");
    expect(html).not.toContain("Connections reporting an error");
  });

  it("never draws a group it could not read as a zero", () => {
    const html = render({
      needsDecision: null,
      reporting: null,
      snapshots: null,
      activeClients: null,
    });

    expect(html).toContain("This check could not be read, so treat it as unknown.");
    expect(html).toContain("The reporting pulse could not be read.");
    expect(html).toContain("Snapshot health could not be read.");
    expect(html).toContain("The client count could not be read.");
    expect(html).toContain("—");

    // "No store is silent" and "we could not ask" are different facts.
    expect(html).not.toContain(">0<");
    expect(html).not.toContain("0/0");
    expect(html).not.toContain("Nothing is waiting on you.");
  });

  it("shows how the reporting is running, out of what", () => {
    const html = render();

    expect(html).toContain("How reporting is running");
    expect(html).toContain("Stores reporting today");
    expect(html).toContain("3/5");
    expect(html).toContain("5 stores bound");
    expect(html).toContain("Stores silent today");
    expect(html).toContain(">2<");
    expect(html).toContain("Last metric written");
    expect(html).toContain("Snapshots fresh");
    expect(html).toContain("4/6");
    expect(html).toContain("oldest success");
    expect(html).toContain("Active clients");
    expect(html).toContain("clients with a live store");
    expect(html).toContain(">4<");

    // Relative times wait for the browser: the server has neither the reader's
    // clock nor the reader's timezone, so it renders the placeholder instead.
    expect(html).toContain("…");
  });

  it("keeps a missing timestamp honest without losing the count beside it", () => {
    const html = render({
      reporting: {
        storesBound: 5,
        storesReportingToday: 0,
        storesSilentToday: 5,
        lastMetricAt: null,
      },
      snapshots: { fresh: 0, total: 6, oldestSuccessAt: null },
    });

    expect(html).toContain("0/5");
    expect(html).toContain("nothing written today");
    expect(html).toContain("0/6");
    expect(html).toContain("no successful run recorded");
  });
});

describe("the figures reveal", () => {
  const stored = new Map<string, string>();

  beforeEach(() => {
    stored.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remembers the reveal for the person as well as for the machine", () => {
    const owner = figuresStore("owner");
    owner.subscribe(() => {});
    owner.toggle();

    expect(owner.read()).toBe(true);
    expect(stored.get(figuresKey("owner"))).toBe("1");

    // The same browser profile, a different admin: nothing was revealed to
    // them, so the page opens with no money on it.
    const colleague = figuresStore("colleague");
    colleague.subscribe(() => {});

    expect(colleague.read()).toBe(false);
    expect(stored.has(figuresKey("colleague"))).toBe(false);
  });

  it("forgets the reveal when it is switched back off", () => {
    const store = figuresStore("switcher");
    store.subscribe(() => {});
    store.toggle();
    store.toggle();

    expect(store.read()).toBe(false);
    expect(stored.has(figuresKey("switcher"))).toBe(false);
  });

  it("keeps the toggle working on a device that refuses to remember", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("Site data is blocked.");
      },
    });

    const store = figuresStore("blocked");
    store.subscribe(() => {});

    expect(store.read()).toBe(false);
    store.toggle();
    expect(store.read()).toBe(true);
  });
});

describe("relativeFromNow", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");

  it("picks the unit a person would use for the distance", () => {
    expect(relativeFromNow("2026-09-15T11:59:40Z", now, "en-GB")).toBe("20 seconds ago");
    expect(relativeFromNow("2026-09-15T11:49:00Z", now, "en-GB")).toBe("11 minutes ago");
    expect(relativeFromNow("2026-09-15T09:00:00Z", now, "en-GB")).toBe("3 hours ago");
    expect(relativeFromNow("2026-09-13T12:00:00Z", now, "en-GB")).toBe("2 days ago");
  });

  it("reads an offset timestamp as the instant it is, not as text", () => {
    // Postgres hands back offsets as well as "Z", and both spell the same moment.
    expect(relativeFromNow("2026-09-15T12:49:00+01:00", now, "en-GB")).toBe("11 minutes ago");
  });

  it("shows a dash rather than inventing a time from an unparsable value", () => {
    expect(relativeFromNow("not a timestamp", now, "en-GB")).toBe("—");
  });
});
