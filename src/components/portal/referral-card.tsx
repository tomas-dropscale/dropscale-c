"use client";

import * as React from "react";
import { Check, Copy, Gift } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

export type ReferredClient = {
  name: string;
  /** Approved referrals are the ones earning the discount right now. */
  approved: boolean;
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
}: {
  code: string | null;
  referred: ReferredClient[];
  /** The agency's price before the discount. Null when they own no stores yet. */
  listRate: number | null;
  effectiveRate: number | null;
  floorRate: number;
}) {
  const { d } = useI18n();
  const [copied, setCopied] = React.useState(false);

  const approved = referred.filter((client) => client.approved);
  const pending = referred.length - approved.length;
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

        <div className="space-y-2">
          <p className="label-caps">{d.referrals.referred}</p>
          {referred.length === 0 ? (
            <p className="text-[12.5px] text-[var(--text-muted)]">{d.referrals.none}</p>
          ) : (
            <>
              <ul className="divide-y divide-[var(--border-subtle)] rounded-[10px] border border-[var(--border-subtle)]">
                {referred.map((client, index) => (
                  <li
                    key={`${client.name}-${index}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <span className="truncate text-[13px] text-[var(--text-primary)]">
                      {client.name}
                    </span>
                    <Badge variant={client.approved ? "gold" : "neutral"}>
                      {client.approved ? `−${0.5}%` : "…"}
                    </Badge>
                  </li>
                ))}
              </ul>
              {pending > 0 && (
                <p className="text-[11.5px] text-[var(--text-muted)]">
                  {fmt(d.referrals.pendingNote, { count: pending })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
