/**
 * Standalone Telegram bot test — no dependencies, global fetch.
 *
 *   node scripts/telegram-test.mjs
 *
 * Reads from .env.local (never printed):
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   TELEGRAM_CHAT_ID     the destination chat (negative id for a group)
 *
 * Checks the token, resolves the bot's own identity, then posts one message
 * formatted exactly like a real alert. A green run here means the secrets are
 * right, so anything still broken afterwards is the Supabase webhook, not the
 * bot.
 *
 * Without TELEGRAM_CHAT_ID it stops after the identity check and prints the
 * chat ids it can see, which is the easiest way to find the group's.
 */
import { readFileSync } from "node:fs";

function env() {
  const out = {};
  try {
    // Split on \r?\n, not \n: this repo is edited on Windows and VS Code writes
    // .env.local back as CRLF, which would otherwise leave a trailing \r that
    // JS's `$` refuses to match past — every variable then reads as unset.
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) out[match[1]] = match[2].trim();
    }
  } catch {
    console.error("Could not read .env.local");
    process.exit(1);
  }
  return out;
}

const vars = env();
const token = vars.TELEGRAM_BOT_TOKEN;
const chatId = vars.TELEGRAM_CHAT_ID;

if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in .env.local (get it from @BotFather).");
  process.exit(1);
}

const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(method, body) {
  const response = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    // Telegram's description is the only diagnosable part of a failure.
    throw new Error(payload?.description ?? `HTTP ${response.status}`);
  }
  return payload.result;
}

/**
 * Wrapped in a function so the no-chat-id path can `return` instead of calling
 * process.exit(), which on Windows tears the loop down under fetch's still-open
 * handle and prints a libuv assertion over an otherwise successful run.
 */
async function main() {
  const me = await call("getMe");
  console.log(`✓ Token valid — bot is @${me.username} ("${me.first_name}")`);

  if (!chatId) {
    console.log("\nTELEGRAM_CHAT_ID is not set. Looking for chats the bot can see…");
    // Every update type carries its chat somewhere, and which one arrives is
    // not something we control: with privacy mode on (BotFather's default) a
    // plain group message never reaches the bot, but `my_chat_member` — sent
    // when the bot is added to a group — always does. Scanning all of them is
    // what makes "I added the bot and it still sees nothing" resolvable.
    const updates = await call("getUpdates", { allowed_updates: [] });
    const chats = new Map();
    for (const update of updates) {
      for (const value of Object.values(update)) {
        const chat = value?.chat;
        if (chat?.id) {
          chats.set(chat.id, chat.title ?? chat.username ?? chat.first_name ?? "(private)");
        }
      }
    }

    if (chats.size === 0) {
      console.log(
        "None found. Telegram has nothing queued for this bot, which almost always\n" +
          "means privacy mode is on — in a group the bot only receives commands aimed\n" +
          "at it. Any ONE of these fixes it:\n\n" +
          `  • In the group, send:  /start@${me.username}\n` +
          "  • Or DM the bot directly and press Start (gives you your personal id)\n" +
          "  • Or @BotFather → /setprivacy → Disable, then remove and re-add the bot\n" +
          "    (privacy changes only apply from the next time it joins)\n\n" +
          "Then run this again.",
      );
    } else {
      console.log("\nSet one of these as TELEGRAM_CHAT_ID:");
      for (const [id, name] of chats) console.log(`  ${id}  ${name}`);
    }
    return;
  }

  await call("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    text: [
      "<b>👤 Novo cliente registado</b>",
      "Ana Dias",
      "<code>ana@loja.pt</code>",
      "",
      '<a href="https://dropscale.app/admin/clients">Aprovar no painel</a>',
    ].join("\n"),
  });

  console.log(`✓ Sample alert delivered to chat ${chatId}`);
  console.log("\nBot is working. What's left is the Supabase webhook — see scripts/telegram-setup.md");
}

try {
  await main();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}
