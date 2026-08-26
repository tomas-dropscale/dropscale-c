"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

/**
 * Takes a blocked client out of the dashboard the moment the team blocks them.
 *
 * Navigation is already safe — the portal gate is force-dynamic and re-reads
 * portal_clients on every request. The gap this closes is the idle tab: a
 * client left sitting on their dashboard keeps seeing live numbers after the
 * block, until they happen to click something.
 *
 * Refreshing rather than signing out is deliberate. The gate then renders the
 * blocked screen, which says plainly what happened and offers sign-out — a
 * client dumped on the login page has to guess. Signing them out would reach
 * the same place anyway: logging back in lands on the same screen.
 *
 * This is UX, not the security boundary. RLS decides what data can leave the
 * database, so a blocked client gains nothing by blocking this component.
 */
export function AccessWatcher({ clientId }: { clientId: string }) {
  const router = useRouter();

  React.useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`portal-access:${clientId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "portal_clients",
          filter: `id=eq.${clientId}`,
        },
        (payload) => {
          const next = payload.new as
            | { access_blocked?: boolean; approval_status?: string }
            | null;
          if (!next) return;
          // Archiving lands here too: it flips approval_status to 'rejected',
          // which empties the workspace list and closes the portal just as
          // firmly. Both deserve the same immediate exit.
          if (next.access_blocked === true || next.approval_status === "rejected") {
            router.refresh();
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [clientId, router]);

  return null;
}
