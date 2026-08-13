import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { safeInternalPath } from "@/lib/site";

export const metadata: Metadata = { title: "New password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeInternalPath((await searchParams).next);

  return (
    <AuthCard title="Choose a new password" subtitle="Minimum of 8 characters.">
      <ResetPasswordForm next={next} />
    </AuthCard>
  );
}
