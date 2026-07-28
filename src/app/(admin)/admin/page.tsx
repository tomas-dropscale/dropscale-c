import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OverviewView } from "@/components/finance/overview-view";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchFinanceSnapshot } from "@/lib/finance/queries";
import {
  purgeAdminAccountRevenue,
  syncCommissionLedger,
  syncRevenueShareLedger,
} from "@/lib/admin/commission-sync";
import { syncHstCommission } from "@/lib/admin/hst";
import { countActiveClients } from "@/lib/admin/active-clients";
import { getServerDictionary } from "@/lib/i18n/server";
import { defaultSelection } from "@/lib/finance/defaults";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.nav.overview };
}

export default async function OverviewPage() {
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");

  // Strip any revenue booked for admins' own accounts, then refresh the ledgers
  // (Google + revenue share + HST) before reading. All throttled.
  await purgeAdminAccountRevenue();
  await syncCommissionLedger();
  await syncRevenueShareLedger();
  await syncHstCommission();

  const supabase = await createClient();
  const range = defaultSelection();
  const snapshot = await fetchFinanceSnapshot(supabase, range.from, range.to);
  const activeClientCount = await countActiveClients(supabase);

  return (
    <OverviewView
      initial={snapshot}
      initialRange={range}
      firstName={profile.full_name.split(" ")[0]}
      currentUserId={profile.id}
      activeClientCount={activeClientCount}
    />
  );
}
