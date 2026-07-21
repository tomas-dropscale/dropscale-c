import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "New password" };

export default function ResetPasswordPage() {
  return (
    <AuthCard title="Choose a new password" subtitle="Minimum of 8 characters.">
      <ResetPasswordForm />
    </AuthCard>
  );
}
