import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OverviewView } from "@/components/finance/overview-view";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchAdminOperations } from "@/lib/admin/operations-overview";
import { getServerDictionary } from "@/lib/i18n/server";
import { defaultSelection } from "@/lib/finance/defaults";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.nav.overview };
}

export default async function OverviewPage() {
  const { profile } = await getSessionProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();
  const range = defaultSelection();

  // Nothing money-shaped is fetched here, and nothing money-shaped is sent.
  //
  // The finance snapshot used to be loaded on every visit and handed to a
  // client component, which put every commission and expense of the window into
  // the page source of a screen that draws none of them. The figures are behind
  // a toggle, so they are fetched by the browser when that toggle is used; the
  // only finance row the first screen needs is the partner list, which decides
  // whether a commission can be recorded at all and carries no amount.
  const [operations, sources] = await Promise.all([
    fetchAdminOperations(),
    supabase.from("revenue_sources").select("*").order("name"),
  ]);

  return (
    <OverviewView
      sources={sources.data ?? []}
      initialRange={range}
      firstName={profile.full_name.split(" ")[0]}
      currentUserId={profile.id}
      operations={operations}
    />
  );
}
