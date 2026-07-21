import { Terminal } from "lucide-react";
import { Logo } from "@/components/brand/logo";

/**
 * First-run screen: shown when the Supabase env vars are missing.
 * Explaining what's absent beats crashing with a 500.
 */
export function SetupNotice() {
  return (
    <div className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[520px] rounded-[var(--radius-window)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-7">
        <Logo size="lg" />

        <h1 className="mt-6 text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
          Supabase is not configured
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Copy <code>.env.local.example</code> to <code>.env.local</code> and fill in the
          project keys, then restart the dev server.
        </p>

        <pre className="mt-5 overflow-x-auto rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
          <code>{`NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
NEXT_PUBLIC_SITE_URL=http://localhost:3001`}</code>
        </pre>

        <p className="mt-4 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <Terminal className="size-3.5" />
          Project Settings → API in the Supabase dashboard.
        </p>
      </div>
    </div>
  );
}
