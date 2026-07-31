-- =============================================================================
-- 0022 — affiliates: a client who brings a client pays us less.
--
-- The deal: every client has a code. Someone registering can type it. The
-- person who OWNS the code — the existing client — drops 0.5 off their
-- management fee, 10% → 9.5%, stacking per referral down to a floor. The new
-- client gets nothing and starts at the standard rate. The discount lasts while
-- the referred client is still an approved client, and disappears if they leave.
--
-- WHY commission_rate BECOMES DERIVED
--   That last rule is the whole design constraint. A discount that can vanish
--   cannot be a value somebody wrote once; it has to be recomputed from live
--   state. But `commission_rate` is read in eleven places — every dashboard, the
--   admin campaigns screen, the commission ledger and the weekly invoice
--   generator — and making all eleven subtract a discount is eleven chances to
--   disagree about what a client is charged.
--
--   So the column keeps its meaning ("what this store is billed at") and stops
--   being hand-written:
--
--     list_commission_rate  the agency's price. What the admin edits.
--     commission_rate       = max(FLOOR, list − 0.5 × active referrals),
--                             recomputed by trigger on every write.
--
--   Every existing reader is correct with no change at all, including billing.
--   And because the ledger books each day at the rate in force that day
--   (0007/0013), a discount earned today changes today forward and never
--   rewrites an invoice already sent.
-- =============================================================================

-- Percentage points removed per active referral.
create or replace function public.referral_step()
returns numeric language sql immutable as $$ select 0.5::numeric $$;

-- The fee can never fall below this, however many people a client brings.
create or replace function public.referral_floor()
returns numeric language sql immutable as $$ select 5::numeric $$;

-- -----------------------------------------------------------------------------
-- The code, and who used whose
-- -----------------------------------------------------------------------------
alter table public.portal_clients
  add column if not exists referral_code text,
  -- Who brought this client in. Null for everyone who arrived on their own.
  -- `on delete set null` so removing a portal login never rewrites somebody
  -- else's discount history by cascade.
  add column if not exists referred_by uuid references public.portal_clients (id) on delete set null;

create unique index if not exists portal_clients_referral_code_uq
  on public.portal_clients (upper(referral_code))
  where referral_code is not null;

create index if not exists portal_clients_referred_by_idx
  on public.portal_clients (referred_by) where referred_by is not null;

-- Unambiguous alphabet: no O/0 or I/1, because these get read aloud and typed
-- from a screenshot, and a code that can be transcribed wrong is a support
-- ticket about a discount that did not apply.
create or replace function public.generate_referral_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  attempt integer := 0;
begin
  loop
    candidate := '';
    for _ in 1..8 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    exit when not exists (
      select 1 from public.portal_clients where upper(referral_code) = candidate
    );

    attempt := attempt + 1;
    if attempt > 20 then
      raise exception 'Could not generate a unique referral code.';
    end if;
  end loop;

  return candidate;
end;
$$;

-- Every client has one from the moment they exist.
create or replace function public.assign_referral_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.referral_code is null then
    new.referral_code := public.generate_referral_code();
  end if;
  return new;
end;
$$;

drop trigger if exists portal_clients_referral_code on public.portal_clients;
create trigger portal_clients_referral_code
  before insert on public.portal_clients
  for each row execute function public.assign_referral_code();

-- Backfill everyone who already exists.
update public.portal_clients
set referral_code = public.generate_referral_code()
where referral_code is null;

-- -----------------------------------------------------------------------------
-- The discount
-- -----------------------------------------------------------------------------

-- How many people this client brought in who are still clients. "Still a
-- client" is approval_status = 'approved': a rejected or pending signup has
-- not become anything yet, and a client who leaves takes their 0.5 with them.
create or replace function public.active_referral_count(p_client_id uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int
  from public.portal_clients c
  where c.referred_by = p_client_id
    and c.approval_status = 'approved';
$$;

/** The rate a store is actually billed at, from its list price. */
create or replace function public.effective_commission_rate(p_client_id uuid, p_list numeric)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select greatest(
    public.referral_floor(),
    p_list - (public.referral_step() * public.active_referral_count(p_client_id))
  );
$$;

-- -----------------------------------------------------------------------------
-- ad_accounts: list price in, billed rate out
-- -----------------------------------------------------------------------------
alter table public.ad_accounts
  add column if not exists list_commission_rate numeric not null default 10
    check (list_commission_rate >= 0 and list_commission_rate <= 100);

-- Existing rows: whatever they are billed today IS their list price. Anything
-- else would silently re-price live accounts the moment this migration runs.
update public.ad_accounts
set list_commission_rate = commission_rate
where list_commission_rate is distinct from commission_rate;

-- commission_rate is now output, never input: whatever a writer puts there is
-- replaced by the derived value. That is what makes it impossible for the
-- column to drift from the rule, no matter which code path did the write.
create or replace function public.derive_commission_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.commission_rate := public.effective_commission_rate(new.client_id, new.list_commission_rate);
  return new;
end;
$$;

drop trigger if exists ad_accounts_derive_rate on public.ad_accounts;
create trigger ad_accounts_derive_rate
  before insert or update on public.ad_accounts
  for each row execute function public.derive_commission_rate();

-- The 0006 guard policed commission_rate. That column is no longer written by
-- anybody, so it polices the LIST rate instead — otherwise the admin's own edit
-- would be refused while a client could still set their own price.
create or replace function public.guard_ad_account_commission()
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
  if not public.is_admin() and (
    new.list_commission_rate is distinct from old.list_commission_rate
    or new.revenue_share_enabled is distinct from old.revenue_share_enabled
  ) then
    raise exception 'Only the team can change an account''s billing settings.';
  end if;
  return new;
end;
$$;

-- Apply the current rule to every existing row.
update public.ad_accounts set list_commission_rate = list_commission_rate;

-- -----------------------------------------------------------------------------
-- Keeping it current when referrals change
-- -----------------------------------------------------------------------------

-- Re-derive a client's stores. SECURITY DEFINER because the person whose signup
-- triggers this is not the person whose rates change, and RLS would rightly
-- refuse them. Touching list_commission_rate is enough — the BEFORE trigger
-- above recomputes from it.
create or replace function public.refresh_referrer_rates(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_client_id is null then
    return;
  end if;
  update public.ad_accounts
  set list_commission_rate = list_commission_rate
  where client_id = p_client_id;
end;
$$;

-- Fires when a referral is created, when a referred client is approved or
-- rejected, and when a referral is moved between referrers.
create or replace function public.on_referral_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.refresh_referrer_rates(new.referred_by);
    return null;
  end if;

  if new.referred_by is distinct from old.referred_by then
    perform public.refresh_referrer_rates(old.referred_by);
    perform public.refresh_referrer_rates(new.referred_by);
  elsif new.approval_status is distinct from old.approval_status then
    perform public.refresh_referrer_rates(new.referred_by);
  end if;

  return null;
end;
$$;

drop trigger if exists portal_clients_referral_changed on public.portal_clients;
create trigger portal_clients_referral_changed
  after insert or update of referred_by, approval_status on public.portal_clients
  for each row execute function public.on_referral_changed();

-- -----------------------------------------------------------------------------
-- Claiming a code
--
-- SECURITY DEFINER because the caller must be able to find a client by code
-- without being able to READ other clients — the function answers "did it
-- work", never "whose code is this".
--
-- Refuses: an unknown code, your own code, a client who already has a referrer
-- (the link is set once and never rewritten), and a referrer who is not an
-- approved client.
-- -----------------------------------------------------------------------------
create or replace function public.claim_referral_code(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_referrer uuid;
  v_existing uuid;
begin
  if auth.uid() is null then
    return 'not_signed_in';
  end if;
  if v_code = '' then
    return 'empty';
  end if;

  select referred_by into v_existing from public.portal_clients where id = auth.uid();
  if not found then
    return 'not_a_client';
  end if;
  if v_existing is not null then
    return 'already_referred';
  end if;

  select id into v_referrer
  from public.portal_clients
  where upper(referral_code) = v_code
    and approval_status = 'approved';

  if v_referrer is null then
    return 'unknown_code';
  end if;
  if v_referrer = auth.uid() then
    return 'own_code';
  end if;

  update public.portal_clients set referred_by = v_referrer where id = auth.uid();
  return 'ok';
end;
$$;

grant execute on function public.claim_referral_code(text) to authenticated;

-- Nobody edits the link by hand: it is set once by claim_referral_code, which
-- runs as the definer and is not subject to this check.
create or replace function public.guard_referral_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.referral_code is distinct from old.referral_code then
    raise exception 'A referral code cannot be changed.';
  end if;
  if new.referred_by is distinct from old.referred_by then
    raise exception 'Only the sign-up flow can set who referred you.';
  end if;

  return new;
end;
$$;

drop trigger if exists portal_clients_guard_referral on public.portal_clients;
create trigger portal_clients_guard_referral
  before update on public.portal_clients
  for each row execute function public.guard_referral_fields();

-- -----------------------------------------------------------------------------
-- Sign-up: resolve the code typed at /register.
--
-- Extends the 0002 trigger rather than replacing its job: the flag check and
-- the confirmed-email rule are unchanged, and the code is simply read from the
-- same signup metadata. An unknown or self-referencing code is ignored, never
-- fatal — a typo must not cost somebody their account.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_portal_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_referrer uuid;
begin
  if coalesce(new.raw_user_meta_data ->> 'portal_signup', '') <> 'true' then
    return new;
  end if;

  if new.email_confirmed_at is null then
    return new;
  end if;

  v_code := upper(trim(coalesce(new.raw_user_meta_data ->> 'referral_code', '')));
  if v_code <> '' then
    select id into v_referrer
    from public.portal_clients
    where upper(referral_code) = v_code
      and approval_status = 'approved'
      and id <> new.id;
  end if;

  insert into public.portal_clients (id, full_name, email, approval_status, referred_by)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    'pending',
    v_referrer
  )
  on conflict (id) do nothing;

  return new;
end;
$$;
