/**
 * Prints migration 0034 with the real NOTIFY_SECRET substituted, ready to paste
 * into the Supabase SQL editor.
 *
 *   node scripts/telegram-webhooks-sql.mjs
 *
 * The migration itself carries a __NOTIFY_SECRET__ placeholder so the file is
 * safe in git. This script never writes the filled-in version to disk — it goes
 * to stdout, you paste it, and it is gone.
 *
 * Pass --url to point the triggers somewhere else (a preview deployment):
 *   node scripts/telegram-webhooks-sql.mjs --url https://staging.dropscale.app
 */
import { readFileSync } from "node:fs";

const MIGRATION = new URL("../supabase/migrations/0034_telegram_admin_webhooks.sql", import.meta.url);
const DEFAULT_URL = "https://dropscale.app";

function env(key) {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

const secret = env("NOTIFY_SECRET");
if (!secret) {
  console.error("NOTIFY_SECRET is not set in .env.local. Generate one with:");
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exitCode = 1;
} else {
  const urlFlag = process.argv.indexOf("--url");
  const target = urlFlag !== -1 ? process.argv[urlFlag + 1] : DEFAULT_URL;

  let sql = readFileSync(MIGRATION, "utf8").replaceAll("__NOTIFY_SECRET__", secret);
  if (target !== DEFAULT_URL) sql = sql.replaceAll(DEFAULT_URL, target.replace(/\/+$/, ""));

  console.log(sql);
  console.error(`\n-- ↑ paste into Supabase → SQL Editor. Target: ${target}`);
}
