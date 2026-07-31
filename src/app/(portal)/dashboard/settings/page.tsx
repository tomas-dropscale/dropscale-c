import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { BillingProfileForm } from "@/components/portal/billing-profile-form";
import { ReferralCard } from "@/components/portal/referral-card";
import { REFERRAL_FLOOR_RATE } from "@/lib/billing/referrals";
import { LanguageSwitcher } from "@/components/settings/language-switcher";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.portal.personalSettings };
}

export default async function PersonalSettingsPage() {
  const [{ viewer, active, owner }, { d }] = await Promise.all([
    getWorkspaceContext(),
    getServerDictionary(),
  ]);
  if (!viewer || !active) return null; // gate already handled this

  // Identity is the VIEWER's; the billing profile belongs to the WORKSPACE, so
  // a sócio editing it edits the business's, not their own empty one.
  const supabase = await createClient();
  const [{ data: profile }, { data: referred }, { data: rateRows }] = await Promise.all([
    supabase.from("billing_profiles").select("*").eq("client_id", active.id).maybeSingle(),
    // Who the WORKSPACE OWNER brought in — the discount belongs to the account
    // being billed, not to whichever sócio happens to be looking at the page.
    supabase
      .from("portal_clients")
      .select("full_name, approval_status")
      .eq("referred_by", active.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("ad_accounts")
      .select("commission_rate, list_commission_rate")
      .eq("client_id", active.id),
  ]);

  // Stores can sit on different deals, so there is no single "your fee" — show
  // the most common list price rather than inventing an average nobody is
  // billed at. One store (the usual case) makes this exact.
  const rates = rateRows ?? [];
  const listRate = rates.length > 0 ? Math.max(...rates.map((r) => Number(r.list_commission_rate))) : null;
  const effectiveRate =
    rates.length > 0 ? Math.max(...rates.map((r) => Number(r.commission_rate))) : null;

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
        <ReferralCard
          code={active.isOwner ? viewer.referral_code : (owner?.referral_code ?? null)}
          referred={(referred ?? []).map((client) => ({
            name: client.full_name,
            approved: client.approval_status === "approved",
          }))}
          listRate={listRate}
          effectiveRate={effectiveRate}
          floorRate={REFERRAL_FLOOR_RATE}
          // Only the VIEWER can name who referred them — the RPC writes their
          // own row — and only while nobody is recorded yet.
          canClaim={viewer.referred_by === null}
        />
        <LanguageSwitcher />
      </div>
    </PageContainer>
  );
}
