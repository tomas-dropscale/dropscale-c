import type { Metadata } from "next";
import { createClient, getSessionClient } from "@/lib/supabase/server";
import { BillingProfileForm } from "@/components/portal/billing-profile-form";
import { LanguageSwitcher } from "@/components/settings/language-switcher";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.personalSettings };
}

export default async function PersonalSettingsPage() {
  const [{ client }, { d }] = await Promise.all([getSessionClient(), getServerDictionary()]);
  if (!client) return null; // gate already handled this

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("billing_profiles")
    .select("*")
    .eq("client_id", client.id)
    .maybeSingle();

  return (
    <PageContainer
      title={d.portal.personalSettings}
      description={d.portal.personalSettingsSubtitle}
    >
      <div className="max-w-[720px] space-y-4">
        <BillingProfileForm client={client} profile={profile} />
        <LanguageSwitcher />
      </div>
    </PageContainer>
  );
}
