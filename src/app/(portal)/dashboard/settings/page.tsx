import type { Metadata } from "next";
import { createClient, getSessionClient } from "@/lib/supabase/server";
import { BillingProfileForm } from "@/components/portal/billing-profile-form";

export const metadata: Metadata = { title: "Personal Settings" };

export default async function PersonalSettingsPage() {
  const { client } = await getSessionClient();
  if (!client) return null; // gate already handled this

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("billing_profiles")
    .select("*")
    .eq("client_id", client.id)
    .maybeSingle();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight text-[var(--text-primary)]">
          Personal Settings
        </h1>
        <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
          Your account details and billing profile.
        </p>
      </div>

      <BillingProfileForm client={client} profile={profile} />
    </div>
  );
}
