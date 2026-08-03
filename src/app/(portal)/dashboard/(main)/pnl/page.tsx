import type { Metadata } from "next";

import { fetchAccounts } from "@/lib/portal/data";
import { PnlSheetView } from "@/components/portal/pnl-sheet";
import { StoreSelector } from "@/components/portal/store-selector";
import { PageContainer } from "@/components/ui/page-container";
import { ensureDailyCoverage, recomputeDailyMetrics } from "@/lib/metrics/recompute";
import { fetchDailyMetrics } from "@/lib/metrics/queries";
import { buildPnlSheet, monthDays } from "@/lib/portal/pnl";
import { fetchManualReferralRateSchedule } from "@/lib/billing/referral-rate-schedule";
import { manualReferralRateOnDay } from "@/lib/billing/referrals";
import { intlLocale } from "@/lib/i18n";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.pnl.title };
}

/** How many years back the picker offers. Beyond this there is no data anyway. */
const YEARS_BACK = 2;

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;

/**
 * The client's P&L, one month per view.
 *
 * Period and store live in the URL (?year=&month=&store=), so the page stays a
 * Server Component, every view is a shareable link, and the back button works.
 */
export default async function PnlPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string; store?: string }>;
}) {
  const params = await searchParams;
  const [accounts, { d, locale }] = await Promise.all([fetchAccounts(), getServerDictionary()]);
  const intl = intlLocale(locale);

  const now = new Date();
  const year = clamp(Number(params.year ?? now.getFullYear()), now.getFullYear() - YEARS_BACK, now.getFullYear());
  const month = clamp(Number(params.month ?? now.getMonth() + 1), 1, 12);

  // A store filter, or every store combined — the same choice the rest of the
  // portal offers, and the P&L of one shop is a different question to the P&L
  // of the whole business.
  const selected = accounts.find((account) => account.id === params.store) ?? null;
  const scope = selected ? [selected] : accounts;

  const days = monthDays(year, month);
  const from = days[0];
  const to = days[days.length - 1];

  // Older months need the backfill; the current one needs the rollup current.
  await ensureDailyCoverage(scope, from);
  await recomputeDailyMetrics(scope);

  const [rows, referralRateSchedule] = await Promise.all([
    fetchDailyMetrics(
      scope.map((account) => account.id),
      from,
      to,
    ),
    scope[0]
      ? fetchManualReferralRateSchedule(scope[0].client_id)
      : Promise.resolve([]),
  ]);

  const sheet = buildPnlSheet(
    rows,
    days,
    (accountId, day) => {
      const account = scope.find((candidate) => candidate.id === accountId);
      return Number(account?.list_commission_rate) === 10 && !account?.revenue_share_enabled
        ? manualReferralRateOnDay(day, referralRateSchedule)
        : Number(account?.commission_rate ?? 0);
    },
  );

  const years = Array.from({ length: YEARS_BACK + 1 }, (_, index) => now.getFullYear() - index)
    .reverse();

  /** Keeps the other params while changing one — the store filter must survive. */
  const hrefFor = (next: { year?: number; month?: number }) => {
    const query = new URLSearchParams();
    query.set("year", String(next.year ?? year));
    query.set("month", String(next.month ?? month));
    if (selected) query.set("store", selected.id);
    return `/dashboard/pnl?${query}`;
  };

  return (
    <PageContainer
      title={d.pnl.title}
      description={d.pnl.subtitle}
      actions={
        accounts.length > 1 ? (
          <StoreSelector accounts={accounts} current={selected?.id ?? null} />
        ) : undefined
      }
    >
      <PnlSheetView
        d={d}
        intl={intl}
        sheet={sheet}
        currency={scope[0]?.currency ?? "EUR"}
        year={year}
        month={month}
        years={years}
        hrefFor={hrefFor}
      />
    </PageContainer>
  );
}
