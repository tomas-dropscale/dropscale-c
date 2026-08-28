"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";

/**
 * The one place HST is connected: signing in, and what the session is doing.
 *
 * Two ways in, because they fail differently. Signing in with the account's own
 * username and password is the one to use — the credentials are kept encrypted
 * and every later expiry is repaired without anybody being asked, which is what
 * the pasted route could never do. Pasting a login response still works and is
 * kept for the day the login endpoint changes shape, but it ends when its
 * refresh token does, silently.
 *
 * The captcha field is passed through exactly as typed. Nothing here invents a
 * value for it.
 */
export function HstCommissionCard({
  hasSession,
  hasCredentials,
  lastSyncedAt,
  tokenExpiresAt,
}: {
  hasSession: boolean;
  /** Credentials stored, so the session can rebuild itself unattended. */
  hasCredentials: boolean;
  lastSyncedAt: string | null;
  tokenExpiresAt: string | null;
}) {
  const router = useRouter();
  const [session, setSession] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [captcha, setCaptcha] = React.useState("");
  const [showPaste, setShowPaste] = React.useState(false);
  const [busy, setBusy] = React.useState<"save" | "sync" | "login" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  async function signIn() {
    setBusy("login");
    setError(null);
    setNotice(null);
    const res = await fetch("/api/hst/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, captchaCode: captcha || undefined }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Couldn't sign in to HST.");
      return;
    }
    // Nothing left to do with the password here once it is a session.
    setPassword("");
    setNotice("Signed in. The session will renew itself from now on.");
    router.refresh();
  }

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
      | {
          ok?: boolean;
          error?: string;
          total?: number;
          days?: number;
          booked?: number;
          ignoredRows?: number;
        }
      | null;
    setBusy(null);
    if (!res.ok || !body?.ok) {
      setError(body?.error ?? "Sync failed.");
      return;
    }
    const total = typeof body.total === "number" ? body.total.toFixed(2) : body.total;
    // The booked count is the honest one: it's what actually reached the ledger.
    setNotice(
      `Synced — ${body.booked} entries booked across ${body.days} day(s), commission total ${total}.` +
        (body.ignoredRows ? ` ${body.ignoredRows} HST row(s) had no usable date and were skipped.` : ""),
    );
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
        {hasCredentials
          ? "Signed in with the agency's HST account. The session renews itself, and signs back in on its own when the refresh token expires too — nothing here needs repeating."
          : "Sign in with the agency's HST account. One login covers every shop it buys through, and the credentials are kept encrypted so the session can rebuild itself instead of dying quietly."}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="hst-username">HST username</Label>
          <Input
            id="hst-username"
            autoComplete="off"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="hst-password">Password</Label>
          <Input
            id="hst-password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="hst-captcha">Captcha code (only if HST asks for one)</Label>
        <Input
          id="hst-captcha"
          autoComplete="off"
          value={captcha}
          placeholder="Leave empty unless the HST login shows a code"
          onChange={(event) => setCaptcha(event.target.value)}
        />
      </div>

      {/* The pasted route is the fallback for the day the login endpoint
          changes shape, not the way in. It is folded away so it stops reading
          as the normal thing to do. */}
      <button
        type="button"
        className="text-left text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-secondary)]"
        onClick={() => setShowPaste((open) => !open)}
      >
        {showPaste ? "Hide" : "Or paste a login response instead"}
      </button>

      {showPaste && (
        <div className="space-y-1.5">
          <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
            F12 → Network → the <span className="font-mono">login</span> request →{" "}
            <span className="text-[var(--text-secondary)]">Response</span> tab, not{" "}
            <span className="text-[var(--text-secondary)]">Preview</span>: Preview shortens long
            values with a <span className="font-mono">…</span>, and a token cut that way can never
            be sent. A session saved this way ends when its refresh token does.
          </p>
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
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={username.trim() === "" || password === ""}
          loading={busy === "login"}
          onClick={signIn}
        >
          Sign in to HST
        </Button>
        {showPaste && (
          <Button
            variant="secondary"
            size="sm"
            disabled={session.trim() === ""}
            loading={busy === "save"}
            onClick={saveSession}
          >
            Save pasted session
          </Button>
        )}
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
