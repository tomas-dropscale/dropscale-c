import { NextResponse, type NextRequest } from "next/server";

import { isClientOnboardingId } from "@/lib/client-onboarding/invitations";
import {
  ClientOnboardingError,
  authorizeClientOnboardingRequest,
} from "@/lib/client-onboarding/sessions";
import {
  ClientShopifyConnectionError,
  connectReportingShopifyStore,
} from "@/lib/client-onboarding/shopify-connections";
import { createReportingShopifyRepository } from "@/lib/client-onboarding/shopify-repository";
import { REQUIRED_REPORTING_SHOPIFY_SCOPES } from "@/lib/client-onboarding/shopify-scopes";
import { ShopifyReportingError } from "@/lib/client-onboarding/shopify";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const BODY_KEYS = [
  "shopDomain",
  "shopifyClientId",
  "clientSecret",
] as const;
const MAX_BODY_BYTES = 8_192;

type ConnectBody = {
  shopDomain: string;
  shopifyClientId: string;
  clientSecret: string;
};

class BodyTooLargeError extends Error {}

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: RESPONSE_HEADERS,
  });
}

function publicError(error: unknown) {
  if (
    error instanceof ClientOnboardingError ||
    error instanceof ClientShopifyConnectionError
  ) {
    return response({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof ShopifyReportingError) {
    const status =
      error.code === "shopify_rate_limited"
        ? 429
        : error.retryable
          ? 503
          : 422;
    return response({ error: error.message, code: error.code }, status);
  }
  console.error("Shopify client reporting connection failed without a classified error.");
  return response(
    {
      error: "The Shopify reporting connection could not be completed.",
      code: "connection_failed",
    },
    500,
  );
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
    body.shopDomain.length > 512 ||
    body.shopifyClientId.length > 256 ||
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

function assertShopifyStep(
  authorization: Awaited<ReturnType<typeof authorizeClientOnboardingRequest>>,
) {
  if (
    authorization.session.status !== "collecting" ||
    !authorization.session.claimed_user_id ||
    !authorization.session.requested_assets.includes("shopify")
  ) {
    throw new ClientOnboardingError(
      "invalid_state",
      "Complete the account step before connecting a Shopify store.",
      409,
    );
  }
}

type Context = { params: Promise<{ id: string }> };

/** Validate the fragment bearer before the browser shows credential setup. */
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!isClientOnboardingId(id)) {
    return response(
      {
        error: "This onboarding link is invalid or no longer available.",
        code: "invalid_invitation",
      },
      404,
    );
  }
  try {
    const authorization = await authorizeClientOnboardingRequest(
      id,
      request.headers.get("x-dropscale-client-onboarding"),
    );
    assertShopifyStep(authorization);
    return response({
      ok: true,
      scopes: REQUIRED_REPORTING_SHOPIFY_SCOPES,
    });
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return response({ error: "Request body is too large." }, 413);
  }

  const { id } = await params;
  if (!isClientOnboardingId(id)) {
    return response(
      {
        error: "This onboarding link is invalid or no longer available.",
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

  try {
    // Authenticate the one-time bearer/user before merchant credentials leave
    // this server or an RLS-bypassing repository is constructed.
    const authorization = await authorizeClientOnboardingRequest(
      id,
      request.headers.get("x-dropscale-client-onboarding"),
    );
    assertShopifyStep(authorization);
    const connected = await connectReportingShopifyStore({
      authorization: {
        sessionId: authorization.session.id,
        tokenHash: authorization.tokenHash,
      },
      shopDomain: body.shopDomain,
      shopifyClientId: body.shopifyClientId,
      clientSecret: body.clientSecret,
      repository: createReportingShopifyRepository(),
    });
    return response({ ok: true, connection: connected }, 201);
  } catch (error) {
    return publicError(error);
  }
}
