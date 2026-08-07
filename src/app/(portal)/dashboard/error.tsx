"use client";

import Link from "next/link";
import { Logo } from "@/components/brand/logo";

/**
 * Retryable portal error boundary. Transient Worker→Supabase failures now
 * throw instead of masquerading as empty stores or a 404, and this is where
 * they land: one click retries the exact request instead of leaving the
 * client on Next's bare digest page.
 */
export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-5 px-4">
      <Logo size="lg" />
      <p className="text-[15px] font-medium text-[var(--text-primary)]">
        Something went wrong loading this page
      </p>
      <p className="max-w-[380px] text-center text-[13px] leading-relaxed text-[var(--text-secondary)]">
        A temporary connection problem interrupted the request. Your data is
        safe — trying again usually fixes it.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="transition-smooth rounded-lg bg-[var(--accent-gold)] px-4 py-2 text-[13px] font-semibold text-[var(--bg-base)] hover:bg-[var(--accent-gold-strong)]"
      >
        Try again
      </button>
      <Link
        href="/dashboard"
        className="transition-smooth text-[13px] font-medium text-[var(--accent-gold)] hover:text-[var(--accent-gold-strong)]"
      >
        ← Back to dashboard
      </Link>
    </div>
  );
}
