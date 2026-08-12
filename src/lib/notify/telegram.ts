import "server-only";

/**
 * Telegram delivery for the team's approval inbox.
 *
 * The admin bell (notifications-menu.tsx) only alerts somebody already looking
 * at the panel. These are the same four events pushed to a phone, so a client
 * who registers at 22:00 isn't discovered the next morning.
 *
 * Telegram rather than web push on purpose: web push on iOS only reaches a site
 * installed to the Home Screen, and these alerts are internal team operations,
 * not something a client ever sees.
 */

const API = "https://api.telegram.org";

export type TelegramConfig = { token: string; chatId: string };

/**
 * Null when unconfigured rather than throwing, so a deployment without the
 * secrets set simply doesn't notify — an alert channel must never be able to
 * fail the write that triggered it.
 */
export function telegramConfig(): TelegramConfig | null {
  // Trimmed, because these arrive through `wrangler secret put` and a pasted
  // value routinely carries a trailing newline or a stray space. Telegram does
  // not ignore it: a chat id of "-100123\n" comes back as "chat not found",
  // which reads exactly like a wrong id and sends you looking in the wrong
  // place.
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

export type SendResult =
  | { ok: true }
  | { ok: false; reason: "unconfigured" | "rejected" | "unreachable"; detail?: string };

/**
 * One message to the team chat.
 *
 * Never throws: every caller is a side effect of an approval landing, and a
 * Telegram outage must not turn a successful registration into a 500.
 */
export async function sendTelegram(
  text: string,
  options: { config?: TelegramConfig | null; signal?: AbortSignal } = {},
): Promise<SendResult> {
  const config = options.config === undefined ? telegramConfig() : options.config;
  if (!config) return { ok: false, reason: "unconfigured" };

  try {
    const response = await fetch(`${API}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "HTML",
        // The alert is the whole message; a link preview would bury it.
        link_preview_options: { is_disabled: true },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      // Telegram puts the real reason in the body ("chat not found", "bot was
      // blocked"), which is the only thing that makes a misconfiguration
      // diagnosable from a log line.
      const detail = await response.text().catch(() => "");
      return { ok: false, reason: "rejected", detail: detail.slice(0, 300) };
    }

    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      reason: "unreachable",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Telegram's HTML mode accepts a small tag set and rejects the whole message on
 * a stray `<`, so every interpolated value goes through here. Names, store
 * names and URLs are all client-supplied.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
