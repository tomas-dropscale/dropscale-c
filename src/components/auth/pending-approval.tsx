"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock, LogOut, RefreshCw, ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/provider";

/**
 * Shown to a signed-in user who has no way in yet: staff whose role is not
 * 'admin', or a portal client the team has not approved.
 *
 * This is a courtesy screen, not a security boundary — the data itself is
 * protected by RLS, so someone who bypasses this sees nothing either way.
 */
export function PendingApproval({
  email,
  audience = "staff",
  rejected = false,
}: {
  email: string;
  audience?: "staff" | "client";
  rejected?: boolean;
}) {
  const router = useRouter();
  const { d } = useI18n();
  const [busy, setBusy] = React.useState(false);

  const title = rejected ? d.pending.rejectedTitle : d.pending.title;
  const body = rejected
    ? d.pending.rejectedBody
    : audience === "client"
      ? d.pending.clientBody
      : d.pending.body;

  async function signOut() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[440px] rounded-[var(--radius-window)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-7">
        <Logo size="lg" />

        <div className="mt-6 flex size-10 items-center justify-center rounded-full bg-[var(--accent-gold-dim)]">
          {rejected ? (
            <ShieldOff className="size-5 text-[var(--accent-gold)]" aria-hidden />
          ) : (
            <Clock className="size-5 text-[var(--accent-gold)]" aria-hidden />
          )}
        </div>

        <h1 className="mt-4 text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">{body}</p>

        <p className="mt-5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2.5 text-[12.5px] text-[var(--text-secondary)]">
          <span className="label-caps block">{d.pending.signedInAs}</span>
          <span className="mt-0.5 block truncate text-[var(--text-primary)]">{email}</span>
        </p>

        <div className="mt-5 flex gap-2">
          {/* Nothing to re-check once the answer is a firm no. */}
          {!rejected && (
            <Button variant="secondary" onClick={() => router.refresh()} disabled={busy}>
              <RefreshCw aria-hidden />
              {d.pending.recheck}
            </Button>
          )}
          <Button variant="ghost" onClick={() => void signOut()} loading={busy}>
            {!busy && <LogOut aria-hidden />}
            {d.pending.signOut}
          </Button>
        </div>
      </div>
    </div>
  );
}
