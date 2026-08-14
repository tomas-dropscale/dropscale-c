-- =============================================================================
-- 0055 - Normalized V2 reporting anchors without rewriting legacy history.
--
-- ad_accounts remains the stable foreign-key used by daily_metrics, products,
-- campaigns and financial evidence. New V2 rows use that surrogate only: the
-- credentials and authoritative asset identities remain in the V2 connection
-- tables and are linked through the audited bindings introduced by 0054.
-- =============================================================================

create or replace function public.normalize_shopify_reporting_domain(p_value text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select nullif(lower(regexp_replace(
    regexp_replace(btrim(p_value), '^https?://', '', 'i'),
    '/.*$',
    ''
  )), '')
$$;

alter table public.ad_accounts
  add column reporting_role text not null default 'legacy_hybrid';

alter table public.ad_accounts
  add constraint ad_accounts_reporting_role_check check (
    reporting_role in ('legacy_hybrid', 'shopify_anchor', 'google_spend')
  ),
  add constraint ad_accounts_reporting_role_shape check (
    reporting_role = 'legacy_hybrid'
    or (
      reporting_role = 'shopify_anchor'
      and (google_ads_customer_id is not null or status = 'pending')
      and shopify_url is not null
      and shopify_connected = false
      and shopify_client_id is null
      and shopify_scopes is null
      and shopify_admin_token is null
      and shopify_token_last4 is null
      and shopify_connected_at is null
      and google_ads_refresh_token is null
      and google_ads_connected_email is null
      and google_ads_connected = false
    )
    or (
      reporting_role = 'google_spend'
      and google_ads_customer_id is not null
      and shopify_url is null
      and shopify_connected = false
      and shopify_client_id is null
      and shopify_scopes is null
      and shopify_admin_token is null
      and shopify_token_last4 is null
      and shopify_connected_at is null
      and google_ads_refresh_token is null
      and google_ads_connected_email is null
      and google_ads_connected = false
    )
  );

comment on column public.ad_accounts.reporting_role is
  'Stable metric surrogate role. Legacy rows remain hybrid; V2 Shopify facts and Google spend children keep credentials in their purpose-bound connection tables.';

-- `v2_active` predates normalized reporting and therefore cannot prove that a
-- client passed the binding/backfill gate below. Historical rows intentionally
-- receive NULL: only activate_client_reporting_cutover may set this marker.
alter table public.client_rollout_states
  add column reporting_cutover_at timestamptz,
  add column reporting_cutover_by uuid
    references public.profiles(id) on delete restrict,
  add column reporting_cutover_reason text,
  add constraint client_rollout_states_reporting_cutover_shape check (
    (
      reporting_cutover_at is null
      and reporting_cutover_by is null
      and reporting_cutover_reason is null
    )
    or (
      reporting_cutover_at is not null
      and reporting_cutover_by is not null
      and reporting_cutover_reason is not null
      and reporting_cutover_reason = btrim(reporting_cutover_reason)
      and length(reporting_cutover_reason) between 3 and 500
    )
  );

comment on column public.client_rollout_states.reporting_cutover_at is
  'Proof that normalized reporting passed exact binding coverage and the required 90-day post-binding backfill gate.';

create or replace function public.legacy_asset_writes_allowed(p_client_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select not exists (
    select 1 from public.client_rollout_states rollout
    where rollout.client_id = p_client_id
      and rollout.operational_surface = 'v2_active'
      and rollout.reporting_cutover_at is not null
  )
$$;

create or replace function public.guard_client_reporting_cutover_marker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  purpose_bound_write boolean := false;
begin
  if tg_op = 'DELETE' then
    if old.reporting_cutover_at is not null then
      raise exception 'A reporting cutover marker is durable and cannot be deleted.'
        using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.reporting_cutover_at is not null then
      raise exception 'Only the reporting cutover RPC may set its marker.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  purpose_bound_write :=
    auth.role() is not distinct from 'service_role'
    and current_setting('dropscale.reporting_cutover_marker', true)
          is not distinct from new.client_id::text;

  if new.reporting_cutover_at is distinct from old.reporting_cutover_at
    or new.reporting_cutover_by is distinct from old.reporting_cutover_by
    or new.reporting_cutover_reason is distinct from old.reporting_cutover_reason
  then
    if old.reporting_cutover_at is not null
      or not purpose_bound_write
      or new.client_id is distinct from old.client_id
      or new.operational_surface <> 'v2_active'
      or new.reporting_cutover_at is null
      or new.reporting_cutover_by is null
      or new.reporting_cutover_reason is null
      or new.updated_by is distinct from new.reporting_cutover_by
      or new.reporting_cutover_at < clock_timestamp() - interval '1 minute'
      or new.reporting_cutover_at > clock_timestamp() + interval '1 minute'
    then
      raise exception 'A reporting cutover marker is immutable and purpose-bound.'
        using errcode = '23514';
    end if;
  end if;

  -- A rollback makes the historical marker inactive. It cannot later be
  -- reused by a generic lifecycle update; reactivation needs a future
  -- purpose-bound reporting workflow that revalidates sources and receipts.
  if old.reporting_cutover_at is not null
    and old.operational_surface <> 'v2_active'
    and new.operational_surface = 'v2_active'
    and not purpose_bound_write
  then
    raise exception 'A rolled-back reporting cutover cannot be reactivated generically.'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger client_rollout_states_guard_reporting_cutover_marker
  before insert or update or delete on public.client_rollout_states
  for each row execute function public.guard_client_reporting_cutover_marker();

create or replace function public.guard_client_reporting_cutover_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_is_reporting boolean := false;
  new_is_reporting boolean := false;
  event_client_id uuid;
begin
  if tg_op <> 'INSERT' then
    old_is_reporting := old.event_type = 'activated'
      and old.details ->> 'reportingBindings' = 'true';
  end if;
  if tg_op <> 'DELETE' then
    new_is_reporting := new.event_type = 'activated'
      and new.details ->> 'reportingBindings' = 'true';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old_is_reporting then
    raise exception 'A reporting cutover audit event is immutable.'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new_is_reporting then
    raise exception 'A reporting cutover audit event cannot be manufactured by update.'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new_is_reporting then
    select session.claimed_user_id into event_client_id
    from public.client_onboarding_sessions session
    where session.id = new.session_id;
    if event_client_id is null
      or auth.role() is distinct from 'service_role'
      or current_setting('dropscale.reporting_cutover_marker', true)
           is distinct from event_client_id::text
      or not exists (
        select 1 from public.client_rollout_states rollout
        where rollout.client_id = event_client_id
          and rollout.operational_surface = 'v2_active'
          and rollout.reporting_cutover_at is not null
          and rollout.reporting_cutover_by = new.actor_id
          and rollout.reporting_cutover_reason = new.details ->> 'reason'
          and new.details ->> 'reportingCutoverAt'
                = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
      )
    then
      raise exception 'A reporting cutover event must match its purpose-bound marker.'
        using errcode = '23514';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger client_onboarding_events_guard_reporting_cutover
  before insert or update or delete on public.client_onboarding_events
  for each row execute function public.guard_client_reporting_cutover_event();

do $$
declare
  duplicate_domain text;
begin
  select public.normalize_shopify_reporting_domain(account.shopify_url)
    into duplicate_domain
  from public.ad_accounts account
  where account.shopify_url is not null
  group by public.normalize_shopify_reporting_domain(account.shopify_url)
  having count(*) > 1
  limit 1;

  if duplicate_domain is not null then
    raise exception 'Cannot normalize reporting anchors: Shopify domain % belongs to multiple ad accounts.',
      duplicate_domain using errcode = '23505';
  end if;
end
$$;

create unique index ad_accounts_shopify_reporting_domain_uq
  on public.ad_accounts(public.normalize_shopify_reporting_domain(shopify_url))
  where shopify_url is not null;

-- Browser/admin writes may not manufacture normalized source rows or turn one
-- source family into another. The one permitted role change is a purpose-bound
-- service RPC adopting a pristine pending legacy row.
create or replace function public.guard_ad_account_reporting_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.reporting_role <> 'legacy_hybrid'
      and auth.role() is distinct from 'service_role'
    then
      raise exception 'Only the reporting service can provision a normalized ad account.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- Purpose-bound adoption may populate only previously-null source identity
  -- fields from the locked V2 rows in provision_client_reporting_anchor.
  if old.reporting_role = 'legacy_hybrid'
    and new.reporting_role = 'shopify_anchor'
    and auth.role() is not distinct from 'service_role'
    and old.status = 'pending'
    and new.status is not distinct from old.status
    and new.client_id is not distinct from old.client_id
    and new.created_at is not distinct from old.created_at
    and current_setting('dropscale.reporting_anchor_adoption', true) = old.id::text
  then
    if (
      old.shopify_url is not null
      and new.shopify_url is distinct from old.shopify_url
    ) or (
      old.google_ads_customer_id is not null
      and new.google_ads_customer_id is distinct from old.google_ads_customer_id
    )
    then
      raise exception 'Adoption cannot replace an existing source identity.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.reporting_role is distinct from old.reporting_role then
    if auth.role() is distinct from 'service_role'
      or old.reporting_role <> 'legacy_hybrid'
      or new.reporting_role <> 'shopify_anchor'
      or old.status <> 'pending'
      or new.status is distinct from old.status
      or new.client_id is distinct from old.client_id
      or new.created_at is distinct from old.created_at
      or current_setting('dropscale.reporting_anchor_adoption', true)
           is distinct from old.id::text
    then
      raise exception 'An ad account reporting role is immutable.' using errcode = '23514';
    end if;
  end if;

  if old.reporting_role <> 'legacy_hybrid' and (
    new.client_id is distinct from old.client_id
    or new.reporting_role is distinct from old.reporting_role
    or new.shopify_url is distinct from old.shopify_url
    or new.google_ads_customer_id is distinct from old.google_ads_customer_id
    or new.currency is distinct from old.currency
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'A normalized reporting source identity is immutable.' using errcode = '23514';
  end if;

  if old.reporting_role = 'shopify_anchor'
    and old.google_ads_customer_id is null
    and new.status is distinct from old.status
  then
    raise exception 'A Shopify-only fact anchor remains pending; its active binding is the operational state.'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger ad_accounts_guard_reporting_role
  before insert or update on public.ad_accounts
  for each row execute function public.guard_ad_account_reporting_role();

-- Currency determines aggregation and day windows, so it becomes part of a
-- bound source identity in 0055. Names, health timestamps and error metadata
-- remain mutable; changing owner/source/currency still requires revoke/rebind.
create or replace function public.guard_bound_shopify_connection_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.shopify_connection_id = old.id and binding.status = 'active'
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Revoke the client reporting binding before changing its Shopify source identity.'
      using errcode = '23514';
  end if;
  if new.client_id is distinct from old.client_id
    or new.shopify_domain is distinct from old.shopify_domain
    or new.shopify_currency is distinct from old.shopify_currency
    or new.status is distinct from old.status
  then
    raise exception 'Revoke the client reporting binding before changing its Shopify source identity.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.guard_bound_google_ads_connection_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  purpose_bound_metadata_fill boolean := false;
begin
  if not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.google_ads_connection_id = old.id and binding.status = 'active'
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Revoke the client reporting binding before changing its Google Ads source identity.'
      using errcode = '23514';
  end if;

  -- Older connected rows may have been bound before account currency/timezone
  -- inventory became mandatory. Only the exact metadata-proof RPC may fill a
  -- missing value underneath that binding; an existing value remains part of
  -- the immutable source identity.
  purpose_bound_metadata_fill :=
    auth.role() is not distinct from 'service_role'
    and current_setting('dropscale.google_reporting_identity_refresh', true)
          is not distinct from old.id::text
    and (new.currency is not distinct from old.currency
      or (old.currency is null and new.currency ~ '^[A-Z]{3}$'))
    and (new.time_zone is not distinct from old.time_zone
      or (
        nullif(btrim(coalesce(old.time_zone, '')), '') is null
        and nullif(btrim(coalesce(new.time_zone, '')), '') is not null
      ));

  if new.client_id is distinct from old.client_id
    or new.windsor_account_id is distinct from old.windsor_account_id
    or (
      (
        new.currency is distinct from old.currency
        or new.time_zone is distinct from old.time_zone
      )
      and not purpose_bound_metadata_fill
    )
    or new.status is distinct from old.status
  then
    raise exception 'Revoke the client reporting binding before changing its Google Ads source identity.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

-- A live V2 workspace may not lose an operational source behind the portal's
-- back. The only in-place replacement is the exact pair-upgrade transaction
-- below, which revokes and recommits before the transaction can become
-- visible. A future support rollback must first demote the rollout explicitly.
create or replace function public.guard_client_reporting_binding_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A client reporting binding cannot be deleted.' using errcode = '23514';
  end if;
  if new.id is distinct from old.id
    or new.client_id is distinct from old.client_id
    or new.ad_account_id is distinct from old.ad_account_id
    or new.shopify_connection_id is distinct from old.shopify_connection_id
    or new.google_ads_connection_id is distinct from old.google_ads_connection_id
    or new.shopify_anchor_binding_id is distinct from old.shopify_anchor_binding_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.bound_reason is distinct from old.bound_reason
    or new.bound_by is distinct from old.bound_by
    or new.bound_at is distinct from old.bound_at
    or old.status <> 'active'
    or new.status <> 'revoked'
    or new.revoked_by is null
    or new.revoked_at is null
    or new.revoke_reason is null
  then
    raise exception 'A client reporting binding identity is immutable.' using errcode = '23514';
  end if;
  if exists (
      select 1 from public.client_rollout_states rollout
      where rollout.client_id = old.client_id
        and rollout.operational_surface = 'v2_active'
        and rollout.reporting_cutover_at is not null
    )
    and current_setting('dropscale.reporting_pair_upgrade', true)
          is distinct from old.id::text
  then
    raise exception 'Demote the V2 rollout before revoking an operational reporting binding.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

-- Preserve the 0028 billing contract while admitting service-provisioned V2
-- rows. Shopify-only anchors can never cross the billing status boundary. A
-- pair anchor or Google spend child starts pending and the existing immutable
-- billing-start RPC is still the only path to active.
create or replace function public.guard_ad_account_billing_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_google_customer_id text := new.google_ads_customer_id;
begin
  if raw_google_customer_id is not null
     and raw_google_customer_id !~ '^[0-9[:space:]-]+$' then
    raise exception 'A Google Ads customer id may contain only digits, spaces and hyphens.';
  end if;

  new.google_ads_customer_id :=
    public.normalize_google_ads_customer_id(raw_google_customer_id);

  if new.google_ads_customer_id is not null
     and new.google_ads_customer_id !~ '^[0-9]{10}$' then
    raise exception 'A Google Ads customer id must contain exactly 10 digits.';
  end if;

  if tg_op = 'INSERT' then
    if new.reporting_role <> 'legacy_hybrid' then
      if auth.role() is distinct from 'service_role' or new.status <> 'pending' then
        raise exception 'A normalized reporting account must be provisioned pending by the service.'
          using errcode = '42501';
      end if;
      return new;
    end if;

    if auth.uid() is not null and not public.is_admin() then
      new.status := 'pending';
      new.created_at := now();
      new.currency := 'EUR';
      new.google_ads_refresh_token := null;
      new.google_ads_connected_email := null;
      new.google_ads_connected := false;
      new.list_commission_rate := 10;
      new.commission_rate := public.effective_commission_rate(new.client_id, 10);
      new.revenue_share_enabled := false;
    end if;

    if new.status <> 'pending' then
      raise exception 'An approved Google account requires a committed billing start.';
    end if;
    return new;
  end if;

  if auth.uid() is not null and not public.is_admin() then
    if new.created_at is distinct from old.created_at then
      raise exception 'An ad account creation date is immutable.';
    end if;
    if new.currency is distinct from old.currency then
      raise exception 'Only the team can change an ad account currency.';
    end if;
  end if;

  if exists (
       select 1
       from public.ad_account_billing_starts billing_start
       where billing_start.ad_account_id = old.id
         and (
           new.google_ads_customer_id is distinct from billing_start.google_ads_customer_id
           or new.client_id is distinct from old.client_id
         )
     ) then
    raise exception 'An account with a Google billing start cannot change billing identity or owner.';
  end if;

  if old.status = 'pending'
     and new.status in ('active', 'suspended')
     and old.google_ads_customer_id is not null
     and not exists (
       select 1 from public.ad_account_billing_starts billing_start
       where billing_start.ad_account_id = old.id
     ) then
    raise exception 'An approved Google account requires a committed billing start.';
  end if;

  if new.google_ads_customer_id is distinct from old.google_ads_customer_id
     and exists (
       select 1 from public.commissions commission
       where commission.ad_account_id = old.id
     ) then
    raise exception 'A Google billing identity with ledger history cannot be replaced.';
  end if;

  if new.google_ads_customer_id is distinct from old.google_ads_customer_id
     and auth.uid() is not null
     and (
       old.status <> 'pending'
       or new.status <> 'pending'
       or old.google_ads_connected
     ) then
    raise exception 'Disconnect Google first; an approved Google billing identity can only be changed by the server.';
  end if;

  if old.status <> 'pending'
     and new.status = 'pending'
     and (
       exists (
         select 1 from public.ad_account_billing_starts billing_start
         where billing_start.ad_account_id = old.id
       )
       or exists (
         select 1 from public.commissions commission
         where commission.ad_account_id = old.id
       )
     ) then
    raise exception 'An ad account with a billing boundary or ledger history cannot return to pending.';
  end if;

  if new.client_id is distinct from old.client_id
     and exists (
       select 1 from public.commissions commission
       where commission.ad_account_id = old.id
     ) then
    raise exception 'An ad account with ledger history cannot be reassigned.';
  end if;

  return new;
end
$$;

-- A normalized metric row belongs to one source family. A combined Shopify +
-- Google pair is represented by one active pair binding; otherwise a Shopify
-- anchor must never acquire Google figures and a Google child must never
-- acquire Shopify facts.
create or replace function public.guard_normalized_daily_metric_family()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_role text;
  prior_role text;
  active_binding_found boolean := false;
  active_binding_has_google boolean := false;
begin
  select account.reporting_role into target_role
  from public.ad_accounts account
  where account.id = new.ad_account_id;

  if tg_op = 'UPDATE' and new.ad_account_id is distinct from old.ad_account_id then
    select account.reporting_role into prior_role
    from public.ad_accounts account
    where account.id = old.ad_account_id;
    if target_role <> 'legacy_hybrid' or prior_role <> 'legacy_hybrid' then
      raise exception 'A normalized daily metric cannot be reassigned to another source.'
        using errcode = '23514';
    end if;
  end if;

  if target_role = 'shopify_anchor' then
    select true, binding.google_ads_connection_id is not null
      into active_binding_found, active_binding_has_google
    from public.client_reporting_bindings binding
    where binding.ad_account_id = new.ad_account_id
      and binding.status = 'active'
      and binding.shopify_connection_id is not null;

    if not active_binding_found then
      raise exception 'A normalized metric row requires an active reporting binding.'
        using errcode = '23514';
    end if;

    if not active_binding_has_google and (
      new.ad_spend <> 0
      or new.impressions <> 0
      or new.clicks <> 0
      or new.conversions <> 0
      or new.conversion_value <> 0
    ) then
      raise exception 'A Shopify-only fact anchor cannot store Google metrics.'
        using errcode = '23514';
    end if;
  elsif target_role = 'google_spend' then
    select true into active_binding_found
    from public.client_reporting_bindings binding
    where binding.ad_account_id = new.ad_account_id
      and binding.status = 'active'
      and binding.shopify_connection_id is null
      and binding.google_ads_connection_id is not null;

    if not active_binding_found then
      raise exception 'A normalized metric row requires an active reporting binding.'
        using errcode = '23514';
    end if;

    if new.revenue <> 0
      or new.orders_count <> 0
      or new.refunds_amount <> 0
      or new.product_cost <> 0
      or new.payment_fees <> 0
      or new.shipping_cost <> 0
      or new.revenue_share_base <> 0
      or new.revenue_share_amount <> 0
      or new.units_sold <> 0
      or coalesce(new.attributed_orders, 0) <> 0
      or coalesce(new.attributed_revenue, 0) <> 0
    then
      raise exception 'A Google spend child cannot store Shopify metrics.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

create trigger daily_metrics_guard_normalized_family
  before insert or update on public.daily_metrics
  for each row execute function public.guard_normalized_daily_metric_family();

-- Existing child-table policies chain through these three helpers. A
-- normalized surrogate becomes a client-owned operational row only while its
-- audited binding is active; an unbound/revoked pending surrogate stays
-- invisible. Source-family triggers below still prevent Google children from
-- acquiring Shopify products/COGS or mixed daily facts.
create or replace function public.owns_ad_account(p_ad_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.ad_accounts account
    where account.id = p_ad_account_id
      and public.is_client_member(account.client_id)
      and (
        account.reporting_role = 'legacy_hybrid'
        or exists (
          select 1 from public.client_reporting_bindings binding
          where binding.ad_account_id = account.id
            and binding.status = 'active'
        )
      )
  )
$$;

-- Normalized facts are written by the server adapter, never by a browser
-- session. Keep the historical client-session recompute contract for legacy
-- rows while leaving the existing SELECT policy untouched for V2 projections.
drop policy if exists daily_metrics_insert_own on public.daily_metrics;
create policy daily_metrics_insert_own on public.daily_metrics
  for insert with check (
    exists (
      select 1 from public.ad_accounts account
      where account.id = ad_account_id
        and account.reporting_role = 'legacy_hybrid'
        and public.legacy_asset_writes_allowed(account.client_id)
        and (
          public.is_admin()
          or public.owns_ad_account(account.id)
        )
    )
  );

drop policy if exists daily_metrics_update_own on public.daily_metrics;
create policy daily_metrics_update_own on public.daily_metrics
  for update using (
    exists (
      select 1 from public.ad_accounts account
      where account.id = ad_account_id
        and account.reporting_role = 'legacy_hybrid'
        and public.legacy_asset_writes_allowed(account.client_id)
        and (
          public.is_admin()
          or public.owns_ad_account(account.id)
        )
    )
  ) with check (
    exists (
      select 1 from public.ad_accounts account
      where account.id = ad_account_id
        and account.reporting_role = 'legacy_hybrid'
        and public.legacy_asset_writes_allowed(account.client_id)
        and (
          public.is_admin()
          or public.owns_ad_account(account.id)
        )
    )
  );

drop policy if exists daily_metrics_admin_delete on public.daily_metrics;
create policy daily_metrics_admin_delete on public.daily_metrics
  for delete using (
    exists (
      select 1 from public.ad_accounts account
      where account.id = ad_account_id
        and account.reporting_role = 'legacy_hybrid'
        and public.legacy_asset_writes_allowed(account.client_id)
        and public.is_admin()
    )
  );

create or replace function public.owns_store_product(p_product_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.store_products product
    join public.ad_accounts account on account.id = product.ad_account_id
    where product.id = p_product_id
      and public.is_client_member(account.client_id)
      and (
        account.reporting_role = 'legacy_hybrid'
        or (
          account.reporting_role = 'shopify_anchor'
          and exists (
            select 1 from public.client_reporting_bindings binding
            where binding.ad_account_id = account.id
              and binding.status = 'active'
              and binding.shopify_connection_id is not null
          )
        )
      )
  )
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
    from public.cogs_collections collection
    join public.ad_accounts account on account.id = collection.ad_account_id
    where collection.id = p_collection_id
      and public.is_client_member(account.client_id)
      and (
        account.reporting_role = 'legacy_hybrid'
        or (
          account.reporting_role = 'shopify_anchor'
          and exists (
            select 1 from public.client_reporting_bindings binding
            where binding.ad_account_id = account.id
              and binding.status = 'active'
              and binding.shopify_connection_id is not null
          )
        )
      )
  )
$$;

create or replace function public.guard_normalized_shopify_child_family()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_role text;
  prior_role text;
begin
  select account.reporting_role into target_role
  from public.ad_accounts account
  where account.id = new.ad_account_id;

  if tg_op = 'UPDATE' and new.ad_account_id is distinct from old.ad_account_id then
    select account.reporting_role into prior_role
    from public.ad_accounts account
    where account.id = old.ad_account_id;
    if target_role <> 'legacy_hybrid' or prior_role <> 'legacy_hybrid' then
      raise exception 'A normalized Shopify child cannot be reassigned to another source.'
        using errcode = '23514';
    end if;
  end if;

  if target_role = 'google_spend' then
    raise exception 'A Google spend child cannot own Shopify products or COGS.'
      using errcode = '23514';
  end if;
  if target_role = 'shopify_anchor' and not exists (
    select 1 from public.client_reporting_bindings binding
    where binding.ad_account_id = new.ad_account_id
      and binding.status = 'active'
      and binding.shopify_connection_id is not null
  ) then
    raise exception 'A normalized Shopify child requires an active anchor binding.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger store_products_guard_normalized_family
  before insert or update on public.store_products
  for each row execute function public.guard_normalized_shopify_child_family();

create trigger cogs_collections_guard_normalized_family
  before insert or update on public.cogs_collections
  for each row execute function public.guard_normalized_shopify_child_family();

-- Hide normalized surrogates from the legacy portal. The V2 portal projects
-- only active audited bindings through its server adapter, so a pending
-- Shopify anchor is operational without becoming a legacy pending request.
drop policy if exists ad_accounts_select_own on public.ad_accounts;
create policy ad_accounts_select_own on public.ad_accounts
  for select using (
    public.is_admin()
    or (
      reporting_role = 'legacy_hybrid'
      and public.can_open_workspace(client_id)
    )
  );

drop policy if exists ad_accounts_insert_own on public.ad_accounts;
create policy ad_accounts_insert_own on public.ad_accounts
  for insert with check (
    public.is_admin()
    or (
      reporting_role = 'legacy_hybrid'
      and public.can_open_workspace(client_id)
      and public.legacy_asset_writes_allowed(client_id)
    )
  );

drop policy if exists ad_accounts_update_own on public.ad_accounts;
create policy ad_accounts_update_own on public.ad_accounts
  for update using (
    public.is_admin()
    or (
      reporting_role = 'legacy_hybrid'
      and public.is_client_member(client_id)
      and public.legacy_asset_writes_allowed(client_id)
    )
  ) with check (
    public.is_admin()
    or (
      reporting_role = 'legacy_hybrid'
      and public.is_client_member(client_id)
      and public.legacy_asset_writes_allowed(client_id)
    )
  );

create table public.client_reporting_anchor_events (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null
    references public.client_reporting_bindings(id) on delete restrict,
  prior_binding_id uuid
    references public.client_reporting_bindings(id) on delete restrict,
  ad_account_id uuid not null
    references public.ad_accounts(id) on delete restrict,
  event_type text not null check (event_type in ('provisioned', 'adopted', 'upgraded')),
  idempotency_key text not null unique,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint client_reporting_anchor_events_key_shape check (
    idempotency_key = btrim(idempotency_key)
    and length(idempotency_key) between 8 and 100
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint client_reporting_anchor_events_reason_shape check (
    reason = btrim(reason) and length(reason) between 3 and 500
  ),
  constraint client_reporting_anchor_events_details_object check (
    jsonb_typeof(details) = 'object'
  ),
  constraint client_reporting_anchor_events_no_secret_keys check (
    not (details ?| array[
      'token', 'token_hash', 'invite_token', 'invite_token_hash',
      'client_secret', 'access_token', 'ciphertext', 'password', 'api_key'
    ])
  )
);

create index client_reporting_anchor_events_account_created_idx
  on public.client_reporting_anchor_events(ad_account_id, created_at desc);

alter table public.client_reporting_anchor_events enable row level security;
revoke all on table public.client_reporting_anchor_events
  from public, anon, authenticated, service_role;
grant select on table public.client_reporting_anchor_events to service_role;

create or replace function public.guard_client_reporting_anchor_event_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'A reporting anchor event is immutable.' using errcode = '23514';
end
$$;

create trigger client_reporting_anchor_events_guard_immutable
  before update or delete on public.client_reporting_anchor_events
  for each row execute function public.guard_client_reporting_anchor_event_immutable();

-- A binding is only a source-identity decision. This receipt proves the
-- reporting adapter subsequently wrote a complete source window. Rows are
-- service-readable but can only be changed through the validation RPC below.
create table public.client_reporting_sync_states (
  binding_id uuid not null
    references public.client_reporting_bindings(id) on delete restrict,
  source_type text not null check (source_type in ('shopify', 'google_ads')),
  last_success_at timestamptz not null,
  last_success_from date not null,
  last_success_to date not null,
  source_currency text not null check (source_currency ~ '^[A-Z]{3}$'),
  row_count integer not null check (row_count >= 0),
  primary key (binding_id, source_type),
  constraint client_reporting_sync_states_window check (
    last_success_to >= last_success_from
  )
);

alter table public.client_reporting_sync_states enable row level security;
revoke all on table public.client_reporting_sync_states
  from public, anon, authenticated, service_role;
grant select on table public.client_reporting_sync_states to service_role;

create or replace function public.guard_client_reporting_sync_state_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A reporting sync receipt cannot be deleted.' using errcode = '23514';
  end if;
  if current_setting('dropscale.reporting_sync_receipt', true)
       is distinct from new.binding_id::text || ':' || new.source_type
    or (
      tg_op = 'UPDATE'
      and (
        new.binding_id is distinct from old.binding_id
        or new.source_type is distinct from old.source_type
        or new.last_success_at <= old.last_success_at
      )
    )
  then
    raise exception 'A reporting sync receipt may only be advanced by its service RPC.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger client_reporting_sync_states_guard_write
  before insert or update or delete on public.client_reporting_sync_states
  for each row execute function public.guard_client_reporting_sync_state_write();

create or replace function public.record_client_reporting_sync_success(
  p_binding_id uuid,
  p_source_type text,
  p_success_from date,
  p_success_to date,
  p_source_currency text,
  p_row_count integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_binding public.client_reporting_bindings%rowtype;
  expected_currency text;
  receipt_time timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can record a sync receipt.'
      using errcode = '42501';
  end if;
  if p_binding_id is null
    or p_source_type not in ('shopify', 'google_ads')
    or p_success_from is null
    or p_success_to is null
    or p_success_to < p_success_from
    or p_success_to > current_date + 1
    or coalesce(p_source_currency, '') !~ '^[A-Z]{3}$'
    or p_row_count is null
    or p_row_count < 0
  then
    raise exception 'Invalid reporting sync receipt.' using errcode = '22023';
  end if;

  select * into target_binding
  from public.client_reporting_bindings binding
  where binding.id = p_binding_id and binding.status = 'active'
  for share;
  if not found then
    raise exception 'Active reporting binding not found.' using errcode = 'P0002';
  end if;

  if p_source_type = 'shopify' then
    select connection.shopify_currency into expected_currency
    from public.client_shopify_connections connection
    join public.client_shopify_credentials credential
      on credential.connection_id = connection.id
    where connection.id = target_binding.shopify_connection_id
      and connection.client_id = target_binding.client_id
      and connection.status = 'connected'
      and connection.last_verified_at is not null
      and connection.last_error_code is null
    for share of connection, credential;
  else
    select connection.currency into expected_currency
    from public.client_google_ads_connections connection
    where connection.id = target_binding.google_ads_connection_id
      and connection.client_id = target_binding.client_id
      and connection.status = 'connected'
      and connection.last_verified_at is not null
      and connection.last_error_code is null
      and nullif(btrim(coalesce(connection.time_zone, '')), '') is not null
    for share;
  end if;

  if not found
    or expected_currency is distinct from p_source_currency
    or expected_currency !~ '^[A-Z]{3}$'
    or receipt_time <= target_binding.bound_at
  then
    raise exception 'Sync receipt does not match the active verified source.'
      using errcode = '23514';
  end if;

  perform set_config(
    'dropscale.reporting_sync_receipt',
    p_binding_id::text || ':' || p_source_type,
    true
  );
  insert into public.client_reporting_sync_states (
    binding_id, source_type, last_success_at, last_success_from,
    last_success_to, source_currency, row_count
  ) values (
    p_binding_id, p_source_type, receipt_time, p_success_from,
    p_success_to, p_source_currency, p_row_count
  ) on conflict (binding_id, source_type) do update
    set last_success_at = excluded.last_success_at,
        last_success_from = excluded.last_success_from,
        last_success_to = excluded.last_success_to,
        source_currency = excluded.source_currency,
        row_count = excluded.row_count;

  return p_binding_id;
end
$$;

-- Some older Windsor links predate the mandatory account metadata capture.
-- Refresh only reporting metadata for the already-selected exact connection;
-- the customer id itself is deliberately absent from this RPC's arguments.
create table public.client_google_ads_reporting_identity_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null
    references public.client_google_ads_connections(id) on delete restrict,
  prior_currency text,
  source_currency text not null check (source_currency ~ '^[A-Z]{3}$'),
  prior_time_zone text,
  source_time_zone text not null check (length(btrim(source_time_zone)) between 1 and 160),
  verified_at timestamptz not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (connection_id, verified_at)
);

alter table public.client_google_ads_reporting_identity_events enable row level security;
revoke all on table public.client_google_ads_reporting_identity_events
  from public, anon, authenticated, service_role;
grant select on table public.client_google_ads_reporting_identity_events to service_role;

create or replace function public.guard_client_google_ads_reporting_identity_event_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'A Google Ads reporting identity event is immutable.'
    using errcode = '23514';
end
$$;

create trigger client_google_ads_reporting_identity_events_guard_immutable
  before update or delete on public.client_google_ads_reporting_identity_events
  for each row execute function public.guard_client_google_ads_reporting_identity_event_immutable();

create or replace function public.record_client_google_ads_reporting_identity(
  p_connection_id uuid,
  p_currency text,
  p_time_zone text,
  p_admin_id uuid,
  p_verified_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.client_google_ads_connections%rowtype;
  normal_currency text := upper(btrim(coalesce(p_currency, '')));
  normal_time_zone text := btrim(coalesce(p_time_zone, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can refresh Google Ads identity metadata.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_connection_id is null
    or normal_currency !~ '^[A-Z]{3}$'
    or length(normal_time_zone) not between 1 and 160
    or p_verified_at is null
    or p_verified_at < clock_timestamp() - interval '15 minutes'
    or p_verified_at > clock_timestamp() + interval '1 minute'
  then
    raise exception 'Invalid or stale Google Ads reporting metadata proof.'
      using errcode = '22023';
  end if;

  select * into target
  from public.client_google_ads_connections connection
  where connection.id = p_connection_id and connection.status = 'connected'
  for update;
  if not found then
    raise exception 'Connected Google Ads source not found.' using errcode = 'P0002';
  end if;
  if btrim(target.windsor_account_id) !~ '^[0-9[:space:]-]+$'
    or length(public.normalize_google_ads_customer_id(target.windsor_account_id)) <> 10
  then
    raise exception 'Google Ads source has no canonical customer identifier.'
      using errcode = '23514';
  end if;

  if (target.currency is not null and target.currency <> normal_currency)
    or (
      nullif(btrim(coalesce(target.time_zone, '')), '') is not null
      and btrim(target.time_zone) <> normal_time_zone
    )
  then
    raise exception 'Existing Google Ads reporting metadata is immutable.'
      using errcode = '23514';
  end if;

  perform binding.id
  from public.client_reporting_bindings binding
  join public.ad_accounts account on account.id = binding.ad_account_id
  where binding.google_ads_connection_id = target.id
    and binding.status = 'active'
    and account.currency is distinct from normal_currency
  for share of binding, account;
  if found then
    raise exception 'Google Ads currency cannot drift from its active reporting identity.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.client_google_ads_reporting_identity_events event
    where event.connection_id = target.id
      and event.verified_at = p_verified_at
  ) then
    if exists (
      select 1
      from public.client_google_ads_reporting_identity_events event
      where event.connection_id = target.id
        and event.verified_at = p_verified_at
        and event.source_currency = normal_currency
        and event.source_time_zone = normal_time_zone
        and event.actor_id = p_admin_id
    ) then
      return target.id;
    end if;
    raise exception 'Google Ads metadata proof was already recorded differently.'
      using errcode = '23505';
  end if;

  perform set_config(
    'dropscale.google_reporting_identity_refresh',
    target.id::text,
    true
  );
  update public.client_google_ads_connections
  set currency = normal_currency,
      time_zone = normal_time_zone,
      last_verified_at = p_verified_at,
      last_error_code = null,
      updated_at = clock_timestamp()
  where id = target.id;

  insert into public.client_google_ads_reporting_identity_events (
    connection_id, prior_currency, source_currency,
    prior_time_zone, source_time_zone, verified_at, actor_id
  ) values (
    target.id, target.currency, normal_currency,
    target.time_zone, normal_time_zone, p_verified_at, p_admin_id
  );

  return target.id;
end
$$;

-- Existing no-asset onboarding still activates through the established review
-- path. This cutover RPC is intentionally asset-only: it will not move a
-- workspace until every currently connected source is bound and has a fresh
-- post-binding adapter receipt.
create or replace function public.activate_client_reporting_cutover(
  p_client_id uuid,
  p_admin_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  rollout public.client_rollout_states%rowtype;
  onboarding_session public.client_onboarding_sessions%rowtype;
  normal_reason text := btrim(coalesce(p_reason, ''));
  source_count integer;
  binding_count integer;
  cutover_time timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can activate a cutover.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_client_id is null or length(normal_reason) not between 3 and 500 then
    raise exception 'Invalid reporting cutover request.' using errcode = '22023';
  end if;

  -- Cutover is a rare admin boundary, so serialize the complete source
  -- snapshot rather than relying on row locks that cannot prevent phantoms at
  -- READ COMMITTED. Every writer to a covered source/binding/receipt waits
  -- until the rollout flip commits, or finishes first and becomes visible to
  -- the checks below.
  lock table
    public.client_shopify_connections,
    public.client_shopify_credentials,
    public.client_google_ads_connections,
    public.client_asset_mappings,
    public.client_reporting_bindings,
    public.client_reporting_sync_states,
    public.daily_metrics
  in share row exclusive mode;

  perform client.id
  from public.portal_clients client
  join public.profiles profile on profile.id = client.id
  where client.id = p_client_id
    and client.approval_status = 'approved'
    and profile.role <> 'admin'
  for share of client, profile;
  if not found then
    raise exception 'Only an approved non-admin client can activate reporting.'
      using errcode = '23514';
  end if;

  select * into rollout
  from public.client_rollout_states state
  where state.client_id = p_client_id
  for update;
  if not found
    or rollout.onboarding_session_id is null
    or rollout.operational_surface not in ('v2_ready_for_cutover', 'v2_active')
  then
    raise exception 'Client rollout is not ready for reporting cutover.'
      using errcode = '23514';
  end if;

  if rollout.reporting_cutover_at is not null then
    if rollout.operational_surface = 'v2_active'
      and rollout.reporting_cutover_by = p_admin_id
      and rollout.reporting_cutover_reason = normal_reason
      and exists (
        select 1
        from public.client_onboarding_events event
        join public.client_onboarding_sessions event_session
          on event_session.id = event.session_id
        where event_session.claimed_user_id = p_client_id
          and event.event_type = 'activated'
          and event.actor_type = 'admin'
          and event.actor_id = rollout.reporting_cutover_by
          and event.details ->> 'reportingBindings' = 'true'
          and event.details ->> 'reason' = rollout.reporting_cutover_reason
          and event.details ->> 'reportingCutoverAt'
                = (to_jsonb(rollout.reporting_cutover_at) #>> '{}')
      )
    then
      return p_client_id;
    end if;
    raise exception 'Reporting cutover is already recorded with different authority or is rolled back.'
      using errcode = '23514';
  end if;

  select * into onboarding_session
  from public.client_onboarding_sessions session
  where session.id = rollout.onboarding_session_id
    and session.claimed_user_id = p_client_id
    and session.status in ('submitted', 'reviewed', 'active')
  for update;
  if not found or cardinality(onboarding_session.requested_assets) = 0 then
    raise exception 'Asset reporting cutover requires a reviewed asset session.'
      using errcode = '23514';
  end if;

  -- These no-op locks intentionally serialize connection health/source changes
  -- with the complete coverage checks that follow.
  perform connection.id
  from public.client_shopify_connections connection
  where connection.client_id = p_client_id and connection.status = 'connected'
  for update;
  perform credential.connection_id
  from public.client_shopify_credentials credential
  join public.client_shopify_connections connection
    on connection.id = credential.connection_id
  where connection.client_id = p_client_id and connection.status = 'connected'
  for share of credential;
  perform connection.id
  from public.client_google_ads_connections connection
  where connection.client_id = p_client_id and connection.status = 'connected'
  for update;
  perform binding.id
  from public.client_reporting_bindings binding
  where binding.client_id = p_client_id and binding.status = 'active'
  for share;
  perform receipt.binding_id
  from public.client_reporting_sync_states receipt
  join public.client_reporting_bindings binding on binding.id = receipt.binding_id
  where binding.client_id = p_client_id and binding.status = 'active'
  for share of receipt;

  select
    (select count(*) from public.client_shopify_connections source
      where source.client_id = p_client_id and source.status = 'connected')
    +
    (select count(*) from public.client_google_ads_connections source
      where source.client_id = p_client_id and source.status = 'connected')
  into source_count;
  if source_count = 0 then
    raise exception 'Asset reporting cutover requires at least one connected source.'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.client_reporting_bindings binding
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and binding.shopify_connection_id is not null
  ) then
    raise exception 'Asset reporting cutover requires at least one active Shopify anchor.'
      using errcode = '23514';
  end if;

  select
    count(binding.shopify_connection_id)
    + count(binding.google_ads_connection_id)
  into binding_count
  from public.client_reporting_bindings binding
  where binding.client_id = p_client_id and binding.status = 'active';
  if binding_count <> source_count
    or exists (
      select 1
      from public.client_shopify_connections source
      where source.client_id = p_client_id
        and source.status = 'connected'
        and (
          source.last_verified_at is null
          or source.last_error_code is not null
          or not exists (
            select 1 from public.client_shopify_credentials credential
            where credential.connection_id = source.id
          )
          or not exists (
            select 1 from public.client_reporting_bindings binding
            where binding.client_id = p_client_id
              and binding.status = 'active'
              and binding.shopify_connection_id = source.id
          )
        )
    )
    or exists (
      select 1
      from public.client_google_ads_connections source
      where source.client_id = p_client_id
        and source.status = 'connected'
        and (
          source.last_verified_at is null
          or source.last_error_code is not null
          or source.currency is null
          or source.currency !~ '^[A-Z]{3}$'
          or nullif(btrim(coalesce(source.time_zone, '')), '') is null
          or not exists (
            select 1 from public.client_reporting_bindings binding
            where binding.client_id = p_client_id
              and binding.status = 'active'
              and binding.google_ads_connection_id = source.id
          )
        )
    )
  then
    raise exception 'Connected reporting sources are not covered exactly once and healthy.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.client_reporting_bindings binding
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and (
        (
          binding.shopify_connection_id is not null
          and not exists (
            select 1 from public.client_reporting_sync_states receipt
            where receipt.binding_id = binding.id
              and receipt.source_type = 'shopify'
              and receipt.last_success_at > binding.bound_at
              and receipt.last_success_from <= current_date - 90
              and receipt.last_success_to >= current_date - 1
              and receipt.source_currency = (
                select source.shopify_currency
                from public.client_shopify_connections source
                where source.id = binding.shopify_connection_id
              )
          )
        )
        or (
          binding.google_ads_connection_id is not null
          and not exists (
            select 1 from public.client_reporting_sync_states receipt
            where receipt.binding_id = binding.id
              and receipt.source_type = 'google_ads'
              and receipt.last_success_at > binding.bound_at
              and receipt.last_success_from <= current_date - 90
              and receipt.last_success_to >= current_date - 1
              and receipt.source_currency = (
                select source.currency
                from public.client_google_ads_connections source
                where source.id = binding.google_ads_connection_id
              )
          )
        )
      )
  ) then
    raise exception 'Every bound source requires a fresh post-binding sync receipt.'
      using errcode = '23514';
  end if;

  -- A receipt is only a claim about an adapter commit. Re-prove the actual
  -- materialized facts at the authority boundary so a missing day, a crash
  -- between upsert and receipt, or a later legacy overwrite cannot ride a
  -- stale receipt into V2. The table lock above closes the check-to-marker
  -- race against normal legacy/browser writers.
  if exists (
    select 1
    from public.client_reporting_bindings binding
    left join public.client_reporting_sync_states shopify_receipt
      on shopify_receipt.binding_id = binding.id
     and shopify_receipt.source_type = 'shopify'
    left join public.client_reporting_sync_states google_receipt
      on google_receipt.binding_id = binding.id
     and google_receipt.source_type = 'google_ads'
    cross join lateral (
      select
        count(*)::integer as day_count,
        count(distinct metric.day)::integer as distinct_day_count,
        count(metric.computed_at)::integer as computed_count,
        min(metric.day) as min_day,
        max(metric.day) as max_day,
        min(metric.computed_at) as min_computed_at,
        max(metric.computed_at) as max_computed_at
      from public.daily_metrics metric
      where metric.ad_account_id = binding.ad_account_id
        and metric.day between current_date - 90 and current_date - 1
    ) materialized
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and (
        materialized.day_count <> 90
        or materialized.distinct_day_count <> 90
        or materialized.computed_count <> 90
        or materialized.min_day is distinct from current_date - 90
        or materialized.max_day is distinct from current_date - 1
        or materialized.min_computed_at is null
        or materialized.min_computed_at <= binding.bound_at
        or materialized.max_computed_at is null
        or (
          binding.shopify_connection_id is not null
          and (
            shopify_receipt.last_success_at is null
            or shopify_receipt.last_success_at < materialized.max_computed_at
          )
        )
        or (
          binding.google_ads_connection_id is not null
          and (
            google_receipt.last_success_at is null
            or google_receipt.last_success_at < materialized.max_computed_at
          )
        )
      )
  ) then
    raise exception 'Every active reporting binding requires complete receipt-owned materialized 90-day facts.'
      using errcode = '23514';
  end if;

  -- A reporting receipt proves that the adapter can read Google, but it does
  -- not authorize agency billing. Never move the portal to the normalized
  -- surface until every bound Google identity already has the immutable
  -- billing baseline created by the existing reviewed billing-start flow.
  if exists (
    select 1
    from public.client_reporting_bindings binding
    join public.client_google_ads_connections source
      on source.id = binding.google_ads_connection_id
    join public.ad_accounts account
      on account.id = binding.ad_account_id
    where binding.client_id = p_client_id
      and binding.status = 'active'
      and binding.google_ads_connection_id is not null
      and (
        source.client_id is distinct from p_client_id
        or account.client_id is distinct from p_client_id
        or account.status not in ('active', 'suspended')
        or account.google_ads_customer_id is distinct from
             public.normalize_google_ads_customer_id(source.windsor_account_id)
        or account.currency is distinct from source.currency
        or not exists (
          select 1
          from public.ad_account_billing_starts billing_start
          where billing_start.ad_account_id = account.id
            and billing_start.google_ads_customer_id = account.google_ads_customer_id
            and billing_start.currency = account.currency
        )
        or exists (
          select 1
          from public.ad_account_billing_ends billing_end
          where billing_end.ad_account_id = account.id
        )
      )
  ) then
    raise exception 'Every Google reporting source requires an open exact immutable billing start.'
      using errcode = '23514';
  end if;

  cutover_time := clock_timestamp();
  perform set_config('dropscale.reporting_cutover_marker', p_client_id::text, true);
  update public.client_rollout_states
  set operational_surface = 'v2_active',
      reporting_cutover_at = cutover_time,
      reporting_cutover_by = p_admin_id,
      reporting_cutover_reason = normal_reason,
      updated_by = p_admin_id,
      updated_at = cutover_time
  where client_id = p_client_id;

  update public.client_onboarding_sessions
  set status = 'active',
      reviewed_at = coalesce(reviewed_at, clock_timestamp()),
      reviewed_by = coalesce(reviewed_by, p_admin_id),
      activated_at = coalesce(activated_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where id = onboarding_session.id;

  insert into public.client_onboarding_events (
    session_id, event_type, actor_type, actor_id, details
  ) values (
    onboarding_session.id, 'activated', 'admin', p_admin_id,
    jsonb_build_object(
      'reason', normal_reason,
      'reportingBindings', true,
      'reportingCutoverAt', cutover_time,
      'requiredHistoryDays', 90
    )
  );

  return p_client_id;
end
$$;

-- A pristine pending row may be adopted once. Reporting, delivery, product,
-- COGS or financial evidence makes it a historical source and keeps it
-- legacy_hybrid. Client-uploaded creative_submissions are intentionally not a
-- source-family blocker: adoption preserves their stable ad_account_id FK.
create or replace function public.ad_account_has_reporting_or_financial_history(p_account_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.daily_metrics where ad_account_id = p_account_id)
    or exists (select 1 from public.campaigns where ad_account_id = p_account_id)
    or exists (select 1 from public.creative_deliveries where ad_account_id = p_account_id)
    or exists (select 1 from public.store_products where ad_account_id = p_account_id)
    or exists (select 1 from public.cogs_collections where ad_account_id = p_account_id)
    or exists (select 1 from public.commissions where ad_account_id = p_account_id)
    or exists (select 1 from public.ad_account_billing_starts where ad_account_id = p_account_id)
    or exists (select 1 from public.ad_account_billing_ends where ad_account_id = p_account_id)
    or exists (select 1 from public.google_ledger_sync_windows where ad_account_id = p_account_id)
    or exists (select 1 from public.reviewed_full_day_billing_boundaries where ad_account_id = p_account_id)
    or exists (select 1 from public.historical_billing_rollover_rows where ad_account_id = p_account_id)
    or exists (select 1 from public.historical_billing_rollover_account_proofs where ad_account_id = p_account_id)
    or exists (select 1 from public.historical_billing_rollover_blockers where ad_account_id = p_account_id)
    or exists (select 1 from public.manual_billing_cutover_account_snapshots where ad_account_id = p_account_id)
$$;

create or replace function public.provision_client_reporting_anchor(
  p_shopify_connection_id uuid,
  p_google_ads_connection_id uuid,
  p_shopify_anchor_binding_id uuid,
  p_existing_ad_account_id uuid,
  p_idempotency_key text,
  p_admin_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  shopify public.client_shopify_connections%rowtype;
  google_ads public.client_google_ads_connections%rowtype;
  anchor public.client_reporting_bindings%rowtype;
  account public.ad_accounts%rowtype;
  existing_event public.client_reporting_anchor_events%rowtype;
  result_binding_id uuid;
  owner_id uuid;
  source_currency text;
  shopify_domain text;
  google_customer_id text;
  prior_shopify_domain text;
  prior_google_customer_id text;
  prior_currency text;
  event_type text;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can provision an anchor.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if (p_shopify_connection_id is null and p_google_ads_connection_id is null)
    or p_shopify_anchor_binding_id is not null and (
      p_shopify_connection_id is not null or p_google_ads_connection_id is null
    )
    or p_existing_ad_account_id is not null and p_shopify_connection_id is null
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 100
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid reporting anchor request.' using errcode = '22023';
  end if;

  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events
  where idempotency_key = p_idempotency_key;
  if found then
    if existing_event.event_type = (case
          when p_existing_ad_account_id is null then 'provisioned'
          else 'adopted'
        end)
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
      and existing_event.details ->> 'shopifyConnectionId'
            is not distinct from p_shopify_connection_id::text
      and existing_event.details ->> 'googleAdsConnectionId'
            is not distinct from p_google_ads_connection_id::text
      and existing_event.details ->> 'shopifyAnchorBindingId'
            is not distinct from p_shopify_anchor_binding_id::text
      and existing_event.details ->> 'requestedExistingAdAccountId'
            is not distinct from p_existing_ad_account_id::text
    then
      return existing_event.binding_id;
    end if;
    raise exception 'Reporting anchor idempotency key is already used.' using errcode = '23505';
  end if;

  if p_shopify_connection_id is not null then
    select * into shopify
    from public.client_shopify_connections connection
    where connection.id = p_shopify_connection_id
      and connection.status = 'connected'
    for update;
    if not found
      or shopify.last_verified_at is null
      or shopify.last_error_code is not null
      or not exists (
        select 1 from public.client_shopify_credentials credential
        where credential.connection_id = shopify.id
        for share
      )
    then
      raise exception 'A verified credentialed Shopify reporting source is required.'
        using errcode = '23514';
    end if;
    shopify_domain := public.normalize_shopify_reporting_domain(shopify.shopify_domain);
    if coalesce(shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
      or shopify.shopify_currency !~ '^[A-Z]{3}$'
    then
      raise exception 'Shopify reporting metadata is invalid.' using errcode = '23514';
    end if;
    owner_id := shopify.client_id;
    -- The normalized metric surface is portfolio-wide and currently reports
    -- in EUR. Shopify receipts keep the store's native shopMoney currency,
    -- while the adapter performs the fail-closed daily ECB conversion before
    -- writing facts to this EUR anchor.
    source_currency := 'EUR';
  end if;

  if p_google_ads_connection_id is not null then
    select * into google_ads
    from public.client_google_ads_connections connection
    where connection.id = p_google_ads_connection_id
      and connection.status = 'connected'
    for update;
    if not found
      or google_ads.last_verified_at is null
      or google_ads.last_error_code is not null
    then
      raise exception 'A verified Google Ads reporting source is required.'
        using errcode = '23514';
    end if;
    if btrim(google_ads.windsor_account_id) !~ '^[0-9[:space:]-]+$' then
      raise exception 'Google Ads source has no canonical customer identifier.'
        using errcode = '23514';
    end if;
    google_customer_id := public.normalize_google_ads_customer_id(
      google_ads.windsor_account_id
    );
    if length(coalesce(google_customer_id, '')) <> 10
      or google_ads.currency is null
      or google_ads.currency !~ '^[A-Z]{3}$'
      or nullif(btrim(coalesce(google_ads.time_zone, '')), '') is null
    then
      raise exception 'Google Ads reporting metadata is incomplete.'
        using errcode = '23514';
    end if;
    if owner_id is not null and owner_id is distinct from google_ads.client_id then
      raise exception 'Reporting sources belong to different clients.' using errcode = '23514';
    end if;
    owner_id := google_ads.client_id;
    -- Google Ads defines the canonical reporting/billing currency for a pair.
    -- Shopify reports native shopMoney and the adapter converts it into this
    -- currency before writing daily_metrics. Shopify-only anchors use the EUR
    -- portfolio currency assigned above.
    source_currency := google_ads.currency;
  end if;

  perform client.id
  from public.portal_clients client
  join public.profiles profile on profile.id = client.id
  where client.id = owner_id
    and client.approval_status = 'approved'
    and profile.role <> 'admin'
  for share of client, profile;
  if not found then
    raise exception 'Only an approved non-admin client can receive a reporting anchor.'
      using errcode = '23514';
  end if;

  if p_shopify_anchor_binding_id is not null then
    select binding.* into anchor
    from public.client_reporting_bindings binding
    join public.ad_accounts anchor_account
      on anchor_account.id = binding.ad_account_id
     -- Exact legacy pairs upgraded above deliberately retain their historical
     -- surrogate role and id. Their active Shopify binding is still the sole
     -- Shopify fact source and may anchor additional explicitly-mapped Google
     -- spend children under the same owner/canonical currency.
     and anchor_account.reporting_role in ('shopify_anchor', 'legacy_hybrid')
     and anchor_account.currency = google_ads.currency
    join public.client_shopify_connections anchor_shopify
      on anchor_shopify.id = binding.shopify_connection_id
     and anchor_shopify.status = 'connected'
     and anchor_shopify.last_verified_at is not null
     and anchor_shopify.last_error_code is null
    join public.client_shopify_credentials anchor_credential
      on anchor_credential.connection_id = anchor_shopify.id
    where binding.id = p_shopify_anchor_binding_id
      and binding.status = 'active'
      and binding.shopify_connection_id is not null
    for share of binding, anchor_account, anchor_shopify, anchor_credential;
    if not found or anchor.client_id is distinct from owner_id then
      raise exception 'Active same-owner Shopify anchor not found.' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.client_asset_mappings mapping
      where mapping.shopify_connection_id = anchor.shopify_connection_id
        and mapping.google_ads_connection_id = google_ads.id
      for share
    ) then
      raise exception 'Google Ads source is not explicitly mapped to the Shopify anchor.'
        using errcode = '23514';
    end if;
  elsif p_shopify_connection_id is not null and p_google_ads_connection_id is not null then
    if not exists (
      select 1 from public.client_asset_mappings mapping
      where mapping.shopify_connection_id = shopify.id
        and mapping.google_ads_connection_id = google_ads.id
      for share
    ) then
      raise exception 'Shopify and Google Ads sources are not explicitly mapped.'
        using errcode = '23514';
    end if;
  elsif p_shopify_connection_id is null and p_google_ads_connection_id is not null then
    if exists (
      select 1 from public.client_asset_mappings mapping
      where mapping.google_ads_connection_id = google_ads.id
      for share
    ) then
      raise exception 'A mapped Google Ads source requires its Shopify anchor.'
        using errcode = '23514';
    end if;
  end if;

  if p_existing_ad_account_id is null then
    if shopify_domain is not null and exists (
      select 1 from public.ad_accounts existing
      where public.normalize_shopify_reporting_domain(existing.shopify_url) = shopify_domain
    ) then
      raise exception 'Shopify reporting identity already belongs to an ad account; use reviewed adoption.'
        using errcode = '23505';
    end if;
    if google_customer_id is not null and exists (
      select 1 from public.ad_accounts existing
      where existing.google_ads_customer_id = google_customer_id
    ) then
      raise exception 'Google Ads reporting identity already belongs to an ad account; use reviewed adoption.'
        using errcode = '23505';
    end if;
  end if;

  if p_existing_ad_account_id is not null then
    select * into account
    from public.ad_accounts target
    where target.id = p_existing_ad_account_id
    for update;
    if not found
      or account.client_id is distinct from owner_id
      or account.status <> 'pending'
      or account.reporting_role <> 'legacy_hybrid'
      or (
        account.shopify_url is not null
        and public.normalize_shopify_reporting_domain(account.shopify_url)
              is distinct from shopify_domain
      )
      or (
        account.google_ads_customer_id is not null
        and (
          google_customer_id is null
          or account.google_ads_customer_id is distinct from google_customer_id
        )
      )
      or account.shopify_connected
      or account.shopify_client_id is not null
      or account.shopify_scopes is not null
      or account.shopify_admin_token is not null
      or account.shopify_token_last4 is not null
      or account.shopify_connected_at is not null
      or account.google_ads_refresh_token is not null
      or account.google_ads_connected_email is not null
      or account.google_ads_connected
      or account.currency is distinct from source_currency
      or public.ad_account_has_reporting_or_financial_history(account.id)
      or exists (
        select 1 from public.client_reporting_bindings binding
        where binding.ad_account_id = account.id
      )
    then
      raise exception 'Only an exact pristine pending legacy row can be adopted.'
        using errcode = '23514';
    end if;

    prior_shopify_domain := public.normalize_shopify_reporting_domain(account.shopify_url);
    prior_google_customer_id := account.google_ads_customer_id;
    prior_currency := account.currency;
    perform set_config('dropscale.reporting_anchor_adoption', account.id::text, true);
    update public.ad_accounts
    set shopify_url = shopify_domain,
        google_ads_customer_id = google_customer_id,
        reporting_role = 'shopify_anchor'
    where id = account.id
    returning * into account;
    event_type := 'adopted';
  else
    insert into public.ad_accounts (
      client_id, store_name, google_ads_customer_id, status, currency,
      shopify_url, reporting_role
    ) values (
      owner_id,
      coalesce(
        case when p_shopify_connection_id is not null
          then nullif(btrim(shopify.shopify_name), '') end,
        case when p_google_ads_connection_id is not null
          then nullif(btrim(google_ads.account_name), '') end,
        'Reporting source'
      ),
      google_customer_id,
      'pending',
      source_currency,
      shopify_domain,
      case when p_shopify_connection_id is not null
        then 'shopify_anchor' else 'google_spend' end
    ) returning * into account;
    event_type := 'provisioned';
  end if;

  result_binding_id := public.commit_client_reporting_binding(
    account.id,
    p_shopify_connection_id,
    p_google_ads_connection_id,
    p_shopify_anchor_binding_id,
    p_idempotency_key,
    p_admin_id,
    normal_reason
  );

  insert into public.client_reporting_anchor_events (
    binding_id, ad_account_id, event_type, idempotency_key,
    actor_id, reason, details
  ) values (
    result_binding_id, account.id, event_type, p_idempotency_key,
    p_admin_id, normal_reason,
    jsonb_build_object(
      'shopifyConnectionId', p_shopify_connection_id,
      'googleAdsConnectionId', p_google_ads_connection_id,
      'shopifyAnchorBindingId', p_shopify_anchor_binding_id,
      'requestedExistingAdAccountId', p_existing_ad_account_id,
      'reportingRole', account.reporting_role,
      'priorShopifyDomain', prior_shopify_domain,
      'priorGoogleAdsCustomerId', prior_google_customer_id,
      'priorCurrency', prior_currency,
      'committedShopifyDomain', shopify_domain,
      'committedGoogleAdsCustomerId', google_customer_id,
      'committedCurrency', account.currency
    )
  );

  return result_binding_id;
end
$$;

create or replace function public.upgrade_client_reporting_google_binding_to_pair(
  p_binding_id uuid,
  p_shopify_connection_id uuid,
  p_reconnect_session_id uuid,
  p_idempotency_key text,
  p_admin_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  old_binding public.client_reporting_bindings%rowtype;
  account public.ad_accounts%rowtype;
  shopify public.client_shopify_connections%rowtype;
  google_ads public.client_google_ads_connections%rowtype;
  reconnect_session public.client_onboarding_sessions%rowtype;
  existing_event public.client_reporting_anchor_events%rowtype;
  new_binding_id uuid;
  shopify_domain text;
  google_customer_id text;
  normal_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the reporting service can upgrade a binding.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_admin_id and role = 'admin'
  ) then
    raise exception 'A verified admin is required.' using errcode = '42501';
  end if;
  if p_binding_id is null or p_shopify_connection_id is null
    or p_reconnect_session_id is null
    or coalesce(p_idempotency_key, '') <> btrim(coalesce(p_idempotency_key, ''))
    or length(coalesce(p_idempotency_key, '')) not between 8 and 100
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9._:-]+$'
    or length(normal_reason) not between 3 and 500
  then
    raise exception 'Invalid reporting binding upgrade.' using errcode = '22023';
  end if;

  lock table public.client_reporting_anchor_events in share row exclusive mode;
  select * into existing_event
  from public.client_reporting_anchor_events
  where idempotency_key = p_idempotency_key;
  if found then
    if existing_event.event_type = 'upgraded'
      and existing_event.prior_binding_id = p_binding_id
      and existing_event.actor_id = p_admin_id
      and existing_event.reason = normal_reason
      and existing_event.details ->> 'shopifyConnectionId' = p_shopify_connection_id::text
      and existing_event.details ->> 'reconnectSessionId' = p_reconnect_session_id::text
    then
      return existing_event.binding_id;
    end if;
    raise exception 'Reporting upgrade idempotency key is already used.' using errcode = '23505';
  end if;

  select * into old_binding
  from public.client_reporting_bindings binding
  where binding.id = p_binding_id and binding.status = 'active'
  for update;
  if not found
    or old_binding.google_ads_connection_id is null
    or old_binding.shopify_connection_id is not null
    or old_binding.shopify_anchor_binding_id is not null
  then
    raise exception 'Active unanchored Google binding not found.' using errcode = '23514';
  end if;

  select * into account
  from public.ad_accounts target
  where target.id = old_binding.ad_account_id
    and target.reporting_role = 'legacy_hybrid'
  for update;
  if not found then
    raise exception 'The reporting identity is not an upgradeable legacy pair.'
      using errcode = '23514';
  end if;

  select * into reconnect_session
  from public.client_onboarding_sessions session
  where session.id = p_reconnect_session_id
    and session.mode = 'reconnect'
    and session.status in ('submitted', 'reviewed', 'active')
    and session.claimed_user_id = old_binding.client_id
    and session.target_client_id = old_binding.client_id
    and session.reconnect_legacy_ad_account_id = old_binding.ad_account_id
    and session.reconnect_completed_at is not null
  for update;
  if not found then
    raise exception 'Completed exact-store reconnect evidence is required.'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.client_onboarding_events event
    where event.session_id = reconnect_session.id
      and event.event_type = 'shopify_connected'
      and event.details ->> 'connection_id' = p_shopify_connection_id::text
  ) then
    raise exception 'Reconnect session does not prove the selected Shopify connection.'
      using errcode = '23514';
  end if;

  select * into shopify
  from public.client_shopify_connections connection
  where connection.id = p_shopify_connection_id
    and connection.status = 'connected'
    and connection.client_id = old_binding.client_id
  for update;
  if not found
    or shopify.last_verified_at is null
    or shopify.last_error_code is not null
    or not exists (
      select 1 from public.client_shopify_credentials credential
      where credential.connection_id = shopify.id
      for share
    )
  then
    raise exception 'Verified reconnect Shopify evidence is required.' using errcode = '23514';
  end if;

  select * into google_ads
  from public.client_google_ads_connections connection
  where connection.id = old_binding.google_ads_connection_id
    and connection.status = 'connected'
    and connection.client_id = old_binding.client_id
  for update;
  if not found
    or google_ads.last_verified_at is null
    or google_ads.last_error_code is not null
    or google_ads.currency is null
    or google_ads.currency !~ '^[A-Z]{3}$'
    or nullif(btrim(coalesce(google_ads.time_zone, '')), '') is null
  then
    raise exception 'The bound Google Ads source is no longer verified.' using errcode = '23514';
  end if;

  shopify_domain := public.normalize_shopify_reporting_domain(shopify.shopify_domain);
  google_customer_id := public.normalize_google_ads_customer_id(google_ads.windsor_account_id);
  if coalesce(shopify_domain, '') !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
    or shopify.shopify_currency !~ '^[A-Z]{3}$'
    or btrim(google_ads.windsor_account_id) !~ '^[0-9[:space:]-]+$'
    or length(coalesce(google_customer_id, '')) <> 10
    or public.normalize_shopify_reporting_domain(account.shopify_url)
       is distinct from shopify_domain
    or account.google_ads_customer_id is distinct from google_customer_id
    or account.currency is distinct from google_ads.currency
  then
    raise exception 'Reconnect sources do not exactly match the existing reporting identity.'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from public.client_asset_mappings mapping
    where mapping.google_ads_connection_id = google_ads.id
      and mapping.shopify_connection_id is distinct from shopify.id
  ) then
    raise exception 'Google Ads source is mapped to another Shopify store.'
      using errcode = '23514';
  end if;

  perform set_config('dropscale.reporting_pair_upgrade', old_binding.id::text, true);
  perform public.revoke_client_reporting_binding(
    old_binding.id,
    p_admin_id,
    p_idempotency_key || ':revoke',
    normal_reason
  );

  insert into public.client_asset_mappings (
    session_id, shopify_connection_id, google_ads_connection_id
  ) values (
    reconnect_session.id, shopify.id, google_ads.id
  ) on conflict (google_ads_connection_id) do nothing;

  if not exists (
    select 1
    from public.client_asset_mappings mapping
    where mapping.session_id = reconnect_session.id
      and mapping.shopify_connection_id = shopify.id
      and mapping.google_ads_connection_id = google_ads.id
  ) then
    raise exception 'Exact reconnect asset mapping could not be committed.'
      using errcode = '23514';
  end if;

  new_binding_id := public.commit_client_reporting_binding(
    account.id,
    shopify.id,
    google_ads.id,
    null,
    p_idempotency_key || ':bind',
    p_admin_id,
    normal_reason
  );

  insert into public.client_reporting_anchor_events (
    binding_id, prior_binding_id, ad_account_id, event_type,
    idempotency_key, actor_id, reason, details
  ) values (
    new_binding_id, old_binding.id, account.id, 'upgraded',
    p_idempotency_key, p_admin_id, normal_reason,
    jsonb_build_object(
      'shopifyConnectionId', shopify.id,
      'googleAdsConnectionId', google_ads.id,
      'reconnectSessionId', reconnect_session.id
    )
  );

  return new_binding_id;
end
$$;

revoke all on function public.provision_client_reporting_anchor(
  uuid, uuid, uuid, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.provision_client_reporting_anchor(
  uuid, uuid, uuid, uuid, text, uuid, text
) to service_role;

revoke all on function public.upgrade_client_reporting_google_binding_to_pair(
  uuid, uuid, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.upgrade_client_reporting_google_binding_to_pair(
  uuid, uuid, uuid, text, uuid, text
) to service_role;

revoke all on function public.record_client_reporting_sync_success(
  uuid, text, date, date, text, integer
) from public, anon, authenticated;
grant execute on function public.record_client_reporting_sync_success(
  uuid, text, date, date, text, integer
) to service_role;

revoke all on function public.record_client_google_ads_reporting_identity(
  uuid, text, text, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_client_google_ads_reporting_identity(
  uuid, text, text, uuid, timestamptz
) to service_role;

revoke all on function public.activate_client_reporting_cutover(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.activate_client_reporting_cutover(
  uuid, uuid, text
) to service_role;

revoke all on function public.normalize_shopify_reporting_domain(text)
  from public, anon;
grant execute on function public.normalize_shopify_reporting_domain(text)
  to authenticated, service_role;
revoke all on function public.guard_ad_account_reporting_role()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_normalized_daily_metric_family()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_reporting_anchor_event_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_reporting_sync_state_write()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_google_ads_reporting_identity_event_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_normalized_shopify_child_family()
  from public, anon, authenticated, service_role;
revoke all on function public.ad_account_has_reporting_or_financial_history(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.guard_ad_account_billing_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_bound_shopify_connection_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_bound_google_ads_connection_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_reporting_binding_change()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_reporting_cutover_marker()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_client_reporting_cutover_event()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
