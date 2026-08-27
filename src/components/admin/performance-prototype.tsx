"use client";

import { BarChart3, Target } from "lucide-react";
import Link from "next/link";

import { AnalyticsPrototype } from "@/components/admin/analytics-prototype";
import { CampaignsPrototype } from "@/components/admin/campaigns-prototype";
import { Sidebar } from "@/components/admin/sidebar";
import { BrowserChrome } from "@/components/portal/browser-chrome";
import { cn } from "@/lib/utils";

type PrototypeTab = "campaigns" | "analytics";
type AnalyticsTarget = {
  clientId?: string;
  storeId?: string;
  campaignId?: string;
};

const TABS = [
  {
    id: "campaigns",
    label: "Campaigns",
    icon: Target,
    href: "/preview/admin/campaigns",
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: BarChart3,
    href: "/preview/admin/analytics",
  },
] as const;

/**
 * Development-only review shell. Campaigns and Analytics are separate routes;
 * every interaction inside them remains reversible mock state.
 */
export function PerformancePrototype({
  view,
  analyticsTarget = {},
}: {
  view: PrototypeTab;
  analyticsTarget?: AnalyticsTarget;
}) {
  return (
    <div className="flex h-svh flex-col p-0 md:p-5">
      <BrowserChrome
        address={`localhost · ${view} visual review`}
        right={
          <span className="rounded-full border border-[var(--accent-gold)]/30 bg-[var(--accent-gold-dim)] px-2.5 py-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--accent-gold-strong)] uppercase">
            Mock data
          </span>
        }
      >
        <div className="flex min-h-0 flex-1">
          <aside
            className="pointer-events-none hidden w-[228px] shrink-0 md:block"
            aria-hidden="true"
            inert
          >
            <Sidebar activePath={`/admin/${view}`} />
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-5 py-3 md:px-7">
              <nav
                aria-label="Performance prototype pages"
                className="inline-flex rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-1"
              >
                {TABS.map(({ id, label, icon: Icon, href }) => {
                  const active = view === id;
                  return (
                    <Link
                      key={id}
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "transition-smooth flex h-8 items-center gap-2 rounded-[8px] px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/35",
                        active
                          ? "bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]",
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden />
                      {label}
                    </Link>
                  );
                })}
              </nav>

              <p className="text-[11.5px] text-[var(--text-muted)]">
                Visual prototype · all data and actions are simulated
              </p>
            </div>

            {view === "campaigns" ? (
              <CampaignsPrototype />
            ) : (
              <AnalyticsPrototype
                initialClientId={analyticsTarget.clientId}
                initialStoreId={analyticsTarget.storeId}
                initialCampaignId={analyticsTarget.campaignId}
              />
            )}
          </main>
        </div>
      </BrowserChrome>
    </div>
  );
}
