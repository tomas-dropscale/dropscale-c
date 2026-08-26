-- =============================================================================
-- 0086 - Let the team name a Google Ads account.
--
-- account_name holds what Windsor reported, and Windsor only knows a name once
-- it has one to give. Three connected accounts carry their own customer id as
-- their name because the workspace inventory answered with an empty string, so
-- the Clients page prints the same ten digits twice and the accounts cannot be
-- told apart.
--
-- The team's name lives in its own column instead of overwriting account_name.
-- Every Windsor write path -- a reconnect, a retry inside the same session --
-- sets account_name from what it just read, so a name written there would be
-- reverted without a word the next time the client reconnects. Kept apart,
-- Windsor keeps its record and the team's name keeps winning.
--
-- Deliberately cosmetic: nothing here touches the canonical customer id, the
-- reporting identity, bindings or billing. Renaming an account never changes
-- which account it is.
-- =============================================================================

alter table public.client_google_ads_connections
  add column if not exists admin_label text,
  add column if not exists admin_label_set_by uuid references public.profiles(id),
  add column if not exists admin_label_set_at timestamptz;

-- A label and its authorship move together: a name with no author would leave
-- no way to tell a deliberate rename from a stray write.
alter table public.client_google_ads_connections
  drop constraint if exists client_google_ads_connections_admin_label_shape;
alter table public.client_google_ads_connections
  add constraint client_google_ads_connections_admin_label_shape check (
    (
      admin_label is null
      and admin_label_set_by is null
      and admin_label_set_at is null
    )
    or (
      admin_label = btrim(admin_label)
      and length(admin_label) between 1 and 80
      and admin_label !~ '[[:cntrl:]]'
      and admin_label_set_by is not null
      and admin_label_set_at is not null
    )
  );

create or replace function public.set_client_google_ads_admin_label(
  p_connection_id uuid,
  p_label text,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normal_label text := nullif(btrim(coalesce(p_label, '')), '');
  target public.client_google_ads_connections%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server can name a Google Ads account.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if normal_label is not null
    and (length(normal_label) > 80 or normal_label ~ '[[:cntrl:]]')
  then
    raise exception 'Enter a name of 80 characters or fewer.' using errcode = '22023';
  end if;

  select * into target
  from public.client_google_ads_connections
  where id = p_connection_id
  for update;
  if not found then
    raise exception 'Google Ads account not found.' using errcode = 'P0002';
  end if;

  -- updated_at is deliberately left alone. The reporting projection keys its
  -- reviewed action ids on it, so bumping it here would expire the admin's
  -- open actions for a change that altered no reporting fact.
  update public.client_google_ads_connections
  set admin_label = normal_label,
      admin_label_set_by = case when normal_label is null then null else p_admin_id end,
      admin_label_set_at = case when normal_label is null then null else now() end
  where id = target.id;
  return target.id;
end
$$;

revoke all on function public.set_client_google_ads_admin_label(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.set_client_google_ads_admin_label(uuid, text, uuid)
  to service_role;
