-- =============================================================================
-- 0034 - Push the admin approval inbox to Telegram.
--
-- The bell in the admin chrome only alerts somebody already looking at the
-- panel. These four triggers post the same events to /api/notify/telegram, so
-- a client who registers at 22:00 is not discovered the next morning.
--
-- Supabase's "Database Webhooks" UI does the same job, but only after the
-- dashboard has installed its supabase_functions schema — a manual step that
-- has to be repeated on every fresh project, and that a migration cannot do for
-- itself. This calls pg_net directly instead, so the whole wiring is one file
-- with nothing to click.
--
-- The payload deliberately matches the shape Supabase's own webhooks send
-- (type / table / schema / record / old_record), so the route accepts either
-- source and switching back later changes nothing on the application side.
--
-- INSERT only, deliberately: an UPDATE on these tables is usually the team's own
-- approval, and being notified about what you just did is how people learn to
-- ignore a channel. The route filters again on its side (a row inserted already
-- approved is real, but not news), so the two agree.
--
-- -----------------------------------------------------------------------------
-- BEFORE RUNNING: replace __NOTIFY_SECRET__ below with the real value, or let
--   node scripts/telegram-webhooks-sql.mjs
-- print this file with the secret already substituted from .env.local.
--
-- The placeholder is why this file is safe in git. Never commit the filled-in
-- version: it is stored in the function body and readable by anyone who can
-- inspect the schema.
-- =============================================================================

-- pg_net performs the HTTP call from Postgres. It exposes net.http_post().
create extension if not exists pg_net;

create or replace function public.notify_admin_telegram()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, net
as $$
begin
  -- Never let an alert break the write that triggered it. pg_net only queues
  -- the request, but a missing extension or a revoked grant would otherwise
  -- turn a client registration into a failed INSERT — losing an alert is
  -- acceptable, losing a signup is not.
  begin
    perform net.http_post(
      url := 'https://dropscale.app/api/notify/telegram',
      body := jsonb_build_object(
        'type', tg_op,
        'table', tg_table_name,
        'schema', tg_table_schema,
        'record', to_jsonb(new),
        'old_record', null
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer __NOTIFY_SECRET__'
      ),
      timeout_milliseconds := 5000
    );
  exception
    when others then
      raise warning 'Telegram alert for %.% failed: %',
        tg_table_schema, tg_table_name, sqlerrm;
  end;

  return null; -- AFTER trigger; the return value is ignored.
end;
$$;

comment on function public.notify_admin_telegram() is
  'Posts an INSERT on the approval-queue tables to /api/notify/telegram. '
  'Best-effort: failures are warnings, never errors.';

-- Idempotent: re-running after a URL or secret change replaces cleanly.
drop trigger if exists telegram_notify_portal_clients on public.portal_clients;
drop trigger if exists telegram_notify_ad_accounts on public.ad_accounts;
drop trigger if exists telegram_notify_account_requests on public.account_requests;
drop trigger if exists telegram_notify_creative_submissions on public.creative_submissions;

-- A client registered and is waiting to be let in.
create trigger telegram_notify_portal_clients
  after insert on public.portal_clients
  for each row execute function public.notify_admin_telegram();

-- A store was added and still needs "Verify Google & start tracking".
create trigger telegram_notify_ad_accounts
  after insert on public.ad_accounts
  for each row execute function public.notify_admin_telegram();

-- A client asked for a Google Ads account or a Shopify link.
create trigger telegram_notify_account_requests
  after insert on public.account_requests
  for each row execute function public.notify_admin_telegram();

-- A client handed in creatives for review.
create trigger telegram_notify_creative_submissions
  after insert on public.creative_submissions
  for each row execute function public.notify_admin_telegram();
