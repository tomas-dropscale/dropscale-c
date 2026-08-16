import { NextResponse, type NextRequest } from "next/server";

import {
  isExactRecord,
  readSmallJson,
} from "@/lib/client-onboarding/http";
import { addDays, mondayOf } from "@/lib/billing/weekly";
import { createServiceClient } from "@/lib/supabase/service";
import { getSessionProfile } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const { user, profile } = await getSessionProfile();
  if (!user) return response({ error: "Unauthorised." }, 401);
  if (profile?.role !== "admin") return response({ error: "Forbidden." }, 403);
  if (!sameOrigin(request)) return response({ error: "Forbidden." }, 403);

  let body: unknown;
  try {
    body = await readSmallJson(request, 1_024);
  } catch {
    return response({ error: "Send exactly one valid clientId." }, 400);
  }
  if (
    !isExactRecord(body, ["clientId"]) ||
    typeof body.clientId !== "string" ||
    !UUID.test(body.clientId)
  ) {
    return response({ error: "Send exactly one valid clientId." }, 400);
  }

  const service = createServiceClient();
  if (!service) return response({ error: "Billing is not configured." }, 503);

  const periodStart = mondayOf(new Date());
  const periodEnd = addDays(periodStart, 6);
  const { data, error } = await service.rpc("skip_billing_cycle", {
    p_client_id: body.clientId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_reason: "Current cycle skipped from the Billing dashboard.",
    p_created_by: profile.id,
  });

  if (error || !data?.[0]) {
    console.error("Billing cycle skip failed", {
      code: error?.code ?? "missing_receipt",
    });
    const conflict = error?.code === "22023" || error?.code === "P0001";
    return response(
      {
        error: conflict
          ? "This billing cycle cannot be skipped."
          : "The billing cycle could not be skipped.",
      },
      conflict ? 409 : 500,
    );
  }

  return response({
    ok: true,
    skip: {
      clientId: data[0].client_id,
      periodStart: data[0].period_start,
      periodEnd: data[0].period_end,
    },
  });
}
