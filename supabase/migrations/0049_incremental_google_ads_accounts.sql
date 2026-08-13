-- A later Windsor authorization may return accounts already connected by an
-- older onboarding for the same client alongside newly selected accounts.
-- Keep those older connections untouched and add only the missing accounts.

create or replace function public.upsert_client_google_ads_connections(
  p_session_id uuid,
  p_token_hash text,
  p_accounts jsonb
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  account jsonb;
  account_id text;
  existing_id uuid;
  existing_session_id uuid;
  seen_account_ids text[] := '{}'::text[];
  result_ids uuid[] := '{}'::uuid[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save Google Ads connections.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found
    or target.status <> 'collecting'
    or target.claimed_user_id is null
    or target.invite_token_hash is distinct from p_token_hash
    or target.invite_expires_at <= now()
    or not ('google_ads' = any(target.requested_assets))
  then
    raise exception 'Google Ads onboarding is not available.' using errcode = 'P0002';
  end if;
  if p_accounts is null
    or jsonb_typeof(p_accounts) is distinct from 'array'
    or jsonb_array_length(p_accounts) not between 1 and 100
  then
    raise exception 'Invalid Google Ads account batch.' using errcode = '22023';
  end if;

  -- Validate and normalize the complete Windsor selection before any
  -- connection is inserted or refreshed.
  for account in select value from jsonb_array_elements(p_accounts)
  loop
    if jsonb_typeof(account) is distinct from 'object'
      or not account ?& array[
        'windsorAccountId', 'accountName', 'currency', 'timeZone', 'dataSourceId'
      ]::text[]
      or exists (
        select 1 from jsonb_object_keys(account) key
        where key not in (
          'windsorAccountId', 'accountName', 'currency', 'timeZone', 'dataSourceId'
        )
      )
      or jsonb_typeof(account -> 'windsorAccountId') is distinct from 'string'
      or jsonb_typeof(account -> 'accountName') is distinct from 'string'
      or (
        account -> 'currency' <> 'null'::jsonb
        and jsonb_typeof(account -> 'currency') is distinct from 'string'
      )
      or (
        account -> 'timeZone' <> 'null'::jsonb
        and jsonb_typeof(account -> 'timeZone') is distinct from 'string'
      )
      or (
        account -> 'dataSourceId' <> 'null'::jsonb
        and jsonb_typeof(account -> 'dataSourceId') is distinct from 'string'
      )
      or length(btrim(coalesce(account ->> 'windsorAccountId', ''))) not between 1 and 160
      or length(btrim(coalesce(account ->> 'accountName', ''))) not between 1 and 240
      or (
        account ->> 'currency' is not null
        and upper(btrim(account ->> 'currency')) !~ '^[A-Z]{3}$'
      )
    then
      raise exception 'Invalid Google Ads account metadata.' using errcode = '22023';
    end if;

    account_id := btrim(account ->> 'windsorAccountId');
    if account_id = any(seen_account_ids) then
      raise exception 'Duplicate Google Ads account in batch.' using errcode = '22023';
    end if;
    seen_account_ids := array_append(seen_account_ids, account_id);
  end loop;

  -- Lock every existing active account in a stable order. Any cross-client
  -- account rejects the whole batch before connection rows are changed.
  perform connection.id
  from public.client_google_ads_connections connection
  where connection.windsor_account_id = any(seen_account_ids)
    and connection.status = 'connected'
  order by connection.windsor_account_id
  for update;

  if exists (
    select 1
    from public.client_google_ads_connections connection
    where connection.windsor_account_id = any(seen_account_ids)
      and connection.status = 'connected'
      and connection.client_id <> target.claimed_user_id
  ) then
    raise exception 'A Google Ads account belongs to another client.' using errcode = '23505';
  end if;

  for account in select value from jsonb_array_elements(p_accounts)
  loop
    account_id := btrim(account ->> 'windsorAccountId');
    select connection.id, connection.session_id
    into existing_id, existing_session_id
    from public.client_google_ads_connections connection
    where connection.windsor_account_id = account_id
      and connection.status = 'connected';

    if found then
      -- An older same-client connection is intentionally immutable here. A
      -- retry in this session may refresh metadata without changing ownership.
      if existing_session_id = target.id then
        update public.client_google_ads_connections
        set account_name = btrim(account ->> 'accountName'),
            currency = nullif(upper(btrim(coalesce(account ->> 'currency', ''))), ''),
            time_zone = nullif(btrim(coalesce(account ->> 'timeZone', '')), ''),
            data_source_id = nullif(btrim(coalesce(account ->> 'dataSourceId', '')), ''),
            last_verified_at = now(),
            updated_at = now(),
            last_error_code = null
        where id = existing_id;
      end if;
    else
      insert into public.client_google_ads_connections (
        session_id, client_id, windsor_account_id, account_name,
        currency, time_zone, data_source_id, last_verified_at
      ) values (
        target.id, target.claimed_user_id, account_id,
        btrim(account ->> 'accountName'),
        nullif(upper(btrim(coalesce(account ->> 'currency', ''))), ''),
        nullif(btrim(coalesce(account ->> 'timeZone', '')), ''),
        nullif(btrim(coalesce(account ->> 'dataSourceId', '')), ''), now()
      ) returning id into existing_id;
      insert into public.client_onboarding_events (
        session_id, event_type, actor_type, actor_id, details
      ) values (
        target.id, 'google_connected', 'invite', target.claimed_user_id,
        jsonb_build_object('connection_id', existing_id)
      );
    end if;
    result_ids := array_append(result_ids, existing_id);
  end loop;

  update public.client_onboarding_sessions set updated_at = now() where id = target.id;
  return result_ids;
end
$$;

revoke all on function public.upsert_client_google_ads_connections(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_client_google_ads_connections(uuid, text, jsonb)
  to service_role;
