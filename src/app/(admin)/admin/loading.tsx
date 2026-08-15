export default function AdminLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full max-w-[1600px] space-y-4 px-4 py-6 sm:px-6 lg:px-8"
    >
      <span className="sr-only">Loading page</span>
      <div className="h-12 animate-pulse rounded-xl bg-[var(--bg-panel)]" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]"
          />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-panel)]" />
    </div>
  );
}
