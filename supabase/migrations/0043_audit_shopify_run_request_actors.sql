-- =============================================================================
-- 0043 - Distinguish human admin requests from machine-triggered audit runs.
--
-- `requested_by` remains the accountable admin sponsor for every run. The
-- separate actor type records whether that request was made in an authenticated
-- browser session or by an authorised machine path. System events deliberately
-- have no actor profile so the audit trail never impersonates the sponsor.
-- =============================================================================

alter table public.audit_shopify_runs
  add column requested_actor_type text not null default 'admin';

alter table public.audit_shopify_runs
  add constraint audit_shopify_runs_requested_actor_type_value
  check (requested_actor_type in ('admin', 'system'));

comment on column public.audit_shopify_runs.requested_actor_type is
  'Originating actor class: admin for browser requests, system for authorised machine requests; requested_by remains the admin sponsor.';

-- Replace the original ten-argument function instead of leaving an overload.
-- The trailing default preserves existing browser callers while machine callers
-- must explicitly select the system actor.
revoke all on function public.enqueue_audit_shopify_run(
  uuid, uuid, uuid, text, text, text, text, text, integer, jsonb
) from public, anon, authenticated, service_role;
drop function public.enqueue_audit_shopify_run(
  uuid, uuid, uuid, text, text, text, text, text, integer, jsonb
);

create function public.enqueue_audit_shopify_run(
  p_run_id uuid,
  p_connection_id uuid,
  p_requested_by uuid,
  p_shopify_domain text,
  p_requested_source text,
  p_requested_note text,
  p_schema_hash text,
  p_manifest_hash text,
  p_max_retries integer default 3,
  p_checkpoint jsonb default '{}'::jsonb,
  p_actor_type text default 'admin'
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
  normalized_actor_type text := lower(btrim(coalesce(p_actor_type, '')));
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
    or normalized_actor_type not in ('admin', 'system')
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
      requested_actor_type,
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
      normalized_actor_type,
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
      if existing.requested_by is distinct from p_requested_by
        or existing.shopify_domain is distinct from canonical_domain
        or existing.requested_by is distinct from p_requested_by
        or existing.requested_actor_type is distinct from normalized_actor_type
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
      normalized_actor_type,
      case when normalized_actor_type = 'admin' then p_requested_by else null end,
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
    or existing.requested_actor_type is distinct from normalized_actor_type
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
    normalized_actor_type,
    case when normalized_actor_type = 'admin' then p_requested_by else null end,
    jsonb_build_object('run_id', existing.id, 'reused_active', true)
  );

  return existing.id;
end
$$;

revoke all on function public.enqueue_audit_shopify_run(
  uuid, uuid, uuid, text, text, text, text, text, integer, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_audit_shopify_run(
  uuid, uuid, uuid, text, text, text, text, text, integer, jsonb, text
) to service_role;
