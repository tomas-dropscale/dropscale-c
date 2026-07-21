"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { oauthRedirect } from "@/lib/site";
import { useI18n } from "@/lib/i18n/provider";

/** Google's mark, inline so the button never waits on a network request. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="size-4 shrink-0" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

/**
 * Sign in / sign up with Google — one and the same to Supabase, which is why
 * this component serves both pages.
 *
 * On success the browser leaves for Google, so there is no success path to
 * handle here: everything after consent happens in /auth/callback.
 */
export function GoogleButton({ onError }: { onError?: (message: string) => void }) {
  const { d } = useI18n();
  const [busy, setBusy] = React.useState(false);

  async function signIn() {
    setBusy(true);

    const { error } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: oauthRedirect("/dashboard"),
        // Always show the account chooser: shared machines are common and a
        // silent re-auth into the wrong account is confusing to undo.
        queryParams: { prompt: "select_account" },
      },
    });

    if (error) {
      setBusy(false);
      onError?.(error.message);
    }
  }

  return (
    <div className="space-y-4">
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        loading={busy}
        onClick={() => void signIn()}
      >
        {!busy && <GoogleMark />}
        {d.auth.continueWithGoogle}
      </Button>

      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
        <span className="text-[11px] tracking-wider text-[var(--text-muted)] uppercase">
          {d.auth.or}
        </span>
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
    </div>
  );
}
