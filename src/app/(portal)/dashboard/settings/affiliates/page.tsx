import type { Metadata } from "next";

import { createClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/portal/workspace";
import { ReferralCard, type ReferralStatus } from "@/components/portal/referral-card";
import { PageContainer } from "@/components/ui/page-container";
import { getServerDictionary } from "@/lib/i18n/server";
import { REFERRAL_FLOOR_RATE } from "@/lib/billing/referrals";

export async function generateMetadata(): Promise<Metadata> {
  const { d } = await getServerDictionary();
  return { title: d.referrals.navLabel };
}

/**
 * Settings → Affiliates: the client's code, who they brought, and what it takes
 * off their fee.
 *
 * A tab of its own rather than a card on personal settings: this is the only
 * screen in the portal that pays the client something, and burying it under a
 * billing profile is the surest way for nobody to ever use it.
 */
export default async function AffiliatesPage() {
  const [{ viewer, active, owner }, { d }] = await Promise.all([
    getWorkspaceContext(),
    getServerDictionary(),
  ]);
  if (!viewer || !active) return null; // gate already handled this

  const supabase = await createClient();
  const [{ data: referred }, { data: rateRows }] = await Promise.all([
    // Who the WORKSPACE OWNER brought in, and whether each is earning anything.
    // Through the definer function (0023) rather than a direct select: deciding
    // "counting" needs the referred client's ad spend, which the referrer has
    // no business reading. It answers with a status and a name, nothing more.
    supabase.rpc("referral_summary", { p_client_id: active.id }),
    supabase
      .from("ad_accounts")
      .select("commission_rate, list_commission_rate")
      .eq("client_id", active.id),
  ]);

  // Stores can sit on different deals, so there is no single "your fee". Show
  // the highest list price rather than an average nobody is actually billed at;
  // with one store — the usual case — it is exact.
  const rates = rateRows ?? [];
  const listRate =
    rates.length > 0 ? Math.max(...rates.map((row) => Number(row.list_commission_rate))) : null;
  const effectiveRate =
    rates.length > 0 ? Math.max(...rates.map((row) => Number(row.commission_rate))) : null;

  return (
    <PageContainer title={d.referrals.navLabel} description={d.referrals.subtitle}>
      <div className="max-w-[720px]">
        <ReferralCard
          code={active.isOwner ? viewer.referral_code : (owner?.referral_code ?? null)}
          referred={(referred ?? []).map((client) => ({
            name: client.name,
            status: client.status as ReferralStatus,
          }))}
          listRate={listRate}
          effectiveRate={effectiveRate}
          floorRate={REFERRAL_FLOOR_RATE}
        />
      </div>
    </PageContainer>
  );
}
