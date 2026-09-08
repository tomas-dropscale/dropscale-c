-- 0099 - Cancelling an onboarding link stops being impossible once one of the
-- assets it delivered is live.
--
-- "Cancel link" revokes the invitation AND every connection made through it.
-- That was safe while a session's assets only became usable after the session
-- itself was activated: an open link could never own live infrastructure.
-- The post-cutover "add assets" flow broke that assumption. A client can
-- deliver one asset through a link, we stage and promote it into reporting,
-- and the link stays open waiting for the OTHER asset it asked for. Cancelling
-- then tried to withdraw a store that a live anchor was reporting through:
-- guard_bound_client_asset_mapping and guard_bound_shopify_connection_identity
-- refused (23514) and the whole cancellation aborted. The link could never be
-- closed, and no new link could be sent for those assets
-- (Diogo e Patricia, session 50cc1a19, Amelia Bristol - 2026-09-08).
--
-- A link is an INVITATION. Cancelling it withdraws the link and any asset it
-- delivered that nothing is using yet; an asset already bound into reporting
-- (an active or staged binding) is live infrastructure and survives untouched,
-- with its credentials and its store mapping. Its row keeps pointing at the
-- cancelled session as the immutable record of how it arrived - the admin
-- lists assets by client, so it stays visible exactly as before.
--
-- The function below is 0048's text with four scoped statements; everything
-- else is byte-identical.

create or replace function public.revoke_client_onboarding_session(
  p_session_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
  was_connected boolean;
  rollout_was_v2_active boolean := false;
  surviving_session_id uuid;
  surviving_session_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can revoke onboarding.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  select * into target from public.client_onboarding_sessions
  where id = p_session_id for update;
  if not found or target.status not in ('pending', 'collecting') then
    raise exception 'Only an open onboarding session can be revoked.' using errcode = 'P0002';
  end if;
  if target.target_client_id is not null then
    select operational_surface = 'v2_active'
    into rollout_was_v2_active
    from public.client_rollout_states
    where client_id = target.target_client_id
    for update;
    rollout_was_v2_active := coalesce(rollout_was_v2_active, false);
  end if;
  was_connected := exists (
    select 1 from public.client_shopify_connections connection
    where connection.session_id = target.id
      and connection.status = 'connected'
      and not exists (
        select 1 from public.client_reporting_bindings binding
        where binding.shopify_connection_id = connection.id
          and binding.status in ('staged', 'active')
      )
  ) or exists (
    select 1 from public.client_google_ads_connections connection
    where connection.session_id = target.id
      and connection.status = 'connected'
      and not exists (
        select 1 from public.client_reporting_bindings binding
        where binding.google_ads_connection_id = connection.id
          and binding.status in ('staged', 'active')
      )
  );

  delete from public.client_shopify_credentials
  where connection_id in (
    select connection.id from public.client_shopify_connections connection
    where connection.session_id = target.id
      and not exists (
        select 1 from public.client_reporting_bindings binding
        where binding.shopify_connection_id = connection.id
          and binding.status in ('staged', 'active')
      )
  );
  delete from public.client_asset_mappings existing_mapping
  where (
    exists (
      select 1
      from public.client_shopify_connections shopify_connection
      where shopify_connection.id = existing_mapping.shopify_connection_id
        and shopify_connection.session_id = target.id
    ) or exists (
      select 1
      from public.client_google_ads_connections google_connection
      where google_connection.id = existing_mapping.google_ads_connection_id
        and google_connection.session_id = target.id
    )
  )
  and not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.status in ('staged', 'active')
      and (
        binding.shopify_connection_id = existing_mapping.shopify_connection_id
        or binding.google_ads_connection_id = existing_mapping.google_ads_connection_id
      )
  );
  delete from public.client_onboarding_secrets where session_id = target.id;
  update public.client_shopify_connections
  set status = 'revoked', credential_hint = null, revoked_at = now(), updated_at = now()
  where session_id = target.id and status = 'connected'
    and not exists (
      select 1 from public.client_reporting_bindings binding
      where binding.shopify_connection_id = client_shopify_connections.id
        and binding.status in ('staged', 'active')
    );
  update public.client_google_ads_connections
  set status = 'revoked', revoked_at = now(), updated_at = now()
  where session_id = target.id and status = 'connected'
    and not exists (
      select 1 from public.client_reporting_bindings binding
      where binding.google_ads_connection_id = client_google_ads_connections.id
        and binding.status in ('staged', 'active')
    );
  update public.client_onboarding_sessions
  set status = 'revoked', invite_token_hash = null, invite_expires_at = null,
      revoked_at = now(), updated_at = now()
  where id = target.id;

  if target.target_client_id is not null then
    select session.id, session.status
    into surviving_session_id, surviving_session_status
    from public.client_onboarding_sessions session
    where session.status <> 'revoked'
      and (
        session.target_client_id = target.target_client_id
        or session.claimed_user_id = target.target_client_id
      )
    order by
      case when session.status in ('pending', 'collecting') then 0 else 1 end,
      session.created_at desc,
      session.id desc
    limit 1;

    update public.client_rollout_states
    set operational_surface = case
          when rollout_was_v2_active then 'v2_active'
          when surviving_session_status = 'active' then 'v2_active'
          when surviving_session_status in ('submitted', 'reviewed')
            then 'v2_ready_for_cutover'
          when surviving_session_status in ('pending', 'collecting')
            then 'v2_onboarding'
          else 'legacy_only'
        end,
        onboarding_session_id = surviving_session_id,
        updated_by = p_admin_id,
        updated_at = now()
    where client_id = target.target_client_id;
  end if;
  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id
  ) values (
    target.id,
    case when was_connected then 'connections_revoked' else 'invitation_revoked' end,
    'admin', p_admin_id
  );
  return target.id;
end
$$;

revoke all on function public.revoke_client_onboarding_session(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_client_onboarding_session(uuid, uuid)
  to service_role;
