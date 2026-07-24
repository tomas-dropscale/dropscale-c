import Link from "next/link";
import { ArrowRight, Check, PlugZap, ShoppingBag, Store, Boxes } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * First-run guide on the client's dashboard, shown while nothing is connected
 * yet — so an empty dashboard reads as "here's how to start", not "broken".
 * Each step self-marks as done, so the same panel doubles as a setup checklist
 * until the store is live.
 */
type Step = {
  icon: typeof Store;
  title: string;
  body: string;
  href: string;
  cta: string;
  done: boolean;
};

export function GettingStartedGuide({
  hasAccounts,
  googleConnected,
  shopifyConnected,
  costsSet,
  showGoogle,
}: {
  hasAccounts: boolean;
  googleConnected: boolean;
  shopifyConnected: boolean;
  /** Any manual product cost saved yet — marks the costs step done. */
  costsSet: boolean;
  /** Hide the Google step where Google Ads isn't configured for the platform. */
  showGoogle: boolean;
}) {
  const steps: Step[] = [
    {
      icon: Store,
      title: "Add your store",
      body: "Create an account for your store so we have somewhere to bring the numbers into.",
      href: "/dashboard/settings/accounts",
      cta: "Manage accounts",
      done: hasAccounts,
    },
    ...(showGoogle
      ? [
          {
            icon: PlugZap,
            title: "Connect Google Ads",
            body: "Link your Google Ads so spend, ROAS and conversions flow in automatically.",
            href: "/dashboard/settings/connections",
            cta: "Connect Google Ads",
            done: googleConnected,
          } as Step,
        ]
      : []),
    {
      icon: ShoppingBag,
      title: "Connect Shopify",
      body: "Link your store’s Shopify to pull in revenue, orders and refunds. We walk you through the app and scopes.",
      href: "/dashboard/settings/connections",
      cta: "Connect Shopify",
      done: shopifyConnected,
    },
    {
      icon: Boxes,
      title: "Set your product costs",
      body: "Add product costs under Finance → Costs so your real profit and margin are exact.",
      href: "/dashboard/costs",
      cta: "Open Costs",
      done: costsSet,
    },
  ];

  const remaining = steps.filter((step) => !step.done).length;

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
              "flex items-center gap-3 rounded-[10px] border px-3.5 py-3",
              step.done
                ? "border-[var(--success-green)]/25 bg-[var(--success-green)]/8"
                : "border-[var(--border-subtle)] bg-[var(--bg-base)]",
            )}
          >
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

            {!step.done && (
              <Link
                href={step.href}
                className="transition-smooth inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] hover:border-[var(--accent-gold)]/40 hover:text-[var(--accent-gold-strong)]"
              >
                {step.cta}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
