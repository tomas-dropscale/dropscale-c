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
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  icon: Icon,
  value,
  hint,
  glow = false,
  highlight = false,
}: {
  label: string;
  icon: LucideIcon;
  value: string;
  hint?: string;
  /** Soft gold halo on the value — reserved for the money-earned figure. */
  glow?: boolean;
  /** Gold neon border around the whole card — the grid's one hero. */
  highlight?: boolean;
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
      <p className={cn("metric-value truncate text-[clamp(22px,2vw,32px)]", glow && "text-glow-gold")}>
        {value}
      </p>
      <p className="text-[11.5px] text-[var(--text-muted)]">
        {hint ?? "— vs previous period"}
      </p>
    </div>
  );
}

/**
 * The 10-card grid shared by the Overview and the per-store view.
 * Revenue leads — it is the client's number — and gets the gold treatment;
 * spend closes the grid where the revenue figure used to sit.
 */
export function MetricsGrid({ metrics, currency }: { metrics: MetricSet; currency: string }) {
  const cards: {
    label: string;
    icon: LucideIcon;
    value: string;
    hint?: string;
    glow?: boolean;
    highlight?: boolean;
  }[] = [
    {
      label: "Revenue",
      icon: BadgeDollarSign,
      value: money(metrics.conversionValue, currency),
      glow: true,
      highlight: true,
    },
    { label: "Impressions", icon: Eye, value: compact(metrics.impressions) },
    { label: "Clicks", icon: MousePointerClick, value: integer(metrics.clicks) },
    { label: "Conversions", icon: Target, value: integer(metrics.conversions) },
    { label: "CTR", icon: Percent, value: percent(metrics.ctr) },
    {
      label: "Dropscale Fee",
      icon: HandCoins,
      value: money(metrics.fee, currency),
      hint: "10% of ad spend",
    },
    { label: "CPC", icon: Coins, value: money(metrics.cpc, currency) },
    {
      label: "Cost / Conversion",
      icon: Crosshair,
      value: money(metrics.costPerConversion, currency),
    },
    { label: "ROAS", icon: TrendingUp, value: multiplier(metrics.roas) },
    { label: "Amount Spent", icon: Wallet, value: money(metrics.spend, currency) },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((card) => (
        <MetricCard key={card.label} {...card} />
      ))}
    </div>
  );
}
