import "server-only";

import { NextResponse } from "next/server";

import { ClientOnboardingError } from "@/lib/client-onboarding/sessions";

export const CLIENT_ONBOARDING_RESPONSE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export function clientOnboardingResponse(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: CLIENT_ONBOARDING_RESPONSE_HEADERS,
  });
}

export function clientOnboardingErrorResponse(
  error: unknown,
  fallback = "The client onboarding request could not be completed.",
) {
  if (error instanceof ClientOnboardingError) {
    return clientOnboardingResponse(
      { error: error.message, code: error.code },
      error.status,
    );
  }
  console.error("Client onboarding request failed without a classified error.");
  return clientOnboardingResponse(
    { error: fallback, code: "request_failed" },
    500,
  );
}

export async function readSmallJson(
  request: Request,
  maximumBytes = 16_384,
): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maximumBytes) {
    throw new ClientOnboardingError(
      "invalid_request",
      "Request body is too large.",
      413,
    );
  }
  if (!request.body) {
    throw new ClientOnboardingError("invalid_request", "Missing JSON body.", 400);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ClientOnboardingError(
        "invalid_request",
        "Request body is too large.",
        413,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ClientOnboardingError("invalid_request", "Invalid JSON body.", 400);
  }
}

export function isExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}
