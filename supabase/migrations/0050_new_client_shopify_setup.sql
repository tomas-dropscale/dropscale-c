-- Let a new client create only their dashboard account, connect one or more
-- Shopify stores, or complete both Shopify and Google Ads onboarding.

alter table public.client_onboarding_sessions
  drop constraint client_onboarding_requested_assets_shape,
  add constraint client_onboarding_requested_assets_shape check (
    cardinality(requested_assets) between 0 and 2
    and requested_assets <@ array['shopify', 'google_ads']::text[]
    and (
      (
        mode = 'new_client'
        and (
          cardinality(requested_assets) = 0
          or requested_assets = array['shopify']::text[]
          or (
            cardinality(requested_assets) = 2
            and requested_assets @> array['shopify', 'google_ads']::text[]
          )
        )
      )
      or (
        mode = 'add_assets'
        and (
          cardinality(requested_assets) = 1
          or (
            cardinality(requested_assets) = 2
            and requested_assets @> array['shopify', 'google_ads']::text[]
          )
        )
      )
      or (mode = 'reconnect' and requested_assets = array['shopify']::text[])
    )
  );

create or replace function public.create_client_onboarding_invitation(
  p_session_id uuid,
  p_mode text,
  p_requested_assets text[],
  p_target_client_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can create an onboarding invitation.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_created_by and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_session_id is null
    or p_mode not in ('new_client', 'add_assets')
    or p_requested_assets is null
    or cardinality(p_requested_assets) not between 0 and 2
    or not p_requested_assets <@ array['shopify', 'google_ads']::text[]
    or (cardinality(p_requested_assets) = 0 and p_mode <> 'new_client')
    or (
      p_mode = 'new_client'
      and cardinality(p_requested_assets) = 1
      and p_requested_assets <> array['shopify']::text[]
    )
    or (
      cardinality(p_requested_assets) = 2
      and not p_requested_assets @> array['shopify', 'google_ads']::text[]
    )
    or coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at <= now()
    or p_expires_at > now() + interval '8 days'
    or (p_mode = 'new_client' and p_target_client_id is not null)
    or (p_mode = 'add_assets' and p_target_client_id is null)
  then
    raise exception 'Invalid client onboarding invitation.' using errcode = '22023';
  end if;
  if p_target_client_id is not null and not exists (
    select 1 from public.portal_clients where id = p_target_client_id
  ) then
    raise exception 'Target client not found.' using errcode = 'P0002';
  end if;

  insert into public.client_onboarding_sessions (
    id, mode, requested_assets, target_client_id, invite_token_hash,
    invite_expires_at, created_by
  ) values (
    p_session_id, p_mode,
    coalesce(
      (select array_agg(asset order by asset) from unnest(p_requested_assets) asset),
      '{}'::text[]
    ),
    p_target_client_id, p_token_hash, p_expires_at, p_created_by
  );

  if p_target_client_id is not null then
    insert into public.client_rollout_states (
      client_id, operational_surface, onboarding_session_id, updated_by
    ) values (
      p_target_client_id, 'v2_onboarding', p_session_id, p_created_by
    ) on conflict (client_id) do update
      set operational_surface = case
            when client_rollout_states.operational_surface = 'v2_active'
              then 'v2_active'
            else 'v2_onboarding'
          end,
          onboarding_session_id = excluded.onboarding_session_id,
          updated_by = excluded.updated_by,
          updated_at = now();
  end if;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    p_session_id, 'invitation_created', 'admin', p_created_by,
    jsonb_build_object('mode', p_mode, 'requested_assets', p_requested_assets)
  );
  return p_session_id;
end
$$;

revoke all on function public.create_client_onboarding_invitation(
  uuid, text, text[], uuid, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.create_client_onboarding_invitation(
  uuid, text, text[], uuid, text, timestamptz, uuid
) to service_role;
