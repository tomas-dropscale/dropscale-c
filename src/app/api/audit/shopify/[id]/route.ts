import { NextResponse, type NextRequest } from "next/server";

import {
  AuditConnectionError,
  completeAuditConnection,
  recordAuditConnectionFailure,
  validateAuditInvitation,
} from "@/lib/audit/connections";
import { isAuditConnectionId } from "@/lib/audit/invitations";
import {
  ShopifyAuditError,
  normalizeAuditShopDomain,
  verifyAuditClientCredentials,
} from "@/lib/audit/shopify";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const BODY_KEYS = ["inviteToken", "shopDomain", "clientId", "clientSecret"] as const;
const MAX_BODY_BYTES = 8_192;

class BodyTooLargeError extends Error {}

type ConnectBody = {
  inviteToken: string;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
};

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function parseBody(value: unknown): ConnectBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== BODY_KEYS.length ||
    !BODY_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key)) ||
    BODY_KEYS.some((key) => typeof record[key] !== "string")
  ) {
    return null;
  }

  const body = record as ConnectBody;
  if (
    body.inviteToken.length > 128 ||
    body.shopDomain.length > 512 ||
    body.clientId.length > 256 ||
    body.clientSecret.length > 512
  ) {
    return null;
  }
  return body;
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Missing JSON body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function publicAuditError(error: unknown) {
  if (error instanceof AuditConnectionError) {
    return response({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof ShopifyAuditError) {
    const status = error.code === "shopify_rate_limited" ? 429 : error.retryable ? 503 : 422;
    return response({ error: error.message, code: error.code }, status);
  }
  console.error("Shopify audit connection failed without a classified error.");
  return response(
    { error: "The Shopify connection could not be completed.", code: "connection_failed" },
    500,
  );
}

type Context = { params: Promise<{ id: string }> };

/** Browser preflight: validate the fragment bearer before showing setup work. */
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!isAuditConnectionId(id)) {
    return response(
      {
        error: "This connection link is invalid or no longer available.",
        code: "invalid_invitation",
      },
      404,
    );
  }

  try {
    await validateAuditInvitation(
      id,
      request.headers.get("x-dropscale-audit-invite") ?? "",
    );
    return response({ ok: true });
  } catch (error) {
    return publicAuditError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: Context,
) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return response({ error: "Request body is too large." }, 413);
  }

  const { id } = await params;
  if (!isAuditConnectionId(id)) {
    return response(
      {
        error: "This connection link is invalid or no longer available.",
        code: "invalid_invitation",
      },
      404,
    );
  }

  let body: ConnectBody | null;
  try {
    body = parseBody(await readJsonBody(request));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return response({ error: "Request body is too large." }, 413);
    }
    return response({ error: "Invalid JSON body." }, 400);
  }
  if (!body) {
    return response(
      { error: "Enter the Shopify domain, Client ID and Client Secret." },
      400,
    );
  }

  let invitation;
  try {
    // The one-time bearer is checked before merchant credentials leave this server.
    invitation = await validateAuditInvitation(id, body.inviteToken);
  } catch (error) {
    return publicAuditError(error);
  }

  try {
    const shopDomain = normalizeAuditShopDomain(body.shopDomain);
    const shop = await verifyAuditClientCredentials({
      shopDomain,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    });

    await completeAuditConnection({
      invitation,
      shop,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    });

    return response({
      ok: true,
      store: { name: shop.name, domain: shop.myshopifyDomain },
    });
  } catch (error) {
    const code =
      error instanceof ShopifyAuditError || error instanceof AuditConnectionError
        ? error.code
        : "connection_failed";
    if (
      error instanceof ShopifyAuditError &&
      ["invalid_domain", "invalid_credentials", "domain_mismatch"].includes(error.code)
    ) {
      await recordAuditConnectionFailure(invitation, code);
    }
    return publicAuditError(error);
  }
}
