import type { LucideIcon } from "lucide-react";
import {
  BadgeDollarSign,
  Coins,
  Crosshair,
  Eye,
  HandCoins,
  MousePointerClick,
  Package,
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
 * The metrics grid shared by the Google views, in the Infinite Scaling
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
  storeRoas = null,
  storeConversions = null,
  storeConversionValue = null,
  showFee = true,
  unitsSold = null,
  orders = null,
}: {
  d: Dictionary;
  metrics: MetricSet;
  currency: string;
  feeRate?: number | null;
  /**
   * The STORE's return: net Shopify revenue ÷ ad spend, for whatever scope this
   * grid was given.
   *
   * When present it becomes the ROAS shown, and Google's attributed figure
   * moves to the hint. Google only counts sales it can attribute, so an account
   * without conversion tracking reports 0.00x next to a dashboard full of real
   * revenue — technically true, and useless to the client reading it. Null
   * falls back to the attributed number (the demo/mock path has no revenue).
   */
  storeRoas?: number | null;
  /**
   * The STORE's conversions: real orders minus the ones Instagram or Facebook
   * referred (migration 0019).
   *
   * Same treatment as storeRoas, for the same reason: Google's conversion count
   * is almost always 0 because tracking is rarely wired up, so it says nothing
   * next to real revenue. Total orders would be the other error — crediting
   * Google's spend with Meta's sales. When present it becomes the CONVERSIONS
   * shown AND the denominator of Cost/Conv, because a cost-per-conversion
   * derived from a different figure than the one beside it is just wrong.
   */
  storeConversions?: number | null;
  /**
   * What those conversions were worth — gross revenue of the same orders.
   *
   * Travels with storeConversions and for the same reason: Google reports a
   * conversion value of 0 wherever it reports 0 conversions, so the card next to
   * a working conversions figure was showing €0.00 over real sales.
   */
  storeConversionValue?: number | null;
  /**
   * Whether the agency fee gets a card.
   *
   * Off on a single store, where ROAS takes that slot instead: the fee is one
   * number for the whole client and it is already on the dashboard and the
   * invoice, whereas ROAS is what you actually open a store to read.
   */
  showFee?: boolean;
  /**
   * Units sold in the shop (line-item quantities), with the order count as its
   * hint. Shopify's number, like storeRoas — not a Google one, which is why it
   * arrives as its own prop instead of joining MetricSet. Null hides the card,
   * for the mock/demo path that has no store behind it.
   */
  unitsSold?: number | null;
  orders?: number | null;
}) {
  type Card = {
    label: string;
    icon: LucideIcon;
    value: string;
    hint?: string;
    glow?: boolean;
    highlight?: boolean;
  };

  const fee: Card = {
    label: d.metrics.fee,
    icon: HandCoins,
    value: money(metrics.fee, currency),
    hint: feeRate != null ? fmt(d.metrics.feeHintRate, { rate: feeRate }) : d.metrics.feeHintMixed,
  };

  const roas: Card = {
    label: d.metrics.roas,
    icon: TrendingUp,
    value: multiplier(storeRoas ?? metrics.roas),
    hint:
      storeRoas != null
        ? fmt(d.metrics.roasHintAttributed, { value: multiplier(metrics.roas) })
        : undefined,
  };

  const cpc: Card = { label: d.metrics.cpc, icon: Coins, value: money(metrics.cpc, currency) };

  // Both derived from the same figure, so they can never disagree: the store's
  // conversions when we have them, Google's when we don't.
  const conversions: Card = {
    label: d.metrics.conversions,
    icon: Target,
    value: integer(storeConversions ?? metrics.conversions),
    hint:
      storeConversions != null
        ? fmt(d.metrics.conversionsHintExcludesMeta, {
            value: integer(metrics.conversions),
          })
        : undefined,
  };

  const costPerConversion: Card = {
    label: d.metrics.costPerConversion,
    icon: Crosshair,
    value: money(
      storeConversions != null
        ? storeConversions > 0
          ? metrics.spend / storeConversions
          : 0
        : metrics.costPerConversion,
      currency,
    ),
  };

  const cards: Card[] = [
    { label: d.metrics.amountSpent, icon: Wallet, value: money(metrics.spend, currency) },
    { label: d.metrics.impressions, icon: Eye, value: compact(metrics.impressions) },
    { label: d.metrics.clicks, icon: MousePointerClick, value: integer(metrics.clicks) },
    conversions,
    { label: d.metrics.ctr, icon: Percent, value: percent(metrics.ctr) },
    // Row 2 leads with the fee, or with ROAS when there is no fee card — ROAS
    // moves INTO that position rather than staying at the end of the row.
    ...(showFee ? [fee, cpc, costPerConversion, roas] : [roas, cpc, costPerConversion]),
    {
      label: d.metrics.conversionValue,
      icon: BadgeDollarSign,
      value: money(storeConversionValue ?? metrics.conversionValue, currency),
      hint:
        storeConversionValue != null
          ? fmt(d.metrics.conversionsHintExcludesMeta, {
              value: money(metrics.conversionValue, currency),
            })
          : undefined,
    },
    ...(unitsSold != null
      ? [
          {
            label: d.metrics.unitsSold,
            icon: Package,
            value: integer(unitsSold),
            hint:
              orders != null
                ? fmt(d.metrics.unitsSoldHint, { orders: integer(orders) })
                : undefined,
          } satisfies Card,
        ]
      : []),
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((card) => (
        <MetricCard key={card.label} d={d} {...card} />
      ))}
    </div>
  );
}
