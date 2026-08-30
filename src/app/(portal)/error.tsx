"use client";

/**
 * Error boundary for every client portal route.
 *
 * The portal's data layer degrades on its own wherever it can (a failed
 * projection shows an empty store list, a failed funnel is simply absent).
 * This catches what is left — a core daily_metrics failure, or an auxiliary
 * read that is deliberately fail-closed — so a client sees the product with a
 * retry instead of a raw browser error page.
 */

import * as React from "react";
import { AlertTriangle } from "lucide-react";

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("portal route error:", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-10 sm:px-6 lg:px-8">
      <div className="panel mx-auto max-w-lg p-6 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-[var(--warning-orange)]/12 text-[var(--warning-orange)]">
          <AlertTriangle className="size-5" aria-hidden />
        </div>
        <h1 className="text-[16px] font-semibold text-[var(--text-primary)]">
          Não foi possível carregar os teus dados
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Houve uma falha temporária a ler os dados desta página. Nada foi
          alterado na tua conta. Tenta novamente dentro de momentos.
        </p>
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
