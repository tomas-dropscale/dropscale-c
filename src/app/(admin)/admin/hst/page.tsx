import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { HstView } from "@/components/finance/hst-view";
import { getSessionProfile } from "@/lib/supabase/server";
import { fetchHstOverview, syncHstCommission } from "@/lib/admin/hst";

export const metadata: Metadata = { title: "HST" };

/**
 * The HST tab: the supplier's own numbers, and what they've settled. Like the
 * other finance pages it refreshes the ledger before reading it (throttled),
 * so opening the tab is enough to see today's commission.
 *
 * This is the AGENCY's side of HST — the commission the supplier pays us for
 * each client order. A client's own HST account, which prices their goods, is
 * theirs and lives on their COGS page; the two never meet, and neither can be
 * reached from the other.
 */
export default async function HstPage() {
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");

  await syncHstCommission();
  const overview = await fetchHstOverview();

  return <HstView overview={overview} />;
}
