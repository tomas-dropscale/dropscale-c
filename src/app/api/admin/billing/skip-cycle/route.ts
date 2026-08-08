import { NextResponse, type NextRequest } from "next/server";

import { createServiceClient } from "@/lib/supabase/service";
import { getSessionProfile } from "@/lib/supabase/server";
import { addDays, mondayOf } from "@/lib/billing/weekly";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

type SkipRequest = {
  clientId: string;
  periodStart: string;
  reason: string | null;
  remove: boolean;
};

function parseBody(body: unknown): SkipRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const clientId = typeof record.clientId === "string" ? record.clientId.trim() : "";
  const periodStart =
    typeof record.periodStart === "string" ? record.periodStart.trim() : "";
  if (!UUID.test(clientId) || !ISO_DAY.test(periodStart)) return null;
  if (record.reason !== undefined && typeof record.reason !== "string") return null;
  if (record.remove !== undefined && typeof record.remove !== "boolean") return null;

  const reason =
    typeof record.reason === "string" ? record.reason.trim().slice(0, 500) : "";
  return {
    clientId,
    periodStart,
    reason: reason || null,
    remove: record.remove === true,
  };
}

/**
 * Record (or undo) an admin decision that a client owes nothing for one weekly
 * cycle. No invoice is created and no Google evidence is touched: the billing
 * engine simply settles that client/week as "no charge".
 *
 * Only the cycle currently being tracked can be skipped — a week already
 * closed and invoiced is Stripe's problem, and the database refuses it too.
 */
export async function POST(request: NextRequest) {
  let input: SkipRequest | null;
  try {
    input = parseBody(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!input) {
    return NextResponse.json(
      { error: "Send a valid clientId and periodStart." },
      { status: 400 },
    );
  }

  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const currentCycle = mondayOf(new Date());
  if (input.periodStart !== currentCycle) {
    return NextResponse.json(
      { error: "Only the cycle currently being tracked can be skipped." },
      { status: 422 },
    );
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 503 },
    );
  }

  if (input.remove) {
    const { data, error } = await supabase.rpc("remove_billing_cycle_skip", {
      p_client_id: input.clientId,
      p_period_start: input.periodStart,
      p_removed_by: profile.id,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ ok: true, removed: data === true });
  }

  const { data, error } = await supabase.rpc("skip_billing_cycle", {
    p_client_id: input.clientId,
    p_period_start: input.periodStart,
    p_period_end: addDays(input.periodStart, 6),
    p_reason: input.reason,
    p_created_by: profile.id,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  const skip = data?.[0] ?? null;
  if (!skip) {
    return NextResponse.json(
      { error: "The skip was not recorded; try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    skip: {
      clientId: skip.client_id,
      periodStart: skip.period_start,
      periodEnd: skip.period_end,
      reason: skip.reason,
    },
  });
}
