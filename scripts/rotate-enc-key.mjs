/**
 * Re-encrypt every stored third-party secret under a new GOOGLE_ADS_TOKEN_ENC_KEY.
 *
 *   node scripts/rotate-enc-key.mjs            # dry run — reads, decrypts, writes nothing
 *   node scripts/rotate-enc-key.mjs --commit   # actually rotates
 *
 * ONE key protects every client's Google Ads refresh token, every store's
 * Shopify Admin token, audit-only Shopify Client Secrets, operational app
 * secrets and the HST session. Changing the key without this script does not
 * "reset" anything — it makes all of them undecryptable, and quietly, because
 * the app treats a failed decrypt as "no token" and falls back to empty data.
 * Every sync would stop and nothing would say why.
 *
 * Reads from .env.local (nothing is ever printed):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY        bypasses RLS — these rows are admin-only
 *   GOOGLE_ADS_TOKEN_ENC_KEY         the OLD key, still in the file
 *   GOOGLE_ADS_TOKEN_ENC_KEY_NEW     the new one you just generated
 *
 * Safe by construction:
 *   · Dry run unless --commit.
 *   · Decrypts EVERYTHING before writing ANYTHING. A single failure aborts the
 *     whole run, so a wrong old key can never half-migrate the database.
 *   · Values already readable with the new key are counted and skipped, so
 *     re-running after an interruption finishes the job instead of corrupting it.
 */
import { readFileSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");

// table → primary key column → encrypted columns
const TARGETS = [
  {
    table: "ad_accounts",
    pk: "id",
    columns: ["google_ads_refresh_token", "shopify_admin_token"],
  },
  {
    table: "hst_integration",
    pk: "id",
    columns: ["access_token", "refresh_token"],
  },
  {
    table: "app_secrets",
    pk: "key",
    columns: ["ciphertext"],
  },
  {
    table: "audit_shopify_credentials",
    pk: "connection_id",
    columns: ["client_secret_ciphertext"],
  },
];

function env() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
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
const url = vars.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = vars.SUPABASE_SERVICE_ROLE_KEY;
const oldKeyRaw = vars.GOOGLE_ADS_TOKEN_ENC_KEY;
const newKeyRaw = vars.GOOGLE_ADS_TOKEN_ENC_KEY_NEW;

const missing = [
  ["NEXT_PUBLIC_SUPABASE_URL", url],
  ["SUPABASE_SERVICE_ROLE_KEY", serviceKey],
  ["GOOGLE_ADS_TOKEN_ENC_KEY", oldKeyRaw],
  ["GOOGLE_ADS_TOKEN_ENC_KEY_NEW", newKeyRaw],
].filter(([, value]) => !value);

if (missing.length > 0) {
  console.error(`Missing in .env.local: ${missing.map(([name]) => name).join(", ")}`);
  console.error('Generate the new key with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  process.exit(1);
}

if (oldKeyRaw === newKeyRaw) {
  console.error("The new key is identical to the old one. Nothing to rotate.");
  process.exit(1);
}

function decodeKey(raw, name) {
  const bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) {
    console.error(`${name} must decode to exactly 32 bytes (AES-256).`);
    process.exit(1);
  }
  return bytes;
}

const oldKey = await crypto.subtle.importKey(
  "raw",
  decodeKey(oldKeyRaw, "GOOGLE_ADS_TOKEN_ENC_KEY"),
  { name: "AES-GCM" },
  false,
  ["decrypt"],
);
const newKeyDecrypt = await crypto.subtle.importKey(
  "raw",
  decodeKey(newKeyRaw, "GOOGLE_ADS_TOKEN_ENC_KEY_NEW"),
  { name: "AES-GCM" },
  false,
  ["decrypt"],
);
const newKeyEncrypt = await crypto.subtle.importKey(
  "raw",
  decodeKey(newKeyRaw, "GOOGLE_ADS_TOKEN_ENC_KEY_NEW"),
  { name: "AES-GCM" },
  false,
  ["encrypt"],
);

const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function decrypt(packedB64, key) {
  const packed = fromB64(packedB64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.subarray(0, 12) },
    key,
    packed.subarray(12),
  );
  return new TextDecoder().decode(plain);
}

async function encrypt(plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    newKeyEncrypt,
    new TextEncoder().encode(plaintext),
  );
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return toB64(packed);
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

async function rest(path, options = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  if (!res.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// ---- pass 1: read and decrypt everything, writing nothing -----------------
console.log(COMMIT ? "Rotating (writing).\n" : "Dry run — nothing will be written.\n");

const planned = [];
let alreadyNew = 0;
let failures = 0;

for (const target of TARGETS) {
  let rows;
  try {
    rows = await rest(`${target.table}?select=${[target.pk, ...target.columns].join(",")}`);
  } catch (error) {
    console.error(`! ${target.table}: ${error.message}`);
    failures += 1;
    continue;
  }

  for (const row of rows ?? []) {
    for (const column of target.columns) {
      const value = row[column];
      if (!value) continue;

      // Already rotated (an interrupted earlier run) — leave it alone.
      try {
        await decrypt(value, newKeyDecrypt);
        alreadyNew += 1;
        continue;
      } catch {
        // Not readable with the new key; must be the old one.
      }

      try {
        const plaintext = await decrypt(value, oldKey);
        planned.push({ target, id: row[target.pk], column, plaintext });
      } catch {
        console.error(`! ${target.table}.${column} (${row[target.pk]}): decrypt failed with BOTH keys`);
        failures += 1;
      }
    }
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} value(s) could not be decrypted. Nothing was written.\n` +
      "Either GOOGLE_ADS_TOKEN_ENC_KEY is not the key those rows were encrypted with,\n" +
      "or the rows are corrupt. Fix that before rotating — a partial rotation is worse.",
  );
  process.exit(1);
}

console.log(`${planned.length} value(s) to re-encrypt, ${alreadyNew} already on the new key.`);

if (planned.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

if (!COMMIT) {
  for (const item of planned) console.log(`  would rotate ${item.target.table}.${item.column}`);
  console.log("\nAll decrypted cleanly. Re-run with --commit to write.");
  process.exit(0);
}

// ---- pass 2: write ---------------------------------------------------------
let written = 0;
for (const item of planned) {
  const ciphertext = await encrypt(item.plaintext);
  await rest(`${item.target.table}?${item.target.pk}=eq.${item.id}`, {
    method: "PATCH",
    body: JSON.stringify({ [item.column]: ciphertext }),
  });
  written += 1;
}

console.log(`\nRotated ${written} value(s).`);
console.log("Now update the deployed secret:");
console.log("  npx wrangler secret put GOOGLE_ADS_TOKEN_ENC_KEY      # the NEW key");
console.log("  npx wrangler secret put GOOGLE_ADS_TOKEN_ENC_KEY_PREVIOUS  # the OLD key, temporarily");
console.log("Then confirm a client's dashboard still loads, and delete the PREVIOUS secret.");
