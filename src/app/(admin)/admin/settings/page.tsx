import type { Metadata } from "next";
import { Settings as SettingsIcon } from "lucide-react";

import { PageContainer } from "@/components/ui/page-container";
import { ModulePlaceholder } from "@/components/admin/placeholder";
import { LanguageSwitcher } from "@/components/settings/language-switcher";
import { AgencyGoogleAdsCard } from "@/components/settings/agency-google-ads-card";
import { TeamList } from "@/components/admin/team-list";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { agencyServiceAccount } from "@/lib/google-ads/env";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.settings.title };
}

export default async function SettingsPage() {
  const [{ profile }, { d }] = await Promise.all([getSessionProfile(), getServerDictionary()]);

  const supabase = await createClient();
  const { data: members } = await supabase.from("profiles").select("*").order("full_name");

  const agency = agencyServiceAccount();

  return (
    <PageContainer title={d.settings.title} description={d.settings.subtitle}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TeamList
          members={members ?? []}
          currentUserId={profile?.id ?? ""}
          isAdmin={profile?.role === "admin"}
        />

        <div className="flex flex-col gap-4">
          <LanguageSwitcher />

          <AgencyGoogleAdsCard
            configured={agency !== null}
            email={agency?.key.client_email ?? null}
            loginCustomerId={agency?.loginCustomerId ?? null}
          />

          <ModulePlaceholder
            icon={SettingsIcon}
            title={d.placeholder.preferences.heading}
            description={d.placeholder.preferences.description}
            planned={d.placeholder.preferences.tags}
            footnote={d.placeholder.notImplemented}
          />
        </div>
      </div>
    </PageContainer>
  );
}
