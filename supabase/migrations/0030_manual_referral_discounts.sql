-- =============================================================================
-- 0030 - Manual, week-bound referral discounts.
--
-- A referral code is a claim, not permission to change a client's price. An
-- admin reviews one referred client at a time and schedules a full commercial
-- snapshot. Decisions made on Monday may start that Monday; decisions made on
-- any other day start the following Monday. Past weeks are never repriced.
--
-- The invoice contract introduced here is deliberately a new v3 RPC. The v2
-- fixed-10% function from 0028 remains untouched for immutable historic rows.
-- =============================================================================

-- Former billing state is commercial evidence, not disposable cache. There is
-- no honest generic way to invent the admin reviewer, reason, historic referral
-- evidence or account-level contract needed by the manual 10%-fee model. Fail
-- before any DDL if a bespoke, reviewed rollover is required. This deliberately
-- includes referral relationships whose cached rate happens to be back at 10%:
-- that current cache cannot prove what an unissued historic week was owed.
do $$
declare
  expected_cutover_monday date :=
    (now() at time zone 'Europe/Lisbon')::date
      - (
          extract(
            isodow from (now() at time zone 'Europe/Lisbon')::date
          )::integer - 1
        );
  reviewed_cutover_monday date;
begin
  -- A snapshot-only preflight is racy with the old app: an attribution, ledger
  -- sync or invoice INSERT may be uncommitted when SELECT runs and commit while
  -- later DDL waits. Drain every legacy writer first and retain these locks for
  -- the migration transaction, so no incompatible state can cross the check.
  lock table
    public.portal_clients,
    public.ad_accounts,
    public.revenue_sources,
    public.commissions,
    public.invoices,
    public.ad_account_billing_starts,
    public.manual_billing_cutovers,
    public.manual_billing_cutover_commission_snapshots
  in share row exclusive mode;

  select cutover.cutover_monday
    into reviewed_cutover_monday
  from public.manual_billing_cutovers cutover
  where cutover.singleton;

  if reviewed_cutover_monday is null
     or reviewed_cutover_monday <> expected_cutover_monday then
    raise exception using
      errcode = 'P0001',
      message = '0030 preflight: the explicit legacy billing cutover is missing or belongs to a different Lisbon week.';
  end if;

  if exists (
    select 1
    from public.ad_accounts account
    where account.list_commission_rate is distinct from 10::numeric
       or account.commission_rate is distinct from account.list_commission_rate
       or account.revenue_share_enabled
  ) or exists (
    select 1
    from public.portal_clients client
    where client.referred_by is not null
  ) or exists (
    select 1
    from public.commissions commission
    join public.revenue_sources source on source.id = commission.source_id
    left join public.manual_billing_cutover_commission_snapshots snapshot
      on snapshot.commission_id = commission.id
    where source.name = 'Google Ads Management'
      and commission.ad_account_id is not null
      and commission.rate is distinct from 10::numeric
      and (
        snapshot.commission_id is null
        or snapshot.snapshot is distinct from to_jsonb(commission)
      )
  ) or exists (
    select 1
    from public.invoices invoice
    where invoice.status = 'draft'
      and invoice.issued_at is null
  ) or exists (
    select 1
    from public.ad_account_billing_starts billing_start
    where billing_start.google_local_date < reviewed_cutover_monday
  ) then
    raise exception using
      errcode = 'P0001',
      message = '0030 preflight: legacy referrals, pre-cutover billing starts, non-10% Google rows, custom rates, revenue share or unissued drafts require an explicit reviewed rollover before manual 10%-fee referral billing can be installed.';
  end if;
end
$$;

-- Two identities share a workspace when the sets of workspaces they own or
-- have joined intersect. Checking only the direct owner/member pair misses two
-- partners who are both members of a third workspace.
create or replace function public.clients_share_workspace(
  p_left_client_id uuid,
  p_right_client_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  with left_workspaces(workspace_id) as (
    select p_left_client_id
    union
    select membership.client_id
    from public.client_members membership
    where membership.member_id = p_left_client_id
  ),
  right_workspaces(workspace_id) as (
    select p_right_client_id
    union
    select membership.client_id
    from public.client_members membership
    where membership.member_id = p_right_client_id
  )
  select exists (
    select 1
    from left_workspaces left_workspace
    join right_workspaces right_workspace using (workspace_id)
  )
$$;

revoke all on function public.clients_share_workspace(uuid, uuid)
  from public, authenticated, anon;

-- Absence of surviving legacy referral rows cannot prove that an arbitrary
-- old, still-unissued week was always owed at 10%. Pin the first Monday that v3
-- is allowed to settle. Pre-cutover weeks must be closed under a separately
-- reviewed legacy rollover instead of silently defaulting to 10%.
create table public.manual_referral_billing_config (
  singleton boolean primary key default true
    constraint manual_referral_billing_config_singleton check (singleton),
  v3_cutover_monday date not null
    constraint manual_referral_billing_config_cutover_monday
    check (extract(isodow from v3_cutover_monday) = 1),
  created_at timestamptz not null default now()
);

insert into public.manual_referral_billing_config (singleton, v3_cutover_monday)
select true, cutover.cutover_monday
from public.manual_billing_cutovers cutover
where cutover.singleton;

comment on table public.manual_referral_billing_config is
  'Immutable rollout boundary: v3 may never infer a 10% price for an unissued pre-cutover week.';

alter table public.manual_referral_billing_config enable row level security;
revoke insert, update, delete on public.manual_referral_billing_config
  from public, authenticated, anon, service_role;
grant select on public.manual_referral_billing_config
  to authenticated, service_role;

create policy manual_referral_billing_config_admin_read
  on public.manual_referral_billing_config for select
  using (public.is_admin());

-- -----------------------------------------------------------------------------
-- Referral attribution is permanent evidence
-- -----------------------------------------------------------------------------

-- 0022 used ON DELETE SET NULL, which could erase who introduced a client.
-- Fail with the existing FK if the deployed schema does not have the expected
-- relationship; never rewrite attribution as part of this migration.
alter table public.portal_clients
  drop constraint if exists portal_clients_referred_by_fkey;
alter table public.portal_clients
  add constraint portal_clients_referred_by_fkey
  foreign key (referred_by) references public.portal_clients (id) on delete restrict;

-- Neither a browser client nor a browser admin may rewrite attribution. The
-- one supported client path remains claim_referral_code(), whose transaction-
-- local flag was introduced in 0025. It may only fill an empty relationship.
create or replace function public.guard_referral_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.referral_code is distinct from old.referral_code then
    raise exception 'A referral code cannot be changed.'
      using errcode = '22023';
  end if;

  if new.referred_by is distinct from old.referred_by then
    if coalesce(current_setting('dropscale.referral_claim', true), '') = 'on'
       and old.referred_by is null
       and new.referred_by is not null
       and auth.uid() = old.id then
      return new;
    end if;

    raise exception 'A referral attribution cannot be rewritten.'
      using errcode = '22023';
  end if;

  return new;
end
$$;

-- Stop every old automatic repricing path. The claim and current eligibility
-- helpers remain available for portal explanation, but they no longer mutate
-- commercial terms. New billing reads only the snapshots below.
drop trigger if exists portal_clients_referral_changed on public.portal_clients;
drop trigger if exists client_members_referral_rates on public.client_members;
drop trigger if exists ad_accounts_derive_rate on public.ad_accounts;

create or replace function public.effective_commission_rate(
  p_client_id uuid,
  p_list numeric
)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select p_list
$$;

create or replace function public.refresh_referrer_rates(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Compatibility no-op. Manual snapshots are the only pricing authority.
  return;
end
$$;

create or replace function public.refresh_all_referral_rates()
returns integer
language sql
security definer
set search_path = public
as $$
  select 0
$$;

revoke all on function public.refresh_referrer_rates(uuid)
  from public, authenticated, anon;
revoke all on function public.refresh_all_referral_rates()
  from public, authenticated, anon;

-- -----------------------------------------------------------------------------
-- Append-only manual commercial snapshots
-- -----------------------------------------------------------------------------

create table public.referral_discount_terms (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  effective_from date not null,
  revision integer not null check (revision >= 1),
  supersedes_id uuid unique
    references public.referral_discount_terms (id) on delete restrict,
  decision_id uuid not null unique,
  decision_action text not null
    constraint referral_discount_terms_decision_action
    check (decision_action in ('grant', 'revoke')),
  decision_referred_client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  expected_term_id uuid
    references public.referral_discount_terms (id) on delete restrict,
  list_rate numeric(5,2) not null
    constraint referral_discount_terms_list_rate check (list_rate = 10),
  referral_step_rate numeric(5,2) not null
    constraint referral_discount_terms_step_rate check (referral_step_rate = 0.5),
  referral_count integer not null
    constraint referral_discount_terms_count_nonnegative check (referral_count >= 0),
  referral_discount_rate numeric(5,2) not null,
  fee_rate numeric(5,2) not null,
  reason text not null
    constraint referral_discount_terms_reason_present
    check (btrim(reason) <> '' and length(reason) <= 1000),
  reviewed_by uuid not null
    references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  sealed_at timestamptz,
  constraint referral_discount_terms_monday
    check (extract(isodow from effective_from) = 1),
  constraint referral_discount_terms_discount_formula
    check (
      referral_discount_rate = least(list_rate, referral_step_rate * referral_count)
    ),
  constraint referral_discount_terms_fee_formula
    check (fee_rate = list_rate - referral_discount_rate),
  constraint referral_discount_terms_client_week_revision
    unique (client_id, effective_from, revision)
);

comment on table public.referral_discount_terms is
  'Append-only admin snapshots. Latest revision of latest effective Monday is the client fee term.';
comment on column public.referral_discount_terms.decision_id is
  'Caller-generated idempotency key for one manual grant/revoke decision.';

create index referral_discount_terms_resolve_idx
  on public.referral_discount_terms (client_id, effective_from desc, revision desc)
  where sealed_at is not null;

create table public.referral_discount_term_items (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null
    references public.referral_discount_terms (id) on delete restrict,
  referred_client_id uuid not null
    references public.portal_clients (id) on delete restrict,
  evidence_billing_start_id uuid not null
    references public.ad_account_billing_starts (id) on delete restrict,
  evidence_commission_id uuid not null
    references public.commissions (id) on delete restrict,
  eligibility_checked_on date not null,
  evidence_occurred_on date not null,
  evidence_gross_amount numeric(18,6) not null check (evidence_gross_amount > 0),
  evidence_billable_amount numeric(18,6) not null check (evidence_billable_amount > 0),
  created_at timestamptz not null default now(),
  constraint referral_discount_term_items_unique_client
    unique (term_id, referred_client_id),
  constraint referral_discount_term_items_unique_id_term
    unique (id, term_id)
);

comment on table public.referral_discount_term_items is
  'The approved referrals and exact Google-service evidence frozen into one manual term revision.';

alter table public.referral_discount_terms enable row level security;
alter table public.referral_discount_term_items enable row level security;

revoke insert, update, delete on public.referral_discount_terms
  from public, authenticated, anon;
revoke insert, update, delete on public.referral_discount_term_items
  from public, authenticated, anon;
grant select on public.referral_discount_terms,
  public.referral_discount_term_items to authenticated, service_role;

create policy referral_discount_terms_admin_read
  on public.referral_discount_terms for select using (public.is_admin());
create policy referral_discount_term_items_admin_read
  on public.referral_discount_term_items for select using (public.is_admin());

-- A term is built unsealed inside the service RPC, receives its complete item
-- set, then is sealed before COMMIT. Only that one transition is mutable.
create or replace function public.guard_referral_discount_term_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_count integer;
begin
  if tg_op = 'INSERT' then
    if coalesce(current_setting('dropscale.manual_referral_rpc', true), '') <> 'on' then
      raise exception 'Manual referral terms can be inserted only by the scheduling RPC.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'A manual referral term is append-only.'
      using errcode = '22023';
  end if;

  if old.sealed_at is null
     and new.sealed_at is not null
     and new.id = old.id
     and new.client_id = old.client_id
     and new.effective_from = old.effective_from
     and new.revision = old.revision
     and new.supersedes_id is not distinct from old.supersedes_id
     and new.decision_id = old.decision_id
     and new.decision_action = old.decision_action
     and new.decision_referred_client_id = old.decision_referred_client_id
     and new.expected_term_id is not distinct from old.expected_term_id
     and new.list_rate = old.list_rate
     and new.referral_step_rate = old.referral_step_rate
     and new.referral_count = old.referral_count
     and new.referral_discount_rate = old.referral_discount_rate
     and new.fee_rate = old.fee_rate
     and new.reason = old.reason
     and new.reviewed_by = old.reviewed_by
     and new.created_at = old.created_at then
    select count(*)::int into item_count
    from public.referral_discount_term_items item
    where item.term_id = old.id;

    if item_count <> old.referral_count then
      raise exception 'A manual referral term cannot be sealed with missing items.'
        using errcode = '22023';
    end if;
    return new;
  end if;

  raise exception 'A manual referral term is append-only.'
    using errcode = '22023';
end
$$;

create trigger referral_discount_terms_guard_append_only
  before insert or update or delete on public.referral_discount_terms
  for each row execute function public.guard_referral_discount_term_write();

create or replace function public.guard_referral_discount_term_item_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'A manual referral term item is append-only.'
      using errcode = '22023';
  end if;

  if coalesce(current_setting('dropscale.manual_referral_rpc', true), '') <> 'on' then
    raise exception 'Manual referral term items can be inserted only by the scheduling RPC.'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.referral_discount_terms term
    where term.id = new.term_id and term.sealed_at is not null
  ) then
    raise exception 'A sealed manual referral term cannot receive another item.'
      using errcode = '22023';
  end if;
  return new;
end
$$;

create trigger referral_discount_term_items_guard_append_only
  before insert or update or delete on public.referral_discount_term_items
  for each row execute function public.guard_referral_discount_term_item_write();

-- Lisbon owns the weekly billing calendar. In DST, using database current_date
-- (normally UTC in Supabase) would leave a one-hour window with the wrong day.
create or replace function public.manual_referral_effective_monday(p_decision_day date)
returns date
language sql
immutable
strict
set search_path = public
as $$
  select p_decision_day
    + ((8 - extract(isodow from p_decision_day)::integer) % 7)
$$;

create or replace function public.manual_referral_current_monday(p_business_day date)
returns date
language sql
immutable
strict
set search_path = public
as $$
  select p_business_day
    - (extract(isodow from p_business_day)::integer - 1)
$$;

create or replace function public.resolve_manual_referral_term(
  p_client_id uuid,
  p_period_start date
)
returns table (
  term_id uuid,
  effective_from date,
  revision integer,
  list_rate numeric,
  referral_step_rate numeric,
  referral_count integer,
  referral_discount_rate numeric,
  fee_rate numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_period_start is null or extract(isodow from p_period_start) <> 1 then
    raise exception 'A manual referral term resolves only for a Monday billing period.'
      using errcode = '22023';
  end if;

  return query
  select
    term.id,
    term.effective_from,
    term.revision,
    term.list_rate,
    term.referral_step_rate,
    term.referral_count,
    term.referral_discount_rate,
    term.fee_rate
  from public.referral_discount_terms term
  where term.client_id = p_client_id
    and term.effective_from <= p_period_start
    and term.sealed_at is not null
  order by term.effective_from desc, term.revision desc
  limit 1;

  if not found then
    term_id := null;
    effective_from := null;
    revision := 0;
    list_rate := 10;
    referral_step_rate := 0.5;
    referral_count := 0;
    referral_discount_rate := 0;
    fee_rate := 10;
    return next;
  end if;
end
$$;

revoke all on function public.resolve_manual_referral_term(uuid, date)
  from public, authenticated, anon;

-- commission_rate remains a compatibility cache for legacy dashboards, never
-- invoice authority. It mirrors the manual term effective in the current
-- Lisbon billing week; historical invoices always resolve by period_start.
create or replace function public.manual_referral_rate_on_day(
  p_client_id uuid,
  p_list numeric,
  p_business_day date
)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select case
    when p_list <> 10 then p_list
    else term.fee_rate
  end
  from public.resolve_manual_referral_term(
    p_client_id,
    public.manual_referral_current_monday(p_business_day)
  ) term
$$;

revoke all on function public.manual_referral_rate_on_day(uuid, numeric, date)
  from public, authenticated, anon;

create or replace function public.effective_commission_rate(
  p_client_id uuid,
  p_list numeric
)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select public.manual_referral_rate_on_day(
    p_client_id,
    p_list,
    (now() at time zone 'Europe/Lisbon')::date
  )
$$;

-- Both functions predate the manual snapshot model and are SECURITY DEFINER.
-- Browser access would let any signed-in user probe another workspace's rate
-- or old live-eligibility count outside RLS. Internal definer functions and
-- the account-rate trigger continue to call effective_commission_rate as the
-- function owner.
revoke all on function public.effective_commission_rate(uuid, numeric)
  from public, authenticated, anon;
revoke all on function public.active_referral_count(uuid)
  from public, authenticated, anon;

create or replace function public.derive_commission_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.commission_rate := public.effective_commission_rate(
    new.client_id,
    new.list_commission_rate
  );
  return new;
end
$$;

create trigger ad_accounts_derive_rate
  before insert or update on public.ad_accounts
  for each row execute function public.derive_commission_rate();

create or replace function public.refresh_referrer_rates(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_client_id is null then return; end if;
  update public.ad_accounts account
  set list_commission_rate = account.list_commission_rate
  where account.client_id = p_client_id
    and account.commission_rate is distinct from
      public.effective_commission_rate(account.client_id, account.list_commission_rate);
end
$$;

create or replace function public.refresh_all_referral_rates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  with updated as (
    update public.ad_accounts account
    set list_commission_rate = account.list_commission_rate
    where account.commission_rate is distinct from
      public.effective_commission_rate(account.client_id, account.list_commission_rate)
    returning 1
  )
  select count(*)::int into changed from updated;
  return changed;
end
$$;

revoke all on function public.refresh_referrer_rates(uuid)
  from public, authenticated, anon;
revoke all on function public.refresh_all_referral_rates()
  from public, authenticated, anon;
grant execute on function public.refresh_all_referral_rates() to service_role;

-- One action in, one full snapshot out. p_expected_term_id is an optimistic
-- concurrency token: two admins cannot unknowingly overwrite one another.
create or replace function public.schedule_manual_referral_discount(
  p_client_id uuid,
  p_referred_client_id uuid,
  p_action text,
  p_effective_from date,
  p_expected_term_id uuid,
  p_decision_id uuid,
  p_reason text,
  p_reviewed_by uuid
)
returns setof public.referral_discount_terms
language plpgsql
security definer
set search_path = public
as $$
declare
  decision_day date := (now() at time zone 'Europe/Lisbon')::date;
  allowed_monday date;
  target_client public.portal_clients%rowtype;
  referred_client public.portal_clients%rowtype;
  current_term public.referral_discount_terms%rowtype;
  previous_same_day public.referral_discount_terms%rowtype;
  replay_term public.referral_discount_terms%rowtype;
  created_term public.referral_discount_terms%rowtype;
  evidence record;
  next_count integer;
  next_revision integer;
  next_discount numeric;
  current_has_referral boolean;
  target_found boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can schedule a manual referral discount.'
      using errcode = '42501';
  end if;

  if p_decision_id is null
     or p_client_id is null
     or p_referred_client_id is null
     or p_action is null
     or p_action not in ('grant', 'revoke')
     or nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Invalid manual referral decision.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_reviewed_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin reviewer is required for a referral decision.'
      using errcode = '42501';
  end if;

  -- Exact retries stay idempotent even after the calendar has advanced. The
  -- original allowed-Monday validation was already committed with this key.
  select * into replay_term
  from public.referral_discount_terms term
  where term.decision_id = p_decision_id;

  if found then
    if replay_term.client_id <> p_client_id
       or replay_term.effective_from <> p_effective_from
       or replay_term.decision_action <> p_action
       or replay_term.decision_referred_client_id <> p_referred_client_id
       or replay_term.expected_term_id is distinct from p_expected_term_id
       or replay_term.reason <> btrim(p_reason)
       or replay_term.reviewed_by <> p_reviewed_by then
      raise exception 'A referral decision id cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;

    return next replay_term;
    return;
  end if;

  allowed_monday := public.manual_referral_effective_monday(decision_day);
  if p_effective_from is distinct from allowed_monday then
    raise exception 'A referral decision made today may take effect only on %.', allowed_monday
      using errcode = '22023';
  end if;

  -- Serialize every decision for this referrer before checking the CAS token.
  select * into target_client
  from public.portal_clients client
  where client.id = p_client_id
  for update;
  target_found := found;

  -- The first lookup can race another request with the same decision id. Once
  -- the per-client lock is held, check again so an exact concurrent retry gets
  -- the committed receipt instead of a stale-CAS error.
  select * into replay_term
  from public.referral_discount_terms term
  where term.decision_id = p_decision_id;

  if found then
    if replay_term.client_id <> p_client_id
       or replay_term.effective_from <> p_effective_from
       or replay_term.decision_action <> p_action
       or replay_term.decision_referred_client_id <> p_referred_client_id
       or replay_term.expected_term_id is distinct from p_expected_term_id
       or replay_term.reason <> btrim(p_reason)
       or replay_term.reviewed_by <> p_reviewed_by then
      raise exception 'A referral decision id cannot be replayed with different evidence.'
        using errcode = '22023';
    end if;
    return next replay_term;
    return;
  end if;

  if not target_found or target_client.approval_status <> 'approved' then
    raise exception 'Only an approved client can receive a referral discount.'
      using errcode = '22023';
  end if;

  if p_action = 'grant' and exists (
    select 1
    from public.profiles profile
    where profile.id = p_client_id
      and profile.role = 'admin'
  ) then
    raise exception 'Staff portal identities cannot receive referral discounts.'
      using errcode = '22023';
  end if;

  select term.* into current_term
  from public.referral_discount_terms term
  where term.client_id = p_client_id
    and term.effective_from <= p_effective_from
    and term.sealed_at is not null
  order by term.effective_from desc, term.revision desc
  limit 1;

  if current_term.id is distinct from p_expected_term_id then
    raise exception 'The referral term changed while it was being reviewed.'
      using errcode = '40001';
  end if;

  current_has_referral := current_term.id is not null and exists (
    select 1
    from public.referral_discount_term_items item
    where item.term_id = current_term.id
      and item.referred_client_id = p_referred_client_id
  );

  if p_action = 'grant' then
    if current_has_referral then
      raise exception 'This referral is already present in the effective manual term.'
        using errcode = '22023';
    end if;

    select * into referred_client
    from public.portal_clients client
    where client.id = p_referred_client_id;

    if not found
       or referred_client.approval_status <> 'approved'
       or referred_client.referred_by is distinct from p_client_id
       or referred_client.id = p_client_id then
      raise exception 'A grant requires an approved client attributed to this referrer.'
        using errcode = '22023';
    end if;

    if exists (
      select 1
      from public.profiles profile
      where profile.id = p_referred_client_id
        and profile.role = 'admin'
    ) then
      raise exception 'Staff portal identities cannot earn a referral discount.'
        using errcode = '22023';
    end if;

    if public.clients_share_workspace(p_client_id, p_referred_client_id) then
      raise exception 'Clients who share a workspace cannot earn a referral discount.'
        using errcode = '22023';
    end if;

    -- Freeze one exact piece of recent, confirmed Google-service evidence.
    -- Later inactivity never reprices automatically; only another admin action
    -- can remove the grant from a future weekly snapshot.
    select
      authoritative.billing_start_id,
      commission.id as commission_id,
      commission.occurred_on,
      round(commission.gross_amount, 6) as gross_amount,
      round(authoritative.billable_gross_amount, 6) as billable_amount
      into evidence
    from public.commissions commission
    join public.revenue_sources source on source.id = commission.source_id
    join public.ad_accounts account on account.id = commission.ad_account_id
    join public.ad_account_billing_starts billing_start
      on billing_start.ad_account_id = account.id
     and billing_start.google_ads_customer_id = account.google_ads_customer_id
    left join public.ad_account_billing_ends billing_end
      on billing_end.ad_account_id = account.id
     and billing_end.billing_start_id = billing_start.id
    join lateral public.manual_invoice_authoritative_rows(
      p_referred_client_id,
      commission.occurred_on
        - (extract(isodow from commission.occurred_on)::integer - 1),
      commission.occurred_on
        + (7 - extract(isodow from commission.occurred_on)::integer)
    ) authoritative on authoritative.commission_id = commission.id
    where account.client_id = p_referred_client_id
      and account.status in ('active', 'suspended')
      and billing_end.id is null
      and source.name = 'Google Ads Management'
      and commission.status = 'confirmed'
      and upper(commission.currency) = 'EUR'
      and commission.gross_amount > 0
      and authoritative.billable_gross_amount > 0
      and commission.occurred_on >= decision_day - public.referral_activity_days()
      and commission.occurred_on <= decision_day
      and commission.occurred_on >= billing_start.google_local_date
    order by commission.occurred_on desc, commission.id
    limit 1;

    if evidence.commission_id is null then
      raise exception 'A grant requires verified Google billing and recent confirmed Google spend.'
        using errcode = '22023';
    end if;
  elsif not current_has_referral then
    raise exception 'This referral is not present in the effective manual term.'
      using errcode = '22023';
  end if;

  select term.* into previous_same_day
  from public.referral_discount_terms term
  where term.client_id = p_client_id
    and term.effective_from = p_effective_from
    and term.sealed_at is not null
  order by term.revision desc
  limit 1;

  next_count := coalesce(current_term.referral_count, 0)
    + case when p_action = 'grant' then 1 else -1 end;
  next_revision := coalesce(previous_same_day.revision, 0) + 1;
  next_discount := least(10::numeric, 0.5::numeric * next_count);

  perform set_config('dropscale.manual_referral_rpc', 'on', true);

  insert into public.referral_discount_terms (
    client_id,
    effective_from,
    revision,
    supersedes_id,
    decision_id,
    decision_action,
    decision_referred_client_id,
    expected_term_id,
    list_rate,
    referral_step_rate,
    referral_count,
    referral_discount_rate,
    fee_rate,
    reason,
    reviewed_by
  ) values (
    p_client_id,
    p_effective_from,
    next_revision,
    previous_same_day.id,
    p_decision_id,
    p_action,
    p_referred_client_id,
    p_expected_term_id,
    10,
    0.5,
    next_count,
    next_discount,
    10 - next_discount,
    btrim(p_reason),
    p_reviewed_by
  ) returning * into created_term;

  -- Copy the complete previous grant set, excluding a requested revoke.
  if current_term.id is not null then
    insert into public.referral_discount_term_items (
      term_id,
      referred_client_id,
      evidence_billing_start_id,
      evidence_commission_id,
      eligibility_checked_on,
      evidence_occurred_on,
      evidence_gross_amount,
      evidence_billable_amount
    )
    select
      created_term.id,
      item.referred_client_id,
      item.evidence_billing_start_id,
      item.evidence_commission_id,
      item.eligibility_checked_on,
      item.evidence_occurred_on,
      item.evidence_gross_amount,
      item.evidence_billable_amount
    from public.referral_discount_term_items item
    where item.term_id = current_term.id
      and not (
        p_action = 'revoke'
        and item.referred_client_id = p_referred_client_id
      );
  end if;

  if p_action = 'grant' then
    insert into public.referral_discount_term_items (
      term_id,
      referred_client_id,
      evidence_billing_start_id,
      evidence_commission_id,
      eligibility_checked_on,
      evidence_occurred_on,
      evidence_gross_amount,
      evidence_billable_amount
    ) values (
      created_term.id,
      p_referred_client_id,
      evidence.billing_start_id,
      evidence.commission_id,
      decision_day,
      evidence.occurred_on,
      evidence.gross_amount,
      evidence.billable_amount
    );
  end if;

  update public.referral_discount_terms
  set sealed_at = now()
  where id = created_term.id
  returning * into created_term;

  perform public.refresh_referrer_rates(p_client_id);

  return next created_term;
end
$$;

revoke all on function public.schedule_manual_referral_discount(
  uuid, uuid, text, date, uuid, uuid, text, uuid
) from public, authenticated, anon;
grant execute on function public.schedule_manual_referral_discount(
  uuid, uuid, text, date, uuid, uuid, text, uuid
) to service_role;

-- The top-of-file preflight proved this cannot erase a live discounted rate.
-- Refresh any harmless stale standard-rate cache through the new resolver.
select public.refresh_all_referral_rates();

-- -----------------------------------------------------------------------------
-- Safe portal summary of the manual state
-- -----------------------------------------------------------------------------

-- Advisory eligibility for a referral that is not yet in a term. This uses
-- the same post-boundary, recent Google-spend rule as the scheduling RPC but
-- returns one boolean and is not executable by a browser. Once an item is in a
-- sealed term, later inactivity never removes it automatically.
create or replace function public.manual_referral_client_has_billable_service(
  p_client_id uuid,
  p_on_date date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.commissions commission
    join public.revenue_sources source on source.id = commission.source_id
    join public.ad_accounts account on account.id = commission.ad_account_id
    join public.ad_account_billing_starts billing_start
      on billing_start.ad_account_id = account.id
     and billing_start.google_ads_customer_id = account.google_ads_customer_id
    left join public.ad_account_billing_ends billing_end
      on billing_end.ad_account_id = account.id
     and billing_end.billing_start_id = billing_start.id
    join lateral public.manual_invoice_authoritative_rows(
      p_client_id,
      commission.occurred_on
        - (extract(isodow from commission.occurred_on)::integer - 1),
      commission.occurred_on
        + (7 - extract(isodow from commission.occurred_on)::integer)
    ) authoritative on authoritative.commission_id = commission.id
    where account.client_id = p_client_id
      and account.status in ('active', 'suspended')
      and billing_end.id is null
      and source.name = 'Google Ads Management'
      and commission.status = 'confirmed'
      and upper(commission.currency) = 'EUR'
      and commission.gross_amount > 0
      and authoritative.billable_gross_amount > 0
      and commission.occurred_on >= p_on_date - public.referral_activity_days()
      and commission.occurred_on <= p_on_date
      and commission.occurred_on >= billing_start.google_local_date
  )
$$;

revoke all on function public.manual_referral_client_has_billable_service(uuid, date)
  from public, authenticated, anon;

-- Sanitized commercial timeline for portal metrics. One row per effective
-- Monday is enough to reproduce the historical fee rate: when admins revise a
-- future week before it starts, only the latest sealed revision is
-- authoritative. Deliberately omit term ids, referral ids, reviewer details,
-- reasons and evidence.
create or replace function public.manual_referral_rate_schedule(p_client_id uuid)
returns table (
  effective_from date,
  revision integer,
  referral_count integer,
  referral_discount_rate numeric,
  fee_rate numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_client_member(p_client_id) then
    raise exception 'Not allowed to read this client referral schedule.'
      using errcode = '42501';
  end if;

  return query
  select distinct on (term.effective_from)
    term.effective_from,
    term.revision,
    term.referral_count,
    term.referral_discount_rate,
    term.fee_rate
  from public.referral_discount_terms term
  where term.client_id = p_client_id
    and term.sealed_at is not null
  order by term.effective_from, term.revision desc;
end
$$;

revoke all on function public.manual_referral_rate_schedule(uuid)
  from public, authenticated, anon;
grant execute on function public.manual_referral_rate_schedule(uuid)
  to authenticated;

-- Portal contract (name + status only):
--   approved        present in the term effective this Lisbon week
--   scheduled       absent now, present in a sealed snapshot for next Monday
--   awaiting_review approved + eligible, but no current/future manual grant
--   pending         signup not approved or no current billable Google service
--
-- Current/scheduled membership wins over live eligibility. An admin decision
-- remains in force until another dated admin decision changes it.
create or replace function public.referral_summary(p_client_id uuid)
returns table (name text, status text)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  business_day date := (now() at time zone 'Europe/Lisbon')::date;
  current_monday date;
  next_monday date;
  current_term_id uuid;
  scheduled_term_id uuid;
begin
  if not (public.is_client_member(p_client_id) or public.is_admin()) then
    return;
  end if;

  current_monday := public.manual_referral_current_monday(business_day);
  next_monday := current_monday + 7;

  select resolved.term_id into current_term_id
  from public.resolve_manual_referral_term(p_client_id, current_monday) resolved;

  -- Exact next-Monday snapshot only. resolve_manual_referral_term(next_monday)
  -- would fall back to the current term when nothing is scheduled and would
  -- incorrectly label every current grant as scheduled too.
  select term.id into scheduled_term_id
  from public.referral_discount_terms term
  where term.client_id = p_client_id
    and term.effective_from = next_monday
    and term.sealed_at is not null
  order by term.revision desc
  limit 1;

  return query
  select
    referred.full_name,
    case
      when current_term_id is not null and exists (
        select 1
        from public.referral_discount_term_items item
        where item.term_id = current_term_id
          and item.referred_client_id = referred.id
      ) then 'approved'
      when scheduled_term_id is not null and exists (
        select 1
        from public.referral_discount_term_items item
        where item.term_id = scheduled_term_id
          and item.referred_client_id = referred.id
      ) then 'scheduled'
      when referred.approval_status <> 'approved'
        or not public.manual_referral_client_has_billable_service(
          referred.id,
          business_day
        ) then 'pending'
      else 'awaiting_review'
    end
  from public.portal_clients referred
  where referred.referred_by = p_client_id
  order by referred.created_at;
end
$$;

revoke all on function public.referral_summary(uuid)
  from public, authenticated, anon;
grant execute on function public.referral_summary(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Invoice snapshots and zero-fee settlements
-- -----------------------------------------------------------------------------

-- The reviewed recipient is part of the commercial record, not mutable client
-- profile data. Keep the wire shape deliberately small and exact so both the
-- database and Stripe reconciliation can fail closed on an unknown field,
-- missing field, overlong VAT value, or malformed country code.
create or replace function public.is_valid_invoice_billing_recipient(
  p_recipient jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_recipient is null or jsonb_typeof(p_recipient) <> 'object' then
    return false;
  end if;

  return coalesce(
    p_recipient ?& array[
      'email',
      'fallbackName',
      'billingName',
      'taxId',
      'addressLine1',
      'addressLine2',
      'addressCity',
      'addressPostalCode',
      'addressState',
      'addressCountry'
    ]
    and (
      select count(*) = 10
      from jsonb_object_keys(p_recipient)
    )
    and jsonb_typeof(p_recipient->'email') = 'string'
    and btrim(p_recipient->>'email') = p_recipient->>'email'
    and p_recipient->>'email' ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    and length(p_recipient->>'email') <= 254
    and jsonb_typeof(p_recipient->'fallbackName') = 'string'
    and btrim(p_recipient->>'fallbackName') = p_recipient->>'fallbackName'
    and btrim(p_recipient->>'fallbackName') <> ''
    and length(p_recipient->>'fallbackName') <= 200
    and jsonb_typeof(p_recipient->'billingName') in ('string', 'null')
    and (
      p_recipient->>'billingName' is null
      or (
        btrim(p_recipient->>'billingName') = p_recipient->>'billingName'
        and btrim(p_recipient->>'billingName') <> ''
        and length(p_recipient->>'billingName') <= 120
      )
    )
    and jsonb_typeof(p_recipient->'taxId') in ('string', 'null')
    and (
      p_recipient->>'taxId' is null
      or (
        btrim(p_recipient->>'taxId') = p_recipient->>'taxId'
        and btrim(p_recipient->>'taxId') <> ''
        and length(p_recipient->>'taxId') <= 30
      )
    )
    and jsonb_typeof(p_recipient->'addressLine1') in ('string', 'null')
    and jsonb_typeof(p_recipient->'addressLine2') in ('string', 'null')
    and jsonb_typeof(p_recipient->'addressCity') in ('string', 'null')
    and jsonb_typeof(p_recipient->'addressPostalCode') in ('string', 'null')
    and jsonb_typeof(p_recipient->'addressState') in ('string', 'null')
    and jsonb_typeof(p_recipient->'addressCountry') in ('string', 'null')
    and (
      p_recipient->>'addressLine1' is null
      or (
        btrim(p_recipient->>'addressLine1') = p_recipient->>'addressLine1'
        and btrim(p_recipient->>'addressLine1') <> ''
        and length(p_recipient->>'addressLine1') <= 500
      )
    )
    and (
      p_recipient->>'addressLine2' is null
      or (
        btrim(p_recipient->>'addressLine2') = p_recipient->>'addressLine2'
        and btrim(p_recipient->>'addressLine2') <> ''
        and length(p_recipient->>'addressLine2') <= 500
      )
    )
    and (
      p_recipient->>'addressCity' is null
      or (
        btrim(p_recipient->>'addressCity') = p_recipient->>'addressCity'
        and btrim(p_recipient->>'addressCity') <> ''
        and length(p_recipient->>'addressCity') <= 200
      )
    )
    and (
      p_recipient->>'addressPostalCode' is null
      or (
        btrim(p_recipient->>'addressPostalCode') = p_recipient->>'addressPostalCode'
        and btrim(p_recipient->>'addressPostalCode') <> ''
        and length(p_recipient->>'addressPostalCode') <= 100
      )
    )
    and (
      p_recipient->>'addressState' is null
      or (
        btrim(p_recipient->>'addressState') = p_recipient->>'addressState'
        and btrim(p_recipient->>'addressState') <> ''
        and length(p_recipient->>'addressState') <= 200
      )
    )
    and (
      p_recipient->>'addressCountry' is null
      or p_recipient->>'addressCountry' ~ '^[A-Z]{2}$'
    ),
    false
  );
end
$$;

alter table public.invoices
  add column if not exists referral_discount_term_id uuid
    references public.referral_discount_terms (id) on delete restrict,
  add column if not exists billing_recipient jsonb;

comment on column public.invoices.referral_discount_term_id is
  'The immutable manual-referral snapshot used by v3; null means the default 10% term.';
comment on column public.invoices.billing_recipient is
  'Exact email, legal identity, VAT id and address reviewed for a v3 invoice; immutable after insert.';

alter table public.invoices
  drop constraint if exists invoices_v3_billing_recipient_check;
alter table public.invoices
  add constraint invoices_v3_billing_recipient_check check (
    calculation_version <>
      'agency-fee-eur-v3-manual-referrals-google-boundaries'
    or public.is_valid_invoice_billing_recipient(billing_recipient)
  );

-- A zero referral fee is a real closed-week settlement, not a paid or void
-- Stripe invoice. It reserves client/week and consumes the Google rows locally.
alter table public.invoices
  drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft', 'open', 'paid', 'void', 'uncollectible', 'waived'));

create or replace function public.guard_invoice_commercial_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'An invoice commercial snapshot cannot be deleted.'
      using errcode = '22023';
  end if;

  if new.id is distinct from old.id
     or new.client_id is distinct from old.client_id
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.line_items is distinct from old.line_items
     or new.issued_by is distinct from old.issued_by
     or new.calculation_version is distinct from old.calculation_version
     or new.referral_discount_term_id is distinct from old.referral_discount_term_id
     or new.billing_recipient is distinct from old.billing_recipient
     or new.created_at is distinct from old.created_at then
    raise exception 'An invoice commercial snapshot is immutable.';
  end if;

  if old.stripe_invoice_id is not null
     and new.stripe_invoice_id is distinct from old.stripe_invoice_id then
    raise exception 'A Stripe invoice link cannot be replaced.';
  end if;

  return new;
end
$$;

drop trigger if exists invoices_guard_commercial_snapshot on public.invoices;
create trigger invoices_guard_commercial_snapshot
  before update or delete on public.invoices
  for each row execute function public.guard_invoice_commercial_snapshot();

create or replace function public.guard_waived_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     and new.calculation_version =
       'agency-fee-eur-v3-manual-referrals-google-boundaries'
     and coalesce(
       current_setting('dropscale.manual_referral_invoice_rpc', true),
       ''
     ) <> 'on' then
    raise exception 'A v3 invoice can be inserted only by its validated creation RPC.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' and new.status = 'waived' then
    if new.amount <> 0
       or new.amount_remaining is distinct from 0::numeric
       or new.issued_at is null
       or new.due_date is not null
       or new.calculation_version <>
          'agency-fee-eur-v3-manual-referrals-google-boundaries'
       or not public.is_valid_invoice_billing_recipient(new.billing_recipient)
       or jsonb_typeof(new.line_items) <> 'array'
       or jsonb_array_length(new.line_items) = 0
       or new.stripe_invoice_id is not null
       or new.stripe_hosted_url is not null
       or new.stripe_invoice_number is not null
       or new.stripe_invoice_pdf is not null then
      raise exception 'A waived settlement must be zero, issued locally and have no Stripe identity.'
        using errcode = '22023';
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'waived' and new is distinct from old then
    raise exception 'A waived settlement is immutable and cannot be sent to Stripe.'
      using errcode = '22023';
  elsif tg_op = 'UPDATE' and new.status = 'waived' and old.status <> 'waived' then
    raise exception 'Only the v3 creation transaction can create a waived settlement.'
      using errcode = '22023';
  end if;

  return new;
end
$$;

drop trigger if exists invoices_guard_waived on public.invoices;
create trigger invoices_guard_waived
  before insert or update on public.invoices
  for each row execute function public.guard_waived_invoice();

-- Each invoice points to the exact approved grant items used for its rate. A
-- term header is convenient; these rows make the N individual grants explicit.
create table public.invoice_referral_events (
  invoice_id uuid not null
    references public.invoices (id) on delete restrict,
  referral_discount_term_id uuid not null,
  referral_discount_term_item_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (invoice_id, referral_discount_term_item_id),
  constraint invoice_referral_events_term_item_fk
    foreign key (referral_discount_term_item_id, referral_discount_term_id)
    references public.referral_discount_term_items (id, term_id) on delete restrict
);

alter table public.invoice_referral_events enable row level security;
revoke insert, update, delete on public.invoice_referral_events
  from public, authenticated, anon;
grant select on public.invoice_referral_events to authenticated, service_role;
create policy invoice_referral_events_admin_read
  on public.invoice_referral_events for select using (public.is_admin());
create policy invoice_referral_events_client_read
  on public.invoice_referral_events for select using (
    exists (
      select 1 from public.invoices invoice
      where invoice.id = invoice_id
        and public.is_client_member(invoice.client_id)
    )
  );

create or replace function public.guard_invoice_referral_event_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     and coalesce(current_setting('dropscale.manual_referral_invoice_rpc', true), '') = 'on' then
    if not exists (
      select 1 from public.invoices invoice
      where invoice.id = new.invoice_id
        and invoice.referral_discount_term_id = new.referral_discount_term_id
    ) then
      raise exception 'An invoice referral event must match the invoice term.'
        using errcode = '22023';
    end if;
    return new;
  end if;

  raise exception 'An invoice referral event is immutable.'
    using errcode = '22023';
end
$$;

create trigger invoice_referral_events_guard_immutable
  before insert or update or delete on public.invoice_referral_events
  for each row execute function public.guard_invoice_referral_event_immutable();

create or replace function public.guard_invoice_commission_row_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'An invoice Google ledger claim is immutable.'
    using errcode = '22023';
end
$$;

drop trigger if exists invoice_commission_rows_guard_immutable
  on public.invoice_commission_rows;
create trigger invoice_commission_rows_guard_immutable
  before update or delete on public.invoice_commission_rows
  for each row execute function public.guard_invoice_commission_row_immutable();

-- Exact decimal formatting shared by the v3 line validator. Keeping it in SQL
-- pins Stripe descriptions without locale-dependent decimal separators.
create or replace function public.manual_referral_rate_text(p_rate numeric)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select trim(trailing '.' from trim(trailing '0' from to_char(p_rate, 'FM990.00')))
$$;

-- New commercial formula: Google boundaries still come entirely from 0028;
-- only the immutable, client-wide rate snapshot is new. The separate function
-- name prevents a v2 caller from accidentally changing meaning after deploy.
create or replace function public.create_manual_referral_invoice(
  p_client_id uuid,
  p_period_start date,
  p_period_end date,
  p_amount numeric,
  p_line_items jsonb,
  p_ledger_rows jsonb,
  p_billing_recipient jsonb,
  p_referral_term_id uuid,
  p_issued_by uuid,
  p_calculation_version text
)
returns setof public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  created_invoice public.invoices;
  commercial_term record;
  requested_rows integer;
  valid_rows integer;
  expected_rows integer;
  expected_lines integer;
  valid_lines integer;
  distinct_line_accounts integer;
  client_count integer;
  missing_start_count integer;
  incompatible_terms_count integer;
  account_count integer;
  ready_account_count integer;
  referral_events_count integer;
  lines_total numeric;
  billable_total numeric;
  expected_billing_recipient jsonb;
  business_day date := (now() at time zone 'Europe/Lisbon')::date;
  v3_cutover_monday date;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can create a manual referral invoice.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_issued_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin reviewer is required to create a manual referral invoice.'
      using errcode = '42501';
  end if;

  -- Serialize source identity, recipient identity, Google evidence and
  -- commercial-term resolution. The supplied JSON is compared only after
  -- these locks, so a concurrent profile edit cannot slip between review and
  -- persistence.
  lock table public.portal_clients in share row exclusive mode;
  lock table public.billing_profiles in share row exclusive mode;
  lock table public.ad_accounts in share row exclusive mode;
  lock table public.ad_account_billing_starts in share row exclusive mode;
  lock table public.ad_account_billing_ends in share row exclusive mode;
  lock table public.commissions in share row exclusive mode;
  lock table public.google_ledger_sync_windows in share row exclusive mode;
  lock table public.referral_discount_terms in share row exclusive mode;
  lock table public.referral_discount_term_items in share row exclusive mode;

  select config.v3_cutover_monday into v3_cutover_monday
  from public.manual_referral_billing_config config
  where config.singleton;

  if v3_cutover_monday is null then
    raise exception 'The v3 referral billing cutover is not configured.'
      using errcode = '22023';
  end if;

  if p_period_start < v3_cutover_monday then
    raise exception 'A pre-cutover week cannot be priced by the v3 10%% default.'
      using errcode = '22023';
  end if;

  if p_period_end <> p_period_start + 6
     or extract(isodow from p_period_start) <> 1
     or p_period_end >= business_day
     or now() < (
       ((p_period_end + 1)::timestamp at time zone 'UTC')
         + interval '14 hours 5 minutes'
     ) then
    raise exception 'Only a fully closed and Google-settled Monday-to-Sunday week can be settled.'
      using errcode = '22023';
  end if;

  if p_amount is null
     or p_amount <> round(p_amount, 2)
     or p_amount < 0
     or p_calculation_version <>
       'agency-fee-eur-v3-manual-referrals-google-boundaries' then
    raise exception 'Invalid v3 manual-referral agency-fee calculation.'
      using errcode = '22023';
  end if;

  if not public.is_valid_invoice_billing_recipient(p_billing_recipient) then
    raise exception 'The reviewed invoice recipient has an invalid or incomplete shape.'
      using errcode = '22023';
  end if;

  select jsonb_build_object(
    'email', client.email,
    'fallbackName', client.full_name,
    'billingName', billing_profile.billing_name,
    'taxId', billing_profile.tax_id,
    'addressLine1', billing_profile.address_line1,
    'addressLine2', billing_profile.address_line2,
    'addressCity', billing_profile.address_city,
    'addressPostalCode', billing_profile.address_postal_code,
    'addressState', billing_profile.address_state,
    'addressCountry', billing_profile.address_country
  ) into expected_billing_recipient
  from public.portal_clients client
  left join public.billing_profiles billing_profile
    on billing_profile.client_id = client.id
  where client.id = p_client_id;

  if expected_billing_recipient is null
     or p_billing_recipient is distinct from expected_billing_recipient then
    raise exception 'The reviewed invoice recipient changed before the invoice was created.'
      using errcode = '40001';
  end if;

  select * into commercial_term
  from public.resolve_manual_referral_term(p_client_id, p_period_start);

  if commercial_term.term_id is distinct from p_referral_term_id then
    raise exception 'The manual referral term changed or does not apply to this billing week.'
      using errcode = '40001';
  end if;

  select count(*) into client_count
  from public.portal_clients client
  where client.id = p_client_id
    and client.approval_status in ('approved', 'rejected')
    and not exists (
      select 1 from public.profiles profile
      where profile.id = client.id and profile.role = 'admin'
    );

  if client_count <> 1 then
    raise exception 'Only a billable, non-admin portal client can be settled.'
      using errcode = '22023';
  end if;

  select count(*) into missing_start_count
  from public.ad_accounts account
  left join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
  where account.client_id = p_client_id
    and account.status in ('active', 'suspended')
    and billing_start.id is null;

  if missing_start_count <> 0 then
    raise exception 'Every approved account needs a verified Google billing start.'
      using errcode = '22023';
  end if;

  -- v3 owns referral discounts, but arbitrary list prices and revenue share
  -- are still different contracts and remain fail-closed.
  select count(*) into incompatible_terms_count
  from public.ad_accounts account
  join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
  left join public.ad_account_billing_ends billing_end
    on billing_end.ad_account_id = account.id
   and billing_end.billing_start_id = billing_start.id
  where account.client_id = p_client_id
    and account.status in ('active', 'suspended')
    and billing_start.google_local_date <= p_period_end
    and (billing_end.id is null or billing_end.google_local_date >= p_period_start)
    and (account.list_commission_rate <> 10 or account.revenue_share_enabled);

  if incompatible_terms_count <> 0 then
    raise exception 'Custom list-rate or revenue-share terms are incompatible with v3 referral billing.'
      using errcode = '22023';
  end if;

  -- Require the same post-close, identity-bound, exact Google snapshot as v2.
  select
    count(*),
    count(*) filter (
      where upper(account.currency) = 'EUR'
        and billing_start.currency = 'EUR'
        and billing_start.google_ads_customer_id = account.google_ads_customer_id
        and not exists (
          select 1
          from public.commissions invalid_commission
          join public.revenue_sources invalid_source
            on invalid_source.id = invalid_commission.source_id
          where invalid_commission.ad_account_id = account.id
            and invalid_source.name = 'Google Ads Management'
            and invalid_commission.status = 'confirmed'
            and invalid_commission.occurred_on between
              greatest(p_period_start, billing_start.google_local_date)
              and least(p_period_end, coalesce(billing_end.google_local_date, p_period_end))
            and (
              upper(invalid_commission.currency) <> 'EUR'
              or invalid_commission.gross_amount < 0
            )
        )
        and exists (
          select 1
          from public.google_ledger_sync_windows sync
          where sync.ad_account_id = account.id
            and sync.billing_start_id = billing_start.id
            and (
              sync.billing_end_id is not distinct from billing_end.id
              or (billing_end.google_local_date > p_period_end and sync.billing_end_id is null)
            )
            and sync.period_start = p_period_start
            and sync.period_end = p_period_end
            and sync.status = 'complete'
            and (sync.synced_at at time zone billing_start.google_time_zone)::date > p_period_end
            and sync.ledger_snapshot = (
              select coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'id', commission.id::text,
                    'occurred_on', commission.occurred_on::text,
                    'gross_amount', to_char(
                      commission.gross_amount,
                      'FM999999999999999990.000000'
                    ),
                    'currency', upper(commission.currency),
                    'status', commission.status
                  ) order by commission.id
                ),
                '[]'::jsonb
              )
              from public.commissions commission
              join public.revenue_sources source on source.id = commission.source_id
              where commission.ad_account_id = account.id
                and source.name = 'Google Ads Management'
                and commission.status = 'confirmed'
                and commission.occurred_on between
                  greatest(p_period_start, billing_start.google_local_date)
                  and least(p_period_end, coalesce(billing_end.google_local_date, p_period_end))
            )
        )
    )
    into account_count, ready_account_count
  from public.ad_accounts account
  join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
  left join public.ad_account_billing_ends billing_end
    on billing_end.ad_account_id = account.id
   and billing_end.billing_start_id = billing_start.id
  where account.client_id = p_client_id
    and account.status in ('active', 'suspended')
    and billing_start.google_local_date <= p_period_end
    and (billing_end.id is null or billing_end.google_local_date >= p_period_start);

  if account_count = 0 then
    raise exception 'No client account had begun billing in this week.'
      using errcode = '22023';
  end if;
  if ready_account_count <> account_count then
    raise exception 'Every client account must be EUR and refreshed for the closed week.'
      using errcode = '22023';
  end if;

  if p_line_items is null
     or jsonb_typeof(p_line_items) <> 'array'
     or p_ledger_rows is null
     or jsonb_typeof(p_ledger_rows) <> 'array'
     or jsonb_array_length(p_line_items) = 0
     or jsonb_array_length(p_ledger_rows) = 0 then
    raise exception 'Settlement lines and ledger rows must be non-empty arrays.'
      using errcode = '22023';
  end if;

  requested_rows := jsonb_array_length(p_ledger_rows);

  select count(*) into valid_rows
  from public.manual_invoice_authoritative_rows(
    p_client_id, p_period_start, p_period_end
  ) authoritative
  join (
    select distinct value->>'commission_id' as commission_id
    from jsonb_array_elements(p_ledger_rows)
  ) requested on requested.commission_id = authoritative.commission_id::text;

  if valid_rows <> requested_rows then
    raise exception 'One or more ledger rows are duplicated, foreign, pre-start, post-end, out of period or not billable EUR Google spend.'
      using errcode = '22023';
  end if;

  select count(*), coalesce(sum(billable_gross_amount), 0)
    into expected_rows, billable_total
  from public.manual_invoice_authoritative_rows(
    p_client_id, p_period_start, p_period_end
  );

  if expected_rows <> requested_rows then
    raise exception 'The request must claim every Google ledger row for the client week.'
      using errcode = '22023';
  end if;
  if billable_total <= 0 then
    raise exception 'A week without positive billable Google spend has nothing to settle.'
      using errcode = '22023';
  end if;

  select
    count(*),
    count(distinct line->>'accountId'),
    coalesce(sum((line->>'amount')::numeric), 0)
    into expected_lines, distinct_line_accounts, lines_total
  from jsonb_array_elements(p_line_items) line;

  if distinct_line_accounts <> expected_lines then
    raise exception 'A settlement must contain exactly one line per included store.'
      using errcode = '22023';
  end if;
  if lines_total <> p_amount then
    raise exception 'Settlement amount does not equal its line-item total.'
      using errcode = '22023';
  end if;

  -- Reconstruct every visible field and the exact Stripe/local description.
  with requested as (
    select distinct value->>'commission_id' as commission_id
    from jsonb_array_elements(p_ledger_rows)
  ), per_store_exact as (
    select
      authoritative.account_id,
      authoritative.store_name,
      authoritative.billing_start_id,
      authoritative.billing_start_date,
      authoritative.billing_started_at,
      authoritative.billing_time_zone,
      max(authoritative.billing_start_baseline_micros) as start_baseline_micros,
      bool_or(authoritative.opening_baseline_applied) as opening_baseline_applied,
      authoritative.billing_end_id,
      authoritative.billing_end_date,
      authoritative.billing_ended_at,
      authoritative.billing_end_time_zone,
      authoritative.billing_end_counter_micros as end_counter_micros,
      bool_or(authoritative.ending_cap_applied) as ending_cap_applied,
      sum(authoritative.source_gross_amount) as source_gross_amount,
      sum(authoritative.baseline_deduction_amount) as baseline_deduction_amount,
      sum(authoritative.end_deduction_amount) as end_deduction_amount,
      sum(authoritative.billable_gross_amount) as billable_gross_amount
    from public.manual_invoice_authoritative_rows(
      p_client_id, p_period_start, p_period_end
    ) authoritative
    join requested on requested.commission_id = authoritative.commission_id::text
    group by
      authoritative.account_id,
      authoritative.store_name,
      authoritative.billing_start_id,
      authoritative.billing_start_date,
      authoritative.billing_started_at,
      authoritative.billing_time_zone,
      authoritative.billing_end_id,
      authoritative.billing_end_date,
      authoritative.billing_ended_at,
      authoritative.billing_end_time_zone,
      authoritative.billing_end_counter_micros
    -- Every positive-spend store remains in the immutable local invoice proof.
    -- Stripe receives only payable lines, but a store whose fee rounds to zero
    -- must not disappear from the admin/client audit trail.
    having sum(authoritative.billable_gross_amount) > 0
  ), per_store_values as (
    select
      exact.*,
      round(exact.source_gross_amount, 2) as source_gross_rounded,
      round(exact.baseline_deduction_amount, 2) as baseline_deduction_rounded,
      round(exact.end_deduction_amount, 2) as end_deduction_rounded,
      round(exact.billable_gross_amount, 2) as billable_gross_rounded,
      round(exact.start_baseline_micros / 1000000, 2) as start_baseline_rounded,
      round(exact.end_counter_micros / 1000000, 2) as end_counter_rounded,
      round(exact.billable_gross_amount * commercial_term.fee_rate / 100, 2)
        as fee_amount
    from per_store_exact exact
  ), per_store as (
    select
      value.*,
      value.store_name
      || ' - Google Ads agency fee ('
      || public.manual_referral_rate_text(commercial_term.fee_rate)
      || '% of captured Google-reported billable spend: EUR '
      || to_char(value.billable_gross_amount, 'FM999999999999999990.000000')
      || '; manual referral term: approved referral count '
      || commercial_term.referral_count::text
      || '; 10% - '
      || public.manual_referral_rate_text(commercial_term.referral_discount_rate)
      || ' percentage points = '
      || public.manual_referral_rate_text(commercial_term.fee_rate)
      || '%'
      || case
        when value.opening_baseline_applied and value.ending_cap_applied then
          '; billing started '
          || to_char(
               value.billing_started_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
          || '; billing ended '
          || to_char(
               value.billing_ended_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
          || ' at Google day counter EUR '
          || to_char(value.end_counter_micros / 1000000, 'FM999999999999999990.000000')
          || '; billable period '
          || value.billing_start_date::text
          || ' to '
          || value.billing_end_date::text
          || ' in '
          || value.billing_end_time_zone
          || '; Google-reported spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus opening baseline EUR '
          || to_char(value.baseline_deduction_amount, 'FM999999999999999990.000000')
          || ' minus post-service spend EUR '
          || to_char(value.end_deduction_amount, 'FM999999999999999990.000000')
        when value.opening_baseline_applied then
          '; billing started '
          || to_char(
               value.billing_started_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
          || '; first billable period '
          || value.billing_start_date::text
          || ' to '
          || p_period_end::text
          || ' in '
          || value.billing_time_zone
          || '; Google-reported spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus opening baseline EUR '
          || to_char(value.baseline_deduction_amount, 'FM999999999999999990.000000')
        when value.ending_cap_applied then
          '; billing ended '
          || to_char(
               value.billing_ended_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
          || ' at Google day counter EUR '
          || to_char(value.end_counter_micros / 1000000, 'FM999999999999999990.000000')
          || '; final billable period '
          || p_period_start::text
          || ' to '
          || value.billing_end_date::text
          || ' in '
          || value.billing_end_time_zone
          || '; Google-reported spend EUR '
          || to_char(value.source_gross_amount, 'FM999999999999999990.000000')
          || ' minus post-service spend EUR '
          || to_char(value.end_deduction_amount, 'FM999999999999999990.000000')
        else ''
      end
      || ')' as expected_label
    from per_store_values value
  )
  select count(*) into valid_lines
  from jsonb_array_elements(p_line_items) item
  cross join lateral jsonb_to_record(item) as line(
    "accountId" uuid,
    kind text,
    store text,
    label text,
    rate numeric,
    amount numeric,
    "listRate" numeric,
    "referralDiscountRate" numeric,
    "referralCount" integer,
    "baseAmount" numeric,
    "sourceGrossAmount" numeric,
    "baselineDeductionAmount" numeric,
    "billingStartBaselineAmount" numeric,
    "billingStartId" uuid,
    "billingStartDate" date,
    "billingStartedAt" timestamptz,
    "billingTimeZone" text,
    "billingEndId" uuid,
    "billingEndDate" date,
    "billingEndedAt" timestamptz,
    "billingEndTimeZone" text,
    "billingEndCounterAmount" numeric,
    "endingCapApplied" boolean,
    "endDeductionAmount" numeric
  )
  join per_store store on store.account_id = line."accountId"
  where line.kind = 'fee'
    and line.store = store.store_name
    and line.rate = commercial_term.fee_rate
    and line."listRate" = commercial_term.list_rate
    and line."referralDiscountRate" = commercial_term.referral_discount_rate
    and line."referralCount" = commercial_term.referral_count
    and line.amount = store.fee_amount
    and line."baseAmount" = store.billable_gross_rounded
    and line."sourceGrossAmount" = store.source_gross_rounded
    and line."billingStartBaselineAmount" = store.start_baseline_rounded
    and line."billingStartId" = store.billing_start_id
    and line."billingStartDate" = store.billing_start_date
    and line."billingStartedAt" = store.billing_started_at
    and line."billingTimeZone" = store.billing_time_zone
    and (
      (
        store.opening_baseline_applied
        and item ? 'baselineDeductionAmount'
        and line."baselineDeductionAmount" = store.baseline_deduction_rounded
      )
      or (
        not store.opening_baseline_applied
        and not (item ? 'baselineDeductionAmount')
      )
    )
    and (
      (
        store.ending_cap_applied
        and item ? 'billingEndId'
        and item ? 'billingEndDate'
        and item ? 'billingEndedAt'
        and item ? 'billingEndTimeZone'
        and item ? 'billingEndCounterAmount'
        and item ? 'endingCapApplied'
        and item ? 'endDeductionAmount'
        and line."billingEndId" = store.billing_end_id
        and line."billingEndDate" = store.billing_end_date
        and line."billingEndedAt" = store.billing_ended_at
        and line."billingEndTimeZone" = store.billing_end_time_zone
        and line."billingEndCounterAmount" = store.end_counter_rounded
        and line."endingCapApplied" is true
        and line."endDeductionAmount" = store.end_deduction_rounded
      )
      or (
        not store.ending_cap_applied
        and not (item ? 'billingEndId')
        and not (item ? 'billingEndDate')
        and not (item ? 'billingEndedAt')
        and not (item ? 'billingEndTimeZone')
        and not (item ? 'billingEndCounterAmount')
        and not (item ? 'endingCapApplied')
        and not (item ? 'endDeductionAmount')
      )
    )
    and line.label = store.expected_label;

  if valid_lines <> expected_lines
     or expected_lines <> (
       select count(*) from (
         select authoritative.account_id
         from public.manual_invoice_authoritative_rows(
           p_client_id, p_period_start, p_period_end
         ) authoritative
         group by authoritative.account_id
         having sum(authoritative.billable_gross_amount) > 0
       ) stores
     ) then
    raise exception 'Settlement lines do not match the v3 manual referral rate and Google boundary evidence per store.'
      using errcode = '22023';
  end if;

  perform set_config('dropscale.manual_referral_invoice_rpc', 'on', true);
  insert into public.invoices (
    client_id,
    period_start,
    period_end,
    amount,
    currency,
    status,
    due_date,
    line_items,
    amount_remaining,
    issued_at,
    issued_by,
    issue_attempted_at,
    calculation_version,
    referral_discount_term_id,
    billing_recipient
  ) values (
    p_client_id,
    p_period_start,
    p_period_end,
    p_amount,
    'EUR',
    case when p_amount = 0 then 'waived' else 'draft' end,
    case when p_amount = 0 then null else business_day + 7 end,
    p_line_items,
    case when p_amount = 0 then 0 else null end,
    case when p_amount = 0 then now() else null end,
    p_issued_by,
    now(),
    p_calculation_version,
    commercial_term.term_id,
    p_billing_recipient
  ) returning * into created_invoice;

  if commercial_term.term_id is not null then
    insert into public.invoice_referral_events (
      invoice_id,
      referral_discount_term_id,
      referral_discount_term_item_id
    )
    select created_invoice.id, item.term_id, item.id
    from public.referral_discount_term_items item
    where item.term_id = commercial_term.term_id;

    get diagnostics referral_events_count = row_count;
    if referral_events_count <> commercial_term.referral_count then
      raise exception 'The invoice did not freeze every approved referral grant.'
        using errcode = '22023';
    end if;
  elsif commercial_term.referral_count <> 0 then
    raise exception 'A default referral term cannot contain grants.'
      using errcode = '22023';
  end if;

  insert into public.invoice_commission_rows (
    invoice_id,
    commission_id,
    gross_amount,
    billing_start_id,
    baseline_deduction_amount,
    billing_end_id,
    end_deduction_amount,
    billable_gross_amount,
    currency
  )
  select
    created_invoice.id,
    authoritative.commission_id,
    round(authoritative.source_gross_amount, 6),
    authoritative.billing_start_id,
    round(authoritative.baseline_deduction_amount, 6),
    authoritative.billing_end_id,
    case when authoritative.ending_cap_applied
      then round(authoritative.end_deduction_amount, 6)
    end,
    round(authoritative.billable_gross_amount, 6),
    'EUR'
  from public.manual_invoice_authoritative_rows(
    p_client_id, p_period_start, p_period_end
  ) authoritative
  join (
    select distinct value->>'commission_id' as commission_id
    from jsonb_array_elements(p_ledger_rows)
  ) requested on requested.commission_id = authoritative.commission_id::text;

  if not found then
    raise exception 'No EUR Google ledger rows were claimed.'
      using errcode = '22023';
  end if;

  if (select count(*) from public.invoice_commission_rows where invoice_id = created_invoice.id)
     <> requested_rows then
    raise exception 'Every requested ledger row must be claimed exactly once.'
      using errcode = '22023';
  end if;

  return next created_invoice;
end
$$;

revoke all on function public.create_manual_referral_invoice(
  uuid, date, date, numeric, jsonb, jsonb, jsonb, uuid, uuid, text
) from public, authenticated, anon;
grant execute on function public.create_manual_referral_invoice(
  uuid, date, date, numeric, jsonb, jsonb, jsonb, uuid, uuid, text
) to service_role;

-- Once manual terms exist, the old fixed-10% creation path would be a bypass.
-- Historic v2 rows remain readable; only creation authority moves to v3.
revoke execute on function public.create_manual_invoice(
  uuid, date, date, numeric, jsonb, jsonb, uuid, text
) from service_role;
