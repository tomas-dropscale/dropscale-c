"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";

import { FormAlert } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";

/**
 * Where the Apify token lives. Comparison runs cost money, so the credential
 * is stored encrypted server-side and never sent back to the browser — the
 * page only ever learns whether one exists and its last four characters.
 */
export function ResearchApifyKey({
  configured,
  hint,
}: {
  configured: boolean;
  hint: string | null;
}) {
  const router = useRouter();
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<
    { tone: "error" | "success"; message: string } | null
  >(null);

  async function save() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/research/apify-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        hint?: unknown;
      } | null;
      if (!response.ok) {
        setFeedback({
          tone: "error",
          message:
            typeof body?.error === "string" ? body.error : "The token could not be saved.",
        });
        return;
      }
      setToken("");
      setFeedback({
        tone: "success",
        message: `Apify token saved (ends in ${String(body?.hint ?? "")}).`,
      });
      router.refresh();
    } catch {
      setFeedback({ tone: "error", message: "The token could not be saved." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel p-4 sm:p-5" aria-label="Apify token">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="label-caps">Apify token</p>
          <p className="mt-1 text-[12.5px] text-[var(--text-secondary)]">
            {configured
              ? `Saved and in use${hint ? ` · ends in ${hint}` : ""}. Paste a new one to rotate it.`
              : "Not configured. Market comparison needs it to run."}
          </p>
        </div>
        <span
          className={
            configured
              ? "inline-flex items-center gap-1.5 rounded-full bg-[var(--success-green)]/10 px-2.5 py-1 text-[11.5px] font-medium text-[var(--success-green)]"
              : "inline-flex items-center gap-1.5 rounded-full bg-[var(--warning-orange)]/15 px-2.5 py-1 text-[11.5px] font-medium text-[var(--warning-orange)]"
          }
        >
          <KeyRound className="size-3" aria-hidden />
          {configured ? "Ready" : "Missing"}
        </span>
      </div>

      {feedback && (
        <div className="mt-3">
          <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="apify_api_…"
          aria-label="Apify token"
          autoComplete="off"
          className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 font-mono text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-gold)] sm:max-w-md"
        />
        <Button type="button" onClick={save} disabled={!token.trim() || busy}>
          {configured ? "Replace token" : "Save token"}
        </Button>
      </div>
    </section>
  );
}
