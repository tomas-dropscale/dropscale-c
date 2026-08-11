import { NextResponse, type NextRequest } from "next/server";

import {
  AuditConnectionError,
  requireAuditAdmin,
  reviewAuditConnection,
  revokeAuditConnection,
} from "@/lib/audit/connections";
import { isAuditConnectionId } from "@/lib/audit/invitations";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function errorResponse(error: unknown) {
  if (error instanceof AuditConnectionError) {
    return response({ error: error.message, code: error.code }, error.status);
  }
  console.error("Audit connection admin action failed.");
  return response({ error: "The audit connection could not be updated." }, 500);
}

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const admin = await requireAuditAdmin();
    const { id } = await params;
    if (!isAuditConnectionId(id)) return response({ error: "Not found." }, 404);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return response({ error: "Invalid JSON body." }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      (body as Record<string, unknown>).action !== "review"
    ) {
      return response({ error: "Send exactly action: review." }, 400);
    }

    await reviewAuditConnection(id, admin.id);
    return response({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  try {
    const admin = await requireAuditAdmin();
    const { id } = await params;
    if (!isAuditConnectionId(id)) return response({ error: "Not found." }, 404);
    await revokeAuditConnection(id, admin.id);
    return response({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
