import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { getServerDictionary } from "@/lib/i18n/server";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { getSessionProfile } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return {
    title: d.auth.register.title,
    robots: { index: false, follow: false },
  };
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
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {d.auth.register.inviteOnlyBody}
        </p>
        <Button variant="primary" size="lg" className="w-full" asChild>
          <a href="mailto:leandro@dropscale.io?subject=Dropscale%20portal%20access">
            {d.auth.register.contact}
          </a>
        </Button>
      </div>
    </AuthCard>
  );
}
