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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The dialog sends the periodStart it DISPLAYED, and it must still be the
 * current Monday when the request lands — a confirm clicked across a Monday
 * midnight must never skip (or un-skip) a different week than the one shown.
 */
async function readSkipRequest(
  request: NextRequest,
): Promise<
  | { clientId: string; adminId: string }
  | { error: string; status: number }
> {
  const { user, profile } = await getSessionProfile();
  if (!user) return { error: "Unauthorised.", status: 401 };
  if (profile?.role !== "admin") return { error: "Forbidden.", status: 403 };
  if (!sameOrigin(request)) return { error: "Forbidden.", status: 403 };

  let body: unknown;
  try {
    body = await readSmallJson(request, 1_024);
  } catch {
    return { error: "Send exactly one clientId and periodStart.", status: 400 };
  }
  if (
    !isExactRecord(body, ["clientId", "periodStart"]) ||
    typeof body.clientId !== "string" ||
    !UUID.test(body.clientId) ||
    typeof body.periodStart !== "string" ||
    !ISO_DAY.test(body.periodStart)
  ) {
    return { error: "Send exactly one clientId and periodStart.", status: 400 };
  }
  if (body.periodStart !== mondayOf(new Date())) {
    return {
      error: "The billing cycle changed while the dialog was open. Refresh and try again.",
      status: 409,
    };
  }
  return { clientId: body.clientId, adminId: profile.id };
}

export async function POST(request: NextRequest) {
  const parsed = await readSkipRequest(request);
  if ("error" in parsed) return response({ error: parsed.error }, parsed.status);

  const service = createServiceClient();
  if (!service) return response({ error: "Billing is not configured." }, 503);

  const periodStart = mondayOf(new Date());
  const periodEnd = addDays(periodStart, 6);
  const { data, error } = await service.rpc("skip_billing_cycle", {
    p_client_id: parsed.clientId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_reason: "Current cycle skipped from the Billing dashboard.",
    p_created_by: parsed.adminId,
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

/**
 * Undo: remove the CURRENT week's skip so the cycle bills normally again.
 * The RPC refuses once the skip already produced a durable no-charge receipt
 * (the automation has settled that week) — surfaced as a 409.
 */
export async function DELETE(request: NextRequest) {
  const parsed = await readSkipRequest(request);
  if ("error" in parsed) return response({ error: parsed.error }, parsed.status);

  const service = createServiceClient();
  if (!service) return response({ error: "Billing is not configured." }, 503);

  const { data, error } = await service.rpc("remove_billing_cycle_skip", {
    p_client_id: parsed.clientId,
    p_period_start: mondayOf(new Date()),
    p_removed_by: parsed.adminId,
  });

  if (error) {
    console.error("Billing cycle skip removal failed", { code: error.code });
    const settled = error.code === "22023";
    return response(
      {
        error: settled
          ? "This skipped cycle already settled with a durable no-charge receipt and cannot be reactivated."
          : "The billing cycle skip could not be removed.",
      },
      settled ? 409 : 500,
    );
  }
  if (data !== true) {
    return response({ error: "There is no skip on the current cycle." }, 404);
  }

  return response({ ok: true });
}
