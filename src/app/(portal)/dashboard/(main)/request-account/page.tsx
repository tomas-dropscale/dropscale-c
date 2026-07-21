import type { Metadata } from "next";
import { getSessionClient } from "@/lib/supabase/server";
import { RequestAccountPanel } from "@/components/portal/request-account-panel";

export const metadata: Metadata = { title: "Request Account" };

export default async function RequestAccountPage() {
  const { client } = await getSessionClient();
  if (!client) return null; // gate already handled this

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight text-[var(--text-primary)]">
          Request Account
        </h1>
        <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
          Ask the team to link a new Google Ads account or connect a Shopify store.
        </p>
      </div>

      <RequestAccountPanel clientId={client.id} />
    </div>
  );
}
