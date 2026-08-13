import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { safeInternalPath } from "@/lib/site";

export const metadata: Metadata = { title: "Forgot password" };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeInternalPath((await searchParams).next);
  const backHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter the email you use to sign in and we'll send you a reset link."
      footer={
        <Link
          href={backHref}
          className="transition-smooth hover:text-[var(--accent-gold)]"
        >
          ← Back to sign in
        </Link>
      }
    >
      <ForgotPasswordForm next={next} />
    </AuthCard>
  );
}
