"use client";

import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { Rich } from "@/components/ui/rich-text";
import { createClient } from "@/lib/supabase/client";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/**
 * Signed in, but no clients row — e.g. a staff account, or an auth user the
 * team hasn't onboarded as a client yet. Deliberately explains nothing about
 * what data exists; it only offers the way out.
 */
export function NotAClient({ email }: { email: string }) {
  const router = useRouter();
  const { d } = useI18n();

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login?notice=signed-out");
    router.refresh();
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-[440px] rounded-[var(--radius-window)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-7 text-center">
        <div className="mb-5 flex justify-center">
          <Logo size="lg" />
        </div>

        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-[var(--accent-gold-dim)]">
          <ShieldAlert className="size-5 text-[var(--accent-gold)]" />
        </div>

        <h1 className="text-[17px] font-semibold tracking-tight text-[var(--text-primary)]">
          {d.banners.notAClientTitle}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {/* The email is emphasised inside the sentence via **{email}**, so each
              language can place it where its own grammar wants it. */}
          <Rich text={fmt(d.banners.notAClientBody, { email })} />
        </p>

        <Button variant="secondary" size="lg" className="mt-6 w-full" onClick={signOut}>
          {d.userMenu.signOut}
        </Button>
      </div>
    </div>
  );
}
