import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

import { AuthCard } from "@/components/auth/auth-card";
import { ConfirmedActions } from "@/components/auth/confirmed-actions";
import { getSessionClient, getSessionProfile } from "@/lib/supabase/server";
import { getServerDictionary } from "@/lib/i18n/server";
import { hasSupabaseEnv } from "@/lib/supabase/env";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.confirmed.title };
}

/**
 * Where the confirmation link in the signup email lands.
 *
 * It reads the real account state rather than assuming "just confirmed ⇒
 * pending": the same link can be opened days later, or by someone the team
 * has already approved, and telling an approved client to keep waiting would
 * be worse than not having this page at all.
 */
export const dynamic = "force-dynamic";

export default async function ConfirmedPage() {
  if (!hasSupabaseEnv()) redirect("/login");

  const { d } = await getServerDictionary();
  const { user, client } = await getSessionClient();

  // The link is what creates the session. No session means it was already
  // used or has expired — signing in is the only way forward.
  if (!user) redirect("/login");

  // Approved already (including staff, who hold an approved row): send them
  // where they actually want to go.
  if (client?.approval_status === "approved") redirect("/dashboard");

  // Staff without a portal identity belong in the admin area.
  if (!client) {
    const { profile } = await getSessionProfile();
    if (profile?.role === "admin") redirect("/admin");
  }

  if (client?.approval_status === "rejected") redirect("/dashboard");

  const steps = [d.confirmed.step1, d.confirmed.step2, d.confirmed.step3];

  return (
    <AuthCard title={d.confirmed.title} subtitle={d.confirmed.body}>
      <div className="mb-5 flex size-10 items-center justify-center rounded-full bg-[var(--accent-gold-dim)]">
        <CheckCircle2 className="size-5 text-[var(--accent-gold)]" aria-hidden />
      </div>

      <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3.5">
        <p className="label-caps">{d.confirmed.whatNext}</p>

        <ol className="mt-2.5 space-y-2">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-2.5 text-[12.5px] leading-relaxed">
              <span
                className="mt-[1px] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-[10.5px] font-semibold text-[var(--text-secondary)]"
                aria-hidden
              >
                {index + 1}
              </span>
              <span className="text-[var(--text-secondary)]">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      <p className="mt-4 rounded-[10px] border border-[var(--border-subtle)] px-3 py-2.5 text-[12.5px]">
        <span className="label-caps block">{d.pending.signedInAs}</span>
        <span className="mt-0.5 block truncate text-[var(--text-primary)]">{user.email}</span>
      </p>

      <ConfirmedActions />
    </AuthCard>
  );
}
