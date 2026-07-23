/**
 * Skeleton for every main-portal page while the server re-renders — range or
 * store changes swap content under the shell instead of a full reload. The
 * shapes echo the dashboard: header row, metric cards, one wide panel.
 */
export default function LoadingMetrics() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-7" aria-busy>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-6 w-40 animate-pulse rounded-md bg-[var(--bg-panel-hover)]" />
          <div className="h-3.5 w-64 animate-pulse rounded-md bg-[var(--bg-panel)]" />
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-[190px] animate-pulse rounded-[10px] bg-[var(--bg-panel)]" />
          <div className="h-9 w-36 animate-pulse rounded-[10px] bg-[var(--bg-panel)]" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="panel space-y-3 p-4">
            <div className="h-3 w-20 animate-pulse rounded bg-[var(--bg-panel-hover)]" />
            <div className="h-8 w-28 animate-pulse rounded bg-[var(--bg-panel-hover)]" />
            <div className="h-3 w-24 animate-pulse rounded bg-[var(--bg-panel-hover)]/60" />
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="panel space-y-3 p-4">
            <div className="h-3 w-16 animate-pulse rounded bg-[var(--bg-panel-hover)]" />
            <div className="h-7 w-20 animate-pulse rounded bg-[var(--bg-panel-hover)]" />
          </div>
        ))}
      </div>

      <div className="panel mt-4 h-[320px] animate-pulse" />
    </div>
  );
}
