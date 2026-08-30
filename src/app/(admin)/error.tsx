"use client";

/**
 * Error boundary for every admin route.
 *
 * The billing dashboard's money reads are deliberately fail-closed: a partial
 * read must never render as if it were complete. Before this boundary existed
 * that honesty cost the whole page — a single failed auxiliary query rendered
 * Next's raw "Application error" screen with no shell and no way back
 * (2026-08-30). The throw still stops the page; it now stops it INSIDE the
 * product, with a retry that re-runs the server render.
 */

import * as React from "react";
import { AlertTriangle } from "lucide-react";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("admin route error:", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-10 sm:px-6 lg:px-8">
      <div className="panel mx-auto max-w-xl p-6 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-[var(--warning-orange)]/12 text-[var(--warning-orange)]">
          <AlertTriangle className="size-5" aria-hidden />
        </div>
        <h1 className="text-[16px] font-semibold text-[var(--text-primary)]">
          Esta página não conseguiu carregar
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Uma das leituras desta página falhou e foi interrompida de propósito,
          para não mostrar números incompletos como se estivessem certos. Os
          dados não foram alterados. Tenta novamente — se persistir, o erro está
          registado para diagnóstico.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[11px] text-[var(--text-muted)]">
            {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          className="transition-smooth mt-5 inline-flex h-9 items-center rounded-[10px] bg-[var(--accent-gold)] px-4 text-[13px] font-medium text-[var(--bg-base)] hover:opacity-90"
        >
          Tentar novamente
        </button>
      </div>
    </div>
  );
}
