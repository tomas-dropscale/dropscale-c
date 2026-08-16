-- A successful exact-store reconnect is the final client action. Consume its
-- bearer in the same transaction instead of leaving a verified link open
-- until the client clicks a redundant Submit button.

create or replace function public.finalize_verified_shopify_reconnect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_onboarding_sessions%rowtype;
begin
  select * into target
  from public.client_onboarding_sessions session
  where session.id = new.session_id
  for update;

  if not found
    or target.mode <> 'reconnect'
    or target.status <> 'collecting'
    or target.reconnect_completed_at is null
    or target.claimed_user_id is null
    or new.actor_type <> 'invite'
    or new.actor_id is distinct from target.claimed_user_id
  then
    return new;
  end if;

  perform public.submit_client_onboarding_session(
    target.id,
    target.invite_token_hash
  );
  return new;
end
$$;

revoke all on function public.finalize_verified_shopify_reconnect()
  from public, anon, authenticated, service_role;

drop trigger if exists client_onboarding_finalizes_verified_shopify_reconnect
  on public.client_onboarding_events;
create trigger client_onboarding_finalizes_verified_shopify_reconnect
  after insert on public.client_onboarding_events
  for each row
  when (new.event_type = 'shopify_connected')
  execute function public.finalize_verified_shopify_reconnect();
