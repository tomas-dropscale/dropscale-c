/**
 * Shared frame for the legal pages: narrow measure, quiet typography, and the
 * last-updated stamp OAuth verification reviewers look for.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  /** ISO date, rendered verbatim — bump on every edit. */
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <article className="mx-auto w-full max-w-[720px] px-5 py-16">
      <p className="label-caps text-[var(--accent-gold)]">Legal</p>
      <h1 className="mt-2 text-[30px] leading-tight font-semibold tracking-tight text-[var(--text-primary)]">
        {title}
      </h1>
      <p className="mt-2 text-[12.5px] text-[var(--text-muted)]">Last updated: {updated}</p>

      <div className="mt-10 space-y-8 text-[14px] leading-relaxed text-[var(--text-secondary)] [&_a]:text-[var(--accent-gold)] [&_a]:underline-offset-2 hover:[&_a]:underline [&_h2]:mt-2 [&_h2]:text-[18px] [&_h2]:font-semibold [&_h2]:text-[var(--text-primary)] [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-[var(--text-primary)]">
        {children}
      </div>
    </article>
  );
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
