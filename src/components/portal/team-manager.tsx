"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Info, Mail, UserPlus } from "lucide-react";

import type { ClientInvite } from "@/lib/supabase/types";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

export type TeamPerson = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  since: string;
};

/**
 * Who can open this workspace, and the invite that puts someone new in it.
 *
 * A sócio has the owner's rights, so this page is the same for both — the only
 * asymmetry is structural: the owner has no membership row, so there is no
 * button that could remove them.
 *
 * Nothing here sends an email. The invite is a row keyed by address, and
 * accept_client_invites() (migration 0015) turns it into access the first time
 * that person loads the portal signed in with it. The copy says so, because an
 * invite that silently waits looks broken otherwise.
 */
export function TeamManager({
  workspaceId,
  viewerId,
  owner,
  members,
  invites,
}: {
  workspaceId: string;
  viewerId: string;
  owner: TeamPerson;
  members: TeamPerson[];
  invites: ClientInvite[];
}) {
  const router = useRouter();
  const { d, intl } = useI18n();

  const [email, setEmail] = React.useState("");
  const [inviting, setInviting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(intl, { day: "2-digit", month: "short", year: "numeric" });

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!address) return;

    setInviting(true);
    setError(null);
    setSent(null);

    const { error: insertError } = await createClient().from("client_invites").insert({
      client_id: workspaceId,
      email: address,
      invited_by: viewerId,
    });

    setInviting(false);

    if (insertError) {
      // The partial unique index is the only failure that arrives as a raw
      // Postgres message; the guard trigger's own errors are already readable.
      setError(insertError.code === "23505" ? d.team.alreadyInvited : insertError.message);
      return;
    }

    setEmail("");
    setSent(address);
    router.refresh();
  }

  async function revoke(inviteId: string) {
    setBusyId(inviteId);
    setError(null);
    const { error: deleteError } = await createClient()
      .from("client_invites")
      .delete()
      .eq("id", inviteId);
    setBusyId(null);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    router.refresh();
  }

  async function removeMember(person: TeamPerson) {
    const leaving = person.id === viewerId;
    const question = leaving
      ? fmt(d.team.leaveConfirm, { name: owner.name })
      : fmt(d.team.removeConfirm, { name: person.name });
    if (!window.confirm(question)) return;

    setBusyId(person.id);
    setError(null);
    const { error: deleteError } = await createClient()
      .from("client_members")
      .delete()
      .eq("client_id", workspaceId)
      .eq("member_id", person.id);
    setBusyId(null);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    // Leaving removes the workspace you are standing in, so go home and let the
    // gate pick whichever one is left.
    if (leaving) {
      router.push("/dashboard");
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {error && <FormAlert>{error}</FormAlert>}
      {sent && <FormAlert tone="success">{fmt(d.team.invited, { email: sent })}</FormAlert>}

      {/* WHO HAS ACCESS */}
      <section className="panel p-5">
        <header className="mb-1 flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{d.team.members}</h2>
        </header>
        <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          {d.team.accessNote}
        </p>

        <ul className="divide-y divide-[var(--border-subtle)] rounded-[10px] border border-[var(--border-subtle)]">
          <PersonRow person={owner} badge={<Badge variant="gold">{d.team.owner}</Badge>} isYou={owner.id === viewerId} />

          {members.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              badge={<Badge>{d.team.partner}</Badge>}
              isYou={person.id === viewerId}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busyId === person.id}
                  onClick={() => void removeMember(person)}
                >
                  {person.id === viewerId ? d.team.leave : d.team.remove}
                </Button>
              }
            />
          ))}
        </ul>

        {members.length === 0 && (
          <p className="mt-3 text-[12.5px] text-[var(--text-muted)]">{d.team.noPartners}</p>
        )}
      </section>

      {/* PENDING INVITES */}
      {invites.length > 0 && (
        <section className="panel p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-[var(--text-primary)]">
            {d.team.pendingInvites}
          </h2>

          <ul className="divide-y divide-[var(--border-subtle)] rounded-[10px] border border-[var(--border-subtle)]">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
                <Mail className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-[var(--text-primary)]">{invite.email}</p>
                  <p className="text-[11.5px] text-[var(--text-muted)]">
                    {fmt(d.team.invitedOn, { date: day(invite.created_at) })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busyId === invite.id}
                  onClick={() => void revoke(invite.id)}
                >
                  {d.team.revoke}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* INVITE */}
      <section className="panel p-5">
        <header className="mb-1 flex items-center gap-2">
          <UserPlus
            size={17}
            strokeWidth={1.5}
            className="text-[var(--accent-gold)]"
            aria-hidden
          />
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{d.team.invite}</h2>
        </header>

        <form onSubmit={invite} className="mt-4 space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="partner-email">{d.team.emailLabel}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="partner-email"
                type="email"
                autoComplete="off"
                placeholder={d.team.emailPlaceholder}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="flex-1"
              />
              <Button type="submit" variant="primary" loading={inviting} disabled={!email.trim()}>
                {d.team.inviteCta}
              </Button>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <span>{d.team.pendingHint}</span>
          </div>
        </form>
      </section>
    </div>
  );
}

function PersonRow({
  person,
  badge,
  isYou,
  action,
}: {
  person: TeamPerson;
  badge: React.ReactNode;
  isYou: boolean;
  action?: React.ReactNode;
}) {
  const { d } = useI18n();

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar name={person.name} src={person.avatarUrl} seed={person.id} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-[13px] font-medium text-[var(--text-primary)]">
          {person.name}
          {isYou && <span className="text-[11.5px] text-[var(--text-muted)]">({d.common.you})</span>}
        </p>
        <p className="truncate text-[11.5px] text-[var(--text-secondary)]">{person.email}</p>
      </div>
      {badge}
      {action}
    </li>
  );
}
