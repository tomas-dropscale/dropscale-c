import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { BillingProfileForm } from "@/components/portal/billing-profile-form";
import { LanguageSwitcher } from "@/components/settings/language-switcher";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.personalSettings };
}

export default async function PersonalSettingsPage() {
  const [{ viewer, active }, { d }] = await Promise.all([
    getWorkspaceContext(),
    getServerDictionary(),
  ]);
  if (!viewer || !active) return null; // gate already handled this

  // Identity is the VIEWER's; the billing profile belongs to the WORKSPACE, so
  // a sócio editing it edits the business's, not their own empty one.
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("billing_profiles")
    .select("*")
    .eq("client_id", active.id)
    .maybeSingle();

  return (
    <PageContainer
      title={d.portal.personalSettings}
      description={d.portal.personalSettingsSubtitle}
    >
      <div className="max-w-[720px] space-y-4">
        <BillingProfileForm
          viewer={viewer}
          workspaceId={active.id}
          workspaceName={active.isOwner ? null : active.name}
          profile={profile}
        />
        <LanguageSwitcher />
      </div>
    </PageContainer>
  );
}
