-- =============================================================================
-- Manual Telegram step 2 - Add partner and billing events to the alerts.
--
-- Step 1 covered the approval queue, which is all creations. These two are state
-- CHANGES: an invite becomes access, an invoice becomes issued or paid. So the
-- trigger function has to start sending the previous row as well — without it
-- the route cannot tell "is paid now" from "was already paid and something else
-- was rewritten".
--
-- Noise control happens twice, on purpose. Here, WHEN clauses stop the trigger
-- firing at all unless the interesting column moved; invoices are rewritten by
-- Stripe reconciliation far more often than they change state, and pg_net would
-- otherwise queue a request per write. Then the route filters again, so the
-- rule stays visible in code where it can be read and tested.
--
-- -----------------------------------------------------------------------------
-- BEFORE RUNNING: replace __NOTIFY_SECRET__, or let
--   node scripts/telegram-webhooks-sql.mjs
-- print this with the secret already substituted from .env.local.
-- =============================================================================

-- Same function as step 1, now carrying OLD on updates. Built with an IF rather
-- than a CASE: in an INSERT trigger the OLD record is unassigned, and touching
-- it at all raises "record 'old' is not assigned yet".
create or replace function public.notify_admin_telegram()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, net
as $$
declare
  body jsonb;
begin
  if tg_op = 'UPDATE' then
    body := jsonb_build_object(
      'type', tg_op,
      'table', tg_table_name,
      'schema', tg_table_schema,
      'record', to_jsonb(new),
      'old_record', to_jsonb(old)
    );
  else
    body := jsonb_build_object(
      'type', tg_op,
      'table', tg_table_name,
      'schema', tg_table_schema,
      'record', to_jsonb(new),
      'old_record', null
    );
  end if;

  -- Never let an alert break the write that triggered it.
  begin
    perform net.http_post(
      url := 'https://dropscale.app/api/notify/telegram',
      body := body,
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

  return null;
end;
$$;

-- Idempotent.
drop trigger if exists telegram_notify_client_invites on public.client_invites;
drop trigger if exists telegram_notify_client_invites_accepted on public.client_invites;
drop trigger if exists telegram_notify_invoices_state on public.invoices;

-- A client invited somebody as a sócio.
create trigger telegram_notify_client_invites
  after insert on public.client_invites
  for each row execute function public.notify_admin_telegram();

-- That invite turned into real access. Only on a status change: an invite row
-- touched for any other reason is not an event.
create trigger telegram_notify_client_invites_accepted
  after update on public.client_invites
  for each row
  when (old.status is distinct from new.status)
  execute function public.notify_admin_telegram();

-- Issued, or paid. Deliberately no INSERT trigger: an invoice row is created as
-- a draft snapshot well before it reaches the client, and announcing that would
-- report the same invoice twice.
create trigger telegram_notify_invoices_state
  after update on public.invoices
  for each row
  when (
    old.status is distinct from new.status
    or (old.issued_at is null and new.issued_at is not null)
  )
  execute function public.notify_admin_telegram();
