"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import { ErrorBanner, StatCard } from "@/components/finance/finance-ui";
import { CommissionDialog, type CommissionTarget } from "@/components/finance/commission-dialog";
import { useFinance } from "@/components/finance/use-finance";
import { totals } from "@/lib/finance/queries";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import { money, percent, shortDate } from "@/lib/format-intl";
import type { RangeSelection } from "@/lib/portal/range";
import type { FinanceSnapshot } from "@/lib/finance/queries";
import type { RevenueSource } from "@/lib/supabase/types";
import type { AdminOperations } from "@/lib/admin/operations-overview";

/**
 * The admin landing page: what the agency has to act on, then how the machine
 * behind the numbers is running. No money is drawn when the page loads.
 *
 * This used to be a strict copy of /admin/revenue: the same four money cards,
 * the same chart, the same breakdowns, which made the first screen of every
 * session a revenue statement. The owner opens it on a laptop and on a phone
 * with other people beside him, and none of those figures were lost by moving
 * them: /admin/revenue still shows all of it plus the day by day table.
 *
 * So the figures did not disappear, they stopped being the default. The toggle
 * at the end reveals the same summary for the default window, and the choice is
 * remembered per device and per person, which is the scope that matches the
 * problem: it is the room the laptop is in that decides whether money can be on
 * screen, and the next person to sign in on that laptop never inherits a reveal
 * they did not ask for.
 *
 * The page arrives with no money in it at all, not merely with none drawn. The
 * server sends the partner list and the operations counts, and the first reveal
 * fetches the window from the browser, so view-source and the network response
 * of a screen nobody asked to see carry no commission and no expense.
 */

/**
 * Per device AND per person.
 *
 * localStorage belongs to the browser profile, not to the session, so one
 * shared key would survive sign-out: the next admin to open /admin on this
 * machine would be shown the money one paint after hydration, having touched
 * nothing. The user id in the key keeps the memory where it belongs, the way
 * use-notification-read-state takes its key from its caller.
 */
const FIGURES_KEY_PREFIX = "dropscale:overview-figures:v1";
const FIGURES_ON = "1";

/** A minute is the smallest distance any label on this page distinguishes. */
const CLOCK_TICK_MS = 60_000;

type OperationsFigure = {
  key: string;
  label: string;
  /** null draws a dash. A group we could not read must never look like a zero. */
  value: React.ReactNode | null;
  hint?: React.ReactNode;
};

export function OverviewView({
  sources,
  initialRange,
  firstName,
  currentUserId,
  operations,
}: {
  /**
   * The partner list, which is the only finance row the first screen needs:
   * it decides whether a commission can be recorded at all. It carries names
   * and default rates, never an amount.
   */
  sources: RevenueSource[];
  initialRange: RangeSelection;
  firstName: string;
  currentUserId: string;
  /** Counts and timestamps only, resolved on the server; no money travels here. */
  operations: AdminOperations;
}) {
  const { d, intl } = useI18n();

  /**
   * The snapshot the page starts with holds no money, and is kept by identity.
   *
   * useFinance replaces it only when a fetch has actually succeeded, so
   * comparing against this object is the honest answer to "do we hold real
   * figures yet": a reveal whose request failed keeps the dashes and the error
   * banner instead of printing a confident zero.
   */
  const [empty] = React.useState<FinanceSnapshot>(() => ({
    sources,
    clients: [],
    commissions: [],
    expenses: [],
    from: initialRange.from,
    to: initialRange.to,
  }));
  const { data, range, refresh, error, setError } = useFinance(empty, initialRange);
  const [target, setTarget] = React.useState<CommissionTarget | null>(null);

  const store = figuresStore(currentUserId);

  /**
   * Always hidden on the first render, whatever the device remembers.
   *
   * The server has no localStorage, so a first client render that already knew
   * the answer would disagree with the markup React is hydrating. The device is
   * only asked once the browser subscribes, one paint later, which makes both
   * ends agree and fails in the safe direction: a device that cannot be read
   * shows no money.
   */
  const showFigures = React.useSyncExternalStore(
    store.subscribe,
    store.read,
    figuresOnServer,
  );

  /**
   * The money is fetched when it is first asked for, never before.
   *
   * This runs for a click and for a device that remembers the reveal alike,
   * since both arrive as showFigures turning true. It fires once per visit: the
   * window does not change on this page, so a second toggle shows what is
   * already in hand instead of asking again.
   */
  const asked = React.useRef(false);
  React.useEffect(() => {
    if (!showFigures || asked.current) return;
    asked.current = true;
    void refresh();
  }, [showFigures, refresh]);

  const figures = React.useMemo(
    () => totals(data.commissions, data.expenses),
    [data.commissions, data.expenses],
  );
  const figuresReady = data !== empty;

  const needs = operations.needsDecision;

  /** Only what is actually waiting: a row that reads 0 is noise, not a decision. */
  const needsRows =
    needs === null
      ? []
      : [
          {
            key: "clients",
            count: needs.pendingClients,
            label: d.overview.needsClients,
            href: "/admin/clients",
          },
          {
            key: "accounts",
            count: needs.pendingAccounts,
            label: d.overview.needsAccounts,
            href: "/admin/clients",
          },
          {
            key: "requests",
            count: needs.accountRequests,
            label: d.overview.needsRequests,
            href: "/admin/clients",
          },
          {
            key: "creatives",
            count: needs.newCreatives,
            label: d.overview.needsCreatives,
            href: "/admin/creatives",
          },
          {
            key: "connections",
            // A health count nobody could answer is not a count of zero, so it
            // gets no row here and says so in a line of its own below.
            count: needs.failingConnections ?? 0,
            label: d.overview.needsConnections,
            href: "/admin/reporting",
          },
        ].filter((row) => row.count > 0);

  const connectionsUnknown = needs !== null && needs.failingConnections === null;

  const operationsFigures = buildOperationsFigures(operations, d, intl);

  return (
    <PageContainer
      title={fmt(d.overview.greeting, { name: firstName })}
      description={d.overview.subtitle}
      actions={
        <Button
          variant="primary"
          size="sm"
          onClick={() => setTarget({ mode: "create" })}
          disabled={data.sources.length === 0}
        >
          <Plus />
          {d.finance.revenue.newEntry}
        </Button>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="space-y-4">
        <section className="panel p-5">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {d.overview.needsTitle}
          </h2>

          {needs === null ? (
            <p className="mt-4 text-[13px] text-[var(--text-muted)]">
              {d.overview.needsUnavailable}
            </p>
          ) : (
            <>
              {needsRows.length > 0 && (
                <ul className="mt-4 flex flex-col gap-2">
                  {needsRows.map((row) => (
                    <li key={row.key}>
                      <Link
                        href={row.href}
                        className="flex min-h-11 items-center gap-3 rounded-[10px] border border-[var(--border-subtle)] px-3 py-2.5 transition-smooth hover:border-[var(--border-strong)] hover:bg-[var(--bg-panel-hover)]"
                      >
                        <span className="min-w-8 shrink-0 text-[17px] font-semibold text-[var(--accent-gold)] tabular-nums">
                          {row.count}
                        </span>
                        <span className="flex-1 text-[13px] text-[var(--text-primary)]">
                          {row.label}
                        </span>
                        <ArrowRight
                          className="size-3.5 shrink-0 text-[var(--text-muted)]"
                          aria-hidden
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {/* "Nothing is waiting" is a claim about every check, so it is
                  only made when every check actually answered. */}
              {needsRows.length === 0 && !connectionsUnknown && (
                <p className="mt-4 text-[13px] text-[var(--text-muted)]">
                  {d.overview.needsClear}
                </p>
              )}

              {connectionsUnknown && (
                <p
                  className={`text-[13px] text-[var(--text-muted)] ${
                    needsRows.length > 0 ? "mt-3" : "mt-4"
                  }`}
                >
                  {d.overview.needsConnectionsUnknown}
                </p>
              )}
            </>
          )}
        </section>

        <section className="panel p-5">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {d.overview.reportingTitle}
          </h2>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {operationsFigures.map((figure) => (
              <div
                key={figure.key}
                className="rounded-[10px] border border-[var(--border-subtle)] px-3 py-3"
              >
                <p className="label-caps">{figure.label}</p>
                <p className="mt-1.5 text-[19px] leading-tight font-semibold text-[var(--text-primary)] tabular-nums">
                  {figure.value ?? "—"}
                </p>
                {figure.hint && (
                  <p className="mt-1 text-[11.5px] text-[var(--text-secondary)]">{figure.hint}</p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={store.toggle}
              aria-expanded={showFigures}
              className="min-h-11"
            >
              {showFigures ? <EyeOff /> : <Eye />}
              {showFigures ? d.overview.hideFigures : d.overview.showFigures}
            </Button>

            {showFigures && (
              <span className="text-[11.5px] text-[var(--text-secondary)]">
                {shortDate(range.from, intl)} – {shortDate(range.to, intl)}
              </span>
            )}
          </div>

          {showFigures && (
            <div className="mt-4 space-y-3">
              {/* The ellipsis is the same placeholder the relative times use:
                  the figures are on their way from the browser, and a zero
                  standing in for them would be read as an answer. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatCard
                  label={d.overview.revenue}
                  value={figuresReady ? money(figures.revenue, intl) : "…"}
                  glow
                />
                <StatCard
                  label={d.overview.expenses}
                  value={figuresReady ? money(figures.expenses, intl) : "…"}
                  tone="danger"
                />
                <StatCard
                  label={d.overview.netProfit}
                  value={figuresReady ? money(figures.profit, intl) : "…"}
                  hint={`${d.overview.margin} ${
                    figuresReady ? percent(figures.margin, intl) : "…"
                  }`}
                  tone={figuresReady && figures.profit < 0 ? "danger" : "success"}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11.5px] text-[var(--text-muted)]">{d.overview.figuresDevice}</p>
                <Link
                  href="/admin/revenue"
                  className="flex min-h-11 items-center gap-1 text-[12px] text-[var(--text-secondary)] transition-smooth hover:text-[var(--accent-gold)]"
                >
                  {d.overview.openRevenue}
                  <ArrowRight className="size-3" aria-hidden />
                </Link>
              </div>
            </div>
          )}
        </section>
      </div>

      <CommissionDialog
        target={target}
        sources={data.sources}
        clients={data.clients}
        currentUserId={currentUserId}
        onClose={() => setTarget(null)}
        onSaved={refresh}
      />
    </PageContainer>
  );
}

/**
 * One tile per figure, and one tile per group we could not read.
 *
 * A group that failed contributes a single dashed tile carrying the reason
 * rather than three tiles repeating it, because the reader needs to know once
 * that the answer is missing, not three times that it is missing.
 */
function buildOperationsFigures(
  operations: AdminOperations,
  d: ReturnType<typeof useI18n>["d"],
  intl: string,
): OperationsFigure[] {
  const list: OperationsFigure[] = [];
  const { reporting, snapshots, activeClients } = operations;

  if (reporting === null) {
    list.push({
      key: "reporting",
      label: d.overview.storesReporting,
      value: null,
      hint: d.overview.reportingUnavailable,
    });
  } else {
    list.push({
      key: "reporting",
      label: d.overview.storesReporting,
      value: `${reporting.storesReportingToday}/${reporting.storesBound}`,
      hint: fmt(d.overview.storesBound, { count: reporting.storesBound }),
    });
    list.push({
      key: "silent",
      label: d.overview.storesSilent,
      value: String(reporting.storesSilentToday),
      hint: d.overview.storesSilentHint,
    });
    list.push({
      key: "last-metric",
      label: d.overview.lastMetric,
      value:
        reporting.lastMetricAt === null ? null : (
          <RelativeTime iso={reporting.lastMetricAt} intl={intl} />
        ),
      hint: reporting.lastMetricAt === null ? d.overview.lastMetricNone : undefined,
    });
  }

  if (snapshots === null) {
    list.push({
      key: "snapshots",
      label: d.overview.snapshotsFresh,
      value: null,
      hint: d.overview.snapshotsUnavailable,
    });
  } else {
    list.push({
      key: "snapshots",
      label: d.overview.snapshotsFresh,
      value: `${snapshots.fresh}/${snapshots.total}`,
      hint:
        snapshots.oldestSuccessAt === null ? (
          d.overview.snapshotsNone
        ) : (
          <>
            {d.overview.snapshotsOldest} <RelativeTime iso={snapshots.oldestSuccessAt} intl={intl} />
          </>
        ),
    });
  }

  list.push(
    activeClients === null
      ? {
          key: "active-clients",
          label: d.overview.activeClients,
          value: null,
          hint: d.overview.activeClientsUnavailable,
        }
      : {
          key: "active-clients",
          label: d.overview.activeClients,
          value: String(activeClients),
          hint: d.overview.activeClientsHint,
        },
  );

  return list;
}

/**
 * "11 minutes ago", in the reader's clock and language.
 *
 * Both halves of this have to happen in the browser. The relative part is
 * measured against the reader's now, and the absolute part in the title is
 * formatted in the reader's timezone. A server component would format that
 * wherever the server happens to be, which on Cloudflare is UTC.
 */
function RelativeTime({ iso, intl }: { iso: string; intl: string }) {
  const nowMs = React.useSyncExternalStore(subscribeClock, readClock, clockOnServer);

  // Zero is the server's answer: there is no clock to measure against yet, so
  // the tile shows an ellipsis rather than a wrong time. Same shape, so nothing
  // moves on screen when the real value arrives.
  if (nowMs === 0) return <>…</>;

  return (
    <span title={new Date(iso).toLocaleString(intl)}>{relativeFromNow(iso, nowMs, intl)}</span>
  );
}

/**
 * Exported for the tests: the rounding is the part worth pinning down, since
 * "an hour ago" and "59 minutes ago" describe the same instant differently.
 */
export function relativeFromNow(iso: string, nowMs: number, intl: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";

  const seconds = Math.round((at - nowMs) / 1000);
  const magnitude = Math.abs(seconds);
  // "auto" so the near past reads as "now" and "yesterday" instead of counting.
  const relative = new Intl.RelativeTimeFormat(intl, { numeric: "auto" });

  if (magnitude < 60) return relative.format(seconds, "second");
  if (magnitude < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (magnitude < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86_400), "day");
}

/**
 * The reveal, kept outside React as a tiny store of its own, one per person.
 *
 * It is read through useSyncExternalStore rather than set from an effect so
 * the render itself stays pure and the hydrating markup is never contradicted:
 * React renders the server answer first and only then asks the device.
 *
 * The truth is held in memory and merely SEEDED from localStorage, which is
 * what keeps the button working in a browser with site data blocked. There the
 * accessor throws on every call, so a screen that read the device on each
 * render would find "hidden" forever and the button would do nothing at all.
 *
 * The store is kept in a map rather than rebuilt per render because
 * useSyncExternalStore needs the same subscribe and read functions across
 * renders, and a fresh pair every time would resubscribe on every paint.
 */
type FiguresStore = {
  subscribe: (listener: () => void) => () => void;
  read: () => boolean;
  toggle: () => void;
};

const figuresStores = new Map<string, FiguresStore>();

/** Exported for the tests: the key is the whole point of the per person scope. */
export function figuresKey(userId: string) {
  return `${FIGURES_KEY_PREFIX}:${userId}`;
}

export function figuresStore(userId: string): FiguresStore {
  const held = figuresStores.get(userId);
  if (held) return held;

  const key = figuresKey(userId);
  const listeners = new Set<() => void>();
  let shown: boolean | null = null;

  const store: FiguresStore = {
    subscribe(listener) {
      listeners.add(listener);
      // First subscriber asks the device; React re-reads the snapshot right
      // after subscribing, so the answer reaches the screen without an effect.
      if (shown === null) shown = remembersFigures(key);

      return () => {
        listeners.delete(listener);
      };
    },
    read: () => shown ?? false,
    toggle() {
      shown = !(shown ?? false);
      rememberFigures(key, shown);
      for (const listener of listeners) listener();
    },
  };

  figuresStores.set(userId, store);
  return store;
}

/** The server has no device to ask, so the page always renders hidden first. */
const figuresOnServer = () => false;

/**
 * Every localStorage call is guarded: the accessor itself throws in a browser
 * with site data blocked, and a landing page that crashes because it could not
 * read a preference would be a worse failure than forgetting the preference.
 */
function remembersFigures(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === FIGURES_ON;
  } catch {
    return false;
  }
}

function rememberFigures(key: string, shown: boolean) {
  try {
    if (shown) window.localStorage.setItem(key, FIGURES_ON);
    else window.localStorage.removeItem(key);
  } catch {
    // The device simply will not remember; the page keeps working.
  }
}

/**
 * One clock for every relative time on the page, read as an external value
 * rather than called during render.
 *
 * Date.now() is impure: a component that calls it while rendering prints a
 * different answer every time React happens to re-render it. Going through a
 * store keeps the render pure, and the minute tick is not decoration: a label
 * that said "11 minutes ago" when the tab was opened is simply wrong an hour
 * later, and this page is the one people leave open all day.
 */
let clockNow = 0;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);

  if (clockTimer === null) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const each of clockListeners) each();
    }, CLOCK_TICK_MS);
  }

  return () => {
    clockListeners.delete(listener);
    // The last tile to leave turns the timer off: nothing on screen is waiting
    // for it, and a stray interval would keep a closed page's work alive.
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const readClock = () => clockNow;

/** Zero means "no clock yet", which is exactly what the server can honestly say. */
const clockOnServer = () => 0;
