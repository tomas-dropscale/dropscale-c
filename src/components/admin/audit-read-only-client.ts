export const LARA_AUDIT_CONNECTION_ID =
  "a023c7e2-a96b-4f04-bc6e-0165e23332c3" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODE_PATTERN = /^[a-z0-9._:-]{2,64}$/;

type JsonRecord = Record<string, unknown>;

export type AuditCollectionSummary = {
  runId: string;
  state: "completed" | "partial" | "in_progress" | "failed";
  generatedAt: string | null;
  errorCode: string | null;
  modules: {
    total: number;
    complete: number;
    blocked: number;
    failed: number;
  };
  catalog: {
    products: number | null;
    variants: number | null;
    productsExact: boolean | null;
    variantsExact: boolean | null;
  };
  captured: {
    priorityProductsFound: number;
    priorityProductsRequested: number;
    policies: number;
    pages: number;
    menus: number;
    themeSourceFilesMatched: number;
  };
};

export type AuditCollectionOutcome =
  | { ok: true; summary: AuditCollectionSummary }
  | { ok: false; summary: AuditCollectionSummary | null; message: string };

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function boundedCount(value: unknown): number | null {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
  return Math.min(value as number, 100_000_000);
}

function connectionCount(value: unknown): number | null {
  return boundedCount(record(value)?.count);
}

function countExact(value: unknown): boolean | null {
  const precision = record(value)?.precision;
  return typeof precision === "string" ? precision === "EXACT" : null;
}

function generatedAt(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function errorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalised = value.toLowerCase();
  return SAFE_ERROR_CODE_PATTERN.test(normalised) ? normalised : null;
}

/**
 * Reduces the collector response to non-sensitive aggregate data. The raw
 * artifact is intentionally never returned to the React component or stored
 * in client state.
 */
export function summariseAuditCollection(
  value: unknown,
): AuditCollectionSummary | null {
  const body = record(value);
  if (!body || typeof body.runId !== "string" || !UUID_PATTERN.test(body.runId)) {
    return null;
  }
  if (
    body.state !== "completed" &&
    body.state !== "partial" &&
    body.state !== "in_progress" &&
    body.state !== "failed"
  ) {
    return null;
  }

  const summary = record(body.summary);
  const moduleEntries = Object.values(record(summary?.modules) ?? {})
    .map(record)
    .filter((entry): entry is JsonRecord => entry !== null);
  const moduleStatuses = moduleEntries
    .map((entry) => entry.status)
    .filter(
      (status): status is "complete" | "blocked_missing_scope" | "failed" =>
        status === "complete" ||
        status === "blocked_missing_scope" ||
        status === "failed",
    );

  const counts = record(summary?.counts);
  const captured = record(summary?.captured);

  return {
    runId: body.runId.toLowerCase(),
    state: body.state,
    generatedAt: generatedAt(summary?.generatedAt),
    errorCode: errorCode(body.errorCode),
    modules: {
      total: moduleStatuses.length,
      complete: moduleStatuses.filter((status) => status === "complete").length,
      blocked: moduleStatuses.filter(
        (status) => status === "blocked_missing_scope",
      ).length,
      failed: moduleStatuses.filter((status) => status === "failed").length,
    },
    catalog: {
      products: connectionCount(counts?.productsCount),
      variants: connectionCount(counts?.productVariantsCount),
      productsExact: countExact(counts?.productsCount),
      variantsExact: countExact(counts?.productVariantsCount),
    },
    captured: {
      priorityProductsFound: boundedCount(captured?.priorityProductsFound) ?? 0,
      priorityProductsRequested:
        boundedCount(captured?.priorityProductsRequested) ?? 0,
      policies: boundedCount(captured?.policies) ?? 0,
      pages: boundedCount(captured?.pages) ?? 0,
      menus: boundedCount(captured?.menus) ?? 0,
      themeSourceFilesMatched:
        boundedCount(captured?.themeSourceFilesMatched) ?? 0,
    },
  };
}

function failureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "Your admin session no longer authorises this audit. Refresh the page and sign in again.";
  }
  if (status === 404) {
    return "The read-only Lara collector is not available for this connection.";
  }
  if (status === 502) {
    return "The read-only audit stopped safely before completing. No Shopify data was changed.";
  }
  return "The read-only audit could not be completed. No Shopify data was changed.";
}

export async function requestReadOnlyLaraAudit(
  connectionId: string,
  fetcher: Fetcher = fetch,
): Promise<AuditCollectionOutcome> {
  if (connectionId !== LARA_AUDIT_CONNECTION_ID) {
    return {
      ok: false,
      summary: null,
      message: "The read-only collector is restricted to the Lara connection.",
    };
  }

  let response: Response;
  try {
    response = await fetcher(
      `/api/admin/audit/connections/${LARA_AUDIT_CONNECTION_ID}/collect`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "collect-read-only" }),
      },
    );
  } catch {
    return {
      ok: false,
      summary: null,
      message: "The read-only audit request could not reach Dropscale.",
    };
  }

  const body = await response.json().catch(() => null);
  const summary = summariseAuditCollection(body);
  if (response.ok && summary) return { ok: true, summary };

  return {
    ok: false,
    summary,
    message: failureMessage(response.status),
  };
}
