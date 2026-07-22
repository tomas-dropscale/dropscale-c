import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import { hasAgencyServiceAccount } from "@/lib/google-ads/env";
import { listAgencyAccounts } from "@/lib/google-ads/client";

/**
 * Live smoke test of the AGENCY connection (staff-admins only): mint a token
 * from the env service-account key, list the ad accounts it can reach, name
 * them. If this returns data, the whole chain works — key, JWT, developer
 * token. Responses carry machine codes; the settings card translates them.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const { user, profile } = await getSessionProfile();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!hasAgencyServiceAccount()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  try {
    return NextResponse.json(await listAgencyAccounts());
  } catch (error) {
    return NextResponse.json(
      { error: "google_ads_error", detail: error instanceof Error ? error.message : null },
      { status: 502 },
    );
  }
}
