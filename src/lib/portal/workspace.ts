/**
 * Which client workspace the viewer is looking at.
 *
 * A portal login used to BE the workspace — every query said
 * `client_id = auth.uid()`. Since migration 0015 a login can also be a sócio of
 * somebody else's workspace, so the two questions came apart:
 *
 *   VIEWER    — who is signed in (avatar, personal settings, sign out).
 *   WORKSPACE — whose stores, costs and invoices are on screen. This is the
 *               OWNER's portal_clients id, which is what every `client_id`
 *               column in the schema points at. Nothing about the data moved.
 *
 * Most people own exactly one workspace and are a member of none, so `active`
 * is simply their own. When there are several, the choice is a cookie and the
 * switcher in the account menu writes it.
 *
 * The zone rule from data.ts still holds and is why every read pins the id
 * explicitly: RLS now permits ALL of the viewer's workspaces at once, so it can
 * no longer be what decides which one you see — the active workspace is.
 */

import { cache } from "react";
import { cookies } from "next/headers";

import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { WORKSPACE_COOKIE } from "@/lib/portal/workspace-cookie";
import type { Client } from "@/lib/supabase/types";

export { WORKSPACE_COOKIE };

export type Workspace = {
  /** The owner's portal_clients id — the value of `client_id` on their rows. */
  id: string;
  name: string;
  email: string;
  /** False when the viewer is a sócio here rather than the owner. */
  isOwner: boolean;
};

export type WorkspaceContext = {
  /** The signed-in auth user, or null when there is no session. */
  user: User | null;
  /** The signed-in user's own portal_clients row, or null if they have none. */
  viewer: Client | null;
  /** Every workspace the viewer may open, own first. */
  workspaces: Workspace[];
  /** The one on screen — cookie choice, else the first accessible one. */
  active: Workspace | null;
  /** The active workspace's portal_clients row (owner identity, Stripe customer). */
  owner: Client | null;
};

const EMPTY: WorkspaceContext = {
  user: null,
  viewer: null,
  workspaces: [],
  active: null,
  owner: null,
};

/**
 * Turns any invitation waiting for this person's email into a membership.
 *
 * Called by the portal gate, i.e. once per dashboard navigation, because that
 * is the only moment we can be sure the invitee has a session: invites are
 * matched by CONFIRMED email inside the database function, which is what makes
 * a service-role key unnecessary here. Idempotent and cheap — an indexed
 * lookup that finds nothing on all but the first load after being invited.
 */
export async function acceptPendingInvites(): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_client_invites");
  // Never fatal: a failure here means the sócio waits for the next page load,
  // not that the person cannot use the portal they already have. 42501 is a
  // signed-out visitor — the grant is to `authenticated` only — which is an
  // expected outcome on public pages, not something to log.
  if (error && error.code !== "42501") {
    console.error("accept_client_invites failed:", error.message);
  }
}

/**
 * Cached per request: layout, page and their children all ask for this, and it
 * should cost one round trip, not five.
 */
export const getWorkspaceContext = cache(async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return EMPTY;

  const [{ data: viewer }, { data: memberships }] = await Promise.all([
    supabase.from("portal_clients").select("*").eq("id", user.id).maybeSingle(),
    supabase.from("client_members").select("client_id").eq("member_id", user.id),
  ]);

  if (!viewer) return { ...EMPTY, user };

  const ownerIds = (memberships ?? []).map((row) => row.client_id).filter((id) => id !== viewer.id);

  // The owner rows of the workspaces the viewer was invited into. Readable
  // thanks to shares_client_workspace() in migration 0015.
  const owners: Client[] = [];
  if (ownerIds.length > 0) {
    const { data } = await supabase.from("portal_clients").select("*").in("id", ownerIds);
    owners.push(...((data as Client[] | null) ?? []));
  }

  // Only approved workspaces are openable — an unapproved one has no readable
  // data anyway (can_open_workspace), so listing it would be a dead end.
  const workspaces: Workspace[] = [];
  if (viewer.approval_status === "approved") {
    workspaces.push({ id: viewer.id, name: viewer.full_name, email: viewer.email, isOwner: true });
  }
  for (const owner of owners) {
    if (owner.approval_status !== "approved") continue;
    workspaces.push({ id: owner.id, name: owner.full_name, email: owner.email, isOwner: false });
  }

  const chosen = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const active = workspaces.find((w) => w.id === chosen) ?? workspaces[0] ?? null;
  const ownerRow = active
    ? active.id === viewer.id
      ? viewer
      : (owners.find((o) => o.id === active.id) ?? null)
    : null;

  return { user, viewer, workspaces, active, owner: ownerRow };
});

/**
 * The id to pin every portal read and write to. Null means "no workspace" —
 * callers return empty rather than falling back to the user id, because that
 * fallback is exactly the bug this module exists to prevent.
 */
export async function activeWorkspaceId(): Promise<string | null> {
  const { active } = await getWorkspaceContext();
  return active?.id ?? null;
}
