-- Remove a legacy Shopify credential without deleting or otherwise changing
-- the operational ad account that owns it. Reconnect can keep using the
-- preserved domain, client ID and scope metadata as replacement context.

create or replace function public.disconnect_legacy_shopify_connection(
  p_account_id uuid,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can disconnect a legacy Shopify asset.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;

  select id into target_id
  from public.ad_accounts
  where id = p_account_id
    and status = 'active'
    and shopify_connected is true
  for update;
  if not found then
    raise exception 'Active legacy Shopify connection not found.' using errcode = 'P0002';
  end if;

  update public.ad_accounts
  set shopify_admin_token = null,
      shopify_token_last4 = null,
      shopify_connected = false,
      shopify_connected_at = null
  where id = target_id;

  return target_id;
end
$$;

revoke all on function public.disconnect_legacy_shopify_connection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.disconnect_legacy_shopify_connection(uuid, uuid)
  to service_role;
