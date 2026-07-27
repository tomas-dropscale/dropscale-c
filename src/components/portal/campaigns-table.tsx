"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";

import type { Campaign } from "@/lib/supabase/types";
import { Badge } from "@/components/ui/badge";
import { compact, integer, money, percent } from "@/lib/format";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

const STATUS_VARIANT: Record<Campaign["status"], "success" | "neutral" | "danger"> = {
  active: "success",
  paused: "neutral",
  ended: "danger",
};

export function CampaignsTable({
  campaigns,
  currency,
}: {
  campaigns: Campaign[];
  currency: string;
}) {
  const { d, intl } = useI18n();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const statusLabel: Record<Campaign["status"], string> = {
    active: d.campaigns.statusActive,
    paused: d.campaigns.statusPaused,
    ended: d.campaigns.statusEnded,
  };

  const totals = campaigns.reduce(
    (sum, campaign) => ({
      spend: sum.spend + Number(campaign.spend),
      impressions: sum.impressions + campaign.impressions,
      clicks: sum.clicks + campaign.clicks,
      budget: sum.budget + Number(campaign.daily_budget ?? 0),
    }),
    { spend: 0, impressions: 0, clicks: 0, budget: 0 },
  );
  const totalCtr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
  const totalCpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;

  return (
    <section className="panel overflow-hidden">
      <header className="border-b border-[var(--border-subtle)] px-5 py-4">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          {d.campaigns.title}
        </h2>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--border-subtle)]">
              <th className="label-caps px-4 py-2.5 text-left">{d.campaigns.campaign}</th>
              <th className="label-caps px-4 py-2.5 text-left">{d.campaigns.status}</th>
              <th className="label-caps px-4 py-2.5 text-right">{d.campaigns.spend}</th>
              <th className="label-caps px-4 py-2.5 text-right">{d.campaigns.impressions}</th>
              <th className="label-caps px-4 py-2.5 text-right">{d.campaigns.clicks}</th>
              <th className="label-caps px-4 py-2.5 text-right">{d.campaigns.ctr}</th>
              <th className="label-caps px-4 py-2.5 text-right">{d.campaigns.cpc}</th>
              <th className="label-caps px-4 py-2.5 text-right">{d.campaigns.dailyBudget}</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => {
              const expanded = expandedId === campaign.id;

              return (
                <React.Fragment key={campaign.id}>
                  <tr
                    className={cn(
                      "transition-smooth cursor-pointer border-b border-[var(--border-subtle)] hover:bg-[var(--bg-panel-hover)]",
                      expanded && "bg-[var(--bg-panel-hover)]",
                    )}
                    onClick={() => setExpandedId(expanded ? null : campaign.id)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <ChevronRight
                          className={cn(
                            "transition-smooth size-3.5 shrink-0 text-[var(--text-muted)]",
                            expanded && "rotate-90",
                          )}
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-[var(--text-primary)]">
                            {campaign.name}
                          </p>
                          <p className="truncate text-[11.5px] text-[var(--text-muted)]">
                            {d.campaigns.creativeHint}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[campaign.status]}>
                        {statusLabel[campaign.status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-[var(--text-primary)]">
                      {money(campaign.spend, currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--text-secondary)]">
                      {compact(campaign.impressions)}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--text-secondary)]">
                      {integer(campaign.clicks)}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--text-secondary)]">
                      {percent(Number(campaign.ctr))}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-[var(--text-secondary)]">
                      {money(campaign.cpc, currency)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-[var(--text-secondary)]">
                      {campaign.daily_budget != null
                        ? money(campaign.daily_budget, currency)
                        : "—"}
                    </td>
                  </tr>

                  {expanded && (
                    <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-base)]">
                      <td colSpan={8} className="px-4 py-4 pl-11">
                        <div className="grid grid-cols-2 gap-4 text-[12.5px] sm:grid-cols-4">
                          <div>
                            <p className="label-caps mb-1">{d.campaigns.avgCpc}</p>
                            <p className="text-[var(--text-primary)]">
                              {money(campaign.cpc, currency)}
                            </p>
                          </div>
                          <div>
                            <p className="label-caps mb-1">{d.campaigns.conversionWindow}</p>
                            <p className="text-[var(--text-primary)]">
                              {d.campaigns.conversionWindowValue}
                            </p>
                          </div>
                          <div>
                            <p className="label-caps mb-1">{d.campaigns.lastUpdated}</p>
                            <p className="text-[var(--text-primary)]">
                              {new Date(campaign.updated_at).toLocaleDateString(intl)}
                            </p>
                          </div>
                          <div>
                            <p className="label-caps mb-1">{d.campaigns.creativeMetrics}</p>
                            <p className="text-[var(--text-muted)]">
                              {d.campaigns.creativeMetricsValue}
                            </p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}

            {/* Totals */}
            <tr className="bg-[var(--bg-panel-hover)] font-semibold text-[var(--text-primary)]">
              <td className="px-4 py-3 pl-10">{d.campaigns.total}</td>
              <td className="px-4 py-3" />
              <td className="px-4 py-3 text-right whitespace-nowrap">
                {money(totals.spend, currency)}
              </td>
              <td className="px-4 py-3 text-right">{compact(totals.impressions)}</td>
              <td className="px-4 py-3 text-right">{integer(totals.clicks)}</td>
              <td className="px-4 py-3 text-right">{percent(totalCtr)}</td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                {money(totalCpc, currency)}
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                {totals.budget > 0 ? money(totals.budget, currency) : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
