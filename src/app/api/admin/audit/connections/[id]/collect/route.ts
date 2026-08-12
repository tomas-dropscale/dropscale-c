import { NextResponse, type NextRequest } from "next/server";

import {
  AuditConnectionError,
  getAuditMachineSponsor,
  requireAuditAdmin,
} from "@/lib/audit/connections";
import {
  LARA_AUDIT_CONNECTION,
  LARA_INITIAL_BASELINE_RUN_ID,
  runLaraAuditBaseline,
} from "@/lib/audit/shopify-collector";
import { isAuditConnectionId } from "@/lib/audit/invitations";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_048;
const RESPONSE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

type Context = { params: Promise<{ id: string }> };

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

type ArtifactSummary = {
  schemaVersion: string | null;
  auditStatus: "complete" | "partial" | null;
  generatedAt: string | null;
  completionIssues: string[];
  modules: Record<string, { status: string }>;
  counts: {
    productsCount: { count: number; precision: string | null } | null;
    productVariantsCount: { count: number; precision: string | null } | null;
  } | null;
  captured: {
    priorityProductsRequested: number;
    priorityProductsFound: number;
    policies: number;
    pages: number;
    menus: number;
    themeSourceFilesMatched: number;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeCount(value: unknown): { count: number; precision: string | null } | null {
  const countRecord = record(value);
  const count = countRecord?.count;
  const precision = countRecord?.precision;
  return Number.isSafeInteger(count) && (count as number) >= 0
    ? {
        count: Math.min(count as number, 100_000_000),
        precision:
          typeof precision === "string" && /^[A-Z_]{2,32}$/.test(precision)
            ? precision
            : null,
      }
    : null;
}

function summarizeArtifact(value: unknown): ArtifactSummary {
  const artifact = record(value) ?? {};
  const modules = record(artifact.modules) ?? {};
  const safeModules = Object.fromEntries(
    Object.entries(modules).flatMap(([name, value]) => {
      const status = record(value)?.status;
      return /^[a-z][a-zA-Z]+$/.test(name) &&
        (status === "complete" ||
          status === "failed" ||
          status === "blocked_missing_scope")
        ? [[name, { status }]]
        : [];
    }),
  );
  const counts = record(artifact.counts);
  const priorityProducts = Array.isArray(artifact.priorityProducts)
    ? artifact.priorityProducts
    : [];
  const arrayLength = (field: string) =>
    Array.isArray(artifact[field]) ? Math.min(artifact[field].length, 100_000) : 0;
  const themeSourceScan = record(record(artifact.theme)?.sourceScan);
  const sourceMatches = Array.isArray(themeSourceScan?.matches)
    ? themeSourceScan.matches.length
    : 0;
  const rawIssues = Array.isArray(artifact.completionIssues)
    ? artifact.completionIssues
    : [];

  return {
    schemaVersion:
      typeof artifact.schemaVersion === "string" && artifact.schemaVersion.length <= 64
        ? artifact.schemaVersion
        : null,
    auditStatus:
      artifact.auditStatus === "complete" || artifact.auditStatus === "partial"
        ? artifact.auditStatus
        : null,
    generatedAt:
      typeof artifact.generatedAt === "string" && artifact.generatedAt.length <= 40
        ? artifact.generatedAt
        : null,
    completionIssues: rawIssues.flatMap((issue) =>
      typeof issue === "string" && /^[a-z0-9:_-]{2,96}$/i.test(issue)
        ? [issue.slice(0, 96)]
        : [],
    ),
    modules: safeModules,
    counts: counts
      ? {
          productsCount: safeCount(counts.productsCount),
          productVariantsCount: safeCount(counts.productVariantsCount),
        }
      : null,
    captured: {
      priorityProductsRequested: Math.min(priorityProducts.length, 100_000),
      priorityProductsFound: priorityProducts.filter(
        (product) => record(product)?.found === true,
      ).length,
      policies: arrayLength("policies"),
      pages: arrayLength("pages"),
      menus: arrayLength("menus"),
      themeSourceFilesMatched: Math.min(sourceMatches, 100_000),
    },
  };
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

export async function POST(request: NextRequest, { params }: Context) {
  const cronSecret = process.env.CRON_SECRET;
  const machineAuthorised = Boolean(
    cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`,
  );
  let adminId: string | null = null;

  if (!machineAuthorised) {
    try {
      // The browser session/role boundary runs before any service-role client
      // or Shopify credential can be constructed.
      adminId = (await requireAuditAdmin()).id;
    } catch (error) {
      const status = error instanceof AuditConnectionError ? error.status : 403;
      return response(
        { error: status === 401 ? "Unauthorised." : "Forbidden." },
        status,
      );
    }
  }

  if (!sameOrigin(request)) return response({ error: "Forbidden." }, 403);

  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return response({ error: "Request body is too large." }, 413);
  }

  const { id } = await params;
  if (!isAuditConnectionId(id) || id !== LARA_AUDIT_CONNECTION.connectionId) {
    return response({ error: "Not found." }, 404);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return response({ error: "Invalid JSON body." }, 400);
  }
  if (!bodyText || new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return response(
      { error: bodyText ? "Request body is too large." : "Invalid JSON body." },
      bodyText ? 413 : 400,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return response({ error: "Invalid JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response({ error: "Send exactly confirmation: collect-read-only." }, 400);
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    record.confirmation !== "collect-read-only"
  ) {
    return response({ error: "Send exactly confirmation: collect-read-only." }, 400);
  }

  if (machineAuthorised) {
    try {
      // CRON_SECRET has already been verified. Resolve the sponsor from the
      // exact connected row; never accept an admin UUID from the request.
      adminId = await getAuditMachineSponsor({
        connectionId: LARA_AUDIT_CONNECTION.connectionId,
        shopifyDomain: LARA_AUDIT_CONNECTION.shopDomain,
        shopifyShopId: LARA_AUDIT_CONNECTION.shopId,
      });
    } catch (error) {
      const status = error instanceof AuditConnectionError ? error.status : 500;
      return response(
        {
          error:
            status === 409
              ? "The audit connection is not ready."
              : "The read-only audit could not be started.",
        },
        status,
      );
    }
  }

  if (!adminId) {
    return response({ error: "Forbidden." }, 403);
  }

  try {
    const result = await runLaraAuditBaseline(
      machineAuthorised
        ? {
            requestedBy: adminId,
            runId: LARA_INITIAL_BASELINE_RUN_ID,
            trigger: "system",
          }
        : { requestedBy: adminId },
    );
    if (result.state === "in_progress") {
      return response({ ok: true, runId: result.runId, state: result.state }, 202);
    }
    if (result.state === "failed") {
      return response(
        {
          ok: false,
          runId: result.runId,
          state: result.state,
          errorCode: result.errorCode,
        },
        502,
      );
    }
    return response({
      ok: true,
      runId: result.runId,
      state: result.state,
      summary: summarizeArtifact(result.artifact),
    });
  } catch {
    // Errors are classified inside the collector. A failure before a durable
    // run exists is still returned generically; never echo database, Shopify,
    // ciphertext or token details to the browser.
    console.error("Read-only Shopify audit collector failed before completion.");
    return response({ error: "The read-only audit could not be completed." }, 500);
  }
}
