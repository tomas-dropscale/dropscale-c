export default function AdminLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-6 sm:px-6 lg:px-8"
    >
      <span className="sr-only">Loading page</span>
      <div className="h-12 animate-pulse rounded-xl bg-[var(--bg-panel)]" />
      <div className="h-44 animate-pulse rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]" />
      <div className="h-36 animate-pulse rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]" />
      <div className="h-14 animate-pulse rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]" />
    </div>
  );
}
