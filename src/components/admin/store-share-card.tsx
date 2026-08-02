"use client";

import * as React from "react";
import { Check, Copy, Share2, X } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Logo } from "@/components/brand/logo";
import { areaPath, endPoint, smoothPath } from "@/lib/admin/share-chart";
import { compact, integer, money, multiplier, percent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AdminStoreOverview } from "@/lib/admin/client-overview";

/**
 * One store's numbers, laid out to be screenshotted and sent to the client.
 *
 * Deliberately NOT a download. An earlier version of this generated a PNG on a
 * canvas, which meant every style existed twice — once in CSS for the screen
 * and once in canvas drawing calls — and the two drifted apart. A screenshot of
 * real DOM is always current, needs no second renderer, and the person sharing
 * it can crop it however they like.
 *
 * So the constraint here is different from the rest of the report: this has to
 * look finished with nothing around it. Fixed width, its own background, no
 * hover states, no controls inside the frame — everything that would look
 * broken in a still image lives outside the card.
 */

/**
 * A gold halo around the type itself.
 *
 * Three layers with widening radius and falling opacity, which is how light
 * actually falls off. A single tight shadow reads as a sticker outline rather
 * than as something lit.
 *
 * The values are deliberately low. A glow bright enough to notice on its own is
 * already too bright: what should be noticeable is the NUMBER, not the effect.
 *
 * Mixed from the gold tokens rather than written as fixed hex, so a change to
 * the brand colour carries through instead of leaving a halo in the old shade
 * behind text in the new one.
 */
const GOLD_GLOW =
  "0 0 6px color-mix(in srgb, var(--accent-gold-strong) 28%, transparent)," +
  " 0 0 22px color-mix(in srgb, var(--accent-gold) 22%, transparent)," +
  " 0 0 48px color-mix(in srgb, var(--accent-gold) 14%, transparent)";

function Metric({
  label,
  value,
  gold,
  glow,
}: {
  label: string;
  value: string;
  /** The two figures a client looks for first. */
  gold?: boolean;
  /** Revenue only — the one number the whole card exists to deliver. */
  glow?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-[14px] border px-4 py-3.5",
        gold
          ? "border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)]"
          : "border-[var(--border-subtle)] bg-[var(--bg-base)]",
      )}
    >
      <p
        className={cn(
          "text-[10.5px] font-medium tracking-[0.1em] uppercase",
          gold ? "text-[var(--accent-gold)]" : "text-[var(--text-muted)]",
        )}
      >
        {label}
      </p>
      {/* `truncate` is withheld from the glowing value on purpose: it carries
          overflow-hidden, which clips a text-shadow at the element's own box
          and draws a hard rectangle around the halo. Nowrap keeps the figure on
          one line; a money value has no realistic length that would spill past
          the card, and if one ever did, an overhanging digit is a smaller
          problem than a glow with visible corners. */}
      <p
        className={cn(
          "mt-2 text-[27px] leading-none font-semibold tabular-nums",
          glow ? "whitespace-nowrap" : "truncate",
          gold ? "text-[var(--accent-gold-strong)]" : "text-[var(--text-primary)]",
        )}
        style={glow ? { textShadow: GOLD_GLOW } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

function SpendChart({ days, currency }: { days: AdminStoreOverview["days"]; currency: string }) {
  const geo = { width: 720, height: 200, pad: 16 };
  const { width, height, pad } = geo;

  const values = days.map((day) => day.adSpend);
  const max = Math.max(...values, 0);
  const path = smoothPath(values, geo);
  const area = areaPath(path, geo);
  const end = endPoint(values, geo);

  const first = days[0]?.day;
  const last = days[days.length - 1]?.day;
  const label = (day: string | undefined) =>
    day ? new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";

  return (
    <div className="rounded-[14px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10.5px] font-medium tracking-[0.1em] text-[var(--text-muted)] uppercase">
          Daily spend
        </p>
        <p className="text-[11.5px] text-[var(--text-muted)] tabular-nums">
          peak {money(max, currency)}
        </p>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-2 w-full"
        role="img"
        aria-label="Ad spend per day"
      >
        <defs>
          <linearGradient id="share-spend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-gold)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent-gold)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Baseline and midline only — gridlines every few euros would crowd a
            card meant to be read at a glance in a chat window. */}
        {[0.5, 1].map((fraction) => (
          <line
            key={fraction}
            x1={pad}
            x2={width - pad}
            y1={pad + (height - pad * 2) * fraction}
            y2={pad + (height - pad * 2) * fraction}
            stroke="var(--border-subtle)"
            strokeDasharray={fraction === 1 ? undefined : "4 6"}
            strokeWidth="1"
          />
        ))}

        {area && <path d={area} fill="url(#share-spend-fill)" />}
        {path && (
          <path
            d={path}
            fill="none"
            stroke="var(--accent-gold)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Marks where the period ends, so the eye lands on the latest day
            rather than trailing off the right edge. */}
        {end && (
          <>
            <circle cx={end.x} cy={end.y} r="7" fill="var(--accent-gold)" opacity="0.18" />
            <circle
              cx={end.x}
              cy={end.y}
              r="3.5"
              fill="var(--accent-gold-strong)"
              stroke="var(--bg-base)"
              strokeWidth="2"
            />
          </>
        )}
      </svg>

      <div className="mt-1 flex justify-between text-[11px] text-[var(--text-muted)]">
        <span>{label(first)}</span>
        <span>{label(last)}</span>
      </div>
    </div>
  );
}

type CopyState = "idle" | "working" | "copied" | "downloaded" | "failed";

export function StoreShareCard({
  store,
  clientName,
  range,
}: {
  store: AdminStoreOverview;
  clientName: string;
  range: { from: string; to: string };
}) {
  const [open, setOpen] = React.useState(false);
  const [copyState, setCopyState] = React.useState<CopyState>("idle");
  /** The frame, and only the frame — the buttons must not land in the image. */
  const frameRef = React.useRef<HTMLDivElement>(null);
  const currency = store.currency;

  // Reset the confirmation on close, so re-opening never shows a stale
  // "Copied". Done in the event rather than an effect: closing IS the moment
  // the label stops being true, and an effect would only notice afterwards.
  function setOpenState(next: boolean) {
    setOpen(next);
    if (!next) setCopyState("idle");
  }

  /**
   * Render the card to a PNG and put it on the clipboard.
   *
   * The image comes from the real DOM rather than from a second renderer. We
   * tried drawing this on a canvas once, which meant every style existed twice
   * — in CSS for the screen and in drawing calls for the export — and the two
   * drifted. Screenshotting the live node cannot drift by construction.
   *
   * The ClipboardItem is built SYNCHRONOUSLY, wrapping the still-pending blob
   * promise. Safari only honours a clipboard write inside the user gesture that
   * started it, and awaiting the render first would put the write outside that
   * window and have it rejected.
   */
  function copyPng() {
    const node = frameRef.current;
    if (!node || copyState === "working") return;
    setCopyState("working");

    const blob = (async () => {
      // Dynamic: this pulls in a renderer worth more than the rest of the
      // dialog, and nobody pays for it until they actually share something.
      const { toBlob } = await import("html-to-image");
      const png = await toBlob(node, {
        // Retina-sharp — a card pasted into a chat gets viewed at full size.
        pixelRatio: 2,
        cacheBust: true,
      });
      if (!png) throw new Error("The card could not be rendered.");
      return png;
    })();

    const canWrite =
      typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);

    const written = canWrite
      ? navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
      : Promise.reject(new Error("Clipboard images are not supported here."));

    written.then(
      () => setCopyState("copied"),
      async () => {
        // Firefox and some locked-down contexts refuse image writes. Losing the
        // render entirely would be the worst outcome, so hand over a file.
        try {
          const png = await blob;
          const url = URL.createObjectURL(png);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${clientName}-${range.from}-to-${range.to}.png`.replace(/\s+/g, "-");
          link.click();
          URL.revokeObjectURL(url);
          setCopyState("downloaded");
        } catch {
          setCopyState("failed");
        }
      },
    );
  }

  const period = `${new Date(`${range.from}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  })} – ${new Date(`${range.to}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="transition-smooth inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] hover:border-[var(--accent-gold)]/40 hover:text-[var(--accent-gold-strong)]"
        aria-label={`Share ${store.storeName}'s report`}
      >
        <Share2 className="size-3.5" aria-hidden />
        Share
      </button>

      <Dialog open={open} onOpenChange={setOpenState}>
        {/* No padding and no close button of its own: the dialog IS the frame
            being photographed, so anything chrome-like has to sit outside it. */}
        <DialogContent
          className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-[820px] overflow-y-auto border-none bg-transparent p-0 shadow-none"
          showClose={false}
        >
          {/* Radix needs a title for the dialog to be announced; the card has
              its own visible heading, so this one is for screen readers only. */}
          <DialogTitle className="sr-only">
            {store.storeName} — performance report
          </DialogTitle>

          <div className="flex items-center justify-end gap-2 pb-2">
            <button
              type="button"
              onClick={copyPng}
              disabled={copyState === "working"}
              className="transition-smooth inline-flex items-center gap-1.5 rounded-full border border-[var(--accent-gold)]/35 bg-[var(--accent-gold-dim)] px-3 py-1.5 text-[12px] font-medium text-[var(--accent-gold-strong)] hover:border-[var(--accent-gold)]/60 disabled:opacity-60"
            >
              {copyState === "copied" ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className={cn("size-3.5", copyState === "working" && "animate-pulse")} aria-hidden />
              )}
              {copyState === "working"
                ? "Rendering…"
                : copyState === "copied"
                  ? "Copied — paste with Ctrl+V"
                  : copyState === "downloaded"
                    ? "Downloaded instead"
                    : copyState === "failed"
                      ? "Couldn't copy"
                      : "Copy PNG"}
            </button>

            <button
              type="button"
              onClick={() => setOpenState(false)}
              className="transition-smooth inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <X className="size-3.5" aria-hidden />
              Close
            </button>
          </div>

          {/* ---- the frame to screenshot ----
              `relative` + `overflow-hidden` so the halo below is clipped to the
              rounded corners instead of bleeding past them. */}
          <div
            ref={frameRef}
            className="relative overflow-hidden rounded-[24px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-7 sm:p-9"
          >
            {/* The same gold light source the auth and marketing screens use.
                Purely decorative and behind everything, so it tints the card
                without touching contrast on any number. */}
            <div
              className="pointer-events-none absolute -top-32 -left-24 h-72 w-[28rem] rounded-full opacity-60 blur-3xl"
              style={{
                background:
                  "radial-gradient(closest-side, var(--accent-gold-dim), transparent)",
              }}
              aria-hidden
            />

            <div className="relative">
              {/* The client is named; the SHOP is not. A client receiving this
                  knows which of their shops it is, and leaving the store name
                  out means one card can be forwarded without exposing how the
                  rest of the account is organised. */}
              <header className="mb-7 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium tracking-[0.14em] text-[var(--accent-gold)] uppercase">
                    Performance report
                  </p>
                  <h2 className="mt-2 truncate text-[26px] leading-tight font-semibold text-[var(--text-primary)]">
                    {clientName}
                  </h2>
                  <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{period}</p>
                </div>
                <Logo size="lg" className="shrink-0" />
              </header>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {/* Revenue and ROAS lead in gold — what a client opens this to
                    see. Spend is the cost of getting there, so it sits beside
                    them rather than above. */}
                <Metric
                  gold
                  glow
                  label="Revenue"
                  value={store.googleRevenue === null ? "—" : money(store.googleRevenue, currency)}
                />
                <Metric gold label="ROAS" value={multiplier(store.roas)} />
                <Metric label="Ad spend" value={money(store.adSpend, currency)} />
                <Metric label="Impressions" value={compact(store.impressions)} />
                <Metric label="Clicks" value={integer(store.clicks)} />
                <Metric label="CTR" value={percent(store.ctr)} />
              </div>

              <div className="mt-3">
                <SpendChart days={store.days} currency={currency} />
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
