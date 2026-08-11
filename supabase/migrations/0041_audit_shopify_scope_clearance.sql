-- =============================================================================
-- 0041 - Record Shopify's actual audit grant without blocking the connection.
--
-- The requested clearance profile is advisory evidence of what Dropscale asked
-- the merchant to grant. Shopify can omit restricted scopes or return scopes
-- added outside that profile, so completion must persist the verified grant
-- rather than requiring an exact set match.
-- =============================================================================

alter table public.audit_shopify_connections
  drop constraint if exists audit_shopify_scope_profile;

alter table public.audit_shopify_connections
  alter column scope_profile set default 'store-audit-clearance-v2';

-- An unconsumed invitation should show the clearance profile the merchant is
-- currently being asked to configure. Completed/revoked v1 rows remain intact
-- as historical evidence of the profile used when they were connected.
update public.audit_shopify_connections
set scope_profile = 'store-audit-clearance-v2',
    failed_attempts = case
      when last_error_code in ('missing_scopes', 'extra_scopes_not_allowed') then 0
      else failed_attempts
    end,
    last_attempt_at = case
      when last_error_code in ('missing_scopes', 'extra_scopes_not_allowed') then null
      else last_attempt_at
    end,
    last_error_code = case
      when last_error_code in ('missing_scopes', 'extra_scopes_not_allowed') then null
      else last_error_code
    end,
    updated_at = now()
where status = 'pending';

alter table public.audit_shopify_connections
  add constraint audit_shopify_scope_profile check (
    scope_profile in ('store-audit-full-v1', 'store-audit-clearance-v2')
  );

comment on column public.audit_shopify_connections.scope_profile is
  'Requested audit permission profile. granted_scopes stores Shopify''s actual verified grant.';

-- Complete the invite atomically after the application server has exchanged
-- credentials with Shopify and verified the canonical shop. Missing or extra
-- scopes are evidence for audit capability, not a reason to reject an otherwise
-- valid merchant-authorised connection.
create or replace function public.complete_audit_shopify_connection(
  p_connection_id uuid,
  p_token_hash text,
  p_shopify_shop_id text,
  p_shopify_name text,
  p_shopify_domain text,
  p_primary_domain text,
  p_shopify_currency text,
  p_shopify_client_id text,
  p_credential_hint text,
  p_granted_scopes text[],
  p_client_secret_ciphertext text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.audit_shopify_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can complete an audit connection.'
      using errcode = '42501';
  end if;

  select * into target
  from public.audit_shopify_connections
  where id = p_connection_id
  for update;

  if not found
    or target.status <> 'pending'
    or target.invite_token_hash is distinct from p_token_hash
  then
    raise exception 'Audit invitation is not available.' using errcode = 'P0002';
  end if;

  if target.invite_expires_at <= now() then
    raise exception 'Audit invitation expired.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = target.created_by and profile.role = 'admin'
  ) then
    raise exception 'The invitation owner is no longer an admin.'
      using errcode = '42501';
  end if;

  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or coalesce(p_shopify_currency, '') !~ '^[A-Z]{3}$'
    or length(btrim(coalesce(p_shopify_shop_id, ''))) = 0
    or length(btrim(coalesce(p_shopify_name, ''))) = 0
    or length(btrim(coalesce(p_shopify_client_id, ''))) = 0
    or length(btrim(coalesce(p_credential_hint, ''))) = 0
    or length(btrim(coalesce(p_client_secret_ciphertext, ''))) = 0
  then
    raise exception 'Verified Shopify metadata is incomplete.' using errcode = '22023';
  end if;

  insert into public.audit_shopify_credentials (
    connection_id, client_secret_ciphertext, updated_at
  ) values (
    target.id, p_client_secret_ciphertext, now()
  );

  update public.audit_shopify_connections
  set status = 'connected',
      invite_token_hash = null,
      invite_expires_at = null,
      shopify_shop_id = btrim(p_shopify_shop_id),
      shopify_name = btrim(p_shopify_name),
      shopify_domain = lower(btrim(p_shopify_domain)),
      primary_domain = nullif(lower(btrim(coalesce(p_primary_domain, ''))), ''),
      shopify_currency = upper(btrim(p_shopify_currency)),
      shopify_client_id = btrim(p_shopify_client_id),
      credential_hint = btrim(p_credential_hint),
      granted_scopes = (
        select coalesce(
          array_agg(normalized.scope order by normalized.scope),
          '{}'::text[]
        )
        from (
          select distinct lower(btrim(raw_scope)) as scope
          from unnest(coalesce(p_granted_scopes, '{}'::text[])) raw(raw_scope)
          where raw_scope is not null
            and lower(btrim(raw_scope)) ~ '^[a-z][a-z0-9_]*$'
        ) normalized
      ),
      connected_at = now(),
      last_verified_at = now(),
      reviewed_at = null,
      reviewed_by = null,
      last_error_code = null,
      updated_at = now()
  where id = target.id;

  insert into public.audit_shopify_connection_events (
    connection_id, event_type, actor_type,
    details
  ) values (
    target.id, 'store_connected', 'invite',
    jsonb_build_object('shopify_domain', lower(btrim(p_shopify_domain)))
  );

  return target.id;
exception
  when unique_violation then
    raise exception 'This Shopify store already has an active audit connection.'
      using errcode = '23505';
end
$$;

revoke all on function public.complete_audit_shopify_connection(
  uuid, text, text, text, text, text, text, text, text, text[], text
) from public, anon, authenticated;
grant execute on function public.complete_audit_shopify_connection(
  uuid, text, text, text, text, text, text, text, text, text[], text
) to service_role;
