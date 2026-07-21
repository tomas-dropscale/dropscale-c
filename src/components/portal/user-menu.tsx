"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import type { Client } from "@/lib/supabase/types";
import { AccountMenu } from "@/components/ui/account-menu";
import { createClient } from "@/lib/supabase/client";

export function useSignOut() {
  const router = useRouter();
  return async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login?notice=signed-out");
    router.refresh();
  };
}

export function UserBadge({ client }: { client: Client }) {
  const signOut = useSignOut();
  const [signingOut, setSigningOut] = React.useState(false);

  return (
    <AccountMenu
      name={client.full_name}
      email={client.email}
      avatarUrl={client.avatar_url}
      seed={client.id}
      settingsHref="/dashboard/settings"
      signingOut={signingOut}
      onSignOut={() => {
        setSigningOut(true);
        void signOut();
      }}
    />
  );
}
