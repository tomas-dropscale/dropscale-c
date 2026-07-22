import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CalendarClock,
  Check,
  LineChart,
  Search,
  Target,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";

/* ---------------------------------------------------------------------------
 * Content. Kept as data up here so copy edits never mean touching markup.
 * The METRICS numbers are PLACEHOLDERS — swap in the real ones before launch.
 * ------------------------------------------------------------------------- */

const METRICS = [
  { value: "€800K+", label: "Ad spend managed" },
  { value: "30+", label: "Active accounts" },
  { value: "4.6×", label: "Average ROAS" },
  { value: "100%", label: "Google Ads focused" },
];

const SERVICES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Target,
    title: "Google Ads campaign management",
    body: "Search, Performance Max and Shopping — built, structured and managed daily by specialists who only do Google Ads.",
  },
  {
    icon: TrendingUp,
    title: "Conversion optimisation",
    body: "Landing pages, tracking and bidding tuned together, so every click has the best possible chance of becoming revenue.",
  },
  {
    icon: BarChart3,
    title: "Real-time reporting",
    body: "Your own client portal with live spend, ROAS and campaign performance. No waiting for a monthly PDF.",
  },
  {
    icon: LineChart,
    title: "Growth strategy",
    body: "Budget pacing, market expansion and a quarterly roadmap — decisions grounded in your numbers, not hunches.",
  },
];

const STEPS = [
  {
    title: "Diagnosis",
    body: "We audit your account, tracking and funnel, and tell you plainly what is working and what is burning budget.",
  },
  {
    title: "Strategy",
    body: "A concrete plan: structure, budgets, targets and the metrics we will be judged on.",
  },
  {
    title: "Implementation",
    body: "We rebuild what needs rebuilding and launch. You watch it happen live in your portal.",
  },
  {
    title: "Continuous optimisation",
    body: "Weekly iterations on bids, queries and creatives. Scaling what earns, cutting what doesn't.",
  },
];

/** PLACEHOLDER case studies — replace with real clients and real numbers. */
const CASES = [
  {
    sector: "B2B SaaS",
    metric: "-38%",
    metricLabel: "cost per lead",
    body: "Restructured Search around high-intent queries and rebuilt conversion tracking end to end.",
  },
  {
    sector: "E-commerce",
    metric: "5.2×",
    metricLabel: "ROAS at scale",
    body: "Performance Max feed optimisation and margin-based bidding across three markets.",
  },
  {
    sector: "Professional services",
    metric: "2.4×",
    metricLabel: "qualified pipeline",
    body: "From generic clicks to a lead engine the sales team actually trusts.",
  },
];

const PRICING_POINTS = [
  "Plans sized to your ad spend — no one-size-fits-all retainer",
  "No long lock-ins; we earn the renewal every month",
  "Full access to your own accounts and data, always",
  "Live reporting portal included on every plan",
];

/* ------------------------------------------------------------------------- */

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <Reveal className="mx-auto max-w-[640px] text-center">
      <p className="label-caps mb-3 text-[var(--accent-gold)]">{eyebrow}</p>
      <h2 className="text-[28px] leading-tight font-semibold tracking-tight text-[var(--text-primary)] sm:text-[34px]">
        {title}
      </h2>
      {body && (
        <p className="mt-3 text-[14.5px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
      )}
    </Reveal>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* ---- Hero ---------------------------------------------------------- */}
      <section className="relative overflow-hidden">
        {/* Same gold halo the auth screens use — one brand, one light source */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-[-22rem] left-1/2 size-[46rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(212,168,106,0.12),transparent_65%)] blur-2xl"
        />

        <div className="relative mx-auto w-full max-w-[1120px] px-5 pt-24 pb-20 text-center sm:pt-32 sm:pb-24">
          <Reveal>
            <p className="label-caps mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] px-3 py-1.5 text-[var(--accent-gold-strong)]">
              Specialist Google Ads agency
            </p>
          </Reveal>

          <Reveal delay={80}>
            <h1 className="mx-auto max-w-[760px] text-[38px] leading-[1.08] font-semibold tracking-tight text-[var(--text-primary)] sm:text-[56px]">
              Scale your business with Google Ads that{" "}
              <span className="text-[var(--accent-gold)]">pay for themselves</span>
            </h1>
          </Reveal>

          <Reveal delay={160}>
            <p className="mx-auto mt-5 max-w-[560px] text-[15px] leading-relaxed text-[var(--text-secondary)] sm:text-[16px]">
              Dropscale IO plans, runs and optimises Google Ads for B2B and e-commerce
              brands — with live performance reporting in your own client portal, not a
              monthly PDF.
            </p>
          </Reveal>

          <Reveal delay={240}>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button variant="primary" size="lg" asChild>
                {/* TODO: swap for the booking link (Calendly/Cal.com) when it exists */}
                <a href="mailto:leandro@dropscale.io?subject=Intro%20call%20—%20Google%20Ads">
                  Book a call
                  <ArrowRight />
                </a>
              </Button>
              <Button variant="secondary" size="lg" asChild>
                <a href="#pricing">View pricing</a>
              </Button>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---- Trust strip --------------------------------------------------- */}
      <section aria-label="Key numbers" className="border-y border-[var(--border-subtle)]">
        <div className="mx-auto grid w-full max-w-[1120px] grid-cols-2 gap-px px-5 py-10 lg:grid-cols-4">
          {METRICS.map((metric, index) => (
            <Reveal key={metric.label} delay={index * 80} className="py-2 text-center">
              <p className="metric-value">{metric.value}</p>
              <p className="label-caps mt-1.5">{metric.label}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---- Services ------------------------------------------------------ */}
      <section id="services" className="scroll-mt-20 py-24">
        <div className="mx-auto w-full max-w-[1120px] px-5">
          <SectionHeading
            eyebrow="What we do"
            title="One channel, done properly"
            body="We don't do everything. We do Google Ads — deeply, daily and accountably."
          />

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {SERVICES.map((service, index) => (
              <Reveal key={service.title} delay={index * 80}>
                <article className="panel h-full p-6">
                  <div className="mb-4 flex size-10 items-center justify-center rounded-[10px] bg-[var(--accent-gold-dim)]">
                    <service.icon className="size-4.5 text-[var(--accent-gold)]" aria-hidden />
                  </div>
                  <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">
                    {service.title}
                  </h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
                    {service.body}
                  </p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Process ------------------------------------------------------- */}
      <section
        id="process"
        className="scroll-mt-20 border-y border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 py-24"
      >
        <div className="mx-auto w-full max-w-[1120px] px-5">
          <SectionHeading
            eyebrow="How it works"
            title="From audit to compounding results"
            body="A process we repeat every week — not a slide we show once."
          />

          <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <Reveal key={step.title} delay={index * 80}>
                <li className="panel h-full p-6">
                  <p className="metric-value !text-[26px]">0{index + 1}</p>
                  <h3 className="mt-3 text-[15px] font-semibold text-[var(--text-primary)]">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                    {step.body}
                  </p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ---- Results ------------------------------------------------------- */}
      <section id="results" className="scroll-mt-20 py-24">
        <div className="mx-auto w-full max-w-[1120px] px-5">
          <SectionHeading
            eyebrow="Results"
            title="Numbers our clients see in their portal"
            body="Every engagement is measured against targets we agree on upfront."
          />

          <div className="mt-12 grid gap-4 lg:grid-cols-3">
            {CASES.map((item, index) => (
              <Reveal key={item.sector} delay={index * 80}>
                <article className="panel h-full p-6">
                  <p className="label-caps">{item.sector}</p>
                  <p className="metric-value mt-4">{item.metric}</p>
                  <p className="text-[13px] font-medium text-[var(--text-primary)]">
                    {item.metricLabel}
                  </p>
                  <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                    {item.body}
                  </p>
                </article>
              </Reveal>
            ))}
          </div>

          <Reveal delay={240} className="mt-6">
            <p className="text-center text-[12px] text-[var(--text-muted)]">
              Detailed case studies available on request.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ---- Pricing ------------------------------------------------------- */}
      <section
        id="pricing"
        className="scroll-mt-20 border-y border-[var(--border-subtle)] bg-[var(--bg-panel)]/40 py-24"
      >
        <div className="mx-auto w-full max-w-[1120px] px-5">
          <SectionHeading
            eyebrow="Pricing"
            title="Built around your ad spend"
            body="No pricing table can be honest without knowing your account. Tell us where you are and we'll quote precisely — usually within one business day."
          />

          <Reveal delay={120} className="mx-auto mt-10 max-w-[560px]">
            <div className="panel p-7">
              <ul className="space-y-3">
                {PRICING_POINTS.map((point) => (
                  <li key={point} className="flex items-start gap-3 text-[13.5px]">
                    <Check className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" aria-hidden />
                    <span className="text-[var(--text-secondary)]">{point}</span>
                  </li>
                ))}
              </ul>

              <Button variant="primary" size="lg" className="mt-7 w-full" asChild>
                <a href="mailto:leandro@dropscale.io?subject=Pricing%20—%20Google%20Ads%20management">
                  <Wallet />
                  Get a quote
                </a>
              </Button>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---- Final CTA ----------------------------------------------------- */}
      <section className="relative overflow-hidden py-24">
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-[-24rem] left-1/2 size-[44rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(212,168,106,0.10),transparent_65%)] blur-2xl"
        />

        <div className="relative mx-auto max-w-[640px] px-5 text-center">
          <Reveal>
            <h2 className="text-[30px] leading-tight font-semibold tracking-tight text-[var(--text-primary)] sm:text-[38px]">
              Ready to make Google Ads your most profitable channel?
            </h2>
            <p className="mt-4 text-[14.5px] leading-relaxed text-[var(--text-secondary)]">
              A 30-minute call is enough to tell you — honestly — whether we can move your
              numbers. If we can&apos;t, we&apos;ll say so.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button variant="primary" size="lg" asChild>
                <a href="mailto:leandro@dropscale.io?subject=Intro%20call%20—%20Google%20Ads">
                  <CalendarClock />
                  Book a call
                </a>
              </Button>
              <Button variant="secondary" size="lg" asChild>
                <Link href="/register">
                  <Search />
                  Create portal account
                </Link>
              </Button>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
