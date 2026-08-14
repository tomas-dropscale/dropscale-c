-- =============================================================================
-- 0060 - Purpose-bound Google reporting metadata enrichment.
--
-- Windsor can prove the currency and reporting time zone of an exact connected
-- account even when an older onboarding row predates mandatory metadata. This
-- migration fills only missing reporting metadata. It does not prove Google
-- Ads agency/MCC access, establish a billing boundary, or change financial
-- history.
-- =============================================================================

create table public.client_google_ads_reporting_metadata_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.client_google_ads_connections(id) on delete restrict,
  client_id uuid not null references public.portal_clients(id) on delete restrict,
  binding_id uuid references public.client_reporting_bindings(id) on delete restrict,
  event_type text not null default 'metadata_enriched'
    check (event_type = 'metadata_enriched'),
  proof_scope text not null default 'windsor_reporting_metadata_only'
    check (proof_scope = 'windsor_reporting_metadata_only'),
  source_account_id text not null
    check (source_account_id ~ '^[0-9]{10}$'),
  prior_currency text,
  source_currency text not null check (source_currency ~ '^[A-Z]{3}$'),
  prior_time_zone text,
  source_time_zone text not null
    check (length(btrim(source_time_zone)) between 1 and 160),
  verified_at timestamptz not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null check (
    reason = btrim(reason) and length(reason) between 3 and 500
  ),
  idempotency_key text not null unique check (
    idempotency_key = btrim(idempotency_key)
    and length(idempotency_key) between 8 and 128
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (connection_id, verified_at)
);

comment on table public.client_google_ads_reporting_metadata_events is
  'Immutable Windsor exact-account reporting metadata proof. It is not agency/MCC access or billing authority.';

alter table public.client_google_ads_reporting_metadata_events enable row level security;
revoke all on table public.client_google_ads_reporting_metadata_events
  from public, anon, authenticated, service_role;
grant select on table public.client_google_ads_reporting_metadata_events to service_role;

-- Every supported connection mutation already enters through a SECURITY
-- DEFINER RPC. Keep service reads, but remove table-level DML so PostgREST or a
-- future server caller cannot bypass the lifecycle guards below.
revoke insert, update, delete on table public.client_google_ads_connections
  from service_role;
grant select on table public.client_google_ads_connections to service_role;

create or replace function public.guard_client_google_ads_reporting_metadata_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'A Google Ads reporting metadata event is immutable.'
      using errcode = '23514';
  end if;

  if auth.role() is distinct from 'service_role'
    or current_setting('dropscale.google_reporting_metadata_event_connection', true)
         is distinct from new.connection_id::text
    or current_setting('dropscale.google_reporting_metadata_event_key', true)
         is distinct from new.idempotency_key
    or not exists (
      select 1
      from public.client_google_ads_connections connection
      where connection.id = new.connection_id
        and connection.client_id = new.client_id
        and public.normalize_google_ads_customer_id(connection.windsor_account_id)
              = new.source_account_id
        and connection.currency = new.source_currency
        and btrim(connection.time_zone) = new.source_time_zone
        and connection.last_verified_at is not distinct from new.verified_at
    )
  then
    raise exception 'A Google Ads reporting metadata event must match its purpose-bound update.'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger client_google_ads_reporting_metadata_events_guard
  before insert or update or delete
  on public.client_google_ads_reporting_metadata_events
  for each row execute function public.guard_client_google_ads_reporting_metadata_event();

-- service_role owns the connection table for server workflows. Protect these
-- two identity fields even from direct service DML: the established collecting
-- workflow and the enrichment RPC each set a transaction-local purpose flag.
create or replace function public.guard_client_google_ads_reporting_metadata_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  enrichment_write boolean := false;
  collecting_write boolean := false;
begin
  if new.currency is not distinct from old.currency
    and new.time_zone is not distinct from old.time_zone
  then
    return new;
  end if;

  enrichment_write :=
    auth.role() is not distinct from 'service_role'
    and current_setting('dropscale.google_reporting_metadata_enrichment', true)
          is not distinct from old.id::text
    and (
      new.currency is not distinct from old.currency
      or (old.currency is null and new.currency ~ '^[A-Z]{3}$')
    )
    and (
      new.time_zone is not distinct from old.time_zone
      or (
        nullif(btrim(coalesce(old.time_zone, '')), '') is null
        and length(btrim(coalesce(new.time_zone, ''))) between 1 and 160
      )
    );

  collecting_write :=
    auth.role() is not distinct from 'service_role'
    and (
      current_setting('dropscale.client_google_onboarding_upsert', true)
        is not distinct from old.id::text
      or current_setting('dropscale.client_google_onboarding_batch_upsert', true)
        is not distinct from old.session_id::text
    )
    and (new.currency is null or new.currency ~ '^[A-Z]{3}$')
    and (
      new.time_zone is null
      or length(btrim(new.time_zone)) between 1 and 160
    )
    and exists (
      select 1
      from public.client_onboarding_sessions session
      where session.id = old.session_id
        and session.claimed_user_id = old.client_id
        and session.status = 'collecting'
    );

  if not enrichment_write and not collecting_write then
    raise exception 'Google Ads reporting metadata may only change through a purpose-bound workflow.'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger client_google_ads_connections_guard_reporting_metadata_write
  before update of currency, time_zone on public.client_google_ads_connections
  for each row execute function public.guard_client_google_ads_reporting_metadata_write();

-- 0049 owns the current plural collection contract and updates a retry from
-- the same collecting session directly. Keep that implementation intact
-- behind a purpose-bound wrapper so schema-first deployment does not break the
-- still-live onboarding bundle while this trigger is already active.
alter function public.upsert_client_google_ads_connections(uuid, text, jsonb)
  rename to upsert_client_google_ads_connections_0049;
revoke all on function public.upsert_client_google_ads_connections_0049(
  uuid, text, jsonb
) from public, anon, authenticated, service_role;

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
  result_ids uuid[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save Google Ads connections.'
      using errcode = '42501';
  end if;

  perform set_config(
    'dropscale.client_google_onboarding_batch_upsert',
    p_session_id::text,
    true
  );
  result_ids := public.upsert_client_google_ads_connections_0049(
    p_session_id,
    p_token_hash,
    p_accounts
  );
  perform set_config(
    'dropscale.client_google_onboarding_batch_upsert',
    '',
    true
  );
  return result_ids;
end
$$;

revoke all on function public.upsert_client_google_ads_connections(
  uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.upsert_client_google_ads_connections(
  uuid, text, jsonb
) to service_role;

-- Preserve the established collecting-session upsert behind the new direct
-- write guard. No reviewed or bound source can enter through this flag.
create or replace function public.upsert_client_google_ads_connection(
  p_session_id uuid,
  p_token_hash text,
  p_windsor_account_id text,
  p_account_name text,
  p_currency text,
  p_time_zone text,
  p_data_source_id text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  result_id uuid;
  existing_client_id uuid;
  existing_session_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can save a Google Ads connection.' using errcode = '42501';
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
  if length(btrim(coalesce(p_windsor_account_id, ''))) not between 1 and 160
    or length(btrim(coalesce(p_account_name, ''))) not between 1 and 240
    or (p_currency is not null and upper(btrim(p_currency)) !~ '^[A-Z]{3}$')
    or (p_time_zone is not null and length(btrim(p_time_zone)) not between 1 and 160)
  then
    raise exception 'Invalid Google Ads account metadata.' using errcode = '22023';
  end if;

  select id, client_id, session_id
  into result_id, existing_client_id, existing_session_id
  from public.client_google_ads_connections
  where windsor_account_id = btrim(p_windsor_account_id)
    and status = 'connected'
  for update;

  if result_id is not null and existing_client_id <> target.claimed_user_id then
    raise exception 'This Google Ads account belongs to another client.' using errcode = '23505';
  end if;
  if result_id is not null and existing_session_id <> target.id then
    raise exception 'This Google Ads account is already connected in another onboarding session.'
      using errcode = '23505';
  end if;

  if result_id is null then
    insert into public.client_google_ads_connections (
      session_id, client_id, windsor_account_id, account_name,
      currency, time_zone, data_source_id, last_verified_at
    ) values (
      target.id, target.claimed_user_id, btrim(p_windsor_account_id),
      btrim(p_account_name), nullif(upper(btrim(coalesce(p_currency, ''))), ''),
      nullif(btrim(coalesce(p_time_zone, '')), ''),
      nullif(btrim(coalesce(p_data_source_id, '')), ''), now()
    ) returning id into result_id;
    insert into public.client_onboarding_events (
      session_id, event_type, actor_type, actor_id,
      details
    ) values (
      target.id, 'google_connected', 'invite', target.claimed_user_id,
      jsonb_build_object('connection_id', result_id)
    );
  else
    perform set_config(
      'dropscale.client_google_onboarding_upsert',
      result_id::text,
      true
    );
    update public.client_google_ads_connections
    set account_name = btrim(p_account_name),
        currency = nullif(upper(btrim(coalesce(p_currency, ''))), ''),
        time_zone = nullif(btrim(coalesce(p_time_zone, '')), ''),
        data_source_id = nullif(btrim(coalesce(p_data_source_id, '')), ''),
        last_verified_at = now(),
        updated_at = now(),
        last_error_code = null
    where id = result_id;
  end if;
  update public.client_onboarding_sessions set updated_at = now() where id = target.id;
  return result_id;
end
$$;

create or replace function public.enrich_client_google_ads_reporting_metadata(
  p_connection_id uuid,
  p_currency text,
  p_time_zone text,
  p_admin_id uuid,
  p_verified_at timestamptz,
  p_reason text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_google_ads_connections%rowtype;
  target_session public.client_onboarding_sessions%rowtype;
  prior_event public.client_google_ads_reporting_metadata_events%rowtype;
  reserved_binding record;
  selected_binding_id uuid := null;
  normal_currency text := btrim(coalesce(p_currency, ''));
  normal_time_zone text := btrim(coalesce(p_time_zone, ''));
  normal_reason text := btrim(coalesce(p_reason, ''));
  normal_key text := btrim(coalesce(p_idempotency_key, ''));
  source_account_id text;
  metadata_changes boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can enrich Google Ads metadata.'
      using errcode = '42501';
  end if;
  if p_connection_id is null
    or p_admin_id is null
    or p_verified_at is null
    or p_currency is distinct from normal_currency
    or normal_currency !~ '^[A-Z]{3}$'
    or p_time_zone is distinct from normal_time_zone
    or length(normal_time_zone) not between 1 and 160
    or normal_time_zone ~ '[[:cntrl:]]'
    or p_reason is distinct from normal_reason
    or length(normal_reason) not between 3 and 500
    or p_idempotency_key is distinct from normal_key
    or length(normal_key) not between 8 and 128
    or normal_key !~ '^[A-Za-z0-9._:-]+$'
  then
    raise exception 'Invalid Google Ads reporting metadata enrichment request.'
      using errcode = '22023';
  end if;

  perform profile.id
  from public.profiles profile
  where profile.id = p_admin_id and profile.role = 'admin'
  for share;
  if not found then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;

  select * into target
  from public.client_google_ads_connections connection
  where connection.id = p_connection_id
  for update;
  if not found or target.status <> 'connected' then
    raise exception 'Connected Google Ads source not found.' using errcode = 'P0002';
  end if;

  perform client.id
  from public.portal_clients client
  join public.profiles owner_profile on owner_profile.id = client.id
  where client.id = target.client_id
    and client.approval_status = 'approved'
    and owner_profile.role <> 'admin'
  for share of client, owner_profile;
  if not found then
    raise exception 'Google Ads metadata requires an approved non-admin client.'
      using errcode = '42501';
  end if;

  select * into target_session
  from public.client_onboarding_sessions session
  where session.id = target.session_id
  for share;
  if not found
    or target_session.claimed_user_id is distinct from target.client_id
    or target_session.status not in ('submitted', 'reviewed', 'active')
  then
    raise exception 'Google Ads source ownership is not immutable and reviewed.'
      using errcode = '23514';
  end if;

  source_account_id := public.normalize_google_ads_customer_id(target.windsor_account_id);
  if source_account_id is null or source_account_id !~ '^[0-9]{10}$' then
    raise exception 'Google Ads source has no canonical customer identifier.'
      using errcode = '23514';
  end if;

  for reserved_binding in
    select
      binding.id,
      binding.client_id,
      account.client_id as account_client_id,
      account.google_ads_customer_id,
      account.currency
    from public.client_reporting_bindings binding
    join public.ad_accounts account on account.id = binding.ad_account_id
    where binding.google_ads_connection_id = target.id
      and binding.status in ('active', 'staged')
    order by binding.id
    for share of binding, account
  loop
    if selected_binding_id is not null
      or reserved_binding.client_id is distinct from target.client_id
      or reserved_binding.account_client_id is distinct from target.client_id
      or public.normalize_google_ads_customer_id(
           reserved_binding.google_ads_customer_id
         ) is distinct from source_account_id
      or reserved_binding.currency is distinct from normal_currency
    then
      raise exception 'Google Ads reporting binding identity does not match this source.'
        using errcode = '23514';
    end if;
    selected_binding_id := reserved_binding.id;
  end loop;

  select * into prior_event
  from public.client_google_ads_reporting_metadata_events event
  where event.idempotency_key = normal_key
  for share;
  if found then
    if prior_event.connection_id = target.id
      and prior_event.client_id = target.client_id
      and prior_event.binding_id is not distinct from selected_binding_id
      and prior_event.event_type = 'metadata_enriched'
      and prior_event.proof_scope = 'windsor_reporting_metadata_only'
      and prior_event.source_account_id = source_account_id
      and prior_event.source_currency = normal_currency
      and prior_event.source_time_zone = normal_time_zone
      and prior_event.verified_at = p_verified_at
      and prior_event.actor_id = p_admin_id
      and prior_event.reason = normal_reason
    then
      return target.id;
    end if;
    raise exception 'Google Ads metadata idempotency key was already used differently.'
      using errcode = '23505';
  end if;

  if p_verified_at < clock_timestamp() - interval '5 minutes'
    or p_verified_at > clock_timestamp() + interval '1 minute'
    or (
      target.last_verified_at is not null
      and p_verified_at < target.last_verified_at
    )
  then
    raise exception 'Google Ads reporting metadata proof is stale.'
      using errcode = '22023';
  end if;

  if (target.currency is not null and target.currency <> normal_currency)
    or (
      nullif(btrim(coalesce(target.time_zone, '')), '') is not null
      and btrim(target.time_zone) <> normal_time_zone
    )
  then
    raise exception 'Existing Google Ads reporting metadata is immutable.'
      using errcode = '23514';
  end if;

  metadata_changes := target.currency is null
    or nullif(btrim(coalesce(target.time_zone, '')), '') is null;
  if not metadata_changes then
    if current_setting(
      'dropscale.google_reporting_metadata_legacy_test_key', true
    ) is not distinct from normal_key
      and normal_reason =
        'Legacy admin Google Ads test verified reporting metadata.'
      and normal_key like 'legacy-google-meta:' || target.id::text || ':%'
    then
      return target.id;
    end if;
    raise exception 'Google Ads reporting metadata is already complete.'
      using errcode = '23514';
  end if;

  perform set_config(
    'dropscale.google_reporting_metadata_enrichment',
    target.id::text,
    true
  );
  -- Retain compatibility with the 0055/0056 bound-identity guard. The new
  -- metadata guard above ensures the legacy flag alone cannot authorize DML.
  perform set_config(
    'dropscale.google_reporting_identity_refresh',
    target.id::text,
    true
  );
  update public.client_google_ads_connections
  set currency = normal_currency,
      time_zone = normal_time_zone,
      last_verified_at = p_verified_at,
      last_error_code = null,
      updated_at = clock_timestamp()
  where id = target.id;

  perform set_config(
    'dropscale.google_reporting_metadata_event_connection',
    target.id::text,
    true
  );
  perform set_config(
    'dropscale.google_reporting_metadata_event_key',
    normal_key,
    true
  );
  insert into public.client_google_ads_reporting_metadata_events (
    connection_id,
    client_id,
    binding_id,
    source_account_id,
    prior_currency,
    source_currency,
    prior_time_zone,
    source_time_zone,
    verified_at,
    actor_id,
    reason,
    idempotency_key
  ) values (
    target.id,
    target.client_id,
    selected_binding_id,
    source_account_id,
    target.currency,
    normal_currency,
    target.time_zone,
    normal_time_zone,
    p_verified_at,
    p_admin_id,
    normal_reason,
    normal_key
  );

  return target.id;
end
$$;

-- Rolling-deploy bridge for the previous admin Google Test bundle. Its
-- service-only five-argument contract is retained temporarily, but every
-- metadata write delegates to the new Windsor-scoped provenance path with a
-- deterministic key. A later test on already-complete matching metadata is a
-- strictly validated no-op, matching the old route's unconditional call.
create or replace function public.record_client_google_ads_reporting_identity(
  p_connection_id uuid,
  p_currency text,
  p_time_zone text,
  p_admin_id uuid,
  p_verified_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normal_key text;
  result_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can refresh Google Ads identity metadata.'
      using errcode = '42501';
  end if;

  normal_key := 'legacy-google-meta:'
    || p_connection_id::text
    || ':'
    || replace(extract(epoch from p_verified_at)::text, '.', '_');
  perform set_config(
    'dropscale.google_reporting_metadata_legacy_test_key',
    normal_key,
    true
  );
  result_id := public.enrich_client_google_ads_reporting_metadata(
    p_connection_id,
    upper(btrim(coalesce(p_currency, ''))),
    btrim(coalesce(p_time_zone, '')),
    p_admin_id,
    p_verified_at,
    'Legacy admin Google Ads test verified reporting metadata.',
    normal_key
  );
  perform set_config(
    'dropscale.google_reporting_metadata_legacy_test_key',
    '',
    true
  );
  return result_id;
end
$$;

revoke all on function public.record_client_google_ads_reporting_identity(
  uuid, text, text, uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.record_client_google_ads_reporting_identity(
  uuid, text, text, uuid, timestamptz
) to service_role;

revoke all on function public.enrich_client_google_ads_reporting_metadata(
  uuid, text, text, uuid, timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.enrich_client_google_ads_reporting_metadata(
  uuid, text, text, uuid, timestamptz, text, text
) to service_role;

revoke all on function public.guard_client_google_ads_reporting_metadata_event()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_google_ads_reporting_metadata_write()
  from public, anon, authenticated, service_role;

comment on function public.enrich_client_google_ads_reporting_metadata(
  uuid, text, text, uuid, timestamptz, text, text
) is
  'Fills missing metadata from a fresh Windsor exact-account reporting proof. Does not establish agency/MCC or billing authority.';

notify pgrst, 'reload schema';
