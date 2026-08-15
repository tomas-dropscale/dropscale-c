"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChartNoAxesCombined } from "lucide-react";

import { integer, money, multiplier } from "@/lib/format";
import { cn } from "@/lib/utils";

const GREEN = "#7bc47f";
const SPEND_BLUE = "#6ea8e0";
const SESSIONS_CYAN = "#5cc7d8";
const ATC_BLUE = "#7aa2e3";
const CHECKOUT_GOLD = "#d4af6a";

const CHART_WIDTH = 100;
const CHART_HEIGHT = 42;
const CHART_TOP = 5;
const CHART_BOTTOM = 5;
const CHART_INSET = 2.5;
const CHART_PLOT_HEIGHT = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;

export type PerformanceChartGranularity = "hour" | "day";

export type PerformanceChartPoint = {
  /** ISO day or timestamp used by the x-axis and hover tooltip. */
  date: string;
  revenue: number;
  estimatedProfit: number;
  realRoas: number | null;
  googleSpend: number;
  sessions: number;
  addToCarts: number;
  checkouts: number;
  conversions: number;
};

export type FunnelChartPoint = Pick<
  PerformanceChartPoint,
  "date" | "sessions" | "addToCarts" | "checkouts" | "conversions"
>;
export type SpendChartPoint = Pick<PerformanceChartPoint, "date" | "googleSpend">;

export type RoasEvolutionWindows = {
  d30: number | null;
  d14: number | null;
  d7: number | null;
  d3: number | null;
  yesterday: number | null;
  today: number | null;
};

function dateLabel(value: string, granularity: PerformanceChartGranularity, long = false) {
  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return value;

  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    ...(long ? { year: "numeric" as const } : {}),
    ...(granularity === "hour"
      ? { hour: "2-digit" as const, minute: "2-digit" as const }
      : {}),
  });
}

function percent(value: number, digits = 1) {
  return new Intl.NumberFormat("en-GB", {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(value);
}

type ChartPoint = { x: number; y: number };

/** A compact smooth curve with horizontal handles, so it never overshoots a bucket. */
function smoothPath(points: ChartPoint[]) {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M ${CHART_INSET} ${points[0].y} L ${CHART_WIDTH - CHART_INSET} ${points[0].y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const middle = (current.x + next.x) / 2;
    path += ` C ${middle} ${current.y}, ${middle} ${next.y}, ${next.x} ${next.y}`;
  }
  return path;
}

function xAt(index: number, length: number) {
  if (length <= 1) return CHART_WIDTH / 2;
  const usable = CHART_WIDTH - CHART_INSET * 2;
  return CHART_INSET + (index / (length - 1)) * usable;
}

function xPercent(index: number, length: number) {
  return (xAt(index, length) / CHART_WIDTH) * 100;
}

function hoverIndex(event: React.MouseEvent<HTMLDivElement>, length: number) {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || length <= 1) return 0;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return Math.round(ratio * (length - 1));
}

function handleChartKey(
  event: React.KeyboardEvent<HTMLDivElement>,
  length: number,
  active: number | null,
  setActive: React.Dispatch<React.SetStateAction<number | null>>,
) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "Home") return setActive(0);
  if (event.key === "End") return setActive(length - 1);
  const direction = event.key === "ArrowLeft" ? -1 : 1;
  setActive(Math.max(0, Math.min(length - 1, (active ?? length - 1) + direction)));
}

function TimelineLabels({
  points,
  granularity,
}: {
  points: Array<{ date: string }>;
  granularity: PerformanceChartGranularity;
}) {
  if (points.length === 1) {
    return (
      <div className="mt-2 text-center text-[10px] tabular-nums text-[var(--text-muted)]">
        {dateLabel(points[0].date, granularity)}
      </div>
    );
  }

  const middle = Math.floor((points.length - 1) / 2);
  return (
    <div className="mt-2 grid grid-cols-3 text-[10px] tabular-nums text-[var(--text-muted)]">
      <span>{dateLabel(points[0].date, granularity)}</span>
      <span className="text-center">{dateLabel(points[middle].date, granularity)}</span>
      <span className="text-right">
        {dateLabel(points[points.length - 1].date, granularity)}
      </span>
    </div>
  );
}

function LegendMetric({
  color,
  label,
  value,
  detail,
  tone,
}: {
  color?: string;
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative";
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[10.5px] text-[var(--text-secondary)]">
      {color && <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden />}
      <span>{label}</span>
      <strong
        className={cn(
          "font-semibold tabular-nums text-[var(--text-primary)]",
          tone === "positive" && "text-[var(--success-green)]",
          tone === "negative" && "text-[#e08374]",
        )}
      >
        {value}
      </strong>
      {detail && <span className="tabular-nums text-[var(--text-muted)]">{detail}</span>}
    </span>
  );
}

function ChartTooltip({
  left,
  label,
  children,
}: {
  left: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="pointer-events-none absolute top-1 z-30 min-w-[184px] -translate-x-1/2 rounded-[9px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2.5 text-[11px] shadow-xl shadow-black/45"
      style={{ left: `${left}%` }}
    >
      <p className="mb-1.5 whitespace-nowrap text-[10px] tabular-nums text-[var(--text-muted)]">
        {label}
      </p>
      {children}
    </div>
  );
}

function EmptyChart({ title }: { title: string }) {
  return (
    <section className="panel flex min-h-[240px] flex-col p-4">
      <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">{title}</h2>
      <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">
        No development data in this period.
      </div>
    </section>
  );
}

export function SpendDevelopmentChart({
  points,
  currency,
  granularity,
}: {
  points: SpendChartPoint[];
  currency: string;
  granularity: PerformanceChartGranularity;
}) {
  const [active, setActive] = React.useState<number | null>(null);
  const reactId = React.useId().replace(/:/g, "");

  if (points.length === 0) return <EmptyChart title="Google Spend Development" />;

  const maximum = Math.max(1, ...points.map((point) => point.googleSpend));
  const yAt = (value: number) =>
    CHART_TOP + (1 - Math.max(0, value) / maximum) * CHART_PLOT_HEIGHT;
  const yPercent = (value: number) => (yAt(value) / CHART_HEIGHT) * 100;
  const chartPoints = points.map((point, index) => ({
    x: xAt(index, points.length),
    y: yAt(point.googleSpend),
  }));
  const linePath = smoothPath(chartPoints);
  const baseline = CHART_TOP + CHART_PLOT_HEIGHT;
  const areaPath =
    points.length > 1
      ? `${linePath} L ${xAt(points.length - 1, points.length)} ${baseline} L ${xAt(0, points.length)} ${baseline} Z`
      : "";
  const total = points.reduce((sum, point) => sum + point.googleSpend, 0);
  const point = active === null ? null : points[active];
  const tipX = active === null ? 50 : Math.max(15, Math.min(85, xPercent(active, points.length)));
  const gradientId = `${reactId}-spend-area`;

  return (
    <section className="panel min-w-0 p-4">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
            Google Spend Development
          </h2>
          <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
            Media cost reported by Google · per {granularity}
          </p>
        </div>
        <LegendMetric color={SPEND_BLUE} label="Total" value={money(total, currency)} />
      </header>

      <div
        className="relative h-[200px] min-w-0 select-none rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-[#6ea8e0]/30"
        role="group"
        tabIndex={0}
        aria-label="Google spend chart. Use the left and right arrow keys to inspect each period."
        onMouseMove={(event) => setActive(hoverIndex(event, points.length))}
        onMouseLeave={() => setActive(null)}
        onFocus={() => setActive((current) => current ?? points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => handleChartKey(event, points.length, active, setActive)}
      >
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label="Smooth blue Google spend line"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SPEND_BLUE} stopOpacity="0.24" />
              <stop offset="100%" stopColor={SPEND_BLUE} stopOpacity="0" />
            </linearGradient>
          </defs>
          {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
          <path
            d={linePath}
            fill="none"
            stroke={SPEND_BLUE}
            strokeOpacity="0.14"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={linePath}
            fill="none"
            stroke={SPEND_BLUE}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {active !== null && point && (
          <>
            <span
              className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white/20"
              style={{ left: `${xPercent(active, points.length)}%` }}
            />
            <span
              className="pointer-events-none absolute z-20 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[#0d0b09]"
              style={{
                left: `${xPercent(active, points.length)}%`,
                top: `${yPercent(point.googleSpend)}%`,
                background: SPEND_BLUE,
              }}
            />
            <ChartTooltip
              left={tipX}
              label={dateLabel(point.date, granularity, true)}
            >
              <p className="flex items-center justify-between gap-5 whitespace-nowrap text-[var(--text-secondary)]">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full" style={{ background: SPEND_BLUE }} aria-hidden />
                  Google spend
                </span>
                <strong className="font-semibold tabular-nums text-[var(--text-primary)]">
                  {money(point.googleSpend, currency)}
                </strong>
              </p>
            </ChartTooltip>
          </>
        )}
      </div>
      <TimelineLabels points={points} granularity={granularity} />
    </section>
  );
}

export function FunnelDevelopmentChart({
  points,
  granularity,
}: {
  points: FunnelChartPoint[];
  granularity: PerformanceChartGranularity;
  /** Retained for existing callers; funnel counts are currencyless. */
  currency?: string;
}) {
  const [active, setActive] = React.useState<number | null>(null);
  const reactId = React.useId().replace(/:/g, "");

  if (points.length === 0) return <EmptyChart title="Funnel Development" />;

  const sessions = points.map((point) => Math.max(0, point.sessions ?? 0));
  const sessionMaximum = Math.max(1, ...sessions);
  const sessionY = (value: number) =>
    CHART_TOP + (1 - Math.max(0, value) / sessionMaximum) * CHART_PLOT_HEIGHT;
  const sessionYPercent = (value: number) => (sessionY(value) / CHART_HEIGHT) * 100;
  const sessionPoints = sessions.map((value, index) => ({
    x: xAt(index, points.length),
    y: sessionY(value),
  }));
  const sessionPath = smoothPath(sessionPoints);
  const baseline = CHART_TOP + CHART_PLOT_HEIGHT;
  const sessionArea =
    points.length > 1
      ? `${sessionPath} L ${xAt(points.length - 1, points.length)} ${baseline} L ${xAt(0, points.length)} ${baseline} Z`
      : "";
  const barMaximum = Math.max(
    1,
    ...points.map(
      (point) =>
        Math.max(0, point.addToCarts ?? 0) +
        Math.max(0, point.checkouts ?? 0) +
        Math.max(0, point.conversions ?? 0),
    ),
  );
  const maximumBarHeight = (CHART_PLOT_HEIGHT / CHART_HEIGHT) * 46;
  const barHeight = (value: number) =>
    `${(Math.max(0, value) / barMaximum) * maximumBarHeight}%`;
  const totals = points.reduce(
    (sum, point) => ({
      sessions: sum.sessions + Math.max(0, point.sessions ?? 0),
      addToCarts: sum.addToCarts + Math.max(0, point.addToCarts ?? 0),
      checkouts: sum.checkouts + Math.max(0, point.checkouts ?? 0),
      conversions: sum.conversions + Math.max(0, point.conversions ?? 0),
    }),
    { sessions: 0, addToCarts: 0, checkouts: 0, conversions: 0 },
  );
  const point = active === null ? null : points[active];
  const tipX = active === null ? 50 : Math.max(15, Math.min(85, xPercent(active, points.length)));
  const waveId = `${reactId}-sessions-area`;
  const legend = [
    { label: "Sessions", value: totals.sessions, color: SESSIONS_CYAN },
    { label: "ATC", value: totals.addToCarts, color: ATC_BLUE },
    { label: "Checkout", value: totals.checkouts, color: CHECKOUT_GOLD },
    { label: "Conversions", value: totals.conversions, color: GREEN },
  ];
  const bucketRows = point
    ? [
        { label: "Sessions", value: point.sessions ?? 0, color: SESSIONS_CYAN },
        { label: "ATC", value: point.addToCarts ?? 0, color: ATC_BLUE },
        { label: "Checkout", value: point.checkouts ?? 0, color: CHECKOUT_GOLD },
        { label: "Conversions", value: point.conversions ?? 0, color: GREEN },
      ]
    : [];

  return (
    <section className="panel min-w-0 p-4">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
            Funnel Development
          </h2>
          <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
            Traffic and conversion development · per {granularity}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
          {legend.map((item, index) => (
            <LegendMetric
              key={item.label}
              color={item.color}
              label={item.label}
              value={integer(item.value)}
              detail={
                index > 0 && totals.sessions > 0
                  ? percent(item.value / totals.sessions, index === 3 ? 2 : 1)
                  : undefined
              }
            />
          ))}
        </div>
      </header>

      <div
        className="relative h-[200px] min-w-0 select-none rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-[#5cc7d8]/30"
        role="group"
        tabIndex={0}
        aria-label="Funnel development chart. Use the left and right arrow keys to inspect each period."
        onMouseMove={(event) => setActive(hoverIndex(event, points.length))}
        onMouseLeave={() => setActive(null)}
        onFocus={() => setActive((current) => current ?? points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => handleChartKey(event, points.length, active, setActive)}
      >
        <div className="pointer-events-none absolute inset-0 z-0">
          {points.map((bucket, index) => {
            const segments = [
              { value: bucket.addToCarts ?? 0, color: ATC_BLUE },
              { value: bucket.checkouts ?? 0, color: CHECKOUT_GOLD },
              { value: bucket.conversions ?? 0, color: GREEN },
            ].filter((segment) => segment.value > 0);

            return (
              <div
                key={bucket.date}
                className="absolute flex h-full w-2 flex-col-reverse sm:w-[9px]"
                style={{
                  left: `${xPercent(index, points.length)}%`,
                  bottom: `${(CHART_BOTTOM / CHART_HEIGHT) * 100}%`,
                  transform: "translateX(-50%)",
                }}
              >
                {segments.map((segment, segmentIndex) => (
                  <span
                    key={segment.color}
                    style={{
                      height: barHeight(segment.value),
                      background: segment.color,
                      borderTopLeftRadius: segmentIndex === segments.length - 1 ? 2 : 0,
                      borderTopRightRadius: segmentIndex === segments.length - 1 ? 2 : 0,
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="pointer-events-none relative z-10 h-full w-full"
          role="img"
          aria-label="Cyan sessions wave with stacked add-to-cart, checkout and conversion bars"
        >
          <defs>
            <linearGradient id={waveId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SESSIONS_CYAN} stopOpacity="0.16" />
              <stop offset="100%" stopColor={SESSIONS_CYAN} stopOpacity="0" />
            </linearGradient>
          </defs>
          {sessionArea && <path d={sessionArea} fill={`url(#${waveId})`} />}
          <path
            d={sessionPath}
            fill="none"
            stroke={SESSIONS_CYAN}
            strokeOpacity="0.14"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={sessionPath}
            fill="none"
            stroke={SESSIONS_CYAN}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {active !== null && point && (
          <>
            <span
              className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white/20"
              style={{ left: `${xPercent(active, points.length)}%` }}
            />
            <span
              className="pointer-events-none absolute z-20 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[#0d0b09]"
              style={{
                left: `${xPercent(active, points.length)}%`,
                top: `${sessionYPercent(point.sessions ?? 0)}%`,
                background: SESSIONS_CYAN,
              }}
            />
            <ChartTooltip
              left={tipX}
              label={dateLabel(point.date, granularity, true)}
            >
              <dl className="grid grid-cols-[auto_auto_auto] items-center gap-x-3 gap-y-1">
                {bucketRows.map((row, index) => (
                  <React.Fragment key={row.label}>
                    <dt className="flex items-center gap-1.5 whitespace-nowrap text-[var(--text-secondary)]">
                      <span className="size-1.5 rounded-full" style={{ background: row.color }} aria-hidden />
                      {row.label}
                    </dt>
                    <dd className="text-right font-semibold tabular-nums text-[var(--text-primary)]">
                      {integer(row.value)}
                    </dd>
                    <dd className="text-right tabular-nums text-[var(--text-muted)]">
                      {(point.sessions ?? 0) > 0
                        ? percent(row.value / (point.sessions ?? 0), index === 3 ? 2 : 1)
                        : "—"}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </ChartTooltip>
          </>
        )}
      </div>
      <TimelineLabels points={points} granularity={granularity} />
    </section>
  );
}

const WINDOW_ROWS: ReadonlyArray<[keyof RoasEvolutionWindows, string]> = [
  ["d30", "30 days"],
  ["d14", "14 days"],
  ["d7", "7 days"],
  ["d3", "3 days"],
  ["yesterday", "Yesterday"],
  ["today", "Today"],
];

export function RoasEvolutionHover({ windows }: { windows: RoasEvolutionWindows }) {
  const tooltipId = React.useId();
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);

  function show(event: React.SyntheticEvent<HTMLButtonElement>) {
    setAnchor(event.currentTarget.getBoundingClientRect());
  }

  return (
    <span className="inline-flex">
      <button
        type="button"
        aria-label="View real ROAS evolution"
        aria-describedby={tooltipId}
        className="transition-smooth flex size-7 items-center justify-center rounded-[8px] text-[var(--text-muted)] outline-none hover:bg-[var(--bg-panel-hover)] hover:text-[var(--accent-gold-strong)] focus-visible:bg-[var(--bg-panel-hover)] focus-visible:text-[var(--accent-gold-strong)] focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/30"
        onMouseEnter={show}
        onMouseLeave={() => setAnchor(null)}
        onFocus={show}
        onBlur={() => setAnchor(null)}
      >
        <ChartNoAxesCombined className="size-3.5" aria-hidden />
      </button>

      {anchor &&
        createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            style={{
              left: Math.max(12, Math.min(window.innerWidth - 202, anchor.right - 190)),
              top: anchor.top >= 210 ? anchor.top - 8 : anchor.bottom + 8,
            }}
            className={cn(
              "pointer-events-none fixed z-[100] w-[190px] rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 shadow-xl shadow-black/45",
              anchor.top >= 210 && "-translate-y-full",
            )}
          >
            <span className="mb-2 block text-[10px] font-medium tracking-[0.08em] text-[var(--text-muted)] uppercase">
              Real ROAS evolution
            </span>
            <span className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[11.5px]">
              {WINDOW_ROWS.map(([key, label]) => {
                const value = windows[key];
                return (
                  <React.Fragment key={key}>
                    <span className="text-[var(--text-secondary)]">{label}</span>
                    <span
                      className={cn(
                        "text-right font-semibold tabular-nums",
                        key === "today"
                          ? "text-[var(--accent-gold-strong)]"
                          : "text-[var(--text-primary)]",
                      )}
                    >
                      {value === null || !Number.isFinite(value)
                        ? "—"
                        : multiplier(value)}
                    </span>
                  </React.Fragment>
                );
              })}
            </span>
          </span>,
          document.body,
        )}
    </span>
  );
}
