# Telegram alerts — setup

The four events the admin bell counts, pushed to the team's phones: a client
registers, an ad account needs activating, a client asks for an account, a
client submits creatives.

Telegram rather than web push because web push on iOS only reaches a site
installed to the Home Screen, and these are internal team alerts — nothing a
client ever sees.

```
INSERT on one of four tables
  → Supabase Database Webhook
  → POST /api/notify/telegram   (Bearer NOTIFY_SECRET)
  → Telegram Bot API
  → the team's phones
```

---

## 1. Create the bot

In Telegram, talk to [@BotFather](https://t.me/BotFather):

| Command | Answer |
|---|---|
| `/newbot` | Name: **Dropscale**. Username: something ending in `bot`, e.g. `dropscale_alerts_bot`. |
| `/setdescription` | `Alertas internos do painel Dropscale.` |
| `/setabouttext` | `Avisa a equipa quando há algo à espera de aprovação.` |
| `/setuserpic` | Upload the avatar (see below). |

`/newbot` replies with the token. That is `TELEGRAM_BOT_TOKEN` — anyone holding
it can post as the bot, so treat it like a password.

### The avatar

The Dropscale logo is a wordmark, which is unreadable in a 40px circle, so the
avatar is a **D** monogram in the brand gold. Two versions were generated at
512×512; pick one and upload it with `/setuserpic`.

## 2. Find the chat id

For a team group: create it, add the bot, and post any message there. Then:

```bash
node scripts/telegram-test.mjs
```

With no `TELEGRAM_CHAT_ID` set, the script lists every chat the bot can see
along with its id. Group ids are negative (`-1001234567890`). Put it in
`.env.local` as `TELEGRAM_CHAT_ID` and run the script again — it posts a sample
alert, which confirms the token and the chat in one go.

## 3. Set the secrets

Local, in `.env.local`:

```
TELEGRAM_BOT_TOKEN=…
TELEGRAM_CHAT_ID=-100…
NOTIFY_SECRET=…
```

Generate `NOTIFY_SECRET` rather than inventing one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Production — Worker secrets, never a `[vars]` block:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put NOTIFY_SECRET
```

Deploy before step 4, or the webhooks will fire at a route that doesn't exist
yet.

## 4. Point Supabase at the route

Migration `0034_telegram_admin_webhooks.sql` creates all four triggers in one
go. Print it with the secret filled in and paste it into **Supabase → SQL
Editor**:

```bash
node scripts/telegram-webhooks-sql.mjs
```

The migration in git carries a `__NOTIFY_SECRET__` placeholder; the script
substitutes it to stdout and never writes the filled-in version to disk. Point
the triggers elsewhere with `--url https://staging.example.com`.

It calls `pg_net` directly rather than going through Supabase's own
`supabase_functions.http_request()`. That function only exists after the
dashboard's Database Webhooks page has been opened and used once — a manual step
per project that a migration cannot perform for itself. The payload is
byte-for-byte the shape Supabase's webhooks send, so the route accepts either
and switching back later needs no application change.

Doing it through the dashboard instead is four passes through
**Integrations → Database Webhooks → Create a new hook**:

| | |
|---|---|
| Tables | `portal_clients`, `ad_accounts`, `account_requests`, `creative_submissions` |
| Events | **Insert** only |
| Type | HTTP Request |
| Method | `POST` |
| URL | `https://dropscale.app/api/notify/telegram` |
| HTTP Header | `Authorization: Bearer <NOTIFY_SECRET>` |

Insert only on purpose: an update is usually the team's own approval, and being
notified about what you just did is how people learn to ignore a channel.

## 5. Verify end to end

Signed in as an admin, from the browser console on the live site:

```js
await fetch("/api/notify/telegram", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ test: true }),
}).then((r) => r.json());
```

`{ok: true}` and a message on your phone means the whole path works. Then
register a throwaway client on `/register` to confirm the webhook itself fires.

---

## Behaviour worth knowing

**Nothing configured, nothing breaks.** With the secrets unset, `sendTelegram`
returns `{ok: false, reason: "unconfigured"}` and the request succeeds. An
alert channel must never be able to fail the write that triggered it.

**Failures answer 200.** Supabase retries non-2xx, and a retry means the same
alert lands on a phone twice. So anything a retry cannot fix — Telegram
rejecting the message, no bot configured — returns 200 with `ok:false` and a
reason, and is logged. Only an unauthenticated or unparseable request gets a
non-2xx.

**Rows that aren't waiting on anyone are skipped.** An ad account inserted
already active, a client row created pre-approved: real events, but not news.
The route answers `{ok: true, skipped: "nothing to announce"}`.

**Client text is escaped.** Names, store names and notes are client-supplied,
and a stray `<` makes Telegram reject the whole message. Everything
interpolated goes through `escapeHtml`.

## Adding a fifth event

Add the row in `formatAdminEvent` (`src/lib/notify/admin-events.ts`), add the
table to `NOTIFIED_TABLES`, and create the matching Supabase webhook. Add it to
`fetchPendingCounts` and the bell too, or the badge and the phone start
disagreeing about what is waiting.
