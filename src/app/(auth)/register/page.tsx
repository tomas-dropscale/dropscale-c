import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { RegisterForm } from "@/components/auth/register-form";
import { getServerDictionary } from "@/lib/i18n/server";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { getSessionProfile } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.auth.register.title };
}

export default async function RegisterPage() {
  if (hasSupabaseEnv()) {
    const { user } = await getSessionProfile();
    if (user) redirect("/dashboard");
  }

  const { d } = await getServerDictionary();

  return (
    <AuthCard
      title={d.auth.register.title}
      subtitle={d.auth.register.subtitle}
      footer={
        <>
          {d.auth.register.hasAccount}{" "}
          <Link
            href="/login"
            className="font-medium text-[var(--accent-gold)] transition-smooth hover:text-[var(--accent-gold-strong)]"
          >
            {d.auth.register.login}
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
