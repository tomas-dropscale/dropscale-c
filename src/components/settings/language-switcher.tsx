"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Languages } from "lucide-react";

import { useI18n, setLocaleCookie } from "@/lib/i18n/provider";
import { LOCALES, LOCALE_BADGES, LOCALE_LABELS, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Shared by the admin settings page and the client portal's settings page. */
export function LanguageSwitcher() {
  const router = useRouter();
  const { d, locale } = useI18n();
  const [pending, setPending] = React.useState<Locale | null>(null);

  function choose(next: Locale) {
    if (next === locale) return;
    setPending(next);
    setLocaleCookie(next);
    // refresh() re-renders Server Components with the new cookie, so server
    // copy (page titles, the team list) switches along with the client tree.
    router.refresh();
  }

  return (
    <section className="panel p-5">
      <header className="mb-1 flex items-center gap-2">
        <Languages size={17} strokeWidth={1.5} className="text-[var(--accent-gold)]" aria-hidden />
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          {d.settings.language}
        </h2>
      </header>
      <p className="mb-4 text-[12.5px] text-[var(--text-secondary)]">{d.settings.languageHelp}</p>

      <div className="flex flex-wrap gap-2">
        {LOCALES.map((option) => {
          const active = option === locale;
          return (
            <button
              key={option}
              type="button"
              onClick={() => choose(option)}
              aria-pressed={active}
              disabled={pending !== null && pending !== option}
              className={cn(
                "transition-smooth flex items-center gap-2 rounded-[10px] border px-3.5 py-2 text-[13px]",
                active
                  ? "border-[var(--accent-gold)]/35 bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]"
                  : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
              )}
            >
              <span className="text-[11px] font-semibold tracking-wider uppercase opacity-70">
                {LOCALE_BADGES[option]}
              </span>
              {LOCALE_LABELS[option]}
              {active && <Check className="size-3.5" aria-hidden />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
