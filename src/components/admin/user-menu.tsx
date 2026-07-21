"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { AccountMenu } from "@/components/ui/account-menu";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/supabase/types";

export function UserMenu({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);

  async function signOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <AccountMenu
      name={profile.full_name}
      email={profile.email}
      avatarUrl={profile.avatar_url}
      seed={profile.id}
      settingsHref="/admin/settings"
      signingOut={signingOut}
      onSignOut={() => void signOut()}
      badge={
        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] px-2 py-0.5 text-[10px] font-medium tracking-wide text-[var(--accent-gold-strong)] uppercase">
          <ShieldCheck className="size-3" aria-hidden />
          {profile.role}
        </span>
      }
    />
  );
}
