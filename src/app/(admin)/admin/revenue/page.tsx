import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { RevenueView } from "@/components/finance/revenue-view";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchFinanceSnapshot } from "@/lib/finance/queries";
import { syncCommissionLedger } from "@/lib/admin/commission-sync";
import { getServerDictionary } from "@/lib/i18n/server";
import { DEFAULT_FINANCE_RANGE, defaultBounds } from "@/lib/finance/defaults";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.finance.revenue.title };
}

export default async function RevenuePage() {
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");

  // Pull fresh Google Ads commissions into the ledger BEFORE reading it, so
  // the page always shows today's numbers. Self-throttled to once an hour.
  await syncCommissionLedger();

  const supabase = await createClient();
  const { from, to } = defaultBounds();
  const snapshot = await fetchFinanceSnapshot(supabase, from, to);

  return (
    <RevenueView
      initial={snapshot}
      initialRange={DEFAULT_FINANCE_RANGE}
      currentUserId={profile.id}
    />
  );
}
