"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Coins, RefreshCw, Truck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { money } from "@/lib/format";
import { FormAlert } from "@/components/auth/auth-card";
import { HstCaptcha, randomHstCaptcha } from "@/components/portal/hst-captcha";
import { useCogsFill } from "@/components/portal/cogs-fill";

export type HstStoreCogsProps = {
  adAccountId: string;
  storeName: string;
  /** The supplier's own code for this store, or null when it is not set. */
  hstShopId: string | null;
  /** This client has connected their own HST account. */
  connected: boolean;
  /** Why the last sync failed, in HST's own words. */
  lastError: string | null;
  /** Shops this login can see — suggestions, never a limit on what can be typed. */
  shops: Array<{ id: string; name: string }>;
  shopsError: string | null;
  /**
   * The supplier's per-order import duty over a recent window, so the client
   * can see it is counted — it rides in the day's costs, not in any product's
   * unit cost, and it would otherwise be invisible next to the product COGS.
   */
  duty: { total: number; orders: number; currency: string; days: number } | null;
};

type SyncOutcome = {
  written: number;
  unchanged: number;
  unknownProducts: number;
  charges: number;
  unquotedLines: number;
};

/**
 * Connect this store's own supplier account, and let its costs arrive by
 * themselves.
 *
 * The credentials are the store owner's, not the agency's: an HST account sees
 * its owner's shop and nobody else's, which is why they are asked for here
 * rather than set up centrally. They are stored encrypted, used only to price
 * this store's goods, and can be removed at any time — the costs already
 * written stay, because they are dated facts about what was paid.
 */
export function HstStoreCogs(props: HstStoreCogsProps) {
  const router = useRouter();
  const { begin } = useCogsFill();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [captcha, setCaptcha] = React.useState("");
  const [expectedCaptcha, setExpectedCaptcha] = React.useState(randomHstCaptcha);
  const [code, setCode] = React.useState(props.hstShopId ?? "");
  const [busy, setBusy] = React.useState<"connect" | "disconnect" | "save" | "sync" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<SyncOutcome | null>(null);

  // Pick from the list while there is one, and only fall back to typing when
  // the supplier could not be reached or the shop is genuinely not listed.
  const [manual, setManual] = React.useState(false);
  const picking = props.shops.length > 0 && !manual;

  /**
   * HST sessions last about a day and a half, and their refresh endpoint no
   * longer renews them — it answers "user does not exist" for a token it
   * issued itself, so the stored session simply dies. The only way back in is
   * HST's own sign-in form, which requires the code drawn in the browser: a
   * person has to type it, which is why nothing here signs in on its own.
   *
   * Recognised here so the panel can say that plainly and offer the way back,
   * instead of showing the supplier's raw "The captcha code field is
   * required." — true, but meaningless to the person reading it.
   */
  const sessionExpired =
    props.connected &&
    /did not sign in|refused those credentials|captcha/i.test(props.lastError ?? "");
  const [reauth, setReauth] = React.useState(false);
  const signingIn = !props.connected || reauth || sessionExpired;

  const saved = props.hstShopId ?? "";
  const dirty = code.trim() !== saved;

  async function call<T>(url: string, init: RequestInit): Promise<T | null> {
    setError(null);
    try {
      const res = await fetch(url, init);
      const body = (await res.json().catch(() => null)) as ({ error?: string } & T) | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      return (body ?? null) as T | null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }

  const json = (payload: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  async function connect() {
    // Checked here, as HST checks it on their own page: their server only sees
    // whether the field is non-empty, so the code means nothing unless the
    // person typing it actually read it.
    if (captcha.trim().toUpperCase() !== expectedCaptcha) {
      setError("That code does not match the image.");
      return;
    }
    setBusy("connect");
    setNotice(null);
    const ok = await call("/api/hst/connect", json({ username, password, captchaCode: captcha.trim().toUpperCase() }));
    if (ok) {
      // Nothing left to do with the password here once it is a session.
      setPassword("");
      setReauth(false);
      // A fresh sign-in warms the shop list, so offer it again even if this
      // person had fallen back to typing a code while the session was dead.
      setManual(false);
      setNotice(props.connected ? "Signed in to HST again. The hourly sync resumes." : "Connected to HST.");
      router.refresh();
    }
    setBusy(null);
  }

  async function disconnect() {
    setBusy("disconnect");
    setNotice(null);
    const ok = await call("/api/hst/connect", { method: "DELETE" });
    if (ok) {
      setNotice("Disconnected. The costs already recorded stay as they are.");
      router.refresh();
    }
    setBusy(null);
  }

  async function saveCode() {
    setBusy("save");
    setNotice(null);
    setOutcome(null);
    const trimmed = code.trim();
    const ok = await call(
      "/api/hst/store-code",
      json({ adAccountId: props.adAccountId, shopId: trimmed || null }),
    );
    if (ok) {
      setNotice(trimmed ? "Shop code saved." : "Shop code cleared.");
      router.refresh();
    }
    setBusy(null);
  }

  async function syncNow() {
    setBusy("sync");
    setNotice(null);
    setOutcome(null);
    // Tell the grid below to start filling, then pull. A first pull looks
    // further back than the hourly one: three days of orders would price only
    // the handful of products that happened to sell.
    begin();
    const result = await call<SyncOutcome>(
      "/api/hst/sync-costs",
      json({ adAccountId: props.adAccountId, sinceDays: 30 }),
    );
    if (result) {
      setOutcome(result);
      router.refresh();
    }
    setBusy(null);
  }

  /**
   * Choosing a shop is the whole gesture: it saves the mapping and pulls that
   * shop's costs in one motion, so the grid below fills in without a second
   * click. Only a real change to a listed shop does this — reselecting the
   * current one, or clearing to "not supplied", never triggers a pull.
   */
  async function selectShop(next: string) {
    setCode(next);
    const trimmed = next.trim();
    if (trimmed === saved) return;

    setBusy("sync");
    setError(null);
    setNotice(null);
    setOutcome(null);

    // The sync reads the shop code from the store row, so it has to be saved
    // before the pull — not just held in this input.
    const savedCode = await call(
      "/api/hst/store-code",
      json({ adAccountId: props.adAccountId, shopId: trimmed || null }),
    );
    if (!savedCode) {
      setBusy(null);
      return;
    }

    if (!trimmed) {
      setNotice("Shop code cleared.");
      router.refresh();
      setBusy(null);
      return;
    }

    begin();
    const result = await call<SyncOutcome>(
      "/api/hst/sync-costs",
      json({ adAccountId: props.adAccountId, sinceDays: 30 }),
    );
    if (result) {
      setOutcome(result);
      router.refresh();
    }
    setBusy(null);
  }

  return (
    <section className="panel space-y-4 p-4 md:p-5">
      <header className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-gold-dim)]">
          <Truck className="size-4 text-[var(--accent-gold)]" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            Supplier costs (HST)
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {props.connected
              ? `Connected. Give ${props.storeName} its shop code and its product costs and import duty arrive on their own, every hour.`
              : "Sign in with your HST account and your product costs fill themselves in — no typing a price per product."}
          </p>
        </div>
      </header>

      {error && <FormAlert>{error}</FormAlert>}
      {notice && <FormAlert tone="success">{notice}</FormAlert>}
      {/* The last sync's own reason. Without it a wrong password and a supplier
          with nothing to report look exactly alike from here. */}
      {props.lastError && !error && !sessionExpired && (
        <FormAlert>The last sync failed: {props.lastError}</FormAlert>
      )}
      {sessionExpired && !error && (
        <FormAlert>
          Your HST session has expired, so the costs stopped updating. HST only
          renews a session through their own sign-in, and that asks for the code
          drawn in the image — so nobody but you can do it. Sign in again below
          and the hourly sync picks up where it left off. Everything already
          recorded stays as it is.
        </FormAlert>
      )}

      {signingIn && props.connected && (
        <div className="rounded-[12px] border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] px-3 py-2 text-[12.5px] text-[var(--text-secondary)]">
          Signing in again only replaces the expired session. Your shop choice
          and every cost already recorded are kept.
        </div>
      )}

      {props.connected && !signingIn ? (
        <div className="space-y-2">
          <Label htmlFor="hst-code">
            {picking ? "Which of your HST shops is this store?" : "Shop code in HST"}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            {/* Chosen by NAME. The code is an internal id of the supplier's
                that is shown nowhere in their own interface, so asking for it
                is asking for something nobody has. The list comes from this
                client's own login, so it can only ever contain their shops. */}
            {picking ? (
              <select
                id="hst-code"
                className="min-h-10 min-w-[12rem] flex-1 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus-visible:border-[var(--accent-gold)]/40 disabled:opacity-60"
                value={code}
                disabled={busy !== null}
                onChange={(event) => selectShop(event.target.value)}
              >
                <option value="">Not supplied by HST</option>
                {props.shops.map((shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.name}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id="hst-code"
                inputMode="numeric"
                autoComplete="off"
                placeholder="The numeric id of your shop"
                className="min-w-[12rem] flex-1"
                value={code}
                disabled={busy !== null}
                onChange={(event) => setCode(event.target.value)}
              />
            )}
            <Button
              variant={dirty ? "primary" : "secondary"}
              size="sm"
              loading={busy === "save"}
              disabled={busy !== null || !dirty}
              onClick={saveCode}
            >
              Save
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "sync"}
              disabled={busy !== null || dirty || saved === ""}
              onClick={syncNow}
            >
              <RefreshCw className="size-3.5" />
              Sync now
            </Button>
          </div>

          {props.shopsError ? (
            /* The shop code is an id of the supplier's that appears nowhere in
               their own interface, so "type it by hand" asks for something
               nobody has. The team can read it from HST, so point there. */
            <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
              Couldn&rsquo;t list your shops right now ({props.shopsError}).{" "}
              <span className="text-[var(--text-secondary)]">
                Ask the Dropscale team for your shop ID and paste it above —
                we can read it from HST for you.
              </span>{" "}
              Or try again in a few minutes: the list often comes through on a
              second attempt.
            </p>
          ) : props.shops.length > 0 ? (
            <button
              type="button"
              className="text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-secondary)]"
              onClick={() => setManual((on) => !on)}
            >
              {manual ? "Choose from my shops instead" : "My shop is not listed — enter a code"}
            </button>
          ) : null}

          {outcome && (
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {outcome.written} product cost{outcome.written === 1 ? "" : "s"} written,{" "}
              {outcome.unchanged} already current, {outcome.charges} order
              {outcome.charges === 1 ? "" : "s"} charged import duty.
              {outcome.unknownProducts > 0 && (
                <span className="text-[var(--text-muted)]">
                  {" "}
                  {outcome.unknownProducts} supplier line
                  {outcome.unknownProducts === 1 ? "" : "s"} named a product this store has never
                  sold — either the wrong shop code, or those products have not sold yet.
                </span>
              )}
              {outcome.unquotedLines > 0 && (
                <span className="text-[var(--text-muted)]">
                  {" "}
                  {outcome.unquotedLines} line{outcome.unquotedLines === 1 ? "" : "s"} not quoted by
                  the supplier yet — skipped, never counted as costing nothing.
                </span>
              )}
            </p>
          )}

          {/* The per-order import duty, shown on its own so it is legible next
              to the product costs rather than hidden inside them. It is billed
              per order, not per article, so it rides in the day's costs — it is
              already counted; this is where the client can see that it is. */}
          {props.duty && (
            <div className="flex items-start gap-2.5 rounded-[10px] border border-[var(--accent-gold)]/20 bg-[var(--accent-gold-dim)] px-3 py-2.5">
              <Coins className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" />
              <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                <span className="font-semibold text-[var(--text-primary)]">
                  Import duty: {money(props.duty.total, props.duty.currency)}
                </span>{" "}
                over the last {props.duty.days} days, across {props.duty.orders} order
                {props.duty.orders === 1 ? "" : "s"}. HST bills this per order, on top of each
                product&rsquo;s cost — it is added to this store&rsquo;s costs automatically, never
                typed and never folded into a unit price.
              </p>
            </div>
          )}

          {/* A session that has not failed YET can still be the wrong one —
              after an HST password change, say. Signing in again is the
              harmless repair; disconnecting is not what that person wants. */}
          <button
            type="button"
            className="mr-4 text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-secondary)] disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => {
              setError(null);
              setNotice(null);
              setReauth(true);
            }}
          >
            Sign in to HST again
          </button>

          <button
            type="button"
            className="text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-secondary)] disabled:opacity-50"
            disabled={busy !== null}
            onClick={disconnect}
          >
            Disconnect HST
          </button>
        </div>
      ) : (
        <div className="space-y-4 rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-base)]/50 p-4">
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
            <Label htmlFor="hst-captcha">Captcha</Label>
            <div className="flex items-center gap-2">
              <Input
                id="hst-captcha"
                autoComplete="off"
                inputMode="text"
                maxLength={8}
                className="max-w-[10rem] font-mono uppercase tracking-widest"
                value={captcha}
                placeholder="Type the code"
                onChange={(event) => setCaptcha(event.target.value.toUpperCase())}
              />
              <HstCaptcha
                code={expectedCaptcha}
                onRefresh={() => {
                  setExpectedCaptcha(randomHstCaptcha());
                  setCaptcha("");
                }}
              />
            </div>
            <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
              HST&rsquo;s login draws this code in your browser rather than issuing it from their
              server, so there is nowhere else to look it up. Type what you see; click the image
              for a different one.
            </p>
          </div>

          <Button
            variant="primary"
            size="sm"
            className="w-full sm:w-auto"
            loading={busy === "connect"}
            disabled={busy !== null || username.trim() === "" || password === ""}
            onClick={connect}
          >
            {props.connected ? "Sign in again" : "Connect HST"}
          </Button>
          {props.connected && reauth && !sessionExpired && (
            <button
              type="button"
              className="ml-3 text-[12px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-secondary)]"
              onClick={() => setReauth(false)}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </section>
  );
}
