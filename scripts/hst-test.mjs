/**
 * Standalone HST ERP probe — no dependencies, global fetch.
 *
 *   node scripts/hst-test.mjs
 *
 * Answers the two questions the app cannot answer for you, because both are
 * about the ERP's behaviour rather than ours:
 *
 *   1. Does the commission endpoint return the WHOLE history, or only recent
 *      days? "The key only worked for one day" and "HST only reports one day"
 *      look identical in the portal — this prints the date range it actually
 *      sends back, so they stop looking alike.
 *   2. Does POST /refresh-token work? The app renews the session from the
 *      refresh token so nobody has to re-paste past a captcha. That endpoint is
 *      the vue-pure-admin convention, NOT something HST documented. If it does
 *      not answer, the session dies after about a day and every sync since then
 *      has been failing.
 *
 * Reads from .env.local (never printed):
 *   HST_LOGIN_JSON     the whole pasted login response, on one line
 *   HST_ACCESS_TOKEN   just the access token   (alternative to the above)
 *   HST_REFRESH_TOKEN  just the refresh token  (alternative to the above)
 *
 * Prints commission TOTALS and DATES — your own figures, on your own machine.
 * Never prints a token: only its length and whether it can travel in a header.
 */
import { readFileSync } from "node:fs";

const COMMISSION_URL = "https://hsterp.com/commission-salesman-mingxi";
const REFRESH_URL = "https://hsterp.com/refresh-token";
const PAGE_LIMIT = 1000;

function env() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      // Values here can contain "=" (JSON, base64), so split on the FIRST one only.
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

let accessToken = vars.HST_ACCESS_TOKEN || null;
let refreshToken = vars.HST_REFRESH_TOKEN || null;
let expires = null;

if (vars.HST_LOGIN_JSON) {
  try {
    const parsed = JSON.parse(vars.HST_LOGIN_JSON);
    const data = parsed.data ?? parsed;
    accessToken = accessToken ?? data.accessToken ?? data.token ?? null;
    refreshToken = refreshToken ?? data.refreshToken ?? null;
    expires = data.expires ?? null;
  } catch {
    console.error("HST_LOGIN_JSON is not valid JSON — it must be the whole response, on one line.");
    process.exit(1);
  }
}

if (!accessToken && !refreshToken) {
  console.error(
    "Set HST_LOGIN_JSON (the pasted login response) or HST_ACCESS_TOKEN in .env.local.",
  );
  process.exit(1);
}

/**
 * The same check the app makes at paste time. A token copied from DevTools'
 * Preview tab is silently truncated with "…", and fetch would only complain
 * much later with an opaque message about character 8230.
 */
function tokenReport(label, token) {
  if (!token) {
    console.log(`${label}: absent`);
    return false;
  }
  const chars = [...token];
  const bad = chars.findIndex((char) => (char.codePointAt(0) ?? 0) > 255);
  if (bad === -1) {
    console.log(`${label}: ${chars.length} chars, header-safe`);
    return true;
  }
  console.log(
    `${label}: ${chars.length} chars — UNUSABLE, ${
      chars[bad] === "…"
        ? `truncated ("…" at ${bad}). Copy the raw Response tab in F12, not Preview.`
        : `character "${chars[bad]}" at ${bad} can't travel in an HTTP header.`
    }`,
  );
  return false;
}

tokenReport("access token", accessToken);
tokenReport("refresh token", refreshToken);

if (expires) {
  const ms = new Date(expires.includes("T") ? expires : expires.replace(/-/g, "/")).getTime();
  const hours = Number.isFinite(ms) ? Math.round((ms - Date.now()) / 3_600_000) : null;
  console.log(
    `expires: ${expires}${
      hours === null ? " (unparseable)" : hours < 0 ? ` — EXPIRED ${-hours}h ago` : ` — ${hours}h left`
    }`,
  );
}

async function readBody(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text) };
  } catch {
    // A 200 carrying HTML means the URL is the ERP's own page, not its API.
    return { html: text.replace(/<style[\s\S]*?<\/style>/g, "").slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// 1 — commission endpoint: what does HST actually report?
// ---------------------------------------------------------------------------
console.log("\n--- commission ---");

if (!accessToken) {
  console.log("skipped: no access token to try");
} else {
  const rows = [];
  let lastPage = 1;
  let grandTotal = null;

  for (let page = 1; page <= lastPage && page <= 20; page++) {
    const res = await fetch(`${COMMISSION_URL}?shopIds=&page=${page}&limit=${PAGE_LIMIT}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const contentType = res.headers.get("content-type") ?? "none";
    const body = await readBody(res);

    if (page === 1) console.log(`page 1: HTTP ${res.status}, content-type ${contentType}`);

    if (res.status === 401 || res.status === 403) {
      console.log("→ HST rejected the token. The session has expired: paste a fresh login.");
      break;
    }
    if (!res.ok || body.html) {
      console.log(`→ not JSON. First 300 chars:\n${body.html ?? "(empty)"}`);
      break;
    }

    const data = body.json?.data ?? {};
    if (page === 1) {
      lastPage = data.last_page ?? 1;
      grandTotal = data.all?.total ?? null;
      console.log(`last_page: ${lastPage}, all.total: ${grandTotal ?? "absent"}`);
      console.log(`top keys: [${Object.keys(body.json ?? {}).join(", ")}]`);
      console.log(`data keys: [${Object.keys(data).join(", ")}]`);
      if (Array.isArray(data.data) && data.data[0]) {
        console.log(`first row keys: [${Object.keys(data.data[0]).join(", ")}]`);
      }
    }
    rows.push(...(Array.isArray(data.data) ? data.data : []));
  }

  if (rows.length > 0) {
    const days = [
      ...new Set(
        rows
          .map((row) => (row.express_date ?? "").toString().trim().replace(/\//g, "-").slice(0, 10))
          .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)),
      ),
    ].sort();
    const dropped = rows.length - rows.filter((row) => row.express_date).length;
    const summed = rows.reduce((total, row) => total + Number(row.total ?? 0), 0);

    console.log(`rows: ${rows.length} (${dropped} with no express_date)`);
    console.log(
      days.length === 0
        ? "days: NONE parseable — that is why nothing gets booked."
        : `days: ${days.length}, from ${days[0]} to ${days[days.length - 1]}`,
    );
    console.log(`summed row totals: ${summed.toFixed(2)}`);
    if (days.length === 1) {
      console.log(
        "→ HST returned a SINGLE day. The endpoint is reporting one day, not the whole history — that is upstream, not the portal.",
      );
    }
  } else {
    console.log("rows: 0 — the ledger is deliberately left untouched when this happens.");
  }
}

// ---------------------------------------------------------------------------
// 2 — can the session renew itself?
// ---------------------------------------------------------------------------
console.log("\n--- refresh-token ---");

if (!refreshToken) {
  console.log("skipped: no refresh token. Without one the session CANNOT self-renew —");
  console.log("paste the whole login response in the portal, not just the bearer token.");
} else {
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const contentType = res.headers.get("content-type") ?? "none";
  const body = await readBody(res);
  console.log(`HTTP ${res.status}, content-type ${contentType}`);

  if (body.html) {
    console.log(`→ answered with HTML, not JSON. First 300 chars:\n${body.html}`);
    console.log("→ Self-renewal is NOT working. This is why the sync dies after a day.");
  } else {
    const data = body.json?.data ?? body.json ?? {};
    const renewed = data.accessToken ?? data.token ?? null;
    console.log(`response keys: [${Object.keys(body.json ?? {}).join(", ")}]`);
    console.log(`data keys: [${Object.keys(data).join(", ")}]`);
    if (renewed) {
      tokenReport("renewed access token", renewed);
      console.log(`new expires: ${data.expires ?? "absent"}`);
      console.log("→ Self-renewal WORKS. The hourly cron can keep the session alive on its own.");
    } else {
      console.log("→ No accessToken in the response. Self-renewal is NOT working.");
      console.log("   Find the request the ERP makes when its own session refreshes (F12 →");
      console.log("   Network, leave the tab open past the expiry) and give me that URL.");
    }
  }
}
