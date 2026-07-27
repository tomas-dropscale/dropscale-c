import type { LucideIcon } from "lucide-react";
import {
  BadgeDollarSign,
  Coins,
  Crosshair,
  Eye,
  HandCoins,
  MousePointerClick,
  Percent,
  Target,
  TrendingUp,
  Wallet,
} from "lucide-react";

import type { MetricSet } from "@/lib/portal/mock";
import { compact, integer, money, multiplier, percent } from "@/lib/format";
import { fmt, type Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * These are SERVER components on purpose — `icon` is a Lucide component, and a
 * function cannot cross the server→client boundary. So the dictionary arrives
 * as a prop from the page (a plain object, which crosses fine) rather than
 * through useI18n(), which would force "use client" and break every caller.
 */

export function MetricCard({
  d,
  label,
  icon: Icon,
  value,
  hint,
  glow = false,
  highlight = false,
  valueClassName,
}: {
  d: Dictionary;
  label: string;
  icon: LucideIcon;
  value: string;
  hint?: string;
  /** Soft gold halo on the value — reserved for the money-earned figure. */
  glow?: boolean;
  /** Gold neon border around the whole card — the grid's one hero. */
  highlight?: boolean;
  /** Extra classes on the value line — e.g. the Net Profit neon-green treatment. */
  valueClassName?: string;
}) {
  return (
    <div className={cn("panel flex flex-col gap-3 p-4", highlight && "card-glow-gold")}>
      <div className="flex items-start justify-between gap-2">
        <p className="label-caps">{label}</p>
        <Icon
          className={cn(
            "size-4 shrink-0",
            highlight ? "text-[var(--accent-gold)]" : "text-[var(--text-muted)]",
          )}
          aria-hidden
        />
      </div>
      <p
        className={cn(
          "metric-value truncate text-[clamp(22px,2vw,32px)]",
          glow && "text-glow-gold",
          valueClassName,
        )}
      >
        {value}
      </p>
      <p className="text-[11.5px] text-[var(--text-muted)]">
        {hint ?? d.metrics.vsPrevious}
      </p>
    </div>
  );
}

/**
 * The 10-card grid shared by the Google views, in the Infinite Scaling
 * "Lorena Taller" order: Amount Spent leads, row 2 runs Fee → CPC →
 * Cost/Conv → ROAS → Conversion Value.
 *
 * Every card ranks equal — no hero treatment here; the gold highlight is the
 * main dashboard's Revenue card, and only there.
 * `feeRate` personalises the fee hint (accounts bill their own
 * commission_rate); null means mixed rates across stores, so no single
 * percentage would be true.
 */
export function MetricsGrid({
  d,
  metrics,
  currency,
  feeRate = null,
}: {
  d: Dictionary;
  metrics: MetricSet;
  currency: string;
  feeRate?: number | null;
}) {
  const cards: {
    label: string;
    icon: LucideIcon;
    value: string;
    hint?: string;
    glow?: boolean;
    highlight?: boolean;
  }[] = [
    { label: d.metrics.amountSpent, icon: Wallet, value: money(metrics.spend, currency) },
    { label: d.metrics.impressions, icon: Eye, value: compact(metrics.impressions) },
    { label: d.metrics.clicks, icon: MousePointerClick, value: integer(metrics.clicks) },
    { label: d.metrics.conversions, icon: Target, value: integer(metrics.conversions) },
    { label: d.metrics.ctr, icon: Percent, value: percent(metrics.ctr) },
    {
      label: d.metrics.fee,
      icon: HandCoins,
      value: money(metrics.fee, currency),
      hint:
        feeRate != null
          ? fmt(d.metrics.feeHintRate, { rate: feeRate })
          : d.metrics.feeHintMixed,
    },
    { label: d.metrics.cpc, icon: Coins, value: money(metrics.cpc, currency) },
    {
      label: d.metrics.costPerConversion,
      icon: Crosshair,
      value: money(metrics.costPerConversion, currency),
    },
    { label: d.metrics.roas, icon: TrendingUp, value: multiplier(metrics.roas) },
    {
      label: d.metrics.conversionValue,
      icon: BadgeDollarSign,
      value: money(metrics.conversionValue, currency),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((card) => (
        <MetricCard key={card.label} d={d} {...card} />
      ))}
    </div>
  );
}
