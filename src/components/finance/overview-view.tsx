"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  Inbox,
  PlugZap,
  Plus,
  Sparkles,
  Store,
  UserPlus,
} from "lucide-react";

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
 * in the header reveals the same summary for the default window, and the choice
 * is remembered per device and per person, which is the scope that matches the
 * problem: it is the room the laptop is in that decides whether money can be on
 * screen, and the next person to sign in on that laptop never inherits a reveal
 * they did not ask for.
 *
 * The page arrives with no money in it at all, not merely with none drawn. The
 * server sends the partner list and the operations counts, and the first reveal
 * fetches the window from the browser, so view-source and the network response
 * of a screen nobody asked to see carry no commission and no expense.
 *
 * The shape of the screen is the other half of the job. Three panels of equal
 * weight read as three lists, and a reader who opens this at eight in the
 * morning is asking two questions in order: is anything waiting for me, and is
 * the reporting still alive. So the waiting work is a grid of cards a thumb can
 * hit, and the health panel leads with a single number, the stores reporting
 * today out of the stores bound, with the rest of the pulse demoted to one
 * divided row underneath it. The reveal is a control, not a subject, so it went
 * up into the header beside the other action and stopped costing a panel.
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

/**
 * One placeholder for every answer this page could not get, and it is the
 * ellipsis the relative times already use.
 *
 * A figure nobody could read must never arrive as a zero, and a dash is barely
 * better: a dash sits where a value goes and reads as a value of nothing, while
 * an ellipsis reads as an answer still missing. The short reason printed beside
 * it says which of the two failures it was.
 */
const UNKNOWN = "…";

/**
 * How many bound stores may be quiet before the morning is a problem.
 *
 * One or two silent stores early in the day is usually a store that has not had
 * its first sale yet, which is worth a glance and not an alarm. Past that the
 * shape is a sync that stopped, and that is the morning this pill exists for.
 */
const WATCH_LIMIT = 2;

type PulseTone = "healthy" | "watch" | "behind" | "unknown";

/**
 * The pill and the progress fill are deliberately the same colour: they are one
 * statement said twice, once as a word and once as a length, and a reader who
 * takes in only the bar still gets the verdict.
 */
const PULSE: Record<PulseTone, { pill: string; fill: string }> = {
  healthy: {
    pill: "border-[var(--success-green)]/25 bg-[var(--success-green)]/12 text-[var(--success-green)]",
    fill: "bg-[var(--success-green)]",
  },
  watch: {
    pill: "border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]",
    fill: "bg-[var(--accent-gold)]",
  },
  behind: {
    pill: "border-[var(--danger-red)]/25 bg-[var(--danger-red)]/12 text-[var(--danger-red)]",
    fill: "bg-[var(--danger-red)]",
  },
  unknown: {
    /*
     * Not the muted grey the rest of the page uses for a value it could not
     * read, because this one is a pill and a pill is read at a glance.
     *
     * --text-muted on the panel hover fill measures 2.4:1, which is the lowest
     * contrast on the screen, and it was carrying the single state that needs
     * a person to go and look. Secondary text clears 5:1 on the same fill, so
     * the quietest tone in the panel is still one you can actually read.
     */
    pill: "border-[var(--border-strong)] bg-[var(--bg-panel-hover)] text-[var(--text-secondary)]",
    fill: "bg-[var(--text-secondary)]",
  },
};

type ReportingFact = {
  key: string;
  label: string;
  /** Already resolved to text: UNKNOWN stands in for what could not be read. */
  value: React.ReactNode;
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
            Icon: UserPlus,
            alarming: false,
          },
          {
            key: "accounts",
            count: needs.pendingAccounts,
            label: d.overview.needsAccounts,
            href: "/admin/clients",
            Icon: Store,
            alarming: false,
          },
          {
            key: "requests",
            count: needs.accountRequests,
            label: d.overview.needsRequests,
            href: "/admin/clients",
            Icon: Inbox,
            alarming: false,
          },
          {
            key: "creatives",
            count: needs.newCreatives,
            label: d.overview.needsCreatives,
            href: "/admin/creatives",
            Icon: Sparkles,
            alarming: false,
          },
          {
            key: "connections",
            // A health count nobody could answer is not a count of zero, so it
            // gets no row here and says so in a line of its own below.
            count: needs.failingConnections ?? 0,
            label: d.overview.needsConnections,
            href: "/admin/reporting",
            Icon: PlugZap,
            // The one row that is a fault rather than a queue. Gold is the
            // colour of work waiting, and a connection answering with an error
            // was wearing it while three silent stores were painted red in the
            // panel underneath, which puts the two problems in the wrong order.
            alarming: true,
          },
        ].filter((row) => row.count > 0);

  /** It counts things, not rows: six creatives are six decisions. */
  const needsTotal = needsRows.reduce((sum, row) => sum + row.count, 0);

  const connectionsUnknown = needs !== null && needs.failingConnections === null;

  const reporting = operations.reporting;
  const tone = pulseTone(reporting);
  const pulseWord: Record<PulseTone, string> = {
    healthy: d.overview.pulseHealthy,
    watch: d.overview.pulseWatch,
    behind: d.overview.pulseBehind,
    unknown: d.overview.pulseUnknown,
  };

  /**
   * Nothing bound is a real answer, and it is 0%: the track keeps its place so
   * the panel does not change height on the day the last binding is removed.
   */
  const reportedShare =
    reporting === null || reporting.storesBound === 0
      ? 0
      : Math.round((reporting.storesReportingToday / reporting.storesBound) * 100);

  const facts = buildReportingFacts(operations, d, intl);

  return (
    <PageContainer
      title={fmt(d.overview.greeting, { name: firstName })}
      description={d.overview.subtitle}
      actions={
        <>
          {/*
            The important modifier is load bearing here, not a shortcut.

            globals.css ends with an unlayered phone block that floors every
            button at 36px, and an unlayered declaration outranks anything in
            @layer utilities however specific it is. A plain min-h-11 therefore
            wins on the laptop and loses on the phone, which is the one device
            where a 44px thumb target means anything at all.
          */}
          <Button
            variant="ghost"
            size="sm"
            onClick={store.toggle}
            aria-expanded={showFigures}
            className="min-h-11!"
          >
            {showFigures ? <EyeOff /> : <Eye />}
            {showFigures ? d.overview.hideFigures : d.overview.showFigures}
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => setTarget({ mode: "create" })}
            disabled={data.sources.length === 0}
            className="min-h-11!"
          >
            <Plus />
            {d.finance.revenue.newEntry}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="space-y-4">
        <section className="panel p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold text-[var(--text-primary)]">
              {d.overview.needsTitle}
            </h2>

            {/* A quantity, not a verdict, so it wears no capsule and no gold.
                The pill in the next panel is a judgement about the reporting,
                and two identical gold capsules 80px apart made a reader stop
                to work out which of them was saying something. It says the
                word as well as the number now, so nothing is left to a label
                only a screen reader was given. */}
            {needsTotal > 0 && (
              <span className="shrink-0 text-[12px] leading-none font-medium text-[var(--text-secondary)] tabular-nums">
                {fmt(d.overview.needsWaiting, { count: needsTotal })}
              </span>
            )}
          </div>

          {needs === null ? (
            <Unreadable message={d.overview.needsUnavailable} />
          ) : (
            <>
              {/* Filled tiles, not bordered ones, which is the same rule the
                  divided row in the next panel states: a hairline box inside a
                  hairline panel is one border drawn twice, and at the panel's
                  own 14px radius the inner corner reads as pasted on rather
                  than nested. Three across from xl, because a card stretched
                  past 600px strands its chevron a long way from the label it
                  belongs to. */}
              {needsRows.length > 0 && (
                <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {needsRows.map((row) => (
                    <li key={row.key}>
                      <Link
                        href={row.href}
                        className="group flex min-h-[4.5rem] items-center gap-3 rounded-[10px] bg-[var(--bg-panel-hover)] px-3.5 py-3 transition-smooth hover:bg-[var(--bg-elevated)]"
                      >
                        <span
                          className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
                            row.alarming
                              ? "bg-[var(--danger-red)]/12 text-[var(--danger-red)]"
                              : "bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
                          }`}
                        >
                          <row.Icon className="size-4" aria-hidden />
                        </span>

                        <span className="min-w-0 flex-1">
                          <span
                            className={`block text-[22px] leading-none font-semibold tabular-nums ${
                              row.alarming
                                ? "text-[var(--danger-red)]"
                                : "text-[var(--accent-gold)]"
                            }`}
                          >
                            {row.count}
                          </span>
                          <span className="mt-1 block text-[13px] leading-snug text-[var(--text-primary)]">
                            {row.label}
                          </span>
                        </span>

                        <ChevronRight
                          className="size-4 shrink-0 text-[var(--text-muted)] transition-smooth group-hover:translate-x-0.5"
                          aria-hidden
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {/* "Nothing is waiting" is a claim about every check, so it is
                  only made when every check actually answered. The panel keeps
                  its height rather than collapsing to one sentence: a quiet
                  morning is a result, not an absence of one. */}
              {needsRows.length === 0 && !connectionsUnknown && (
                <div className="flex flex-col items-center px-4 py-10 text-center">
                  <span className="flex size-11 items-center justify-center rounded-full bg-[var(--success-green)]/12 text-[var(--success-green)]">
                    <CircleCheck className="size-5" aria-hidden />
                  </span>
                  <p className="mt-3 text-[13px] text-[var(--text-secondary)]">
                    {d.overview.needsClear}
                  </p>
                </div>
              )}

              {connectionsUnknown &&
                (needsRows.length > 0 ? (
                  <p className="mt-4 border-t border-[var(--border-subtle)] pt-3 text-[12.5px] text-[var(--text-secondary)]">
                    {d.overview.needsConnectionsUnknown}
                  </p>
                ) : (
                  <Unreadable message={d.overview.needsConnectionsUnknown} />
                ))}
            </>
          )}
        </section>

        <section className="panel p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[17px] font-semibold text-[var(--text-primary)]">
              {d.overview.reportingTitle}
            </h2>

            <span
              data-tone={tone}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-none font-semibold tracking-[0.08em] uppercase ${PULSE[tone].pill}`}
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {pulseWord[tone]}
            </span>
          </div>

          <p className="label-caps mt-4">{d.overview.storesReporting}</p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
            <span className="metric-value tabular-nums">
              {reporting === null ? UNKNOWN : reporting.storesReportingToday}
            </span>
            {reporting !== null && (
              <span className="text-[14px] text-[var(--text-secondary)] tabular-nums">
                {fmt(d.overview.storesOf, { count: reporting.storesBound })}
              </span>
            )}
          </p>

          {/* The bar carries the name of what it is out of, because on its own
              a length says a share and never says a share of what. A pulse we
              could not read has no value to announce, so it announces none. */}
          <div
            role="progressbar"
            aria-label={
              reporting === null
                ? d.overview.reportingUnavailable
                : fmt(d.overview.storesBound, { count: reporting.storesBound })
            }
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={reporting === null ? undefined : reportedShare}
            className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.06)]"
          >
            <div
              className={`h-full rounded-full transition-smooth ${PULSE[tone].fill}`}
              style={{ width: `${reportedShare}%` }}
            />
          </div>

          {reporting === null && (
            <p className="mt-2.5 text-[12.5px] text-[var(--text-secondary)]">
              {d.overview.reportingUnavailable}
            </p>
          )}

          {/* A hero reading "0 of 0" has to say what it means in words. The
              pill above it has already stopped claiming health, and a track at
              zero width does not explain itself: nothing is bound, so there is
              no pulse here to be good or bad. */}
          {reporting !== null && reporting.storesBound === 0 && (
            <p className="mt-2.5 text-[12.5px] text-[var(--text-secondary)]">
              {d.overview.storesNoneBound}
            </p>
          )}

          {/* Hairlines, not boxes. Three bordered tiles inside a bordered panel
              is the same border drawn twice, and the eye reads the container
              before it reads the facts.

              The value is a point larger below sm because the phone ramp in
              globals.css lifts 11px and 13px text by two and leaves 15px
              alone, which flattened label, value and hint to 13/15/13 on the
              device that most needs the three of them to differ. */}
          <div className="mt-5 grid grid-cols-1 border-t border-[var(--border-subtle)] pt-4 sm:grid-cols-3">
            {facts.map((fact, index) => (
              <div
                key={fact.key}
                className={`${index === 0 ? "pb-3" : index === facts.length - 1 ? "pt-3" : "py-3"} ${
                  index > 0 ? "border-t border-[var(--border-subtle)]" : ""
                } sm:border-t-0 sm:py-0 ${
                  index > 0 ? "sm:border-l sm:border-[var(--border-subtle)] sm:pl-4" : ""
                } ${index < facts.length - 1 ? "sm:pr-4" : ""}`}
              >
                <p className="label-caps">{fact.label}</p>
                <p className="mt-1.5 text-[16px] leading-tight font-semibold text-[var(--text-primary)] tabular-nums sm:text-[15px]">
                  {fact.value}
                </p>
                {fact.hint && (
                  <p className="mt-1 text-[11.5px] text-[var(--text-secondary)]">{fact.hint}</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {showFigures && (
          <section className="space-y-4">
            {/* The window belongs to the figures, so it appears with them and
                leaves with them: a date range on a page showing no money is a
                label for something that is not on screen. */}
            <p className="text-[11.5px] text-[var(--text-muted)] tabular-nums">
              {shortDate(range.from, intl)} – {shortDate(range.to, intl)}
            </p>

            {/* The ellipsis is the same placeholder the relative times use:
                the figures are on their way from the browser, and a zero
                standing in for them would be read as an answer. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {/* No halo here, unlike /admin/revenue. The reveal is remembered
                  per device, so for anyone who has clicked once this block is
                  the page's daily state, and a glowing money figure beside a
                  plain store count would put the money straight back on top of
                  the hierarchy this page was rebuilt to invert. */}
              <StatCard
                label={d.overview.revenue}
                value={figuresReady ? money(figures.revenue, intl) : UNKNOWN}
              />
              <StatCard
                label={d.overview.expenses}
                value={figuresReady ? money(figures.expenses, intl) : UNKNOWN}
                tone="danger"
              />
              <StatCard
                label={d.overview.netProfit}
                value={figuresReady ? money(figures.profit, intl) : UNKNOWN}
                hint={`${d.overview.margin} ${
                  figuresReady ? percent(figures.margin, intl) : UNKNOWN
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
          </section>
        )}
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
 * The one word at the top right of the health panel, decided by silence.
 *
 * Exported for the tests, because the thresholds are the judgement here and a
 * colour is the last place to discover one of them moved.
 *
 * Silence is the symptom that matters: a store that reported is fine whatever
 * it reported, and a store that said nothing today is either asleep or broken.
 * A pulse nobody could read is its own tone, because "no store is silent" and
 * "we could not ask" must never wear the same colour.
 */
export function pulseTone(reporting: AdminOperations["reporting"]): PulseTone {
  if (reporting === null) return "unknown";

  // Nothing bound measures nothing, and zero silent out of zero bound clears
  // every threshold below it. A green pill over an empty bar would be the page
  // asserting health it never read, on exactly the morning the last binding
  // came off, so an empty measurement wears the same tone as no measurement.
  if (reporting.storesBound === 0) return "unknown";

  if (reporting.storesSilentToday === 0) return "healthy";
  return reporting.storesSilentToday <= WATCH_LIMIT ? "watch" : "behind";
}

/**
 * The three facts that support the hero, and never a fourth.
 *
 * Each group states its own reason exactly once. The reporting group's reason
 * is printed beside the hero, so the fact that comes from that same group
 * carries the placeholder alone: the reader needs to be told once that the
 * pulse did not answer, not three times in one panel.
 *
 * None of the three repeats the hero. Stores silent today used to sit first
 * here, and it is the hero subtracted from itself: the loader defines it as
 * bound minus reporting, so "3 of 5" above, "Behind" beside it and "2" below
 * it are one statement made three times, which left two slots to carry the
 * whole of the rest. Active clients took the slot because it is the thing the
 * hero cannot say: three of five stores reporting means one thing for an
 * agency with four live clients and another for one with forty.
 */
function buildReportingFacts(
  operations: AdminOperations,
  d: ReturnType<typeof useI18n>["d"],
  intl: string,
): ReportingFact[] {
  const { reporting, snapshots, activeClients } = operations;

  return [
    {
      key: "clients",
      label: d.overview.activeClients,
      value: activeClients === null ? UNKNOWN : String(activeClients),
      hint:
        activeClients === null
          ? d.overview.activeClientsUnavailable
          : d.overview.activeClientsHint,
    },
    {
      key: "snapshots",
      label: d.overview.snapshotsFresh,
      value: snapshots === null ? UNKNOWN : `${snapshots.fresh}/${snapshots.total}`,
      hint:
        snapshots === null ? (
          d.overview.snapshotsUnavailable
        ) : snapshots.oldestSuccessAt === null ? (
          d.overview.snapshotsNone
        ) : (
          <>
            {d.overview.snapshotsOldest} <RelativeTime iso={snapshots.oldestSuccessAt} intl={intl} />
          </>
        ),
    },
    {
      key: "last-metric",
      label: d.overview.lastMetric,
      value:
        reporting === null || reporting.lastMetricAt === null ? (
          UNKNOWN
        ) : (
          <RelativeTime iso={reporting.lastMetricAt} intl={intl} />
        ),
      hint:
        reporting !== null && reporting.lastMetricAt === null
          ? d.overview.lastMetricNone
          : undefined,
    },
  ];
}

/**
 * A check that could not be read, drawn with the weight of the all clear.
 *
 * The success state got a mark, a colour and a block of its own, and the two
 * failures got one grey sentence, so a morning where nothing could be read
 * looked calmer than a morning where everything was fine and a reader skimming
 * the panel would take a failed check for a quiet one. They are the same block
 * now, and the orange is neither the gold of a count nor the red of an error:
 * it says the answer is missing, not that the answer is bad.
 */
function Unreadable({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-[var(--warning-orange)]/12 text-[var(--warning-orange)]">
        <CircleAlert className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-[13px] text-[var(--text-secondary)]">{message}</p>
    </div>
  );
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
  // the fact shows an ellipsis rather than a wrong time. Same shape, so nothing
  // moves on screen when the real value arrives.
  if (nowMs === 0) return <>{UNKNOWN}</>;

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
    // The last fact to leave turns the timer off: nothing on screen is waiting
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
