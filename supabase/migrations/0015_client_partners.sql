-- =============================================================================
-- 0015 — Sócios: more than one login per client workspace.
--
-- Until now a portal login WAS the workspace: every policy asked
-- `client_id = auth.uid()`, so a client's business partner had no way in short
-- of sharing a password. This migration splits the two ideas apart:
--
--   WORKSPACE  = a portal_clients row (the owner). Stores, metrics, costs and
--                invoices keep hanging off it exactly as before — no data moves.
--   MEMBERSHIP = client_members: other logins that may open that workspace.
--
-- A sócio has the SAME rights as the owner inside the workspace (see the
-- product decision: "igual ao dono") — stores, costs, connections, invoices,
-- and inviting or removing other sócios. The one thing the table makes
-- structurally impossible is removing the owner, who is not a row in it.
--
-- Everything below funnels through two predicates, which is why the blast
-- radius is small: is_client_member() replaces `client_id = auth.uid()`, and
-- owns_ad_account() — already the gate for campaigns, creatives, daily_metrics
-- and the whole COGS chain — is rewritten once, so those tables follow for free.
--
-- No service role is involved anywhere: invites are matched by email inside a
-- SECURITY DEFINER function the invitee calls on their own session.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- client_members — partners only. The owner is NOT a row here.
--
-- Deliberately no `role` column: a sócio is a co-owner, and a column nothing
-- ever checks is worse than no column at all. If levels are ever wanted, that
-- is the migration that adds it, together with the checks that read it.
-- -----------------------------------------------------------------------------
create table if not exists public.client_members (
  -- The workspace: the OWNER's portal_clients row.
  client_id uuid not null references public.portal_clients (id) on delete cascade,
  -- The partner's own portal login.
  member_id uuid not null references public.portal_clients (id) on delete cascade,
  invited_by uuid references public.portal_clients (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (client_id, member_id),
  -- The owner cannot be their own partner.
  constraint client_members_not_self check (client_id <> member_id)
);

create index if not exists client_members_member_idx
  on public.client_members (member_id);

-- -----------------------------------------------------------------------------
-- client_invites — an invitation by EMAIL, because the inviter cannot look up
-- other people's auth accounts (and this stack has no service-role key in the
-- request path). The invitee turns it into a membership themselves, by calling
-- accept_client_invites() on their own session.
--
-- Revoking is a DELETE, so `status` only ever moves pending → accepted.
-- -----------------------------------------------------------------------------
create table if not exists public.client_invites (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients (id) on delete cascade,
  email text not null,
  invited_by uuid references public.portal_clients (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references public.portal_clients (id) on delete set null
);

-- One live invite per address per workspace; accepted rows stay as history.
create unique index if not exists client_invites_pending_uq
  on public.client_invites (client_id, lower(email))
  where status = 'pending';

create index if not exists client_invites_email_idx
  on public.client_invites (lower(email)) where status = 'pending';

-- =============================================================================
-- The two predicates everything else is built on
-- =============================================================================

-- Owner or partner of this workspace?
--
-- SECURITY DEFINER so the lookup is not itself blocked by client_members' RLS,
-- which would otherwise recurse (its own policy calls this function).
--
-- A membership stops working the moment the AGENCY rejects that person: being
-- vouched for by a client is not a way around the agency's own door.
create or replace function public.is_client_member(p_client_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_client_id = auth.uid()
    or exists (
      select 1
      from public.client_members m
      join public.portal_clients me on me.id = m.member_id
      where m.client_id = p_client_id
        and m.member_id = auth.uid()
        and me.approval_status <> 'rejected'
    );
$$;

-- Member AND the workspace itself is approved by the team. This is what
-- replaces is_approved_client(): approval is a property of the WORKSPACE
-- (its owner), not of whoever happens to be looking at it — otherwise a
-- partner's own untouched 'pending' row would lock them out of a workspace
-- they were legitimately invited into.
create or replace function public.can_open_workspace(p_client_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_client_member(p_client_id)
    and exists (
      select 1
      from public.portal_clients c
      where c.id = p_client_id
        and c.approval_status = 'approved'
    );
$$;

-- Is this person somebody I share a workspace with (owner or fellow partner)?
-- Used only to widen portal_clients SELECT, so a team list can show names and
-- emails of the people in the workspace.
create or replace function public.shares_client_workspace(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.client_members m
    where (m.client_id = p_user_id or m.member_id = p_user_id)
      and public.is_client_member(m.client_id)
  );
$$;

-- =============================================================================
-- The chain: rewritten once, inherited by every table that hangs off an account
-- (campaigns, creative_deliveries, daily_metrics, store_products, product_costs,
--  product_cost_tiers, cogs_collections, members and their tiers).
-- =============================================================================
create or replace function public.owns_ad_account(p_ad_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.ad_accounts a
    where a.id = p_ad_account_id
      and public.is_client_member(a.client_id)
  );
$$;

create or replace function public.owns_store_product(p_product_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.store_products p
    join public.ad_accounts a on a.id = p.ad_account_id
    where p.id = p_product_id
      and public.is_client_member(a.client_id)
  );
$$;

create or replace function public.owns_cogs_collection(p_collection_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.cogs_collections c
    join public.ad_accounts a on a.id = c.ad_account_id
    where c.id = p_collection_id
      and public.is_client_member(a.client_id)
  );
$$;

-- =============================================================================
-- Policies that asked `= auth.uid()` now ask `is_client_member()`
-- =============================================================================

-- ---- portal_clients ---------------------------------------------------------
-- Widened so a workspace can render the names of the people in it. Writes are
-- untouched: you still update only your OWN row, so a partner can never rename
-- the owner or touch their Stripe customer.
drop policy if exists portal_clients_select_self on public.portal_clients;
create policy portal_clients_select_self on public.portal_clients
  for select using (
    id = auth.uid()
    or public.shares_client_workspace(id)
    or public.is_admin()
  );

-- ---- billing_profiles -------------------------------------------------------
drop policy if exists billing_select_own on public.billing_profiles;
create policy billing_select_own on public.billing_profiles
  for select using (public.is_client_member(client_id) or public.is_admin());

drop policy if exists billing_insert_own on public.billing_profiles;
create policy billing_insert_own on public.billing_profiles
  for insert with check (public.is_client_member(client_id) or public.is_admin());

drop policy if exists billing_update_own on public.billing_profiles;
create policy billing_update_own on public.billing_profiles
  for update using (public.is_client_member(client_id) or public.is_admin())
  with check (public.is_client_member(client_id) or public.is_admin());

-- ---- ad_accounts ------------------------------------------------------------
drop policy if exists ad_accounts_select_own on public.ad_accounts;
create policy ad_accounts_select_own on public.ad_accounts
  for select using (public.can_open_workspace(client_id) or public.is_admin());

drop policy if exists ad_accounts_insert_own on public.ad_accounts;
create policy ad_accounts_insert_own on public.ad_accounts
  for insert with check (public.can_open_workspace(client_id) or public.is_admin());

drop policy if exists ad_accounts_update_own on public.ad_accounts;
create policy ad_accounts_update_own on public.ad_accounts
  for update using (public.is_client_member(client_id) or public.is_admin())
  with check (public.is_client_member(client_id) or public.is_admin());

-- ---- account_requests -------------------------------------------------------
drop policy if exists requests_select_own on public.account_requests;
create policy requests_select_own on public.account_requests
  for select using (public.is_client_member(client_id) or public.is_admin());

drop policy if exists requests_insert_own on public.account_requests;
create policy requests_insert_own on public.account_requests
  for insert with check (
    (public.can_open_workspace(client_id) and status = 'pending') or public.is_admin()
  );

-- ---- invoices ---------------------------------------------------------------
-- A sócio is a co-owner: they see what the business is billed. Writes stay
-- admin/webhook-only, as before.
drop policy if exists invoices_client_read on public.invoices;
create policy invoices_client_read on public.invoices
  for select using (public.is_client_member(client_id) or public.is_admin());

-- =============================================================================
-- RLS on the two new tables
-- =============================================================================
alter table public.client_members enable row level security;
alter table public.client_invites enable row level security;

-- ---- client_members ---------------------------------------------------------
drop policy if exists client_members_select on public.client_members;
create policy client_members_select on public.client_members
  for select using (
    public.is_client_member(client_id) or member_id = auth.uid() or public.is_admin()
  );

-- Nobody inserts directly. Memberships are created by accept_client_invites(),
-- which runs SECURITY DEFINER — so the only way in is through an invite the
-- workspace actually issued, and no one can staple themselves (or a stranger)
-- onto a workspace by writing a row.
drop policy if exists client_members_insert on public.client_members;
create policy client_members_insert on public.client_members
  for insert with check (public.is_admin());

-- Any member may remove a partner, and may remove themselves (leave). The
-- owner is not in this table, so they can never be removed.
drop policy if exists client_members_delete on public.client_members;
create policy client_members_delete on public.client_members
  for delete using (
    public.is_client_member(client_id) or member_id = auth.uid() or public.is_admin()
  );

-- ---- client_invites ---------------------------------------------------------
drop policy if exists client_invites_select on public.client_invites;
create policy client_invites_select on public.client_invites
  for select using (public.is_client_member(client_id) or public.is_admin());

drop policy if exists client_invites_insert on public.client_invites;
create policy client_invites_insert on public.client_invites
  for insert with check (
    (
      public.can_open_workspace(client_id)
      and status = 'pending'
      and invited_by = auth.uid()
    )
    or public.is_admin()
  );

-- Revoke = delete. There is no update policy on purpose: status, accepted_at
-- and accepted_by are written only by accept_client_invites().
drop policy if exists client_invites_delete on public.client_invites;
create policy client_invites_delete on public.client_invites
  for delete using (public.is_client_member(client_id) or public.is_admin());

-- Normalise the address and reject invites that cannot mean anything: yourself,
-- the owner, or someone already in the workspace. Cheaper to say so at insert
-- time than to leave a pending row that can never be accepted.
create or replace function public.guard_client_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_email text;
begin
  new.email := lower(trim(new.email));

  if new.email = '' or new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That does not look like an email address.';
  end if;

  select lower(c.email) into v_owner_email
  from public.portal_clients c
  where c.id = new.client_id;

  if new.email = v_owner_email then
    raise exception 'That is the workspace owner.';
  end if;

  if exists (
    select 1
    from public.client_members m
    join public.portal_clients p on p.id = m.member_id
    where m.client_id = new.client_id
      and lower(p.email) = new.email
  ) then
    raise exception 'That person is already in this workspace.';
  end if;

  return new;
end;
$$;

drop trigger if exists client_invites_guard on public.client_invites;
create trigger client_invites_guard
  before insert on public.client_invites
  for each row execute function public.guard_client_invite();

-- =============================================================================
-- accept_client_invites — the only way a membership is ever created.
--
-- Called by the portal on the caller's own session. Matches PENDING invites
-- against the caller's CONFIRMED email, so an unverified address cannot be
-- used to walk into someone's workspace. Idempotent: running it again finds
-- nothing pending and returns 0.
-- =============================================================================
create or replace function public.accept_client_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_count integer := 0;
begin
  if auth.uid() is null then
    return 0;
  end if;

  select lower(u.email) into v_email
  from auth.users u
  where u.id = auth.uid()
    and u.email_confirmed_at is not null;

  if v_email is null then
    return 0;
  end if;

  -- The invitee must be a portal login themselves (the signup trigger creates
  -- the row). Their own approval_status is irrelevant here: the workspace they
  -- are joining is somebody else's, and it is that owner's approval that counts
  -- — but a REJECTED person is turned away, same rule as is_client_member().
  if not exists (
    select 1 from public.portal_clients c
    where c.id = auth.uid() and c.approval_status <> 'rejected'
  ) then
    return 0;
  end if;

  with matched as (
    select i.id, i.client_id, i.invited_by
    from public.client_invites i
    join public.portal_clients o
      on o.id = i.client_id and o.approval_status = 'approved'
    where i.status = 'pending'
      and lower(i.email) = v_email
      and i.client_id <> auth.uid()
  ),
  joined as (
    insert into public.client_members (client_id, member_id, invited_by)
    select m.client_id, auth.uid(), m.invited_by from matched m
    on conflict do nothing
    returning 1
  )
  update public.client_invites i
     set status = 'accepted',
         accepted_at = now(),
         accepted_by = auth.uid()
   where i.id in (select id from matched);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.accept_client_invites() to authenticated;

-- =============================================================================
-- set_workspace_stripe_customer — the one write a sócio needs on somebody
-- else's portal_clients row.
--
-- portal_clients UPDATE stays `id = auth.uid()`: widening it to the workspace
-- would also let a sócio rename the owner or edit their identity. Saving a card
-- needs exactly one column, exactly once, so it gets exactly that — a function
-- that writes stripe_customer_id and only while it is still null, so it can
-- never repoint an existing customer at another Stripe account.
-- =============================================================================
create or replace function public.set_workspace_stripe_customer(
  p_client_id uuid,
  p_customer_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_client_member(p_client_id) then
    raise exception 'Not a member of that workspace.';
  end if;

  update public.portal_clients
     set stripe_customer_id = p_customer_id
   where id = p_client_id
     and stripe_customer_id is null;
end;
$$;

grant execute on function public.set_workspace_stripe_customer(uuid, text) to authenticated;
