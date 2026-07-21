-- =============================================================================
-- Dropscale IO — Client self-signup with team approval
--
-- Reverses one decision from 0001 ("there is no self-signup in the portal"):
-- anyone can now register at /register, but a fresh account cannot open the
-- dashboard until the team approves it in the admin panel.
--
-- Where the boundary actually lives
--   The layout gate in the app is a courtesy screen. The real guarantee is
--   here: a client cannot change their own approval_status, because the
--   guard trigger below rejects it regardless of which policy let the UPDATE
--   through. Approval is admin-only, enforced by the database.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- portal_clients — approval state
--
-- Added with default 'approved' so every row that already exists (created by
-- the team, back when a row *was* the approval) keeps working, then the
-- default flips to 'pending' for everyone who signs up from here on.
-- -----------------------------------------------------------------------------
alter table public.portal_clients
  add column if not exists approval_status text not null default 'approved'
    check (approval_status in ('pending', 'approved', 'rejected')),
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users (id) on delete set null;

alter table public.portal_clients alter column approval_status set default 'pending';

create index if not exists portal_clients_approval_status_idx
  on public.portal_clients (approval_status);

-- -----------------------------------------------------------------------------
-- Self-signup: create the portal_clients row once the email is confirmed.
--
-- Gated on a 'portal_signup' flag in the signup metadata rather than firing
-- for every new auth user, because this project shares its Supabase project
-- with the admin app — without the flag, every staff member registering there
-- would also become a pending portal client.
--
-- The flag is attacker-controllable (it comes from the browser), which is
-- fine: the worst it can do is create a *pending* client row, and pending
-- grants nothing. approval_status is hard-coded here, never read from
-- metadata.
--
-- Waiting for email_confirmed_at keeps the approval queue meaningful: the
-- team should only ever be asked about people who proved they own the
-- address. Two triggers because confirmation may be off (the INSERT already
-- carries a timestamp) or on (it arrives later, as an UPDATE).
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_portal_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.raw_user_meta_data ->> 'portal_signup', '') <> 'true' then
    return new;
  end if;

  if new.email_confirmed_at is null then
    return new;
  end if;

  insert into public.portal_clients (id, full_name, email, approval_status)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    'pending'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_portal on auth.users;
create trigger on_auth_user_created_portal
  after insert on auth.users
  for each row execute function public.handle_new_portal_client();

drop trigger if exists on_auth_user_confirmed_portal on auth.users;
create trigger on_auth_user_confirmed_portal
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_new_portal_client();

-- -----------------------------------------------------------------------------
-- The actual security boundary.
--
-- portal_clients_update_self (0001) lets a client update their own row so they
-- can edit their name. RLS authorises rows, not columns — without this trigger
-- a pending client could simply
--     update portal_clients set approval_status = 'approved' where id = auth.uid()
-- and let themselves in. Same pattern as guard_ad_account_status.
-- -----------------------------------------------------------------------------
create or replace function public.guard_portal_client_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Trusted contexts (SQL editor, migrations, service role) have no uid.
  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.approval_status is distinct from old.approval_status
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by then
    raise exception 'Only the team can change a client''s approval status.';
  end if;

  return new;
end;
$$;

drop trigger if exists portal_clients_guard_approval on public.portal_clients;
create trigger portal_clients_guard_approval
  before update on public.portal_clients
  for each row execute function public.guard_portal_client_approval();

-- -----------------------------------------------------------------------------
-- Everything a pending client owns stays invisible to them.
--
-- A pending client has a portal_clients row, so the 0001 policies would let
-- them read their own ad_accounts. Nothing is attached to a brand-new account
-- yet, but tightening it here means "pending" is a real state in the database
-- and not just a screen the app happens to render.
-- -----------------------------------------------------------------------------
create or replace function public.is_approved_client()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.portal_clients c
    where c.id = auth.uid()
      and c.approval_status = 'approved'
  );
$$;

drop policy if exists ad_accounts_select_own on public.ad_accounts;
create policy ad_accounts_select_own on public.ad_accounts
  for select using (
    (client_id = auth.uid() and public.is_approved_client()) or public.is_admin()
  );

drop policy if exists ad_accounts_insert_own on public.ad_accounts;
create policy ad_accounts_insert_own on public.ad_accounts
  for insert with check (
    (client_id = auth.uid() and public.is_approved_client()) or public.is_admin()
  );

drop policy if exists requests_insert_own on public.account_requests;
create policy requests_insert_own on public.account_requests
  for insert with check (
    (client_id = auth.uid() and status = 'pending' and public.is_approved_client())
    or public.is_admin()
  );
