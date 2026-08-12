-- =============================================================================

alter table public.audit_shopify_connection_events
  drop constraint if exists audit_shopify_connection_events_event_type_check;
alter table public.audit_shopify_connection_events
  add constraint audit_shopify_connection_events_event_type_check check (
    event_type in (
      'invitation_created', 'invitation_rotated', 'invitation_revoked',
      'credentials_rejected', 'store_connected', 'connection_reviewed',
      'connection_revoked', 'verification_failed', 'audit_collector_requested'
    )
  );
-- 0042 - Durable, resumable read-only Shopify audit collector runs.
--
-- A run is bound to one verified connection and its canonical myshopify domain.
-- Workers receive only short fenced leases and persist a bounded checkpoint
-- between invocations. The final JSON artifact is deliberately a sanitized,
-- bounded summary; credentials and raw Shopify tokens belong only in the
-- existing encrypted credential table.
-- =============================================================================

-- Reject secret-shaped keys at any depth, including inside arrays. This is a
-- defence-in-depth guard for checkpoint and artifact JSON; callers must still
-- sanitize values before writing them.
create or replace function public.audit_shopify_json_has_secret_keys(
  p_document jsonb
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
declare
  member record;
  normalized_key text;
begin
  if p_document is null then
    return false;
  end if;

  if jsonb_typeof(p_document) = 'object' then
    for member in select key, value from jsonb_each(p_document)
    loop
      normalized_key := regexp_replace(lower(member.key), '[^a-z0-9]+', '', 'g');
      if normalized_key = any(array[
        'token', 'tokenhash', 'invitetoken', 'invitetokenhash',
        'clientsecret', 'accesstoken', 'refreshtoken', 'authorization',
        'credential', 'credentials', 'ciphertext', 'password', 'passphrase',
        'privatekey', 'apikey'
      ]::text[])
      or normalized_key ~ '(secret|token|password|passphrase|credential|ciphertext|authorization|privatekey|apikey|bearer)'
      then
        return true;
      end if;

      if public.audit_shopify_json_has_secret_keys(member.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_document) = 'array' then
    for member in select value from jsonb_array_elements(p_document)
    loop
      if public.audit_shopify_json_has_secret_keys(member.value) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end
$$;

create or replace function public.audit_shopify_json_is_safe(
  p_document jsonb,
  p_max_bytes integer
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select p_document is not null
    and jsonb_typeof(p_document) = 'object'
    and p_max_bytes > 0
    and octet_length(p_document::text) <= p_max_bytes
    and not public.audit_shopify_json_has_secret_keys(p_document)
$$;

revoke all on function public.audit_shopify_json_has_secret_keys(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.audit_shopify_json_is_safe(jsonb, integer)
  from public, anon, authenticated, service_role;

create table public.audit_shopify_runs (
  id uuid primary key,
  connection_id uuid not null
    references public.audit_shopify_connections(id) on delete restrict,
  requested_by uuid not null
    references public.profiles(id) on delete restrict,
  shopify_domain text not null,
  state text not null default 'queued'
    constraint audit_shopify_runs_state_value
    check (state in ('queued', 'running', 'completed', 'failed')),

  requested_source text not null,
  requested_note text,
  schema_hash text not null,
  manifest_hash text not null,

  checkpoint jsonb not null default '{}'::jsonb,
  artifact jsonb,

  attempt_count integer not null default 0,
  retry_count integer not null default 0,
  max_retries integer not null default 3,
  next_attempt_at timestamptz,

  lease_token uuid,
  lease_generation bigint not null default 0,
  lease_acquired_at timestamptz,
  lease_renewed_at timestamptz,
  lease_expires_at timestamptz,

  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,

  constraint audit_shopify_runs_domain_shape check (
    shopify_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
  ),
  constraint audit_shopify_runs_source_shape check (
    requested_source ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'
  ),
  constraint audit_shopify_runs_note_shape check (
    requested_note is null
    or length(requested_note) between 1 and 1000
  ),
  constraint audit_shopify_runs_hash_shape check (
    schema_hash ~ '^[0-9a-f]{64}$'
    and manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint audit_shopify_runs_checkpoint_safe check (
    public.audit_shopify_json_is_safe(checkpoint, 65536)
  ),
  constraint audit_shopify_runs_artifact_safe check (
    artifact is null
    or public.audit_shopify_json_is_safe(artifact, 8388608)
  ),
  constraint audit_shopify_runs_retry_shape check (
    attempt_count >= 0
    and retry_count >= 0
    and max_retries between 0 and 10
    and retry_count <= max_retries
    and retry_count <= attempt_count
  ),
  constraint audit_shopify_runs_lease_generation_shape check (
    lease_generation >= 0
  ),
  constraint audit_shopify_runs_error_shape check (
    error_code is null
    or error_code ~ '^[a-z0-9][a-z0-9._:-]{1,63}$'
  ),
  constraint audit_shopify_runs_time_order check (
    updated_at >= created_at
    and (started_at is null or started_at >= created_at)
    and (completed_at is null or completed_at >= created_at)
    and (failed_at is null or failed_at >= created_at)
    and (
      lease_acquired_at is null
      or (
        lease_renewed_at >= lease_acquired_at
        and lease_expires_at > lease_renewed_at
      )
    )
  ),
  constraint audit_shopify_runs_state_shape check (
    (
      state = 'queued'
      and artifact is null
      and completed_at is null
      and failed_at is null
      and next_attempt_at is not null
      and lease_token is null
      and lease_acquired_at is null
      and lease_renewed_at is null
      and lease_expires_at is null
    )
    or (
      state = 'running'
      and artifact is null
      and error_code is null
      and completed_at is null
      and failed_at is null
      and next_attempt_at is null
      and lease_token is not null
      and lease_acquired_at is not null
      and lease_renewed_at is not null
      and lease_expires_at is not null
    )
    or (
      state = 'completed'
      and artifact is not null
      and error_code is null
      and completed_at is not null
      and failed_at is null
      and next_attempt_at is null
      and lease_token is null
      and lease_acquired_at is null
      and lease_renewed_at is null
      and lease_expires_at is null
    )
    or (
      state = 'failed'
      and artifact is null
      and error_code is not null
      and completed_at is null
      and failed_at is not null
      and next_attempt_at is null
      and lease_token is null
      and lease_acquired_at is null
      and lease_renewed_at is null
      and lease_expires_at is null
    )
  )
);

comment on table public.audit_shopify_runs is
  'Service-readable queue and sanitized artifacts for fenced, resumable, read-only Shopify collectors; mutations require lifecycle RPCs.';
comment on column public.audit_shopify_runs.checkpoint is
  'Sanitized resumable progress object, limited to 64 KiB and never containing secret-shaped keys.';
comment on column public.audit_shopify_runs.artifact is
  'Sanitized completed collector artifact, limited to 8 MiB and never containing secret-shaped keys.';
comment on column public.audit_shopify_runs.lease_generation is
  'Monotonic fencing generation; every leased write must present it with the exact run, domain and lease token.';

create index audit_shopify_runs_connection_created_idx
  on public.audit_shopify_runs (connection_id, created_at desc);
create index audit_shopify_runs_queue_idx
  on public.audit_shopify_runs (next_attempt_at, created_at, id)
  where state = 'queued';
create index audit_shopify_runs_expired_lease_idx
  on public.audit_shopify_runs (lease_expires_at, id)
  where state = 'running';
create unique index audit_shopify_runs_one_active_manifest_idx
  on public.audit_shopify_runs (connection_id, manifest_hash)
  where state in ('queued', 'running');

alter table public.audit_shopify_runs enable row level security;
revoke all on table public.audit_shopify_runs
  from public, anon, authenticated, service_role;
grant select on table public.audit_shopify_runs to service_role;

-- Idempotently enqueue a caller-generated run UUID. Replays are accepted only
-- when every immutable request field is identical.
create or replace function public.enqueue_audit_shopify_run(
  p_run_id uuid,
  p_connection_id uuid,
  p_requested_by uuid,
  p_shopify_domain text,
  p_requested_source text,
  p_requested_note text,
  p_schema_hash text,
  p_manifest_hash text,
  p_max_retries integer default 3,
  p_checkpoint jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  canonical_domain text;
  normalized_source text := lower(btrim(coalesce(p_requested_source, '')));
  normalized_note text := nullif(btrim(coalesce(p_requested_note, '')), '');
  normalized_schema_hash text := lower(btrim(coalesce(p_schema_hash, '')));
  normalized_manifest_hash text := lower(btrim(coalesce(p_manifest_hash, '')));
  inserted_id uuid;
  existing public.audit_shopify_runs%rowtype;
  reused_active boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the audit collector service can enqueue a Shopify run.'
      using errcode = '42501';
  end if;

  if p_run_id is null
    or p_connection_id is null
    or p_requested_by is null
    or coalesce(lower(btrim(p_shopify_domain)), '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or normalized_source !~ '^[a-z0-9][a-z0-9._:-]{0,63}$'
    or (normalized_note is not null and length(normalized_note) > 1000)
    or normalized_schema_hash !~ '^[0-9a-f]{64}$'
    or normalized_manifest_hash !~ '^[0-9a-f]{64}$'
    or p_max_retries not between 0 and 10
    or not public.audit_shopify_json_is_safe(p_checkpoint, 65536)
  then
    raise exception 'Invalid audit run request.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_requested_by and profile.role = 'admin'
  ) then
    raise exception 'The audit run requester is not an admin.' using errcode = '42501';
  end if;

  select lower(connection.shopify_domain) into canonical_domain
  from public.audit_shopify_connections connection
  where connection.id = p_connection_id
    and connection.status = 'connected'
  for share;

  if not found
    or canonical_domain is distinct from lower(btrim(p_shopify_domain))
  then
    raise exception 'The exact connected Shopify domain is not available.'
      using errcode = '22023';
  end if;

  begin
    insert into public.audit_shopify_runs (
      id,
      connection_id,
      requested_by,
      shopify_domain,
      requested_source,
      requested_note,
      schema_hash,
      manifest_hash,
      checkpoint,
      max_retries,
      next_attempt_at
    ) values (
      p_run_id,
      p_connection_id,
      p_requested_by,
      canonical_domain,
      normalized_source,
      normalized_note,
      normalized_schema_hash,
      normalized_manifest_hash,
      p_checkpoint,
      p_max_retries,
      clock_timestamp()
    )
    on conflict (id) do nothing
    returning id into inserted_id;
  exception
    when unique_violation then
      select run.* into existing
      from public.audit_shopify_runs run
      where run.connection_id = p_connection_id
        and run.manifest_hash = normalized_manifest_hash
        and run.state in ('queued', 'running')
      order by run.created_at, run.id
      limit 1;

      if not found then
        raise;
      end if;
      if existing.shopify_domain is distinct from canonical_domain
        or existing.requested_source is distinct from normalized_source
        or existing.requested_note is distinct from normalized_note
        or existing.schema_hash is distinct from normalized_schema_hash
        or existing.manifest_hash is distinct from normalized_manifest_hash
        or existing.max_retries is distinct from p_max_retries
      then
        raise exception 'An active audit manifest cannot be reused with different evidence.'
          using errcode = '22023';
      end if;
      inserted_id := existing.id;
      reused_active := true;
  end;

  if inserted_id is not null then
    insert into public.audit_shopify_connection_events (
      connection_id, event_type, actor_type, actor_profile_id, details
    ) values (
      p_connection_id,
      'audit_collector_requested',
      'admin',
      p_requested_by,
      jsonb_build_object('run_id', inserted_id, 'reused_active', reused_active)
    );
    return inserted_id;
  end if;

  select * into existing
  from public.audit_shopify_runs run
  where run.id = p_run_id
  for update;

  if existing.connection_id is distinct from p_connection_id
    or existing.requested_by is distinct from p_requested_by
    or existing.shopify_domain is distinct from canonical_domain
    or existing.requested_source is distinct from normalized_source
    or existing.requested_note is distinct from normalized_note
    or existing.schema_hash is distinct from normalized_schema_hash
    or existing.manifest_hash is distinct from normalized_manifest_hash
    or existing.max_retries is distinct from p_max_retries
  then
    raise exception 'An audit run UUID cannot be replayed with different evidence.'
      using errcode = '22023';
  end if;

  insert into public.audit_shopify_connection_events (
    connection_id, event_type, actor_type, actor_profile_id, details
  ) values (
    p_connection_id,
    'audit_collector_requested',
    'admin',
    p_requested_by,
    jsonb_build_object('run_id', existing.id, 'reused_active', true)
  );

  return existing.id;
end
$$;

-- Claim at most one ready row. SKIP LOCKED lets parallel workers contend
-- without waiting. An expired lease consumes one retry and receives a fresh
-- fencing generation; exhausted expired leases are terminally failed first.
create or replace function public.claim_audit_shopify_run(
  p_lease_token uuid,
  p_run_id uuid default null,
  p_shopify_domain text default null,
  p_lease_seconds integer default 55
)
returns setof public.audit_shopify_runs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target public.audit_shopify_runs%rowtype;
  claimed public.audit_shopify_runs%rowtype;
  v_now timestamptz := clock_timestamp();
  reclaiming boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the audit collector service can claim a Shopify run.'
      using errcode = '42501';
  end if;

  if p_lease_token is null
    or p_lease_seconds not between 15 and 300
    or (
      p_shopify_domain is not null
      and lower(btrim(p_shopify_domain)) !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    )
  then
    raise exception 'Invalid audit run lease request.' using errcode = '22023';
  end if;

  update public.audit_shopify_runs run
  set state = 'failed',
      error_code = 'lease_expired',
      failed_at = v_now,
      updated_at = v_now,
      next_attempt_at = null,
      lease_token = null,
      lease_acquired_at = null,
      lease_renewed_at = null,
      lease_expires_at = null
  where run.state = 'running'
    and run.lease_expires_at <= v_now
    and run.retry_count >= run.max_retries
    and (p_run_id is null or run.id = p_run_id)
    and (
      p_shopify_domain is null
      or run.shopify_domain = lower(btrim(p_shopify_domain))
    );

  select run.* into target
  from public.audit_shopify_runs run
  join public.audit_shopify_connections connection
    on connection.id = run.connection_id
   and connection.status = 'connected'
   and lower(connection.shopify_domain) = run.shopify_domain
  where (p_run_id is null or run.id = p_run_id)
    and (
      p_shopify_domain is null
      or run.shopify_domain = lower(btrim(p_shopify_domain))
    )
    and (
      (
        run.state = 'queued'
        and run.next_attempt_at <= v_now
      )
      or (
        run.state = 'running'
        and run.lease_expires_at <= v_now
        and run.retry_count < run.max_retries
      )
    )
  order by
    case when run.state = 'running' then 0 else 1 end,
    coalesce(run.lease_expires_at, run.next_attempt_at),
    run.created_at,
    run.id
  for update of run skip locked
  limit 1;

  if not found then
    return;
  end if;

  reclaiming := target.state = 'running';
  update public.audit_shopify_runs run
  set state = 'running',
      attempt_count = run.attempt_count + 1,
      retry_count = run.retry_count + case when reclaiming then 1 else 0 end,
      next_attempt_at = null,
      lease_token = p_lease_token,
      lease_generation = run.lease_generation + 1,
      lease_acquired_at = v_now,
      lease_renewed_at = v_now,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      error_code = null,
      started_at = coalesce(run.started_at, v_now),
      updated_at = v_now
  where run.id = target.id
  returning * into claimed;

  return next claimed;
end
$$;

-- Persist in-flight progress and extend the exact live lease. A stale worker
-- cannot revive an expired or superseded generation.
create or replace function public.renew_audit_shopify_run(
  p_run_id uuid,
  p_shopify_domain text,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_checkpoint jsonb,
  p_lease_seconds integer default 55
)
returns setof public.audit_shopify_runs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  renewed public.audit_shopify_runs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the audit collector service can renew a Shopify run.'
      using errcode = '42501';
  end if;

  if p_run_id is null
    or p_lease_token is null
    or p_lease_generation <= 0
    or coalesce(lower(btrim(p_shopify_domain)), '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or p_lease_seconds not between 15 and 300
    or not public.audit_shopify_json_is_safe(p_checkpoint, 65536)
  then
    raise exception 'Invalid audit run renewal.' using errcode = '22023';
  end if;

  update public.audit_shopify_runs run
  set checkpoint = p_checkpoint,
      lease_renewed_at = v_now,
      lease_expires_at = greatest(
        run.lease_expires_at,
        v_now + make_interval(secs => p_lease_seconds)
      ),
      updated_at = v_now
  where run.id = p_run_id
    and run.shopify_domain = lower(btrim(p_shopify_domain))
    and run.state = 'running'
    and run.lease_token = p_lease_token
    and run.lease_generation = p_lease_generation
    and run.lease_expires_at > v_now
    and exists (
      select 1
      from public.audit_shopify_connections connection
      where connection.id = run.connection_id
        and connection.status = 'connected'
        and lower(connection.shopify_domain) = run.shopify_domain
    )
  returning * into renewed;

  if not found then
    raise exception 'The audit run lease is not current.' using errcode = 'P0002';
  end if;

  return next renewed;
end
$$;

-- Voluntarily yield after a bounded chunk. This is not a retry and therefore
-- does not consume retry budget; the next invocation resumes the checkpoint.
create or replace function public.yield_audit_shopify_run(
  p_run_id uuid,
  p_shopify_domain text,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_checkpoint jsonb,
  p_continue_after_seconds integer default 0
)
returns setof public.audit_shopify_runs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  yielded public.audit_shopify_runs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the audit collector service can yield a Shopify run.'
      using errcode = '42501';
  end if;

  if p_run_id is null
    or p_lease_token is null
    or p_lease_generation <= 0
    or coalesce(lower(btrim(p_shopify_domain)), '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or p_continue_after_seconds not between 0 and 3600
    or not public.audit_shopify_json_is_safe(p_checkpoint, 65536)
  then
    raise exception 'Invalid audit run checkpoint.' using errcode = '22023';
  end if;

  update public.audit_shopify_runs run
  set state = 'queued',
      checkpoint = p_checkpoint,
      next_attempt_at = v_now + make_interval(secs => p_continue_after_seconds),
      lease_token = null,
      lease_acquired_at = null,
      lease_renewed_at = null,
      lease_expires_at = null,
      error_code = null,
      updated_at = v_now
  where run.id = p_run_id
    and run.shopify_domain = lower(btrim(p_shopify_domain))
    and run.state = 'running'
    and run.lease_token = p_lease_token
    and run.lease_generation = p_lease_generation
    and run.lease_expires_at > v_now
    and exists (
      select 1
      from public.audit_shopify_connections connection
      where connection.id = run.connection_id
        and connection.status = 'connected'
        and lower(connection.shopify_domain) = run.shopify_domain
    )
  returning * into yielded;

  if not found then
    raise exception 'The audit run lease is not current.' using errcode = 'P0002';
  end if;

  return next yielded;
end
$$;

create or replace function public.complete_audit_shopify_run(
  p_run_id uuid,
  p_shopify_domain text,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_checkpoint jsonb,
  p_artifact jsonb
)
returns setof public.audit_shopify_runs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  completed public.audit_shopify_runs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the audit collector service can complete a Shopify run.'
      using errcode = '42501';
  end if;

  if p_run_id is null
    or p_lease_token is null
    or p_lease_generation <= 0
    or coalesce(lower(btrim(p_shopify_domain)), '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or not public.audit_shopify_json_is_safe(p_checkpoint, 65536)
    or not public.audit_shopify_json_is_safe(p_artifact, 8388608)
  then
    raise exception 'Invalid completed audit artifact.' using errcode = '22023';
  end if;

  update public.audit_shopify_runs run
  set state = 'completed',
      checkpoint = p_checkpoint,
      artifact = p_artifact,
      completed_at = v_now,
      next_attempt_at = null,
      lease_token = null,
      lease_acquired_at = null,
      lease_renewed_at = null,
      lease_expires_at = null,
      error_code = null,
      updated_at = v_now
  where run.id = p_run_id
    and run.shopify_domain = lower(btrim(p_shopify_domain))
    and run.state = 'running'
    and run.lease_token = p_lease_token
    and run.lease_generation = p_lease_generation
    and run.lease_expires_at > v_now
    and exists (
      select 1
      from public.audit_shopify_connections connection
      where connection.id = run.connection_id
        and connection.status = 'connected'
        and lower(connection.shopify_domain) = run.shopify_domain
    )
  returning * into completed;

  if not found then
    raise exception 'The audit run lease is not current.' using errcode = 'P0002';
  end if;

  return next completed;
end
$$;

-- A worker may record a terminal failure after its wall-clock lease expired,
-- provided its token and fencing generation were never superseded. The row
-- lock serializes this with claim: a successful reclaim changes the generation
-- first and therefore rejects the stale worker.
create or replace function public.fail_audit_shopify_run(
  p_run_id uuid,
  p_shopify_domain text,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_checkpoint jsonb,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default 30
)
returns setof public.audit_shopify_runs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target public.audit_shopify_runs%rowtype;
  failed public.audit_shopify_runs%rowtype;
  v_now timestamptz := clock_timestamp();
  normalized_error text := lower(btrim(coalesce(p_error_code, '')));
  will_retry boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the audit collector service can fail a Shopify run.'
      using errcode = '42501';
  end if;

  if p_run_id is null
    or p_lease_token is null
    or p_lease_generation <= 0
    or coalesce(lower(btrim(p_shopify_domain)), '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or normalized_error !~ '^[a-z0-9][a-z0-9._:-]{1,63}$'
    or p_retryable is null
    or p_retry_after_seconds not between 0 and 86400
    or not public.audit_shopify_json_is_safe(p_checkpoint, 65536)
  then
    raise exception 'Invalid audit run failure.' using errcode = '22023';
  end if;

  select * into target
  from public.audit_shopify_runs run
  where run.id = p_run_id
    and run.shopify_domain = lower(btrim(p_shopify_domain))
    and run.state = 'running'
    and run.lease_token = p_lease_token
    and run.lease_generation = p_lease_generation
  for update;

  if not found then
    raise exception 'The audit run lease is not current.' using errcode = 'P0002';
  end if;

  will_retry := p_retryable and target.retry_count < target.max_retries;
  update public.audit_shopify_runs run
  set state = case when will_retry then 'queued' else 'failed' end,
      checkpoint = p_checkpoint,
      retry_count = run.retry_count + case when will_retry then 1 else 0 end,
      next_attempt_at = case
        when will_retry
          then v_now + make_interval(secs => p_retry_after_seconds)
        else null
      end,
      lease_token = null,
      lease_acquired_at = null,
      lease_renewed_at = null,
      lease_expires_at = null,
      error_code = normalized_error,
      failed_at = case when will_retry then null else v_now end,
      updated_at = v_now
  where run.id = target.id
  returning * into failed;

  return next failed;
end
$$;

revoke all on function public.enqueue_audit_shopify_run(
  uuid, uuid, uuid, text, text, text, text, text, integer, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.claim_audit_shopify_run(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.renew_audit_shopify_run(
  uuid, text, uuid, bigint, jsonb, integer
) from public, anon, authenticated, service_role;
revoke all on function public.yield_audit_shopify_run(
  uuid, text, uuid, bigint, jsonb, integer
) from public, anon, authenticated, service_role;
revoke all on function public.complete_audit_shopify_run(
  uuid, text, uuid, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.fail_audit_shopify_run(
  uuid, text, uuid, bigint, jsonb, text, boolean, integer
) from public, anon, authenticated, service_role;

grant execute on function public.enqueue_audit_shopify_run(
  uuid, uuid, uuid, text, text, text, text, text, integer, jsonb
) to service_role;
grant execute on function public.claim_audit_shopify_run(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.renew_audit_shopify_run(
  uuid, text, uuid, bigint, jsonb, integer
) to service_role;
grant execute on function public.yield_audit_shopify_run(
  uuid, text, uuid, bigint, jsonb, integer
) to service_role;
grant execute on function public.complete_audit_shopify_run(
  uuid, text, uuid, bigint, jsonb, jsonb
) to service_role;
grant execute on function public.fail_audit_shopify_run(
  uuid, text, uuid, bigint, jsonb, text, boolean, integer
) to service_role;
