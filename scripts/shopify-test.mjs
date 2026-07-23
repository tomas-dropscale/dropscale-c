/**
 * Standalone Shopify connection test — no dependencies, global fetch.
 *
 *   node scripts/shopify-test.mjs
 *
 * Reads from .env.local (never printed):
 *   SHOPIFY_SHOP          my-store.myshopify.com
 *   SHOPIFY_CLIENT_ID     the app's API key (32 hex)
 *   SHOPIFY_CLIENT_SECRET the API secret key (shpss_…)
 *   SHOPIFY_API_VERSION   e.g. 2025-07 (optional, defaults below)
 *   SHOPIFY_ADMIN_TOKEN   direct shpat_… token (optional plan B — skips the exchange)
 *
 * Mirrors exactly what the app's /api/shopify/connect route does, so a green
 * run here means the portal connect will work with the same values.
 */
import { readFileSync } from "node:fs";

const DEFAULT_API_VERSION = "2025-01";

function env() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) out[match[1]] = match[2].trim();
    }
  } catch {
    console.error("Could not read .env.local");
    process.exit(1);
  }
  return out;
}

const vars = env();
const shop = vars.SHOPIFY_SHOP;
const apiVersion = vars.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;

if (!shop) {
  console.error("Set SHOPIFY_SHOP in .env.local");
  process.exit(1);
}

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Shopify error pages bury the real message after a giant <style> block.
    return { html: text.replace(/<style[\s\S]*?<\/style>/g, "").slice(0, 400) };
  }
}

// Step 1 — access token: direct if provided, else client_credentials exchange.
let accessToken = vars.SHOPIFY_ADMIN_TOKEN || null;
if (!accessToken) {
  if (!vars.SHOPIFY_CLIENT_ID || !vars.SHOPIFY_CLIENT_SECRET) {
    console.error("Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN).");
    process.exit(1);
  }
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: vars.SHOPIFY_CLIENT_ID,
      client_secret: vars.SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const body = await readBody(res);
  if (!res.ok || !body.access_token) {
    console.error(`Token exchange failed (${res.status}):`, body.error ?? "", body.error_description ?? body.html ?? "");
    process.exit(1);
  }
  accessToken = body.access_token;
  console.log("token exchange: OK");
}

// Step 2 — read-only shop query.
const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
  body: JSON.stringify({
    query: "{ shop { name myshopifyDomain plan { displayName } } }",
  }),
});
const body = await readBody(res);

if (!res.ok || body.errors || !body.data?.shop) {
  console.error(`GraphQL failed (${res.status}):`, JSON.stringify(body.errors ?? body.html ?? body).slice(0, 400));
  process.exit(1);
}

const info = body.data.shop;
console.log(`connected: ${info.name} (${info.myshopifyDomain}, ${info.plan?.displayName ?? "?"} plan)`);
