import type { LucideIcon } from "lucide-react";

/**
 * Shared "not built yet" state for the tabs without content. Keeps the chrome
 * and layout so the real module can drop straight in without touching nav.
 */
export function ModulePlaceholder({
  icon: Icon,
  title,
  description,
  planned,
  footnote,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  planned: readonly string[];
  footnote: string;
}) {
  return (
    <div className="panel flex flex-1 flex-col items-center px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
        <Icon size={19} strokeWidth={1.5} className="text-[var(--accent-gold)]" aria-hidden />
      </div>

      <h2 className="mt-4 text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
      <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-[var(--text-secondary)]">
        {description}
      </p>

      <ul className="mt-6 flex flex-wrap justify-center gap-2">
        {planned.map((item) => (
          <li
            key={item}
            className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)]"
          >
            {item}
          </li>
        ))}
      </ul>

      <p className="label-caps mt-7">{footnote}</p>
    </div>
  );
}
