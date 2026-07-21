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

export function MetricCard({
  label,
  icon: Icon,
  value,
  hint,
}: {
  label: string;
  icon: LucideIcon;
  value: string;
  hint?: string;
}) {
  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="label-caps">{label}</p>
        <Icon className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
      </div>
      <p className="metric-value truncate text-[clamp(22px,2vw,32px)]">{value}</p>
      <p className="text-[11.5px] text-[var(--text-muted)]">
        {hint ?? "— vs previous period"}
      </p>
    </div>
  );
}

/**
 * The 10-card grid shared by the Overview and the per-store view.
 * Row 1: volume. Row 2: efficiency.
 */
export function MetricsGrid({ metrics, currency }: { metrics: MetricSet; currency: string }) {
  const cards: { label: string; icon: LucideIcon; value: string; hint?: string }[] = [
    { label: "Amount Spent", icon: Wallet, value: money(metrics.spend, currency) },
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
    {
      label: "Conversion Value",
      icon: BadgeDollarSign,
      value: money(metrics.conversionValue, currency),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((card) => (
        <MetricCard key={card.label} {...card} />
      ))}
    </div>
  );
}
