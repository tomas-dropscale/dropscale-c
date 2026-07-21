import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OverviewView } from "@/components/finance/overview-view";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchFinanceSnapshot } from "@/lib/finance/queries";
import { getServerDictionary } from "@/lib/i18n/server";
import { DEFAULT_FINANCE_RANGE, defaultBounds } from "@/lib/finance/defaults";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.nav.overview };
}

export default async function OverviewPage() {
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();
  const { from, to } = defaultBounds();
  const snapshot = await fetchFinanceSnapshot(supabase, from, to);

  return (
    <OverviewView
      initial={snapshot}
      initialRange={DEFAULT_FINANCE_RANGE}
      firstName={profile.full_name.split(" ")[0]}
      currentUserId={profile.id}
    />
  );
}
