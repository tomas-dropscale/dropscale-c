import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PageContainer } from "@/components/ui/page-container";
import { CreativeInboxView } from "@/components/admin/creative-inbox";
import { getSessionProfile } from "@/lib/supabase/server";
import { getServerDictionary } from "@/lib/i18n/server";
import { fetchCreativeInbox } from "@/lib/admin/creatives";
import type { CreativeSubmissionStatus } from "@/lib/supabase/types";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.creativeInbox.title };
}

const STATUSES = new Set<string>(["new", "in_use", "rejected"]);

/**
 * The creative inbox: what clients have handed in, by client and store, ready to
 * be turned into campaigns.
 *
 * The filter lives in the URL rather than in component state so that marking a
 * batch and re-rendering keeps the view you were working in — and so "show me
 * everything new" is a link you can bookmark.
 */
export default async function CreativesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect("/dashboard");

  const params = await searchParams;
  const status: CreativeSubmissionStatus | "all" = STATUSES.has(params.status ?? "")
    ? (params.status as CreativeSubmissionStatus)
    : "all";

  const [inbox, { d }] = await Promise.all([fetchCreativeInbox(status), getServerDictionary()]);

  return (
    <PageContainer title={d.creativeInbox.title} description={d.creativeInbox.subtitle}>
      <CreativeInboxView inbox={inbox} status={status} adminId={profile.id} />
    </PageContainer>
  );
}
