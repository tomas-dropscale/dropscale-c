import { NextResponse, type NextRequest } from "next/server";

import { createServiceClient } from "@/lib/supabase/service";
import { buildDailyReport } from "@/lib/reports/daily";

/**
 * GET /api/reports/daily?data=YYYY-MM-DD[&cliente=<id>][&campanhas=0]
 * Authorization: Bearer <REPORT_API_KEY>
 *
 * Read-only daily figures for an outside consumer (the Discord report bot).
 *
 * Its own key, not CRON_SECRET and not an admin login. A separate secret is the
 * whole point: it can be rotated without touching the cron, and losing it
 * exposes yesterday's numbers rather than the ability to act on the account.
 *
 * There is no session behind an API key, so the read runs with the service role
 * and lib/reports/daily.ts is the only thing deciding what is visible. Nothing
 * here writes.
 */
export const dynamic = "force-dynamic";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today in Lisbon, as the consumer counts days — not UTC, not the server's. */
function lisbonToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dayBefore(day: string): string {
  const date = new Date(`${day}T12:00:00Z`); // midday: no DST edge can shift it
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Constant-time-ish comparison. Not perfect in JS, but it removes the trivial
 * "wrong at character 3" timing signal a plain === leaks on a long-lived key.
 */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < provided.length; index++) {
    diff |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

export async function GET(request: NextRequest) {
  const expected = process.env.REPORT_API_KEY;
  if (!expected) {
    return NextResponse.json(
      { erro: "O relatório diário não está configurado neste servidor." },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ erro: "Chave em falta ou inválida." }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const requested = params.get("data");
  if (requested && !ISO_DAY.test(requested)) {
    return NextResponse.json({ erro: "O parâmetro 'data' tem de ser AAAA-MM-DD." }, { status: 400 });
  }
  // No date → the day that just closed, counted in Lisbon.
  const day = requested ?? dayBefore(lisbonToday());

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { erro: "SUPABASE_SERVICE_ROLE_KEY não está configurada neste servidor." },
      { status: 503 },
    );
  }

  try {
    const report = await buildDailyReport(supabase, day, {
      clientId: params.get("cliente") ?? undefined,
      // Campaigns cost one Google round trip per store; ?campanhas=0 skips them
      // for a caller that only wants store totals.
      includeCampaigns: params.get("campanhas") !== "0",
    });

    if (report.clientes.length === 0) {
      return NextResponse.json(
        { erro: "Sem clientes para este pedido.", data: day },
        { status: 404 },
      );
    }

    return NextResponse.json(report, {
      // A finished day never changes; a request for today might. Either way the
      // bot asks once a day, so nothing should be served from a cache.
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Daily report failed:", error);
    return NextResponse.json({ erro: "Não foi possível gerar o relatório." }, { status: 500 });
  }
}
