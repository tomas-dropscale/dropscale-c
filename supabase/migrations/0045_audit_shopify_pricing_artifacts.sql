-- =============================================================================
-- 0045 - Private immutable material for the Lara compare-at price repair.
--
-- The ordinary audit run checkpoint is capped at 64 KiB and its terminal
-- artifact at 8 MiB. A complete 38k-variant before state plus recovery-only
-- inverse therefore needs a separate, bounded store. There is no R2/private
-- bucket binding in this application, so this migration uses the existing
-- service-role Supabase backend without adding a public Storage bucket, URL,
-- binding or secret.
--
-- Every row is pinned to the exact Lara connection, Shopify shop and audit
-- run. The physical content address is (run_id, digest_sha256); artifact_key is
-- an immutable, run-scoped locator. Three SECURITY DEFINER functions provide
-- the lease-bound preflight and exact-object write/read boundaries. There is
-- intentionally no update, delete, list or browser policy.
-- =============================================================================

create table public.audit_shopify_pricing_artifacts (
  run_id uuid not null
    references public.audit_shopify_runs(id) on delete restrict,
  connection_id uuid not null
    references public.audit_shopify_connections(id) on delete restrict,
  shopify_domain text not null,
  shopify_shop_id text not null,
  artifact_key text not null,
  digest_sha256 text not null,
  byte_length integer not null,
  canonical_json text not null,
  created_at timestamptz not null default clock_timestamp(),

  constraint audit_shopify_pricing_artifacts_pkey
    primary key (run_id, digest_sha256),
  constraint audit_shopify_pricing_artifacts_run_key_unique
    unique (run_id, artifact_key),
  constraint audit_shopify_pricing_artifacts_lara_pin check (
    connection_id = 'a023c7e2-a96b-4f04-bc6e-0165e23332c3'::uuid
    and shopify_domain = 'jwmtjg-fm.myshopify.com'
    and shopify_shop_id = 'gid://shopify/Shop/95462097276'
  ),
  constraint audit_shopify_pricing_artifacts_digest_shape check (
    digest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint audit_shopify_pricing_artifacts_key_shape check (
    artifact_key = lower(artifact_key)
    and length(artifact_key) between 3 and 500
    and artifact_key !~ '\.\.'
    and artifact_key =
      'lara-pricing/lara-pricing-sale-repair.v1/' || run_id::text ||
      case
        when artifact_key ~ '/root\.json$' then '/root.json'
        else substring(artifact_key from '(/products/[0-9]{4}\.json)$')
      end
    and artifact_key ~
      '^lara-pricing/lara-pricing-sale-repair\.v1/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(root\.json|products/[0-9]{4}\.json)$'
  ),
  constraint audit_shopify_pricing_artifacts_byte_shape check (
    byte_length = octet_length(canonical_json)
    and (
      (
        artifact_key ~ '/products/[0-9]{4}\.json$'
        and byte_length between 1 and 2097152
      )
      or (
        artifact_key ~ '/root\.json$'
        and byte_length between 1 and 4194304
      )
    )
  ),
  constraint audit_shopify_pricing_artifacts_json_safe check (
    public.audit_shopify_json_is_safe(canonical_json::jsonb, 4194304)
  ),
  constraint audit_shopify_pricing_artifacts_schema_shape check (
    canonical_json::jsonb ->> 'schemaVersion' is not distinct from
      'lara-pricing-sale-repair.v1'
    and (
      (
        artifact_key ~ '/products/[0-9]{4}\.json$'
        and canonical_json::jsonb ->> 'kind' is not distinct from
          'catalogue_product_partition'
      )
      or (
        artifact_key ~ '/root\.json$'
        and canonical_json::jsonb ->> 'kind' is not distinct from
          'persisted_plan_root'
        and canonical_json::jsonb #>> '{shop,domain}' is not distinct from
          'jwmtjg-fm.myshopify.com'
        and canonical_json::jsonb #>> '{shop,shopId}' is not distinct from
          'gid://shopify/Shop/95462097276'
        and canonical_json::jsonb #>> '{vendorPolicy,mutationsAllowed}'
          is not distinct from
          'false'
      )
    )
  )
);

comment on table public.audit_shopify_pricing_artifacts is
  'Service-only, content-addressed and immutable full before/inverse partitions for the pinned Lara compare-at repair; no public URLs or browser access.';
comment on column public.audit_shopify_pricing_artifacts.canonical_json is
  'Exact canonical UTF-8 JSON bytes covered by digest_sha256 and byte_length; maximum 2 MiB per product partition or 4 MiB for the root.';

create index audit_shopify_pricing_artifacts_run_created_idx
  on public.audit_shopify_pricing_artifacts (run_id, created_at, artifact_key);

-- Service-only preflight. The pricing runner calls this after claiming and
-- before it starts any Shopify bulk query or write. That prevents an app
-- publication racing ahead of this migration from touching Shopify and only
-- discovering the missing private store after the source query completes.
create function public.assert_audit_shopify_pricing_artifact_store_ready(
  p_run_id uuid,
  p_connection_id uuid,
  p_shopify_domain text,
  p_shopify_shop_id text,
  p_lease_token uuid,
  p_lease_generation bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the pricing repair service can preflight artifacts.'
      using errcode = '42501';
  end if;

  if p_connection_id is distinct from
      'a023c7e2-a96b-4f04-bc6e-0165e23332c3'::uuid
    or lower(btrim(coalesce(p_shopify_domain, ''))) <>
      'jwmtjg-fm.myshopify.com'
    or btrim(coalesce(p_shopify_shop_id, '')) <>
      'gid://shopify/Shop/95462097276'
    or p_lease_token is null
    or p_lease_generation is null
    or p_lease_generation <= 0
    or not exists (
      select 1
      from public.audit_shopify_runs run
      join public.audit_shopify_connections connection
        on connection.id = run.connection_id
      where run.id = p_run_id
        and run.connection_id = p_connection_id
        and run.shopify_domain = lower(btrim(p_shopify_domain))
        and run.state = 'running'
        and run.lease_token = p_lease_token
        and run.lease_generation = p_lease_generation
        and run.lease_expires_at > clock_timestamp()
        and connection.status = 'connected'
        and connection.shopify_domain = run.shopify_domain
        and connection.shopify_shop_id = btrim(p_shopify_shop_id)
    )
  then
    raise exception 'The pricing artifact preflight pin is not current.'
      using errcode = 'P0002';
  end if;

  return true;
end
$$;

alter table public.audit_shopify_pricing_artifacts enable row level security;
revoke all on table public.audit_shopify_pricing_artifacts
  from public, anon, authenticated, service_role;

-- Create-if-absent under the exact current run lease. Locking the run row
-- serializes the fixed object-count and total-byte quotas. Replaying the same
-- key is accepted only when every pin and every byte is identical.
create function public.put_audit_shopify_pricing_artifact(
  p_run_id uuid,
  p_connection_id uuid,
  p_shopify_domain text,
  p_shopify_shop_id text,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_artifact_key text,
  p_digest_sha256 text,
  p_byte_length integer,
  p_canonical_json text
)
returns table (
  artifact_key text,
  digest_sha256 text,
  byte_length integer,
  canonical_json text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_run public.audit_shopify_runs%rowtype;
  existing public.audit_shopify_pricing_artifacts%rowtype;
  existing_count integer;
  existing_bytes bigint;
  normalized_domain text := lower(btrim(coalesce(p_shopify_domain, '')));
  normalized_key text := lower(btrim(coalesce(p_artifact_key, '')));
  normalized_digest text := lower(btrim(coalesce(p_digest_sha256, '')));
  payload jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the pricing repair service can persist an artifact.'
      using errcode = '42501';
  end if;

  begin
    payload := p_canonical_json::jsonb;
  exception
    when others then
      raise exception 'Invalid immutable pricing artifact.'
        using errcode = '22023';
  end;

  if p_run_id is null
    or p_connection_id is distinct from
      'a023c7e2-a96b-4f04-bc6e-0165e23332c3'::uuid
    or normalized_domain <> 'jwmtjg-fm.myshopify.com'
    or btrim(coalesce(p_shopify_shop_id, '')) <>
      'gid://shopify/Shop/95462097276'
    or p_lease_token is null
    or p_lease_generation is null
    or p_lease_generation <= 0
    or normalized_key <> coalesce(p_artifact_key, '')
    or normalized_key !~
      ('^lara-pricing/lara-pricing-sale-repair\.v1/' ||
       p_run_id::text || '/(root\.json|products/[0-9]{4}\.json)$')
    or normalized_digest !~ '^[0-9a-f]{64}$'
    or normalized_digest <> coalesce(p_digest_sha256, '')
    or p_byte_length is null
    or p_byte_length <> octet_length(p_canonical_json)
    or not public.audit_shopify_json_is_safe(payload, 4194304)
    or payload ->> 'schemaVersion' is distinct from
      'lara-pricing-sale-repair.v1'
    or (
      normalized_key ~ '/products/[0-9]{4}\.json$'
      and (
        p_byte_length > 2097152
        or payload ->> 'kind' is distinct from
          'catalogue_product_partition'
      )
    )
    or (
      normalized_key ~ '/root\.json$'
      and (
        p_byte_length > 4194304
        or payload ->> 'kind' is distinct from 'persisted_plan_root'
        or payload #>> '{shop,domain}' is distinct from
          'jwmtjg-fm.myshopify.com'
        or payload #>> '{shop,shopId}' is distinct from
          'gid://shopify/Shop/95462097276'
        or payload #>> '{vendorPolicy,mutationsAllowed}' is distinct from
          'false'
      )
    )
  then
    raise exception 'Invalid immutable pricing artifact.'
      using errcode = '22023';
  end if;

  select run.* into target_run
  from public.audit_shopify_runs run
  where run.id = p_run_id
  for update;

  if not found
    or target_run.connection_id is distinct from p_connection_id
    or target_run.shopify_domain is distinct from normalized_domain
    or target_run.state <> 'running'
    or target_run.lease_token is distinct from p_lease_token
    or target_run.lease_generation is distinct from p_lease_generation
    or target_run.lease_expires_at <= clock_timestamp()
    or not exists (
      select 1
      from public.audit_shopify_connections connection
      where connection.id = p_connection_id
        and connection.status = 'connected'
        and connection.shopify_domain = normalized_domain
        and connection.shopify_shop_id = btrim(p_shopify_shop_id)
    )
  then
    raise exception 'The immutable pricing artifact run pin is not current.'
      using errcode = 'P0002';
  end if;

  select artifact.* into existing
  from public.audit_shopify_pricing_artifacts artifact
  where artifact.run_id = p_run_id
    and (
      artifact.artifact_key = normalized_key
      or artifact.digest_sha256 = normalized_digest
    )
  for share;

  if found then
    if existing.connection_id is distinct from p_connection_id
      or existing.shopify_domain is distinct from normalized_domain
      or existing.shopify_shop_id is distinct from btrim(p_shopify_shop_id)
      or existing.artifact_key is distinct from normalized_key
      or existing.digest_sha256 is distinct from normalized_digest
      or existing.byte_length is distinct from p_byte_length
      or existing.canonical_json is distinct from p_canonical_json
    then
      raise exception 'Immutable pricing artifact collision.'
        using errcode = '23505';
    end if;

    return query
      select existing.artifact_key, existing.digest_sha256,
        existing.byte_length, existing.canonical_json;
    return;
  end if;

  select count(*)::integer, coalesce(sum(artifact.byte_length), 0)::bigint
    into existing_count, existing_bytes
  from public.audit_shopify_pricing_artifacts artifact
  where artifact.run_id = p_run_id;

  if existing_count >= 2001
    or existing_bytes + p_byte_length > 134217728
  then
    raise exception 'Immutable pricing artifact run quota exceeded.'
      using errcode = '54000';
  end if;

  insert into public.audit_shopify_pricing_artifacts (
    run_id,
    connection_id,
    shopify_domain,
    shopify_shop_id,
    artifact_key,
    digest_sha256,
    byte_length,
    canonical_json
  ) values (
    p_run_id,
    p_connection_id,
    normalized_domain,
    btrim(p_shopify_shop_id),
    normalized_key,
    normalized_digest,
    p_byte_length,
    p_canonical_json
  );

  -- Deliberate read-after-write from the stored row, rather than echoing the
  -- arguments, so the service adapter can hash and compare durable bytes.
  return query
    select artifact.artifact_key, artifact.digest_sha256,
      artifact.byte_length, artifact.canonical_json
    from public.audit_shopify_pricing_artifacts artifact
    where artifact.run_id = p_run_id
      and artifact.artifact_key = normalized_key
      and artifact.digest_sha256 = normalized_digest;
end
$$;

-- Read one exact run-scoped locator under the current lease, or after the run
-- has reached a lease-free terminal state with the same final generation.
-- Terminal access preserves the recovery/audit value of the inverse even if
-- the Shopify connection is later revoked. There is no list RPC, so a service
-- caller must already hold a sealed artifact reference.
create function public.get_audit_shopify_pricing_artifact(
  p_run_id uuid,
  p_connection_id uuid,
  p_shopify_domain text,
  p_shopify_shop_id text,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_artifact_key text
)
returns table (
  artifact_key text,
  digest_sha256 text,
  byte_length integer,
  canonical_json text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_domain text := lower(btrim(coalesce(p_shopify_domain, '')));
  normalized_key text := lower(btrim(coalesce(p_artifact_key, '')));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the pricing repair service can read an artifact.'
      using errcode = '42501';
  end if;

  if p_run_id is null
    or p_connection_id is distinct from
      'a023c7e2-a96b-4f04-bc6e-0165e23332c3'::uuid
    or normalized_domain <> 'jwmtjg-fm.myshopify.com'
    or btrim(coalesce(p_shopify_shop_id, '')) <>
      'gid://shopify/Shop/95462097276'
    or p_lease_token is null
    or p_lease_generation is null
    or p_lease_generation <= 0
    or normalized_key <> coalesce(p_artifact_key, '')
    or normalized_key !~
      ('^lara-pricing/lara-pricing-sale-repair\.v1/' ||
       p_run_id::text || '/(root\.json|products/[0-9]{4}\.json)$')
  then
    raise exception 'Invalid immutable pricing artifact read.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.audit_shopify_runs run
    join public.audit_shopify_connections connection
      on connection.id = run.connection_id
    where run.id = p_run_id
      and run.connection_id = p_connection_id
      and run.shopify_domain = normalized_domain
      and connection.shopify_domain = normalized_domain
      and connection.shopify_shop_id = btrim(p_shopify_shop_id)
      and (
        (
          run.state = 'running'
          and run.lease_token = p_lease_token
          and run.lease_generation = p_lease_generation
          and run.lease_expires_at > clock_timestamp()
          and connection.status = 'connected'
        )
        or (
          run.state in ('completed', 'failed')
          and run.lease_token is null
          and run.lease_generation = p_lease_generation
          and connection.status in ('connected', 'revoked')
        )
      )
  ) then
    raise exception 'The immutable pricing artifact run pin is not current.'
      using errcode = 'P0002';
  end if;

  return query
    select artifact.artifact_key, artifact.digest_sha256,
      artifact.byte_length, artifact.canonical_json
    from public.audit_shopify_pricing_artifacts artifact
    where artifact.run_id = p_run_id
      and artifact.connection_id = p_connection_id
      and artifact.shopify_domain = normalized_domain
      and artifact.shopify_shop_id = btrim(p_shopify_shop_id)
      and artifact.artifact_key = normalized_key;

  if not found then
    raise exception 'Immutable pricing artifact not found.'
      using errcode = 'P0002';
  end if;
end
$$;

revoke all on function public.put_audit_shopify_pricing_artifact(
  uuid, uuid, text, text, uuid, bigint, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.put_audit_shopify_pricing_artifact(
  uuid, uuid, text, text, uuid, bigint, text, text, integer, text
) to service_role;

revoke all on function public.get_audit_shopify_pricing_artifact(
  uuid, uuid, text, text, uuid, bigint, text
) from public, anon, authenticated, service_role;
grant execute on function public.get_audit_shopify_pricing_artifact(
  uuid, uuid, text, text, uuid, bigint, text
) to service_role;

revoke all on function public.assert_audit_shopify_pricing_artifact_store_ready(
  uuid, uuid, text, text, uuid, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.assert_audit_shopify_pricing_artifact_store_ready(
  uuid, uuid, text, text, uuid, bigint
) to service_role;
