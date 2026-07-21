"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/provider";

/**
 * The only interactive part of the confirmation page, split out so the page
 * itself stays a Server Component and can read the session directly.
 *
 * "Check again" is a plain refresh: the page re-reads approval_status on the
 * server and redirects to the dashboard by itself once the team approves.
 */
export function ConfirmedActions() {
  const router = useRouter();
  const { d } = useI18n();
  const [busy, setBusy] = React.useState(false);

  async function signOut() {
    setBusy(true);
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="mt-5 flex gap-2">
      <Button variant="secondary" onClick={() => router.refresh()} disabled={busy}>
        <RefreshCw aria-hidden />
        {d.pending.recheck}
      </Button>
      <Button variant="ghost" onClick={() => void signOut()} loading={busy}>
        {!busy && <LogOut aria-hidden />}
        {d.pending.signOut}
      </Button>
    </div>
  );
}
