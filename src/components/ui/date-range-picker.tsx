"use client";

import * as React from "react";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  RANGE_PRESETS,
  isoDay,
  presetSelection,
  type RangePreset,
  type RangeSelection,
} from "@/lib/portal/range";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * The one date-range control for the whole product: preset shortcuts down the
 * side, a two-month calendar for free ranges, all in the house gold-on-dark.
 * Presets apply on click; custom ranges apply on "Apply". The host decides
 * what applying means (URL navigation in the portal, local state in charts).
 */

type Draft = { start: string | null; end: string | null };

function calendarView(day: string) {
  const [year, month] = day.split("-").map(Number);
  const previousMonth = new Date(year, month - 2, 1);
  return { year: previousMonth.getFullYear(), month: previousMonth.getMonth() };
}

function monthLabel(year: number, month: number, intl: string) {
  return new Date(year, month, 1).toLocaleDateString(intl, { month: "long", year: "numeric" });
}

/** Monday-first weeks; null cells pad the first/last week. */
function monthMatrix(year: number, month: number): (string | null)[] {
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // 0 = Monday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (string | null)[] = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(isoDay(new Date(year, month, day)));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function weekdayHeaders(intl: string): string[] {
  // 5 Jan 2026 is a Monday.
  return Array.from({ length: 7 }, (_, index) =>
    new Date(2026, 0, 5 + index)
      .toLocaleDateString(intl, { weekday: "short" })
      .slice(0, 2),
  );
}

function Month({
  year,
  month,
  draft,
  today,
  intl,
  onPick,
}: {
  year: number;
  month: number;
  draft: Draft;
  today: string;
  intl: string;
  onPick: (day: string) => void;
}) {
  const cells = monthMatrix(year, month);
  const { start, end } = draft;

  return (
    <div className="w-[224px]">
      <p className="mb-2 text-center text-[12.5px] font-medium text-[var(--text-primary)] capitalize">
        {monthLabel(year, month, intl)}
      </p>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {weekdayHeaders(intl).map((day, index) => (
          <span key={index} className="pb-1 text-[10px] text-[var(--text-muted)] lowercase">
            {day}
          </span>
        ))}
        {cells.map((day, index) => {
          if (!day) return <span key={index} />;

          const disabled = day > today;
          const isStart = day === start;
          const isEnd = day === (end ?? start);
          const inRange = start !== null && end !== null && day > start && day < end;

          return (
            <button
              key={index}
              type="button"
              disabled={disabled}
              onClick={() => onPick(day)}
              className={cn(
                "transition-smooth mx-auto flex size-7 items-center justify-center rounded-[8px] text-[12px]",
                disabled && "cursor-not-allowed text-[var(--text-muted)]/50",
                !disabled && !isStart && !isEnd && !inRange &&
                  "text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]",
                inRange && "rounded-none bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]",
                (isStart || isEnd) &&
                  "bg-[var(--accent-gold)] font-semibold text-[#1a1409]",
              )}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DateRangePicker({
  value,
  onApply,
  align = "end",
  footer,
}: {
  value: RangeSelection;
  onApply: (selection: RangeSelection) => void;
  align?: "start" | "end";
  /** Left slot of the bottom bar — e.g. the "TOTAL ROAS" figure. */
  footer?: React.ReactNode;
}) {
  const { d, intl } = useI18n();
  // Keep the disabled-day boundary on the same Europe/Lisbon reporting day
  // used to resolve presets. A browser outside Lisbon must not make a date
  // selectable that the server would treat as tomorrow (or hide Lisbon's
  // current day around midnight).
  const today = presetSelection("today").to;

  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>({
    start: value.from,
    end: value.to,
  });
  // Left month of the pair; right is +1.
  const [view, setView] = React.useState(() => calendarView(value.to));

  const concreteRange = value.from === value.to
    ? shortLabel(value.from, intl)
    : `${shortLabel(value.from, intl)} – ${shortLabel(value.to, intl)}`;
  const label = value.key === "custom"
    ? concreteRange
    : `${d.ranges[value.key]} · ${concreteRange}`;

  function pick(day: string) {
    setDraft((current) => {
      if (!current.start || current.end) return { start: day, end: null };
      if (day < current.start) return { start: day, end: null };
      return { start: current.start, end: day };
    });
  }

  function shift(delta: number) {
    setView((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  function applyPreset(preset: RangePreset) {
    onApply(presetSelection(preset));
    setOpen(false);
  }

  function applyCustom() {
    if (!draft.start) return;
    const to = draft.end ?? draft.start;
    onApply(
      draft.start === value.from && to === value.to
        ? value
        : { key: "custom", from: draft.start, to },
    );
    setOpen(false);
  }

  function changeOpen(nextOpen: boolean) {
    if (nextOpen) {
      setDraft({ start: value.from, end: value.to });
      setView(calendarView(value.to));
    }
    setOpen(nextOpen);
  }

  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger className="transition-smooth flex h-9 items-center gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3.5 text-[13px] font-medium text-[var(--text-primary)] outline-none hover:border-[var(--border-strong)] hover:bg-[var(--bg-panel-hover)]">
        <Calendar className="size-3.5 text-[var(--accent-gold)]" />
        {label}
        <ChevronDown className="size-3.5 text-[var(--text-muted)]" />
      </DropdownMenuTrigger>

      {/* The cap is what makes flex-wrap mean anything: a dropdown is sized by
          its content, so without it the preset row laid itself out on one line
          and ran off the side of a phone instead of wrapping. */}
      <DropdownMenuContent
        align={align}
        collisionPadding={8}
        className="max-w-[calc(100vw-1rem)] p-0"
      >
        <div className="flex flex-col sm:flex-row">
          {/* Presets */}
          <div className="flex flex-row flex-wrap gap-0.5 border-b border-[var(--border-subtle)] p-2 sm:w-[150px] sm:flex-col sm:border-r sm:border-b-0">
            {RANGE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => applyPreset(preset)}
                className={cn(
                  "transition-smooth rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px]",
                  value.key === preset
                    ? "bg-[var(--accent-gold-dim)] font-medium text-[var(--accent-gold-strong)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]",
                )}
              >
                {d.ranges[preset]}
              </button>
            ))}
            <span
              className={cn(
                "rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px]",
                value.key === "custom"
                  ? "bg-[var(--accent-gold-dim)] font-medium text-[var(--accent-gold-strong)]"
                  : "text-[var(--text-muted)]",
              )}
            >
              {d.ranges.custom}
            </span>
          </div>

          {/* Two-month calendar */}
          <div className="p-3">
            {/* Centred while only one month shows, so the single 224px grid
                doesn't sit off to one side of a full-width phone panel. */}
            <div className="relative flex justify-center gap-5 sm:justify-start">
              <button
                type="button"
                onClick={() => shift(-1)}
                aria-label="Previous month"
                className="transition-smooth absolute top-0 left-0 rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => shift(1)}
                aria-label="Next month"
                className="transition-smooth absolute top-0 right-0 rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
              >
                <ChevronRight className="size-4" />
              </button>

              {/* The EARLIER month is the one that drops on mobile. Hiding the
                  later one instead left a phone opened on 11 August showing
                  only July — the current month is what a single-month view has
                  to be. */}
              <div className="hidden sm:block">
                <Month
                  year={view.year}
                  month={view.month}
                  draft={draft}
                  today={today}
                  intl={intl}
                  onPick={pick}
                />
              </div>
              <Month
                year={view.month === 11 ? view.year + 1 : view.year}
                month={(view.month + 1) % 12}
                draft={draft}
                today={today}
                intl={intl}
                onPick={pick}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] pt-3">
              {footer && (
                <span className="mr-auto text-[11px] font-medium tracking-[0.08em] text-[var(--text-secondary)] uppercase">
                  {footer}
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {d.common.cancel}
              </Button>
              <Button variant="primary" size="sm" onClick={applyCustom} disabled={!draft.start}>
                {d.common.apply}
              </Button>
            </div>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function shortLabel(iso: string, intl: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(intl, { day: "2-digit", month: "short" });
}
