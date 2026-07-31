"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Gift } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { REFERRAL_STEP_PCT } from "@/lib/billing/referrals";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/**
 * Why a referral is or is not earning anything, straight from the database
 * (migration 0023). Anything other than `counting` has a reason the client can
 * act on, which is the point of showing it.
 */
export type ReferralStatus = "counting" | "pending" | "partner" | "inactive";

export type ReferredClient = {
  name: string;
  status: ReferralStatus;
};

/**
 * The client's affiliate code, who they brought in, and what it is worth today.
 *
 * The discount is stated as the fee going FROM one number TO another rather
 * than as "0.5% off": what a client wants to check is the rate on their
 * invoice, and a percentage off a percentage is the kind of phrasing that
 * generates a support message.
 *
 * Pending referrals are counted separately and shown as not-yet-earning,
 * because a signup that has not been approved has not moved anybody's fee — and
 * silence about them would read as the discount being broken.
 */
export function ReferralCard({
  code,
  referred,
  listRate,
  effectiveRate,
  floorRate,
  canClaim = false,
}: {
  code: string | null;
  referred: ReferredClient[];
  /** The agency's price before the discount. Null when they own no stores yet. */
  listRate: number | null;
  effectiveRate: number | null;
  floorRate: number;
  /**
   * This client has no referrer yet, so they can still name one.
   *
   * The registration form has the field, but it only reaches the database
   * through the email/password signup trigger — anyone who used the Google
   * button, or simply forgot, would otherwise have no way to credit whoever
   * sent them. Set once and then gone, like the field it stands in for.
   */
  canClaim?: boolean;
}) {
  const router = useRouter();
  const { d } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const [claim, setClaim] = React.useState("");
  const [claiming, setClaiming] = React.useState(false);
  const [claimError, setClaimError] = React.useState<string | null>(null);

  async function submitClaim(event: React.FormEvent) {
    event.preventDefault();
    const value = claim.trim().toUpperCase();
    if (!value) return;

    setClaiming(true);
    setClaimError(null);
    const { data, error } = await createClient().rpc("claim_referral_code", { p_code: value });
    setClaiming(false);

    if (error) {
      setClaimError(error.message);
      return;
    }

    // The function answers with a status, never with the referrer — a code must
    // not be usable to probe for who else is a client.
    const message: Record<string, string | null> = {
      ok: null,
      unknown_code: d.referrals.claimUnknown,
      own_code: d.referrals.claimOwn,
      already_referred: d.referrals.claimAlready,
    };
    const failure = message[String(data)] ?? d.referrals.claimUnknown;
    if (failure) {
      setClaimError(failure);
      return;
    }

    setClaim("");
    router.refresh();
  }

  const notCounting = referred.filter((client) => client.status !== "counting").length;
  const discount =
    listRate != null && effectiveRate != null ? Math.max(0, listRate - effectiveRate) : 0;

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context) — the code is on screen to select.
    }
  }

  return (
    <section className="panel p-5">
      <header className="mb-1 flex items-center gap-2">
        <Gift size={17} strokeWidth={1.5} className="text-[var(--accent-gold)]" aria-hidden />
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          {d.referrals.title}
        </h2>
      </header>
      <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
        {d.referrals.subtitle}
      </p>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <p className="label-caps">{d.referrals.yourCode}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 font-mono text-[15px] tracking-[0.2em] text-[var(--accent-gold-strong)]">
              {code ?? "—"}
            </code>
            {code && (
              <button
                type="button"
                onClick={() => void copy()}
                className="transition-smooth inline-flex items-center gap-1.5 rounded-[8px] border border-[var(--border-subtle)] px-3 py-2 text-[12.5px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? d.referrals.copied : d.referrals.copy}
              </button>
            )}
          </div>
        </div>

        {/* What it is worth, in the terms the invoice uses. */}
        <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            {discount > 0
              ? fmt(d.referrals.discountNow, { value: discount })
              : d.referrals.discountNone}
          </p>
          {listRate != null && effectiveRate != null && (
            <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
              {fmt(d.referrals.feeLine, { list: listRate, effective: effectiveRate })}
            </p>
          )}
          {effectiveRate != null && effectiveRate <= floorRate && (
            <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
              {d.referrals.floorReached}
            </p>
          )}
        </div>

        {canClaim && (
          <form
            onSubmit={submitClaim}
            className="space-y-1.5 rounded-[10px] border border-[var(--border-subtle)] px-4 py-3"
          >
            <Label htmlFor="claim-code">{d.referrals.claimTitle}</Label>
            <p className="pb-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              {d.referrals.claimHelp}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="claim-code"
                value={claim}
                onChange={(event) => setClaim(event.target.value.toUpperCase())}
                placeholder={d.auth.register.referralPlaceholder}
                aria-invalid={Boolean(claimError)}
                autoComplete="off"
                maxLength={16}
                className="flex-1 uppercase"
              />
              <Button type="submit" variant="secondary" loading={claiming} disabled={!claim.trim()}>
                {d.referrals.claimCta}
              </Button>
            </div>
            <FieldError>{claimError}</FieldError>
          </form>
        )}

        <div className="space-y-2">
          <p className="label-caps">{d.referrals.referred}</p>
          {referred.length === 0 ? (
            <p className="text-[12.5px] text-[var(--text-muted)]">{d.referrals.none}</p>
          ) : (
            <>
              <ul className="divide-y divide-[var(--border-subtle)] rounded-[10px] border border-[var(--border-subtle)]">
                {referred.map((client, index) => {
                  const counting = client.status === "counting";
                  return (
                    <li
                      key={`${client.name}-${index}`}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] text-[var(--text-primary)]">
                          {client.name}
                        </p>
                        {/* The reason, in the client's own terms. "Not counting"
                            without a why is what turns into a support message. */}
                        {!counting && (
                          <p className="text-[11.5px] text-[var(--text-muted)]">
                            {d.referrals.reason[client.status]}
                          </p>
                        )}
                      </div>
                      <Badge variant={counting ? "gold" : "neutral"}>
                        {counting ? `−${REFERRAL_STEP_PCT}%` : d.referrals.notCounting}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
              {notCounting > 0 && (
                <p className="text-[11.5px] text-[var(--text-muted)]">
                  {fmt(d.referrals.notCountingNote, { count: notCounting })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
