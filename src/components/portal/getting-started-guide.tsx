"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Boxes, Check, ChevronRight, Lock, PlugZap, ShoppingBag, Store } from "lucide-react";

import type { AdAccount } from "@/lib/supabase/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShopifyLinkForm } from "@/components/portal/shopify-link-form";
import { ShopifySetupSteps } from "@/components/portal/shopify-setup-steps";
import { cn } from "@/lib/utils";

/**
 * First-run guide on the client's dashboard. It doesn't vanish after the first
 * connection — it stays, ticking each step off, until the store is fully set
 * up. Each step goes STRAIGHT to its own action: Google Ads starts its OAuth,
 * Shopify opens the connect form in a dialog, costs open the Costs page.
 *
 * Order is enforced, not merely suggested: Shopify stays locked until the team
 * has approved the store's ad account, because a store connected before then
 * syncs nothing and may still be turned down. Costs are never locked — they
 * are the client's own data and cost us nothing to accept early.
 */
type StepAction =
  | { kind: "link"; href: string } // in-app navigation
  | { kind: "external"; href: string } // full-page (e.g. an OAuth start route)
  | { kind: "shopify" }; // opens the Shopify connect dialog

type Step = {
  icon: typeof Store;
  title: string;
  body: string;
  cta: string;
  done: boolean;
  action: StepAction;
  /**
   * Why this step can't be started yet — replaces its button. It still links
   * somewhere: a locked step must never be a dead end, and everything a client
   * can do while waiting (build the Shopify app, read the scopes) lives one
   * click away.
   */
  locked?: { reason: string; href: string };
  /** Rendered under the step, inside its own row — never as a sibling block. */
  extra?: React.ReactNode;
};

export function GettingStartedGuide({
  accounts,
  costsSet,
  showGoogle,
}: {
  accounts: AdAccount[];
  /** Any manual product cost saved yet — marks the costs step done. */
  costsSet: boolean;
  /** Hide the Google step where Google Ads isn't configured for the platform. */
  showGoogle: boolean;
}) {
  const [shopifyOpen, setShopifyOpen] = React.useState(false);

  const hasAccounts = accounts.length > 0;
  const googleConnected = accounts.some((account) => account.google_ads_connected);
  const shopifyConnected = accounts.some((account) => account.shopify_connected);

  // "Approved" is the whole gate: a pending account is one we haven't accepted
  // yet, and nothing may be wired to it.
  const approved = accounts.filter((account) => account.status !== "pending");

  // The specific account each connect targets (onboarding is usually one store).
  const googleTarget = accounts.find((account) => !account.google_ads_connected);
  const unlinkedShopify = approved.filter((account) => !account.shopify_connected);

  const shopifyLock = !hasAccounts
    ? { reason: "Add your store first", href: "/dashboard/settings/accounts" }
    : approved.length === 0
      ? // Approval gates connecting, not preparing: Connections explains the
        // wait AND lists the scopes the Shopify app needs.
        { reason: "Waiting for our approval", href: "/dashboard/settings/connections" }
      : undefined;

  const steps: Step[] = [
    {
      icon: Store,
      title: "Add your store",
      body: "Create an account for your store so we have somewhere to bring the numbers into.",
      cta: "Add your store",
      done: hasAccounts,
      action: { kind: "link", href: "/dashboard/settings/accounts" },
    },
    ...(showGoogle
      ? [
          {
            icon: PlugZap,
            title: "Connect Google Ads",
            body: "Link your Google Ads so spend, ROAS and conversions flow in automatically.",
            cta: "Connect Google Ads",
            done: googleConnected,
            action: googleTarget
              ? ({ kind: "external", href: `/api/google-ads/connect?account=${googleTarget.id}` } as StepAction)
              : ({ kind: "link", href: "/dashboard/settings/accounts" } as StepAction),
          } as Step,
        ]
      : []),
    {
      icon: ShoppingBag,
      title: "Connect Shopify",
      body: shopifyLock
        ? "Available once we’ve accepted your store — then link Shopify to pull in revenue, orders and refunds."
        : "Link your store’s Shopify to pull in revenue, orders and refunds. We walk you through the app and scopes.",
      cta: "Connect Shopify",
      done: shopifyConnected,
      locked: shopifyLock,
      action:
        unlinkedShopify.length > 0
          ? { kind: "shopify" }
          : { kind: "link", href: "/dashboard/settings/connections" },
      // The app-and-scopes guide belongs to THIS step: it's what the step is
      // asking you to go and do. Readable even while the step is locked —
      // building the app is the long pole, and waiting is the time for it.
      extra: (
        <details className="group/setup rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)]">
          <summary className="transition-smooth flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)] transition-transform group-open/setup:rotate-90" />
            How to create your Shopify app — and the exact permissions it needs
          </summary>
          <div className="px-3 pb-3">
            <ShopifySetupSteps />
          </div>
        </details>
      ),
    },
    {
      icon: Boxes,
      title: "Set your product costs",
      body: "Add product costs under Finance → Costs so your real profit and margin are exact.",
      cta: "Open Costs",
      done: costsSet,
      action: { kind: "link", href: "/dashboard/costs" },
    },
  ];

  const remaining = steps.filter((step) => !step.done).length;

  const ctaClass =
    "transition-smooth inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] hover:border-[var(--accent-gold)]/40 hover:text-[var(--accent-gold-strong)]";

  return (
    <section className="panel p-5 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            Let’s get your dashboard live
          </h2>
          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            A few quick steps and your revenue, spend and real profit start flowing in.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1 text-[11.5px] text-[var(--text-muted)]">
          {remaining} left
        </span>
      </div>

      <ol className="space-y-2.5">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={cn(
              "rounded-[10px] border px-3.5 py-3",
              step.done
                ? "border-[var(--success-green)]/25 bg-[var(--success-green)]/8"
                : "border-[var(--border-subtle)] bg-[var(--bg-base)]",
            )}
          >
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
                  step.done
                    ? "bg-[var(--success-green)]/15 text-[var(--success-green)]"
                    : "bg-[var(--bg-panel)] text-[var(--text-secondary)]",
                )}
              >
                {step.done ? <Check className="size-4" aria-hidden /> : index + 1}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <step.icon className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                  <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                    {step.title}
                  </span>
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--text-muted)]">
                  {step.body}
                </span>
              </span>

              {!step.done && step.locked ? (
                <Link
                  href={step.locked.href}
                  className="transition-smooth inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]"
                >
                  <Lock className="size-3.5" aria-hidden />
                  {step.locked.reason}
                </Link>
              ) : null}

              {!step.done &&
                !step.locked &&
                (step.action.kind === "shopify" ? (
                  <button type="button" onClick={() => setShopifyOpen(true)} className={ctaClass}>
                    {step.cta}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </button>
                ) : step.action.kind === "external" ? (
                  <a href={step.action.href} className={ctaClass}>
                    {step.cta}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </a>
                ) : (
                  <Link href={step.action.href} className={ctaClass}>
                    {step.cta}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                ))}
            </div>

            {/* Step-owned detail, indented under its own row. */}
            {!step.done && step.extra && <div className="mt-2.5 pl-10">{step.extra}</div>}
          </li>
        ))}
      </ol>

      {/* Shopify connect, right here — no detour through settings. */}
      <Dialog open={shopifyOpen} onOpenChange={setShopifyOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Connect Shopify</DialogTitle>
          </DialogHeader>
          {unlinkedShopify.length > 0 && (
            <ShopifyLinkForm accounts={unlinkedShopify} onConnected={() => setShopifyOpen(false)} />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
