/**
 * Prints the manual Telegram trigger bundle with the real NOTIFY_SECRET
 * substituted, ready to paste into the Supabase SQL editor.
 *
 *   node scripts/telegram-webhooks-sql.mjs
 *
 * Emits every SQL step in numeric order. They
 * are all idempotent (`create or replace`, `drop trigger if exists`), so
 * running the whole set again is how you apply a new one — no need to track
 * which have already been run.
 *
 * The SQL templates carry a __NOTIFY_SECRET__ placeholder so they are safe in git.
 * This script substitutes to stdout and never writes the filled-in version to
 * disk.
 *
 * Pass --url to point the triggers somewhere else (a preview deployment):
 *   node scripts/telegram-webhooks-sql.mjs --url https://staging.dropscale.app
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TELEGRAM_SQL = path.join(ROOT, "supabase", "manual", "telegram");
const DEFAULT_URL = "https://dropscale.app";

function env(key) {
  const raw = readFileSync(path.join(ROOT, ".env.local"), "utf8");
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

  const files = readdirSync(TELEGRAM_SQL)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.error("No Telegram SQL templates found in supabase/manual/telegram.");
    process.exitCode = 1;
  } else {
    for (const file of files) {
      let sql = readFileSync(path.join(TELEGRAM_SQL, file), "utf8").replaceAll(
        "__NOTIFY_SECRET__",
        secret,
      );
      if (target !== DEFAULT_URL) sql = sql.replaceAll(DEFAULT_URL, target.replace(/\/+$/, ""));
      console.log(sql);
    }

    console.error(`\n-- ↑ ${files.length} manual SQL step(s), paste into Supabase → SQL Editor.`);
    console.error(`-- ${files.join(", ")}`);
    console.error(`-- Target: ${target}`);
  }
}
