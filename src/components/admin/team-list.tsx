"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ShieldCheck, ShieldOff } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";
import type { Profile } from "@/lib/supabase/types";

/**
 * Team roster with role management.
 *
 * The buttons are only a convenience: the actual authorization lives in the
 * database. `profiles_guard_role` rejects role changes from non-admins and
 * `guard_last_admin` refuses to strip the final admin, so a crafted request
 * that skips this UI fails the same way.
 */
export function TeamList({
  members,
  currentUserId,
  isAdmin,
}: {
  members: Profile[];
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const { d } = useI18n();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function setRole(member: Profile, role: Profile["role"]) {
    if (member.id === currentUserId && role === "member") {
      setError(d.settings.cannotDemoteSelf);
      return;
    }

    setBusyId(member.id);
    setError(null);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ role })
      .eq("id", member.id);

    if (updateError) {
      setError(fmt(d.settings.roleChangeFailed, { message: updateError.message }));
      setBusyId(null);
      return;
    }

    router.refresh();
    setBusyId(null);
  }

  return (
    <section className="panel p-5">
      <header className="mb-1 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{d.settings.team}</h2>
        <span className="label-caps">{fmt(d.settings.memberCount, { count: members.length })}</span>
      </header>
      <p className="mb-4 text-[12.5px] text-[var(--text-secondary)]">{d.settings.accessHelp}</p>

      {error && (
        <p className="mb-4 flex items-start gap-2 rounded-[10px] border border-[var(--danger-red)]/30 bg-[var(--danger-red)]/10 px-3 py-2 text-[12.5px] text-[#e2a49b]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {members.map((member) => {
          const isSelf = member.id === currentUserId;
          const admin = member.role === "admin";

          return (
            <li key={member.id} className="flex items-center gap-3">
              <Avatar
                name={member.full_name}
                src={member.avatar_url}
                seed={member.id}
                size="lg"
              />

              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                  {member.full_name}
                  {isSelf && (
                    <span className="ml-1.5 text-[11px] font-normal text-[var(--text-muted)]">
                      ({d.common.you})
                    </span>
                  )}
                </p>
                <p className="truncate text-[11.5px] text-[var(--text-secondary)]">
                  {member.email}
                </p>
              </div>

              <Badge variant={admin ? "gold" : "neutral"}>
                {admin ? "admin" : d.settings.pending}
              </Badge>

              {isAdmin && !isSelf && (
                <Button
                  size="sm"
                  variant={admin ? "ghost" : "secondary"}
                  loading={busyId === member.id}
                  onClick={() => void setRole(member, admin ? "member" : "admin")}
                >
                  {busyId !== member.id &&
                    (admin ? <ShieldOff aria-hidden /> : <ShieldCheck aria-hidden />)}
                  {admin ? d.settings.revokeAdmin : d.settings.makeAdmin}
                </Button>
              )}
            </li>
          );
        })}

        {members.length === 0 && (
          <li className="text-[12.5px] text-[var(--text-muted)]">{d.settings.noMembers}</li>
        )}
      </ul>
    </section>
  );
}
