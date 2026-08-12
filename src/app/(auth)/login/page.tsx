import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.auth.login.submit };
}

export default async function LoginPage() {
  const { d } = await getServerDictionary();

  return (
    <AuthCard
      title={d.auth.login.title}
      subtitle={d.auth.login.subtitle}
      footer={
        <>
          {d.auth.login.noAccount}{" "}
          <a
            href="mailto:leandro@dropscale.io?subject=Dropscale%20portal%20access"
            className="transition-smooth font-medium text-[var(--accent-gold)] hover:text-[var(--accent-gold-strong)]"
          >
            {d.auth.login.register}
          </a>
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
