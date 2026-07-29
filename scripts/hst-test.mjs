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
 * Where it looks for the login response, in order:
 *   1. a path given as an argument   node scripts/hst-test.mjs my-login.json
 *   2. scripts/hst-login.json        (gitignored — paste it there, formatted or not)
 *   3. HST_LOGIN_JSON in .env.local  (must be on ONE line: .env is read per line)
 *
 * A file is the easy path: DevTools gives you pretty-printed JSON, and pasting
 * that into .env.local breaks it in a way that only shows up as "no token".
 *
 * Also accepted in .env.local, when you only have the bare tokens:
 *   HST_ACCESS_TOKEN, HST_REFRESH_TOKEN
 *
 * And, to answer "do I have to keep pasting this forever?":
 *   HST_USERNAME, HST_PASSWORD   → tests whether the ERP will issue a session
 *                                  from credentials alone. If it does, the app
 *                                  can log itself in and nobody pastes anything
 *                                  again. If it demands a captcha code, it
 *                                  can't, and this says so — no attempt is made
 *                                  to get around one.
 *   HST_LOGIN_URL                → override if /login isn't the endpoint.
 *
 * Prints commission TOTALS and DATES — your own figures, on your own machine.
 * Never prints a token: only its length and whether it can travel in a header.
 */
import { readFileSync } from "node:fs";

const COMMISSION_URL = "https://hsterp.com/commission-salesman-mingxi";
const REFRESH_URL = "https://hsterp.com/refresh-token";
const DEFAULT_LOGIN_URL = "https://hsterp.com/login";
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

/** The login response as raw text, from wherever it happens to live. */
function loginText() {
  const fromArg = process.argv[2];
  if (fromArg) {
    try {
      return { text: readFileSync(fromArg, "utf8"), origin: fromArg };
    } catch {
      console.error(`Could not read ${fromArg}`);
      process.exit(1);
    }
  }

  try {
    const path = new URL("./hst-login.json", import.meta.url);
    return { text: readFileSync(path, "utf8"), origin: "scripts/hst-login.json" };
  } catch {
    // Not there — fall through to the env var.
  }

  if (vars.HST_LOGIN_JSON) return { text: vars.HST_LOGIN_JSON, origin: ".env.local" };
  return { text: null, origin: null };
}

let accessToken = vars.HST_ACCESS_TOKEN || null;
let refreshToken = vars.HST_REFRESH_TOKEN || null;
let expires = null;

const login = loginText();
if (login.text) {
  let parsed;
  try {
    parsed = JSON.parse(login.text);
  } catch {
    console.error(`The login response in ${login.origin} is not valid JSON.`);
    // The overwhelmingly likely cause when it came from .env.local: DevTools
    // hands you formatted JSON, and .env is parsed one line at a time, so
    // everything after the first line was silently dropped.
    if (login.origin === ".env.local") {
      console.error(
        "It has to be on ONE line there. Easier: save it as scripts/hst-login.json (gitignored) — formatting doesn't matter in a file.",
      );
    }
    process.exit(1);
  }

  const data = parsed.data ?? parsed;
  accessToken = accessToken ?? data.accessToken ?? data.token ?? null;
  refreshToken = refreshToken ?? data.refreshToken ?? null;
  expires = data.expires ?? null;
  console.log(`login response: ${login.origin}`);
}

if (!accessToken && !refreshToken) {
  console.error(
    "No token found. Save the login response as scripts/hst-login.json, or set HST_ACCESS_TOKEN in .env.local.",
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

// ---------------------------------------------------------------------------
// 3 — can the app log itself in? The difference between "paste it every two
//     days" and "never paste it again", for when refresh alone isn't enough.
// ---------------------------------------------------------------------------
console.log("\n--- login from credentials ---");

const loginUrl = vars.HST_LOGIN_URL || DEFAULT_LOGIN_URL;

if (!vars.HST_USERNAME || !vars.HST_PASSWORD) {
  console.log("skipped: set HST_USERNAME + HST_PASSWORD in .env.local to test this.");
} else {
  const res = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: vars.HST_USERNAME, password: vars.HST_PASSWORD }),
  });
  const contentType = res.headers.get("content-type") ?? "none";
  const body = await readBody(res);
  console.log(`POST ${loginUrl} → HTTP ${res.status}, content-type ${contentType}`);

  if (body.html) {
    console.log(`→ answered with HTML, not JSON. First 300 chars:\n${body.html}`);
    console.log("→ Wrong URL. Grab the real one from F12 while you log in, and set HST_LOGIN_URL.");
  } else {
    const data = body.json?.data ?? {};
    const issued = data.accessToken ?? data.token ?? null;
    console.log(`message: ${body.json?.message ?? "(none)"}`);
    console.log(`response keys: [${Object.keys(body.json ?? {}).join(", ")}]`);

    if (issued) {
      tokenReport("issued access token", issued);
      console.log(`expires: ${data.expires ?? "absent"}`);
      console.log("→ The ERP issues a session from username + password alone.");
      console.log("   That is the permanent fix: the app stores the credentials");
      console.log("   encrypted and logs itself in whenever the token dies.");
    } else {
      // Almost always a required verify/captcha field. Reporting it is the end
      // of the road on purpose: a captcha is a deliberate "a human must do
      // this", and the answer then is an API key from HST, not a way around it.
      console.log("→ No token issued. If the message mentions a verify/captcha code, then a");
      console.log("   human has to paste the session and the only permanent fix is asking HST");
      console.log("   for an API key or a long-lived token.");
    }
  }
}
