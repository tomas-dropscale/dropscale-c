"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Store } from "lucide-react";

import type { Client } from "@/lib/supabase/types";
import type { Workspace } from "@/lib/portal/workspace";
import { AccountMenu } from "@/components/ui/account-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/provider";
import { setWorkspaceCookie } from "@/lib/portal/workspace-cookie";

export function useSignOut() {
  const router = useRouter();
  return async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login?notice=signed-out");
    router.refresh();
  };
}

/**
 * The signed-in person, plus — when they are a sócio somewhere — the workspace
 * they are currently looking at.
 *
 * Switching lands on /dashboard rather than staying put on purpose: the current
 * URL may carry a store id belonging to the workspace being left, which in the
 * new one is simply not found.
 */
export function UserBadge({
  viewer,
  workspaces = [],
  activeWorkspaceId,
}: {
  viewer: Client;
  workspaces?: Workspace[];
  activeWorkspaceId?: string;
}) {
  const router = useRouter();
  const { d } = useI18n();
  const signOut = useSignOut();
  const [signingOut, setSigningOut] = React.useState(false);

  function switchTo(id: string) {
    if (id === activeWorkspaceId) return;
    setWorkspaceCookie(id);
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <AccountMenu
      name={viewer.full_name}
      email={viewer.email}
      avatarUrl={viewer.avatar_url}
      seed={viewer.id}
      settingsHref="/dashboard/settings"
      extraItems={
        workspaces.length > 1 ? (
          <>
            <DropdownMenuLabel>{d.team.workspace}</DropdownMenuLabel>
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onSelect={(event) => {
                  event.preventDefault();
                  switchTo(workspace.id);
                }}
              >
                <Store aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {workspace.isOwner ? d.team.myWorkspace : workspace.name}
                </span>
                {workspace.id === activeWorkspaceId && (
                  <Check className="size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null
      }
      signingOut={signingOut}
      onSignOut={() => {
        setSigningOut(true);
        void signOut();
      }}
    />
  );
}
