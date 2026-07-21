"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Signs the user out the moment their own profile stops being 'admin'.
 *
 * Navigation is already safe — the dashboard layout re-reads the role from the
 * database on every request. The gap this closes is the idle tab: someone left
 * on a page keeps seeing it after being demoted. Subscribing to their own row
 * revokes the session immediately instead of waiting for the next navigation.
 *
 * This is UX, not the security boundary. The data is protected by RLS, so a
 * demoted user's queries start failing whether or not this component runs.
 */
export function RoleWatcher({ userId }: { userId: string }) {
  const router = useRouter();

  React.useEffect(() => {
    const supabase = createClient();

    const signOut = async () => {
      await supabase.auth.signOut();
      router.replace("/login?notice=access-revoked");
      router.refresh();
    };

    const channel = supabase
      .channel(`profile-role:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${userId}`,
        },
        (payload) => {
          const next = payload.new as { role?: string } | null;
          // A demotion also removes the SELECT policy on other rows, so the
          // page is already half-broken by this point — leave immediately.
          if (next && next.role !== "admin") void signOut();
        },
      )
      // DELETE carries no row data under RLS, so treat any delete on this
      // channel as "the profile is gone" and bail out too.
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${userId}`,
        },
        () => void signOut(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, router]);

  return null;
}
