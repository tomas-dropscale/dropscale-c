"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, LogOut, Settings } from "lucide-react";

import type { Client } from "@/lib/supabase/types";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export function useSignOut() {
  const router = useRouter();
  return async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login?notice=signed-out");
    router.refresh();
  };
}

/**
 * Compact avatar-only badge for the window chrome; full block (avatar + name
 * + email + chevron) for the sidebar footer. Both open the same menu.
 */
export function UserBadge({ client, compact = false }: { client: Client; compact?: boolean }) {
  const signOut = useSignOut();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "transition-smooth outline-none",
          compact
            ? "rounded-full"
            : "flex w-full items-center gap-2.5 rounded-[10px] border border-transparent px-2 py-2 hover:bg-[var(--bg-panel-hover)]",
        )}
        aria-label="Account menu"
      >
        {compact ? (
          <Avatar name={client.full_name} src={client.avatar_url} seed={client.id} size="sm" />
        ) : (
          <>
            <Avatar name={client.full_name} src={client.avatar_url} seed={client.id} />
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                {client.full_name}
              </span>
              <span className="block truncate text-[11.5px] text-[var(--text-muted)]">
                {client.email}
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-[var(--text-muted)]" />
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align={compact ? "end" : "start"} className="w-52">
        <DropdownMenuItem asChild>
          <Link href="/dashboard/settings">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut} variant="danger">
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
