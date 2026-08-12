import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  formatAdminEvent,
  isNotifiedTable,
  lookupsFor,
  type ResolvedNames,
  type WebhookPayload,
} from "@/lib/notify/admin-events";
import { sendTelegram } from "@/lib/notify/telegram";

/**
 * Puts names to the uuids a row carries — who approved, which store.
 *
 * Service-role because the webhook has no session, and it is read-only. Every
 * failure degrades to "no name" rather than no alert: an unresolved id costs a
 * word in the message, whereas a thrown lookup would cost the whole
 * notification.
 */
async function resolveNames(payload: WebhookPayload): Promise<ResolvedNames> {
  const { profileIds, adAccountIds } = lookupsFor(payload);
  if (profileIds.length === 0 && adAccountIds.length === 0) return {};

  const supabase = createServiceClient();
  if (!supabase) return {};

  const names: ResolvedNames = {};

  try {
    if (profileIds.length > 0) {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", profileIds);
      names.profiles = Object.fromEntries(
        (data ?? []).map((row) => [row.id, row.full_name]),
      );
    }

    if (adAccountIds.length > 0) {
      const { data } = await supabase
        .from("ad_accounts")
        .select("id, store_name")
        .in("id", adAccountIds);
      names.accounts = Object.fromEntries(
        (data ?? []).map((row) => [row.id, row.store_name]),
      );
    }
  } catch (error) {
    console.error("Name lookup for a Telegram alert failed:", error);
  }

  return names;
}

/**
 * POST — Supabase Database Webhook lands here and the team gets a Telegram
 * message.
 *
 * Two ways in, same as the sync routes:
 *   Bearer NOTIFY_SECRET  → the webhook, configured in the Supabase dashboard
 *   admin session + {test:true} → "does this actually work", from the browser
 *
 * On retries and duplicates: Supabase retries non-2xx, and a retry here means
 * the same alert arrives on somebody's phone twice. So anything that a retry
 * cannot fix — Telegram rejecting the message, an unconfigured bot — answers
 * 200 with `ok:false` and a reason. Only a request we could not authenticate or
 * parse gets a non-2xx, because that one genuinely should not be accepted.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.NOTIFY_SECRET;
  const authorised = secret ? request.headers.get("authorization") === `Bearer ${secret}` : false;

  let body: (WebhookPayload & { test?: boolean }) | null;
  try {
    body = (await request.json()) as WebhookPayload & { test?: boolean };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!authorised) {
    const { profile } = await getSessionProfile();
    if (profile?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
  }

  // Admin-triggered smoke test: proves the token, the chat id and the network
  // path in one click, without waiting for a client to register.
  if (body?.test) {
    const result = await sendTelegram(
      [
        "<b>🔔 Teste do Dropscale</b>",
        "Se estás a ler isto no telemóvel, os alertas da equipa estão a funcionar.",
      ].join("\n"),
    );
    return NextResponse.json(result);
  }

  if (!body?.table || !isNotifiedTable(body.table)) {
    return NextResponse.json({ ok: true, skipped: "table not notified" });
  }

  // Cheap pre-check: resolving names costs queries, and most payloads announce
  // nothing at all. Only look them up once the payload is known to be worth a
  // message.
  if (!formatAdminEvent(body)) {
    return NextResponse.json({ ok: true, skipped: "nothing to announce" });
  }

  const message = formatAdminEvent(body, await resolveNames(body));
  if (!message) {
    return NextResponse.json({ ok: true, skipped: "nothing to announce" });
  }

  const result = await sendTelegram(message);

  if (!result.ok) {
    // Logged, not raised: the row is already committed and the approval queue
    // is the source of truth. A missed message is a missed message.
    console.error(`Telegram alert failed (${result.reason}):`, result.detail ?? "");
  }

  return NextResponse.json(result);
}
