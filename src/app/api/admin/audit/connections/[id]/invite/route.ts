import { NextResponse, type NextRequest } from "next/server";

import {
  AuditConnectionError,
  requireAuditAdmin,
  rotateAuditConnectionInvite,
} from "@/lib/audit/connections";
import { isAuditConnectionId } from "@/lib/audit/invitations";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAuditAdmin();
    const { id } = await params;
    if (!isAuditConnectionId(id)) return response({ error: "Not found." }, 404);
    const invitation = await rotateAuditConnectionInvite(id, admin.id);
    return response({ ok: true, invitation });
  } catch (error) {
    if (error instanceof AuditConnectionError) {
      return response({ error: error.message, code: error.code }, error.status);
    }
    console.error("Audit invitation replacement failed.");
    return response({ error: "The audit invitation could not be replaced." }, 500);
  }
}
