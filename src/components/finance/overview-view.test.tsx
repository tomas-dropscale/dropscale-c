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

import { OverviewView, figuresKey, figuresStore, pulseTone, relativeFromNow } from "./overview-view";

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
    // The placeholder reads as an answer that is missing, never as a value of
    // nothing, and it is the one the rest of the page already uses.
    expect(html).toContain("…");

    // "No store is silent" and "we could not ask" are different facts.
    expect(html).not.toContain(">0<");
    expect(html).not.toContain("0/0");
    expect(html).not.toContain("Nothing is waiting on you.");
  });

  it("shows how the reporting is running, out of what", () => {
    const html = render();

    expect(html).toContain("How reporting is running");
    expect(html).toContain("Stores reporting today");
    // The hero says it as a count and an "of", and the bar beneath it carries
    // the name of what the length is a share of.
    expect(html).toContain(">3<");
    expect(html).toContain("of 5");
    expect(html).toContain("5 stores bound");
    expect(html).toContain("Last metric written");
    expect(html).toContain("Snapshots fresh");
    expect(html).toContain("4/6");
    expect(html).toContain("oldest success");
    expect(html).toContain("Active clients");
    expect(html).toContain("clients with a live store");
    expect(html).toContain(">4<");

    // The stores that went silent are the hero subtracted from itself, so the
    // supporting row says something the hero cannot instead of echoing it.
    expect(html).not.toContain("Stores silent today");

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

    expect(html).toContain(">0<");
    expect(html).toContain("of 5");
    expect(html).toContain("nothing written today");
    expect(html).toContain("0/6");
    expect(html).toContain("no successful run recorded");
  });

  it("colours the pulse by how many bound stores went silent today", () => {
    const healthy = render({
      reporting: {
        storesBound: 5,
        storesReportingToday: 5,
        storesSilentToday: 0,
        lastMetricAt: "2026-09-15T10:00:00Z",
      },
    });
    expect(healthy).toMatch(/data-tone="healthy"[^>]*text-\[var\(--success-green\)\]/);
    expect(healthy).toContain('class="h-full rounded-full transition-smooth bg-[var(--success-green)]"');
    expect(healthy).toContain("Healthy");

    // One store quiet on a working morning is a store without its first sale
    // yet, so it is gold: worth a glance, not an alarm.
    const watch = render({
      reporting: {
        storesBound: 5,
        storesReportingToday: 4,
        storesSilentToday: 1,
        lastMetricAt: "2026-09-15T10:00:00Z",
      },
    });
    expect(watch).toMatch(/data-tone="watch"[^>]*text-\[var\(--accent-gold-strong\)\]/);
    expect(watch).toContain('class="h-full rounded-full transition-smooth bg-[var(--accent-gold)]"');
    expect(watch).toContain("Watch");

    const behind = render({
      reporting: {
        storesBound: 5,
        storesReportingToday: 1,
        storesSilentToday: 4,
        lastMetricAt: "2026-09-15T10:00:00Z",
      },
    });
    expect(behind).toMatch(/data-tone="behind"[^>]*text-\[var\(--danger-red\)\]/);
    expect(behind).toContain('class="h-full rounded-full transition-smooth bg-[var(--danger-red)]"');
    expect(behind).toContain("Behind");

    // "No store is silent" and "we could not ask" must never wear one colour,
    // and the one state that needs a person to go and look is drawn in
    // secondary text rather than the 2.4:1 muted grey it used to carry.
    const unknown = render({ reporting: null });
    expect(unknown).toMatch(/data-tone="unknown"[^>]*text-\[var\(--text-secondary\)\]/);
    expect(unknown).not.toMatch(/data-tone="unknown"[^>]*text-\[var\(--text-muted\)\]/);
    expect(unknown).toContain("Unknown");
  });

  it("refuses to call an empty measurement healthy", () => {
    const html = render({
      reporting: {
        storesBound: 0,
        storesReportingToday: 0,
        storesSilentToday: 0,
        lastMetricAt: null,
      },
    });

    // Zero silent out of zero bound clears every threshold, which is how a
    // green "Healthy" ended up over a bar measuring nothing at all.
    expect(html).toMatch(/data-tone="unknown"/);
    expect(html).not.toContain("Healthy");
    expect(html).toContain("No store is bound yet, so there is no pulse to read.");
    expect(html).toContain("of 0");
  });

  it("gives a check it could not read a mark of its own, not a grey sentence", () => {
    const html = render({ needsDecision: null });

    // The all clear had an icon and the two failures had one muted line, so a
    // failed check read as a quiet morning to anyone skimming the panel.
    expect(html).toContain("lucide-circle-alert");
    expect(html).toContain("This check could not be read, so treat it as unknown.");
    expect(html).not.toContain("lucide-circle-check");
  });

  it("keeps both header buttons at a real thumb target on a phone", () => {
    const html = render();

    // The important modifier is the fix, not decoration: the unlayered phone
    // block in globals.css floors every button at 36px and outranks anything
    // in @layer utilities, so a plain min-h-11 loses on the only device that
    // has thumbs.
    expect(html.match(/min-h-11!/g)).toHaveLength(2);
  });

  it("keeps the progress track on screen at zero width when nothing is bound", () => {
    const html = render({
      reporting: {
        storesBound: 0,
        storesReportingToday: 0,
        storesSilentToday: 0,
        lastMetricAt: null,
      },
    });

    // Drawn, not hidden: the panel keeps its height on the day the last
    // binding is removed.
    expect(html).toContain('role="progressbar"');
    expect(html).toMatch(/style="width:\s*0%"/);
  });

  it("counts the total beside the heading only when something is actually waiting", () => {
    const waiting = render({
      needsDecision: {
        pendingClients: 2,
        pendingAccounts: 0,
        accountRequests: 1,
        newCreatives: 0,
        failingConnections: 3,
      },
    });

    // Six decisions, not three rows: it counts the things, not the kinds, and
    // it says the word rather than hiding it in a label only a screen reader
    // was given.
    expect(waiting).toMatch(/>6 waiting</);

    // A quantity is not a verdict, so it wears none of the pill's gold: the
    // only capsule on the page is the one judging the reporting.
    expect(waiting).not.toMatch(/rounded-full bg-\[var\(--accent-gold-dim\)\] px-2\.5/);

    // A quiet morning gets no count at all rather than one reading zero.
    expect(render()).not.toMatch(/>\d+ waiting</);
  });

  it("paints a broken connection as a fault, not as another queue", () => {
    const html = render({
      needsDecision: {
        pendingClients: 2,
        pendingAccounts: 0,
        accountRequests: 0,
        newCreatives: 0,
        failingConnections: 3,
      },
    });

    // Gold is the colour of work waiting. A connection answering with an error
    // is already broken, and it was wearing the same gold as a new creative
    // while silent stores were drawn in red one panel below.
    expect(html).toMatch(/text-\[var\(--danger-red\)\][^<]*>[\s]*3[\s]*</);
    expect(html).toContain("Connections reporting an error");
    expect(html).toContain("Clients waiting for approval");
  });

  it("draws the all clear as a block with its mark, not as a bare sentence", () => {
    const html = render();

    expect(html).toContain("lucide-circle-check");
    expect(html).toContain("Nothing is waiting on you.");

    // And it leaves the moment there is something to decide.
    const waiting = render({
      needsDecision: {
        pendingClients: 1,
        pendingAccounts: 0,
        accountRequests: 0,
        newCreatives: 0,
        failingConnections: 0,
      },
    });
    expect(waiting).not.toContain("lucide-circle-check");
  });

  it("keeps the reveal in the header rather than in a panel of its own", () => {
    const html = render();

    // The mocked PageContainer prints its actions before its children, so the
    // toggle standing before the first panel is the toggle having left the body.
    expect(html.indexOf("Show figures")).toBeGreaterThan(-1);
    expect(html.indexOf("Show figures")).toBeLessThan(html.indexOf("Needs you"));

    // The window belongs to the figures, so it is not on a page showing none.
    expect(html).not.toContain(RANGE.from);
  });
});

describe("pulseTone", () => {
  const reporting = (storesSilentToday: number) => ({
    storesBound: 5,
    storesReportingToday: 5 - storesSilentToday,
    storesSilentToday,
    lastMetricAt: null,
  });

  it("turns on silence, and keeps a pulse it could not read apart from a quiet one", () => {
    expect(pulseTone(reporting(0))).toBe("healthy");
    expect(pulseTone(reporting(1))).toBe("watch");
    expect(pulseTone(reporting(2))).toBe("watch");
    expect(pulseTone(reporting(3))).toBe("behind");
    expect(pulseTone(null)).toBe("unknown");
  });

  it("treats nothing bound as nothing measured, not as health", () => {
    expect(
      pulseTone({
        storesBound: 0,
        storesReportingToday: 0,
        storesSilentToday: 0,
        lastMetricAt: null,
      }),
    ).toBe("unknown");
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
