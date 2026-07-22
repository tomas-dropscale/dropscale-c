"use client";

import * as React from "react";
import { CircleCheck, CircleDashed, Megaphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";
import { fmt } from "@/lib/i18n";

type Account = { id: string; name: string | null; currency: string | null; manager: boolean };

type Props = {
  /** GOOGLE_ADS_SA_KEY_JSON parses on the server. */
  configured: boolean;
  /** The service account's email, for display. */
  email: string | null;
  /** The agency MCC from the environment, digits only. */
  loginCustomerId: string | null;
};

/**
 * Status of the AGENCY's Google Ads connection (admin settings). The
 * connection itself is env-managed — this card only shows what is configured
 * and runs the live smoke test via /api/google-ads/agency. Per-client
 * connections live in the portal and are not shown here.
 */
export function AgencyGoogleAdsCard({ configured, email, loginCustomerId }: Props) {
  const { d } = useI18n();
  const t = d.settings.agencyAds;

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    accounts: Account[];
    total: number;
    truncated: boolean;
  } | null>(null);

  async function runTest() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/google-ads/agency");
      const body = (await response.json()) as {
        error?: string;
        detail?: string | null;
        accounts?: Account[];
        total?: number;
        truncated?: boolean;
      };
      if (!response.ok || body.error) {
        setError(
          body.error === "google_ads_error"
            ? fmt(t.apiError, { message: body.detail ?? "?" })
            : fmt(t.genericError, { code: body.error ?? String(response.status) }),
        );
        return;
      }
      setResult({
        accounts: body.accounts ?? [],
        total: body.total ?? 0,
        truncated: body.truncated ?? false,
      });
    } catch {
      setError(fmt(t.genericError, { code: "network" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel p-5">
      <header className="mb-1 flex items-center gap-2">
        <Megaphone
          size={17}
          strokeWidth={1.5}
          className="shrink-0 text-[var(--accent-gold)]"
          aria-hidden
        />
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{t.title}</h2>
      </header>
      <p className="mb-4 text-[12.5px] text-[var(--text-secondary)]">{t.help}</p>

      {!configured ? (
        <p className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-3 text-[12.5px] text-[var(--text-secondary)]">
          {t.notConfigured}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-[13px]">
            <CircleCheck size={15} className="shrink-0 text-[var(--accent-gold)]" aria-hidden />
            {/* leading-tight, not -none: truncate clips descenders (g, j) otherwise */}
            <span className="min-w-0 truncate leading-tight text-[var(--text-primary)]">
              {fmt(t.connectedAs, { email: email ?? "—" })}
            </span>
          </div>

          {loginCustomerId && (
            <div className="flex items-center gap-2 text-[13px]">
              <CircleDashed
                size={15}
                className="shrink-0 text-[var(--text-secondary)]"
                aria-hidden
              />
              <span className="min-w-0 truncate leading-tight text-[var(--text-secondary)]">
                {fmt(t.mcc, { id: loginCustomerId })}
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={runTest} loading={busy}>
              {t.test}
            </Button>
          </div>

          {error && <p className="text-[12.5px] text-[var(--danger-red)]">{error}</p>}

          {result && (
            <>
              <p className="text-[12.5px] text-[var(--accent-gold-strong)]">
                {fmt(t.testResult, { count: result.total })}
              </p>
              {result.accounts.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {result.accounts.map((account) => (
                    <li
                      key={account.id}
                      className="flex items-center gap-2 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[12.5px]"
                    >
                      <span className="min-w-0 truncate leading-tight text-[var(--text-primary)]">
                        {account.name ?? account.id}
                      </span>
                      {account.manager && (
                        <span className="inline-flex shrink-0 items-center rounded-full border border-[var(--accent-gold)]/35 px-1.5 py-px text-[10.5px] leading-none text-[var(--accent-gold-strong)]">
                          {t.managerTag}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 leading-none text-[var(--text-secondary)]">
                        {account.id}
                        {account.currency ? ` · ${account.currency}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {result.truncated && (
                <p className="text-[12px] text-[var(--text-secondary)]">
                  {fmt(t.testTruncated, { shown: result.accounts.length, count: result.total })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
