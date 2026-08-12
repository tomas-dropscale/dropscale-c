"use client";

import { Link2 } from "lucide-react";

import { useI18n } from "@/lib/i18n/provider";

export function ManagedAssetsNotice({ compact = false }: { compact?: boolean }) {
  const { d } = useI18n();

  if (compact) {
    return (
      <div className="mx-2 flex items-start gap-2 rounded-[9px] border border-[var(--accent-gold)]/25 bg-[var(--accent-gold)]/8 px-3 py-2.5">
        <Link2 className="mt-0.5 size-3.5 shrink-0 text-[var(--accent-gold)]" aria-hidden />
        <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
          {d.portal.managedAssetsSidebar}
        </p>
      </div>
    );
  }

  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-[var(--accent-gold)]/12">
        <Link2 className="size-4.5 text-[var(--accent-gold)]" aria-hidden />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
          {d.portal.managedAssetsTitle}
        </h2>
        <p className="mx-auto max-w-[480px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {d.portal.managedAssetsBody}
        </p>
      </div>
    </div>
  );
}
