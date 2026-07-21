import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to your Dropscale client portal."
      footer={
        <>
          Don&apos;t have access yet? Your account is created by the Dropscale team —{" "}
          <span className="text-[var(--text-primary)]">contact your account manager</span>.
        </>
      }
    >
      {/* useSearchParams requires a Suspense boundary during prerender */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
