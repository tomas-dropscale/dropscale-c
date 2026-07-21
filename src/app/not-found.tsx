import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-5 px-4">
      <Logo size="lg" />
      <p className="text-[15px] font-medium text-[var(--text-primary)]">Page not found</p>
      <p className="max-w-[360px] text-center text-[13px] leading-relaxed text-[var(--text-secondary)]">
        This page doesn&apos;t exist, or you don&apos;t have access to it.
      </p>
      <Link
        href="/dashboard"
        className="transition-smooth text-[13px] font-medium text-[var(--accent-gold)] hover:text-[var(--accent-gold-strong)]"
      >
        ← Back to dashboard
      </Link>
    </div>
  );
}
