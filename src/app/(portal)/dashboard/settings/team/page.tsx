import type { Metadata } from "next";

import { createClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { TeamManager, type TeamPerson } from "@/components/portal/team-manager";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";
import type { ClientInvite } from "@/lib/supabase/types";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.team.title };
}

/**
 * Settings → Partners: who else may open this workspace.
 *
 * Everything here is about the ACTIVE workspace, so a sócio managing a
 * workspace they were invited into is editing that one — the same page, read
 * through whichever account is selected in the switcher.
 */
export default async function TeamSettingsPage() {
  const [{ viewer, active, owner }, { d }] = await Promise.all([
    getWorkspaceContext(),
    getServerDictionary(),
  ]);
  if (!viewer || !active || !owner) return null; // gate already handled this

  const supabase = await createClient();
  const [{ data: memberRows }, { data: inviteRows }] = await Promise.all([
    supabase
      .from("client_members")
      .select("member_id, created_at")
      .eq("client_id", active.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("client_invites")
      .select("*")
      .eq("client_id", active.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
  ]);

  // Names and emails of the partners. Readable because they share a workspace
  // with the viewer (shares_client_workspace, migration 0015).
  const memberIds = (memberRows ?? []).map((row) => row.member_id);
  const people = new Map<string, { full_name: string; email: string; avatar_url: string | null }>();
  if (memberIds.length > 0) {
    const { data } = await supabase
      .from("portal_clients")
      .select("id, full_name, email, avatar_url")
      .in("id", memberIds);
    for (const row of data ?? []) {
      people.set(row.id, {
        full_name: row.full_name,
        email: row.email,
        avatar_url: row.avatar_url,
      });
    }
  }

  const members: TeamPerson[] = (memberRows ?? []).map((row) => {
    const person = people.get(row.member_id);
    return {
      id: row.member_id,
      name: person?.full_name ?? "—",
      email: person?.email ?? "",
      avatarUrl: person?.avatar_url ?? null,
      since: row.created_at,
    };
  });

  return (
    <PageContainer title={d.team.title} description={d.team.subtitle}>
      <div className="max-w-[720px]">
        <TeamManager
          workspaceId={active.id}
          viewerId={viewer.id}
          owner={{
            id: owner.id,
            name: owner.full_name,
            email: owner.email,
            avatarUrl: owner.avatar_url,
            since: owner.created_at,
          }}
          members={members}
          invites={(inviteRows as ClientInvite[] | null) ?? []}
        />
      </div>
    </PageContainer>
  );
}
