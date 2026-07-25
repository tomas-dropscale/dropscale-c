"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";

/**
 * Admin card to bootstrap and run the HST commission sync. The admin logs in to
 * HST once (past the captcha), pastes the login RESPONSE here (which carries the
 * refresh token), and from then on the sync renews itself — no re-pasting until
 * the refresh token itself expires. No captcha is ever automated.
 */
export function HstCommissionCard({
  hasSession,
  lastSyncedAt,
  tokenExpiresAt,
}: {
  hasSession: boolean;
  lastSyncedAt: string | null;
  tokenExpiresAt: string | null;
}) {
  const router = useRouter();
  const [session, setSession] = React.useState("");
  const [busy, setBusy] = React.useState<"save" | "sync" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  async function saveSession() {
    setBusy("save");
    setError(null);
    setNotice(null);
    const res = await fetch("/api/hst/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Failed to save the session.");
      return;
    }
    setSession("");
    setNotice("Session saved. Syncing will renew the token on its own from now on.");
    router.refresh();
  }

  async function sync() {
    setBusy("sync");
    setError(null);
    setNotice(null);
    const res = await fetch("/api/hst/sync", { method: "POST" });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; total?: number; days?: number }
      | null;
    setBusy(null);
    if (!res.ok || !body?.ok) {
      setError(body?.error ?? "Sync failed.");
      return;
    }
    const total = typeof body.total === "number" ? body.total.toFixed(2) : body.total;
    setNotice(`Synced — commission total ${total} across ${body.days} day(s).`);
    router.refresh();
  }

  return (
    <section className="panel space-y-4 p-5">
      <header className="flex flex-wrap items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-[10px] bg-[var(--accent-gold-dim)]">
          <Truck className="size-4 text-[var(--accent-gold)]" />
        </div>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--text-primary)]">
          HST commission
        </h2>
        <Badge variant={hasSession ? "success" : "neutral"}>
          {hasSession ? "Connected" : "Not connected"}
        </Badge>
      </header>

      {error && <FormAlert>{error}</FormAlert>}
      {notice && <FormAlert tone="success">{notice}</FormAlert>}

      <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
        Sign in to HST once. In F12 → Network, click the{" "}
        <span className="font-mono">login</span> request → <span className="text-[var(--text-secondary)]">Response</span>{" "}
        → copy it all and paste below. It carries the refresh token, so the sync renews itself —
        you only repeat this if the refresh token expires (weeks). Stored encrypted.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="hst-session">HST login response</Label>
        <textarea
          id="hst-session"
          value={session}
          onChange={(event) => setSession(event.target.value)}
          rows={4}
          placeholder='{ "code": 0, "data": { "accessToken": "…", "refreshToken": "…", "expires": "…" } }'
          className="w-full rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 font-mono text-[12px] text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent-gold)]/40"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={session.trim() === ""}
          loading={busy === "save"}
          onClick={saveSession}
        >
          Save session
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasSession}
          loading={busy === "sync"}
          onClick={sync}
        >
          <RefreshCw />
          Sync now
        </Button>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] text-[var(--text-muted)]">
        <span>
          {lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : "Never synced"}
        </span>
        {tokenExpiresAt && (
          <span>Token valid until {new Date(tokenExpiresAt).toLocaleString()}</span>
        )}
      </div>
    </section>
  );
}
