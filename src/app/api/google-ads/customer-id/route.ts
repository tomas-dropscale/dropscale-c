import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

type CustomerIdRequest = {
  accountId?: unknown;
  customerId?: unknown;
};

function canonicalCustomerId(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^[0-9\s-]+$/.test(trimmed)) return undefined;
  const canonical = trimmed.replace(/[^0-9]/g, "");
  return /^\d{10}$/.test(canonical) ? canonical : undefined;
}

/**
 * Safe escape hatch for correcting a Google customer id.
 *
 * Browser writes are frozen after approval by the database trigger. This
 * server route re-authorises the caller, requires a disconnected account and
 * relies on the same trigger to atomically reject any account that has gained
 * ledger history since the preflight. OAuth reconnect itself does not call
 * this route because reconnecting rotates only the encrypted credential.
 */
export async function PATCH(request: NextRequest) {
  let body: CustomerIdRequest;
  try {
    body = (await request.json()) as CustomerIdRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.accountId !== "string") {
    return NextResponse.json({ error: "An account id is required." }, { status: 400 });
  }
  const customerId = canonicalCustomerId(body.customerId);
  if (customerId === undefined) {
    return NextResponse.json(
      { error: "Google Ads customer id must contain exactly 10 digits." },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised." }, { status: 401 });

  const [{ data: profile }, { data: account, error: accountError }] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    supabase
      .from("ad_accounts")
      .select("id, client_id, status, google_ads_customer_id, google_ads_connected")
      .eq("id", body.accountId)
      .maybeSingle(),
  ]);
  if (accountError || !account) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  const isAdmin = profile?.role === "admin";
  const { data: isMember } = await supabase.rpc("is_client_member", {
    p_client_id: account.client_id,
  });
  if (!isAdmin && !isMember) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (!isAdmin && account.status !== "pending") {
    return NextResponse.json(
      { error: "Only the team can correct an approved Google billing identity." },
      { status: 403 },
    );
  }
  if (account.google_ads_connected) {
    return NextResponse.json(
      { error: "Disconnect Google Ads before changing its customer id." },
      { status: 409 },
    );
  }
  if (account.google_ads_customer_id === customerId) {
    return NextResponse.json({ customerId });
  }

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json(
      { error: "Server-side Google identity updates are not configured." },
      { status: 503 },
    );
  }

  // The trigger repeats the no-history rule atomically with this UPDATE. The
  // predicates below additionally fail if status/connection changed after the
  // authorisation read.
  let update = service
    .from("ad_accounts")
    .update({ google_ads_customer_id: customerId })
    .eq("id", account.id)
    .eq("status", account.status)
    .eq("google_ads_connected", false);
  update = account.google_ads_customer_id
    ? update.eq("google_ads_customer_id", account.google_ads_customer_id)
    : update.is("google_ads_customer_id", null);
  const { data: updated, error: updateError } = await update
    .select("google_ads_customer_id")
    .maybeSingle();

  if (updateError) {
    const conflict = /duplicate|ledger history|unique/i.test(updateError.message);
    return NextResponse.json(
      { error: updateError.message },
      { status: conflict ? 409 : 500 },
    );
  }
  if (!updated) {
    return NextResponse.json(
      { error: "The account changed while it was being reviewed; try again." },
      { status: 409 },
    );
  }

  return NextResponse.json({ customerId: updated.google_ads_customer_id });
}
