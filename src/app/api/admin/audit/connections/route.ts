import { NextResponse, type NextRequest } from "next/server";

import {
  AuditConnectionError,
  createAuditConnection,
  requireAuditAdmin,
} from "@/lib/audit/connections";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function errorResponse(error: unknown) {
  if (error instanceof AuditConnectionError) {
    return response({ error: error.message, code: error.code }, error.status);
  }
  console.error("Audit invitation creation failed.");
  return response({ error: "The audit invitation could not be created." }, 500);
}

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 4_096) {
    return response({ error: "Request body is too large." }, 413);
  }

  try {
    // Authorisation comes before constructing the RLS-bypassing service client.
    const admin = await requireAuditAdmin();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return response({ error: "Invalid JSON body." }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "Send exactly one storeName." }, 400);
    }
    const record = body as Record<string, unknown>;
    if (
      Object.keys(record).length !== 1 ||
      typeof record.storeName !== "string"
    ) {
      return response({ error: "Send exactly one storeName." }, 400);
    }

    const invitation = await createAuditConnection(record.storeName, admin.id);
    return response({ ok: true, invitation }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
