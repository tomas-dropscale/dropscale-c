"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Truck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";

export type HstStoreCogsProps = {
  adAccountId: string;
  storeName: string;
  /** The supplier's own code for this store, or null when it is not theirs. */
  hstShopId: string | null;
  connected: boolean;
  /** Credentials stored, so the session rebuilds itself when it expires. */
  selfHealing: boolean;
  /** Shops the login can see — suggestions, never a limit on what can be typed. */
  shops: Array<{ id: string; name: string }>;
  shopsError: string | null;
};

type SyncOutcome = {
  written: number;
  unchanged: number;
  unknownProducts: number;
  charges: number;
  unquotedLines: number;
};

/**
 * Connect HST and give this store its supplier code — on the COGS screen,
 * because that is where the question occurs to whoever is looking at the costs.
 *
 * Admin-only. The HST account is the agency's: one login for every shop it buys
 * through, so this is never a client's decision and never a client's
 * credentials. Clients see none of it; they see the costs it produces.
 */
export function HstStoreCogs(props: HstStoreCogsProps) {
  const router = useRouter();
  const [code, setCode] = React.useState(props.hstShopId ?? "");
  const [busy, setBusy] = React.useState<"save" | "sync" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<SyncOutcome | null>(null);

  const saved = props.hstShopId ?? "";
  const dirty = code.trim() !== saved;

  async function call<T>(url: string, payload: unknown): Promise<T | null> {
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as ({ error?: string } & T) | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
      return (body ?? null) as T | null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }

  async function saveCode() {
    setBusy("save");
    setNotice(null);
    setOutcome(null);
    const trimmed = code.trim();
    const ok = await call("/api/admin/hst/shop-mapping", {
      adAccountId: props.adAccountId,
      shopId: trimmed || null,
    });
    if (ok) {
      setNotice(trimmed ? "Supplier code saved." : "Supplier code cleared.");
      router.refresh();
    }
    setBusy(null);
  }

  async function syncNow() {
    setBusy("sync");
    setNotice(null);
    // A first pull looks further back than the hourly one: three days of orders
    // would price only the handful of products that happened to sell.
    const result = await call<SyncOutcome>("/api/admin/hst/sync-costs", {
      adAccountId: props.adAccountId,
      sinceDays: 30,
    });
    if (result) setOutcome(result);
    if (result) router.refresh();
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
            {props.connected ? (
              `Give ${props.storeName} its code in the supplier's ERP. Its product costs and import duty then arrive on their own, every hour.`
            ) : (
              <>
                HST is not connected yet. Sign in once under{" "}
                <a
                  className="underline underline-offset-2 hover:text-[var(--text-secondary)]"
                  href="/admin/settings"
                >
                  admin settings
                </a>{" "}
                — one login covers every shop the agency buys through.
              </>
            )}
          </p>
        </div>
      </header>

      {error && <FormAlert>{error}</FormAlert>}
      {notice && <FormAlert tone="success">{notice}</FormAlert>}

      {props.connected && (
        <div className="space-y-2">
          <Label htmlFor="hst-code">Supplier ERP code (hsterp)</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="hst-code"
              list="hst-shop-suggestions"
              inputMode="numeric"
              autoComplete="off"
              placeholder="2021639129"
              className="min-w-[12rem] flex-1"
              value={code}
              disabled={busy !== null}
              onChange={(event) => setCode(event.target.value)}
            />
            {/* Suggestions, not a menu: the list needs a live call to HST, and a
                code must stay typeable on the day that call fails. */}
            <datalist id="hst-shop-suggestions">
              {props.shops.map((shop) => (
                <option key={shop.id} value={shop.id}>
                  {shop.name}
                </option>
              ))}
            </datalist>
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

          {props.shopsError && (
            <p className="text-[12px] text-[var(--text-muted)]">
              Couldn&rsquo;t list the supplier&rsquo;s shops ({props.shopsError}) — type the code
              by hand.
            </p>
          )}

          {outcome && (
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {outcome.written} product cost{outcome.written === 1 ? "" : "s"} written,{" "}
              {outcome.unchanged} already current, {outcome.charges} order
              {outcome.charges === 1 ? "" : "s"} charged import duty.
              {outcome.unknownProducts > 0 && (
                <>
                  {" "}
                  <span className="text-[var(--text-muted)]">
                    {outcome.unknownProducts} supplier line
                    {outcome.unknownProducts === 1 ? "" : "s"} named a product this store has never
                    sold — either the wrong code, or those products simply have not sold yet.
                  </span>
                </>
              )}
              {outcome.unquotedLines > 0 && (
                <>
                  {" "}
                  <span className="text-[var(--text-muted)]">
                    {outcome.unquotedLines} line{outcome.unquotedLines === 1 ? "" : "s"} not quoted
                    yet — skipped rather than priced at zero.
                  </span>
                </>
              )}
            </p>
          )}

          {!props.selfHealing && (
            <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
              This session was pasted, not signed in — it stops when its refresh token expires, and
              nothing on screen will say so. Sign in under{" "}
              <a
                className="underline underline-offset-2 hover:text-[var(--text-secondary)]"
                href="/admin/settings"
              >
                admin settings
              </a>{" "}
              to make it renew itself.
            </p>
          )}
        </div>
      )}

    </section>
  );
}
