-- =============================================================================
-- 0059 - Policy-gated campaign action lifecycle.
--
-- A read-only Google Ads preflight may establish exact prior evidence. The
-- admitted request is then durable before any provider mutation and the same
-- row is sealed once with succeeded, failed or uncertain evidence. Only an
-- active, cut-over V2 binding with an explicit latest policy may admit it.
-- =============================================================================

create function public.campaign_action_json_has_secret_keys(p_document jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
declare
  member record;
  normalized_key text;
begin
  if p_document is null then
    return false;
  end if;

  if jsonb_typeof(p_document) = 'object' then
    for member in select key, value from jsonb_each(p_document)
    loop
      normalized_key := regexp_replace(lower(member.key), '[^a-z0-9]+', '', 'g');
      if normalized_key = any(array[
        'token', 'tokenhash', 'invitetoken', 'invitetokenhash',
        'clientsecret', 'accesstoken', 'refreshtoken', 'authorization',
        'credential', 'credentials', 'ciphertext', 'password', 'passphrase',
        'privatekey', 'apikey'
      ]::text[])
      or normalized_key ~ '(secret|token|password|passphrase|credential|ciphertext|authorization|privatekey|apikey|bearer)'
      then
        return true;
      end if;

      if public.campaign_action_json_has_secret_keys(member.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_document) = 'array' then
    for member in select value from jsonb_array_elements(p_document)
    loop
      if public.campaign_action_json_has_secret_keys(member.value) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end
$$;

create function public.campaign_action_json_is_safe(
  p_document jsonb,
  p_max_bytes integer
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select p_document is not null
    and jsonb_typeof(p_document) = 'object'
    and p_max_bytes > 0
    and octet_length(p_document::text) <= p_max_bytes
    and not public.campaign_action_json_has_secret_keys(p_document)
$$;

create function public.campaign_action_policy_actions_are_canonical(
  p_actions text[]
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select p_actions is not null
    and array_position(p_actions, null) is null
    and p_actions = coalesce(
      (
        select array_agg(action order by action)
        from (select distinct unnest(p_actions) as action) canonical
      ),
      '{}'::text[]
    )
$$;

-- A normalized V2 account normally has shopify_anchor/google_spend role. The
-- sole safe legacy exception is the purpose-bound 0055 pair upgrade, whose
-- immutable event links the current pair, prior Google-only binding and the
-- same account/client/source identities.
create function public.campaign_action_has_legacy_pair_upgrade(
  p_binding_id uuid,
  p_client_id uuid,
  p_ad_account_id uuid,
  p_google_ads_connection_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.client_reporting_bindings binding
    join public.client_reporting_anchor_events event
      on event.binding_id = binding.id
     and event.event_type = 'upgraded'
     and event.ad_account_id = binding.ad_account_id
    join public.client_reporting_bindings prior
      on prior.id = event.prior_binding_id
     and prior.client_id = binding.client_id
     and prior.ad_account_id = binding.ad_account_id
     and prior.google_ads_connection_id = binding.google_ads_connection_id
     and prior.shopify_connection_id is null
     and prior.shopify_anchor_binding_id is null
     and prior.status = 'revoked'
    where binding.id = p_binding_id
      and binding.client_id = p_client_id
      and binding.ad_account_id = p_ad_account_id
      and binding.google_ads_connection_id = p_google_ads_connection_id
      and binding.shopify_connection_id is not null
      and binding.shopify_anchor_binding_id is null
      and binding.status = 'active'
      and event.details ->> 'shopifyConnectionId'
            = binding.shopify_connection_id::text
      and event.details ->> 'googleAdsConnectionId'
            = binding.google_ads_connection_id::text
  )
$$;

revoke all on function public.campaign_action_json_has_secret_keys(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.campaign_action_json_is_safe(jsonb, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.campaign_action_policy_actions_are_canonical(text[])
  from public, anon, authenticated, service_role;
revoke all on function public.campaign_action_has_legacy_pair_upgrade(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

-- Policies are append-only revisions. No row means no campaign write. An
-- empty latest allowlist explicitly disables a previously-enabled binding.
create table public.campaign_action_policies (
  id uuid primary key,
  client_reporting_binding_id uuid not null
    references public.client_reporting_bindings(id) on delete restrict,
  supersedes_policy_id uuid unique
    references public.campaign_action_policies(id) on delete restrict,
  revision bigint not null check (revision > 0),
  executor text not null default 'agency_google'
    check (executor = 'agency_google'),
  allowed_actions text[] not null default '{}',
  max_daily_budget_micros numeric(18,0),
  idempotency_key text not null unique,
  configured_by uuid not null
    references public.profiles(id) on delete restrict,
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),

  constraint campaign_action_policies_binding_revision_unique
    unique (client_reporting_binding_id, revision),
  constraint campaign_action_policies_exact_reference_unique
    unique (id, client_reporting_binding_id, revision),
  constraint campaign_action_policies_idempotency_shape check (
    length(idempotency_key) between 8 and 200
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint campaign_action_policies_reason_shape check (
    length(reason) between 3 and 500
    and btrim(reason) = reason
  ),
  constraint campaign_action_policies_actions_shape check (
    public.campaign_action_policy_actions_are_canonical(allowed_actions)
    and allowed_actions <@ array[
      'budget_changed', 'campaign_paused', 'campaign_enabled'
    ]::text[]
  ),
  constraint campaign_action_policies_budget_shape check (
    (
      'budget_changed' = any(allowed_actions)
      and max_daily_budget_micros between 1000000 and 1000000000000
    )
    or (
      not ('budget_changed' = any(allowed_actions))
      and max_daily_budget_micros is null
    )
  )
);

comment on table public.campaign_action_policies is
  'Append-only default-deny write policy revisions for exact active Google reporting bindings.';
comment on column public.campaign_action_policies.max_daily_budget_micros is
  'Maximum requested Google Ads DAILY budget in integer micros; provider code separately proves the budget period.';

create index campaign_action_policies_binding_latest_idx
  on public.campaign_action_policies(
    client_reporting_binding_id, revision desc, id
  );

alter table public.campaign_action_policies enable row level security;
revoke all on table public.campaign_action_policies
  from public, anon, authenticated, service_role;
grant select on table public.campaign_action_policies to service_role;

create function public.guard_campaign_action_policy_immutable()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Campaign action policy revisions are immutable.'
      using errcode = '23514';
  end if;
  if auth.role() is distinct from 'service_role'
    or current_setting('dropscale.campaign_action_policy', true)
         is distinct from new.id::text
  then
    raise exception 'Only the campaign action policy RPC may append a revision.'
      using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function public.guard_campaign_action_policy_immutable()
  from public, anon, authenticated, service_role;

create trigger campaign_action_policies_guard_immutable
  before insert or update or delete on public.campaign_action_policies
  for each row execute function public.guard_campaign_action_policy_immutable();

create table public.campaign_action_operations (
  id uuid primary key,
  idempotency_key text not null unique,
  execution_claim_id uuid not null unique,
  client_id uuid not null
    references public.portal_clients(id) on delete restrict,
  client_reporting_binding_id uuid not null
    references public.client_reporting_bindings(id) on delete restrict,
  client_google_ads_connection_id uuid not null
    references public.client_google_ads_connections(id) on delete restrict,
  shopify_anchor_binding_id uuid
    references public.client_reporting_bindings(id) on delete restrict,
  shopify_anchor_ad_account_id uuid
    references public.ad_accounts(id) on delete restrict,
  ad_account_id uuid not null
    references public.ad_accounts(id) on delete restrict,
  billing_start_id uuid not null
    references public.ad_account_billing_starts(id) on delete restrict,
  campaign_action_policy_id uuid not null,
  policy_revision bigint not null,

  executor text not null default 'agency_google'
    check (executor = 'agency_google'),
  google_ads_customer_id text not null,
  google_time_zone text not null,
  currency text not null,
  provider_campaign_id text not null,
  campaign_name text not null,
  action text not null,
  status text not null default 'requested',

  previous_status text,
  next_status text,
  previous_daily_budget_micros numeric(18,0),
  next_daily_budget_micros numeric(18,0),
  requested_details jsonb not null default '{}'::jsonb,
  request_snapshot jsonb not null,
  request_hash text not null,
  requested_by uuid not null
    references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),

  observed_status text,
  observed_daily_budget_micros numeric(18,0),
  result_details jsonb,
  completed_at timestamptz,

  constraint campaign_action_operations_policy_reference_fkey
    foreign key (
      campaign_action_policy_id, client_reporting_binding_id, policy_revision
    ) references public.campaign_action_policies(
      id, client_reporting_binding_id, revision
    ) on delete restrict,
  constraint campaign_action_operations_idempotency_shape check (
    length(idempotency_key) between 8 and 200
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint campaign_action_operations_anchor_shape check (
    (shopify_anchor_binding_id is null and shopify_anchor_ad_account_id is null)
    or
    (shopify_anchor_binding_id is not null and shopify_anchor_ad_account_id is not null)
  ),
  constraint campaign_action_operations_customer_shape
    check (google_ads_customer_id ~ '^[0-9]{10}$'),
  constraint campaign_action_operations_time_zone_shape check (
    length(google_time_zone) between 1 and 100
    and btrim(google_time_zone) = google_time_zone
  ),
  constraint campaign_action_operations_currency_shape
    check (currency ~ '^[A-Z]{3}$'),
  constraint campaign_action_operations_campaign_id_shape
    check (provider_campaign_id ~ '^[0-9]{1,30}$'),
  constraint campaign_action_operations_campaign_name_shape check (
    length(campaign_name) between 1 and 500
    and btrim(campaign_name) = campaign_name
  ),
  constraint campaign_action_operations_action_value check (
    action in (
      'budget_changed', 'campaign_paused', 'campaign_enabled',
      'campaign_launched'
    )
  ),
  constraint campaign_action_operations_status_value check (
    status in ('requested', 'succeeded', 'failed', 'uncertain')
  ),
  constraint campaign_action_operations_request_details_safe
    check (public.campaign_action_json_is_safe(requested_details, 8192)),
  constraint campaign_action_operations_request_snapshot_safe
    check (public.campaign_action_json_is_safe(request_snapshot, 16384)),
  constraint campaign_action_operations_request_hash_exact check (
    request_hash ~ '^[0-9a-f]{32}$'
    and request_hash = md5(request_snapshot::text)
  ),
  constraint campaign_action_operations_result_details_safe check (
    result_details is null
    or public.campaign_action_json_is_safe(result_details, 8192)
  ),
  constraint campaign_action_operations_observed_status_value check (
    observed_status is null
    or observed_status in ('active', 'paused', 'ended')
  ),
  constraint campaign_action_operations_observed_budget_shape check (
    observed_daily_budget_micros is null
    or observed_daily_budget_micros between 1000000 and 1000000000000
  ),
  constraint campaign_action_operations_action_evidence_shape check (
    (
      action = 'budget_changed'
      and previous_status is null
      and next_status is null
      and previous_daily_budget_micros between 1000000 and 1000000000000
      and next_daily_budget_micros between 1000000 and 1000000000000
      and previous_daily_budget_micros <> next_daily_budget_micros
    )
    or (
      action = 'campaign_paused'
      and previous_status = 'active'
      and next_status = 'paused'
      and previous_daily_budget_micros is null
      and next_daily_budget_micros is null
    )
    or (
      action = 'campaign_enabled'
      and previous_status = 'paused'
      and next_status = 'active'
      and previous_daily_budget_micros is null
      and next_daily_budget_micros is null
    )
    or (
      -- Reserved for a future launch executor; the current policy/RPC cannot
      -- authorize this action.
      action = 'campaign_launched'
      and previous_status is null
      and next_status = 'active'
      and previous_daily_budget_micros is null
      and next_daily_budget_micros between 1000000 and 1000000000000
    )
  ),
  constraint campaign_action_operations_lifecycle_shape check (
    (
      status = 'requested'
      and observed_status is null
      and observed_daily_budget_micros is null
      and result_details is null
      and completed_at is null
    )
    or (
      status in ('succeeded', 'failed', 'uncertain')
      and result_details is not null
      and completed_at is not null
      and completed_at >= requested_at
    )
  ),
  constraint campaign_action_operations_success_evidence check (
    status <> 'succeeded'
    or (
      action = 'budget_changed'
      and observed_daily_budget_micros = next_daily_budget_micros
    )
    or (
      action in ('campaign_paused', 'campaign_enabled')
      and observed_status = next_status
    )
    or (
      action = 'campaign_launched'
      and observed_status = next_status
      and observed_daily_budget_micros = next_daily_budget_micros
    )
  )
);

comment on table public.campaign_action_operations is
  'One request-to-terminal lifecycle for a policy-authorized admin Google Ads campaign action.';
comment on column public.campaign_action_operations.request_snapshot is
  'Canonical database-built target, policy and requested-evidence snapshot covered by request_hash.';
comment on column public.campaign_action_operations.execution_claim_id is
  'Server-generated immutable nonce identifying the sole executor admitted to touch Google Ads.';
comment on column public.campaign_action_operations.result_details is
  'Bounded sanitized terminal evidence, never raw provider payloads or credentials.';

create unique index campaign_action_operations_one_requested_campaign_idx
  on public.campaign_action_operations(
    client_reporting_binding_id, provider_campaign_id
  ) where status = 'requested';
create index campaign_action_operations_account_requested_idx
  on public.campaign_action_operations(ad_account_id, requested_at desc, id);
create index campaign_action_operations_anchor_requested_idx
  on public.campaign_action_operations(
    shopify_anchor_ad_account_id, requested_at desc, id
  ) where shopify_anchor_ad_account_id is not null;
create index campaign_action_operations_campaign_requested_idx
  on public.campaign_action_operations(
    client_reporting_binding_id, provider_campaign_id, requested_at desc, id
  );
create index campaign_action_operations_binding_budget_history_idx
  on public.campaign_action_operations(
    client_reporting_binding_id, completed_at desc, id desc
  ) where status = 'succeeded' and action = 'budget_changed';
create index campaign_action_operations_client_activity_idx
  on public.campaign_action_operations(
    client_id, requested_at desc, id desc
  );

alter table public.campaign_action_operations enable row level security;
revoke all on table public.campaign_action_operations
  from public, anon, authenticated, service_role;
grant select on table public.campaign_action_operations
  to authenticated, service_role;

create policy campaign_action_operations_admin_read
  on public.campaign_action_operations
  for select
  to authenticated
  using (public.is_admin());

create function public.guard_campaign_action_operation_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Campaign action evidence cannot be deleted.'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if auth.role() is distinct from 'service_role'
      or current_setting('dropscale.campaign_action_start', true)
           is distinct from new.id::text
      or new.status <> 'requested'
    then
      raise exception 'Only the campaign action start RPC may record a request.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if auth.role() is distinct from 'service_role'
    or current_setting('dropscale.campaign_action_complete', true)
         is distinct from new.id::text
    or old.status <> 'requested'
    or new.status not in ('succeeded', 'failed', 'uncertain')
    or new.id is distinct from old.id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.execution_claim_id is distinct from old.execution_claim_id
    or new.client_id is distinct from old.client_id
    or new.client_reporting_binding_id is distinct from old.client_reporting_binding_id
    or new.client_google_ads_connection_id is distinct from old.client_google_ads_connection_id
    or new.shopify_anchor_binding_id is distinct from old.shopify_anchor_binding_id
    or new.shopify_anchor_ad_account_id is distinct from old.shopify_anchor_ad_account_id
    or new.ad_account_id is distinct from old.ad_account_id
    or new.billing_start_id is distinct from old.billing_start_id
    or new.campaign_action_policy_id is distinct from old.campaign_action_policy_id
    or new.policy_revision is distinct from old.policy_revision
    or new.executor is distinct from old.executor
    or new.google_ads_customer_id is distinct from old.google_ads_customer_id
    or new.google_time_zone is distinct from old.google_time_zone
    or new.currency is distinct from old.currency
    or new.provider_campaign_id is distinct from old.provider_campaign_id
    or new.campaign_name is distinct from old.campaign_name
    or new.action is distinct from old.action
    or new.previous_status is distinct from old.previous_status
    or new.next_status is distinct from old.next_status
    or new.previous_daily_budget_micros is distinct from old.previous_daily_budget_micros
    or new.next_daily_budget_micros is distinct from old.next_daily_budget_micros
    or new.requested_details is distinct from old.requested_details
    or new.request_snapshot is distinct from old.request_snapshot
    or new.request_hash is distinct from old.request_hash
    or new.requested_by is distinct from old.requested_by
    or new.requested_at is distinct from old.requested_at
  then
    raise exception 'A campaign action may only be sealed once by its completion RPC.'
      using errcode = '23514';
  end if;

  return new;
end
$$;

revoke all on function public.guard_campaign_action_operation_lifecycle()
  from public, anon, authenticated, service_role;

create trigger campaign_action_operations_guard_lifecycle
  before insert or update or delete on public.campaign_action_operations
  for each row execute function public.guard_campaign_action_operation_lifecycle();

-- Append one reviewed policy revision. The caller must present the exact
-- latest policy id (or NULL only for the first revision); an empty allowlist
-- is the explicit disable operation.
create function public.set_campaign_action_policy(
  p_policy_id uuid,
  p_idempotency_key text,
  p_client_reporting_binding_id uuid,
  p_expected_policy_id uuid,
  p_allowed_actions text[],
  p_max_daily_budget_micros numeric,
  p_admin_id uuid,
  p_reason text
)
returns public.campaign_action_policies
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_actions text[];
  existing public.campaign_action_policies%rowtype;
  previous public.campaign_action_policies%rowtype;
  configured public.campaign_action_policies%rowtype;
  next_revision bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the campaign action service can set a policy.'
      using errcode = '42501';
  end if;

  if p_allowed_actions is not null
    and array_position(p_allowed_actions, null) is null
  then
    select coalesce(array_agg(action order by action), '{}'::text[])
      into normalized_actions
    from (select distinct unnest(p_allowed_actions) as action) canonical;
  end if;

  if p_policy_id is null
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    or p_client_reporting_binding_id is null
    or normalized_actions is null
    or not (
      normalized_actions <@ array[
        'budget_changed', 'campaign_paused', 'campaign_enabled'
      ]::text[]
    )
    or (
      'budget_changed' = any(normalized_actions)
      and (
        p_max_daily_budget_micros is null
        or p_max_daily_budget_micros < 1000000
        or p_max_daily_budget_micros > 1000000000000
        or trunc(p_max_daily_budget_micros) <> p_max_daily_budget_micros
      )
    )
    or (
      not ('budget_changed' = any(normalized_actions))
      and p_max_daily_budget_micros is not null
    )
    or p_admin_id is null
    or p_reason is null
    or length(p_reason) not between 3 and 500
    or btrim(p_reason) is distinct from p_reason
  then
    raise exception 'Invalid campaign action policy.' using errcode = '22023';
  end if;

  perform profile.id
  from public.profiles profile
  where profile.id = p_admin_id
    and profile.role = 'admin'
  for share;
  if not found then
    raise exception 'The campaign action policy reviewer is not an admin.'
      using errcode = '42501';
  end if;

  -- Serialize both exact id/key retries and revision assignment across server
  -- instances. The binding lock below remains the target-specific authority.
  lock table public.campaign_action_policies in share row exclusive mode;

  select policy.* into existing
  from public.campaign_action_policies policy
  where policy.id = p_policy_id
     or policy.idempotency_key = p_idempotency_key
  order by policy.id
  limit 1
  for update;

  if found then
    if existing.id is distinct from p_policy_id
      or existing.idempotency_key is distinct from p_idempotency_key
      or existing.client_reporting_binding_id is distinct from p_client_reporting_binding_id
      or existing.supersedes_policy_id is distinct from p_expected_policy_id
      or existing.allowed_actions is distinct from normalized_actions
      or existing.max_daily_budget_micros is distinct from p_max_daily_budget_micros
      or existing.configured_by is distinct from p_admin_id
      or existing.reason is distinct from p_reason
    then
      raise exception 'A campaign action policy id or key was reused with different evidence.'
        using errcode = '23505';
    end if;
    return existing;
  end if;

  -- Policy activation is allowed only while the same authority chain needed
  -- by start is healthy. Start repeats every check for every mutation.
  perform binding.id
  from public.client_reporting_bindings binding
  join public.client_rollout_states rollout
    on rollout.client_id = binding.client_id
   and rollout.operational_surface = 'v2_active'
   and rollout.reporting_cutover_at is not null
  join public.client_google_ads_connections source
    on source.id = binding.google_ads_connection_id
   and source.client_id = binding.client_id
   and source.status = 'connected'
   and source.last_verified_at is not null
   and source.last_error_code is null
  join public.ad_accounts account
    on account.id = binding.ad_account_id
   and account.client_id = binding.client_id
   and account.status = 'active'
  join public.ad_account_billing_starts billing_start
    on billing_start.ad_account_id = account.id
   and billing_start.google_ads_customer_id = account.google_ads_customer_id
   and billing_start.currency = account.currency
   and billing_start.google_time_zone = btrim(source.time_zone)
  where binding.id = p_client_reporting_binding_id
    and binding.status = 'active'
    and binding.google_ads_connection_id is not null
    and btrim(source.windsor_account_id) ~ '^[0-9[:space:]-]+$'
    and public.normalize_google_ads_customer_id(source.windsor_account_id)
          = account.google_ads_customer_id
    and source.currency = account.currency
    and source.currency ~ '^[A-Z]{3}$'
    and nullif(btrim(coalesce(source.time_zone, '')), '') is not null
    and (
      account.reporting_role in ('shopify_anchor', 'google_spend')
      or (
        account.reporting_role = 'legacy_hybrid'
        and public.campaign_action_has_legacy_pair_upgrade(
          binding.id,
          binding.client_id,
          binding.ad_account_id,
          binding.google_ads_connection_id
        )
      )
    )
    and not exists (
      select 1
      from public.ad_account_billing_ends billing_end
      where billing_end.ad_account_id = account.id
         or billing_end.billing_start_id = billing_start.id
    )
  for update of binding, account, billing_start
  for share of rollout, source;

  if not found then
    raise exception 'The exact active V2 Google binding is not policy-eligible.'
      using errcode = '23514';
  end if;

  select policy.* into previous
  from public.campaign_action_policies policy
  where policy.client_reporting_binding_id = p_client_reporting_binding_id
  order by policy.revision desc
  limit 1
  for share;

  if previous.id is distinct from p_expected_policy_id then
    raise exception 'The campaign action policy changed while it was being reviewed.'
      using errcode = '40001';
  end if;

  next_revision := coalesce(previous.revision, 0) + 1;
  perform set_config(
    'dropscale.campaign_action_policy',
    p_policy_id::text,
    true
  );

  insert into public.campaign_action_policies (
    id,
    client_reporting_binding_id,
    supersedes_policy_id,
    revision,
    allowed_actions,
    max_daily_budget_micros,
    idempotency_key,
    configured_by,
    reason
  ) values (
    p_policy_id,
    p_client_reporting_binding_id,
    previous.id,
    next_revision,
    normalized_actions,
    p_max_daily_budget_micros,
    p_idempotency_key,
    p_admin_id,
    p_reason
  )
  returning * into configured;

  return configured;
end
$$;

-- Record the exact requested change after read-only provider preflight and
-- before any provider mutation. Exact retries return the original row and its
-- sole execution claim even if policy or connection health later changes.
create function public.start_campaign_action(
  p_operation_id uuid,
  p_idempotency_key text,
  p_execution_claim_id uuid,
  p_client_id uuid,
  p_client_reporting_binding_id uuid,
  p_ad_account_id uuid,
  p_client_google_ads_connection_id uuid,
  p_google_ads_customer_id text,
  p_provider_campaign_id text,
  p_campaign_name text,
  p_action text,
  p_currency text,
  p_actor_id uuid,
  p_previous_status text default null,
  p_next_status text default null,
  p_previous_daily_budget_micros numeric default null,
  p_next_daily_budget_micros numeric default null,
  p_details jsonb default '{}'::jsonb
)
returns public.campaign_action_operations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing public.campaign_action_operations%rowtype;
  started public.campaign_action_operations%rowtype;
  target_binding public.client_reporting_bindings%rowtype;
  google_source public.client_google_ads_connections%rowtype;
  target_account public.ad_accounts%rowtype;
  selected_policy public.campaign_action_policies%rowtype;
  resolved_anchor_binding_id uuid;
  resolved_anchor_ad_account_id uuid;
  exact_billing_start_id uuid;
  reporting_cutover_at timestamptz;
  canonical_time_zone text;
  snapshot jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the campaign action service can start an operation.'
      using errcode = '42501';
  end if;

  if p_operation_id is null
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    or p_execution_claim_id is null
    or p_client_id is null
    or p_client_reporting_binding_id is null
    or p_ad_account_id is null
    or p_client_google_ads_connection_id is null
    or coalesce(p_google_ads_customer_id, '') !~ '^[0-9]{10}$'
    or coalesce(p_provider_campaign_id, '') !~ '^[0-9]{1,30}$'
    or p_campaign_name is null
    or length(p_campaign_name) not between 1 and 500
    or btrim(p_campaign_name) is distinct from p_campaign_name
    or p_action not in (
      'budget_changed', 'campaign_paused', 'campaign_enabled'
    )
    or coalesce(p_currency, '') !~ '^[A-Z]{3}$'
    or p_actor_id is null
    or not public.campaign_action_json_is_safe(p_details, 8192)
    or (
      p_action = 'budget_changed'
      and (
        p_previous_status is not null
        or p_next_status is not null
        or p_previous_daily_budget_micros is null
        or p_previous_daily_budget_micros < 1000000
        or p_previous_daily_budget_micros > 1000000000000
        or trunc(p_previous_daily_budget_micros) <> p_previous_daily_budget_micros
        or p_next_daily_budget_micros is null
        or p_next_daily_budget_micros < 1000000
        or p_next_daily_budget_micros > 1000000000000
        or trunc(p_next_daily_budget_micros) <> p_next_daily_budget_micros
        or p_previous_daily_budget_micros = p_next_daily_budget_micros
      )
    )
    or (
      p_action = 'campaign_paused'
      and (
        p_previous_status is distinct from 'active'
        or p_next_status is distinct from 'paused'
        or p_previous_daily_budget_micros is not null
        or p_next_daily_budget_micros is not null
      )
    )
    or (
      p_action = 'campaign_enabled'
      and (
        p_previous_status is distinct from 'paused'
        or p_next_status is distinct from 'active'
        or p_previous_daily_budget_micros is not null
        or p_next_daily_budget_micros is not null
      )
    )
  then
    raise exception 'Invalid campaign action request.' using errcode = '22023';
  end if;

  perform profile.id
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.role = 'admin'
  for share;
  if not found then
    raise exception 'The campaign action requester is not an admin.'
      using errcode = '42501';
  end if;

  -- This lock closes first-call races for operation/key idempotency and the
  -- one-requested-operation partial uniqueness rule.
  lock table public.campaign_action_operations in share row exclusive mode;

  select operation.* into existing
  from public.campaign_action_operations operation
  where operation.id = p_operation_id
     or operation.idempotency_key = p_idempotency_key
  order by operation.id
  limit 1
  for update;

  if found then
    if existing.id is distinct from p_operation_id
      or existing.idempotency_key is distinct from p_idempotency_key
      or existing.client_id is distinct from p_client_id
      or existing.client_reporting_binding_id is distinct from p_client_reporting_binding_id
      or existing.ad_account_id is distinct from p_ad_account_id
      or existing.client_google_ads_connection_id is distinct from p_client_google_ads_connection_id
      or existing.google_ads_customer_id is distinct from p_google_ads_customer_id
      or existing.provider_campaign_id is distinct from p_provider_campaign_id
      or existing.campaign_name is distinct from p_campaign_name
      or existing.action is distinct from p_action
      or existing.currency is distinct from p_currency
      or existing.requested_by is distinct from p_actor_id
      or existing.previous_status is distinct from p_previous_status
      or existing.next_status is distinct from p_next_status
      or existing.previous_daily_budget_micros is distinct from p_previous_daily_budget_micros
      or existing.next_daily_budget_micros is distinct from p_next_daily_budget_micros
      or existing.requested_details is distinct from p_details
    then
      raise exception 'A campaign action id or idempotency key was reused with different evidence.'
        using errcode = '23505';
    end if;
    return existing;
  end if;

  select binding.* into target_binding
  from public.client_reporting_bindings binding
  where binding.id = p_client_reporting_binding_id
    and binding.client_id = p_client_id
    and binding.ad_account_id = p_ad_account_id
    and binding.google_ads_connection_id = p_client_google_ads_connection_id
    and binding.status = 'active'
  for share;
  if not found then
    raise exception 'The exact active client reporting binding is unavailable.'
      using errcode = '23514';
  end if;

  select rollout.reporting_cutover_at into reporting_cutover_at
  from public.client_rollout_states rollout
  where rollout.client_id = p_client_id
    and rollout.operational_surface = 'v2_active'
    and rollout.reporting_cutover_at is not null
  for share;
  if not found then
    raise exception 'The client is not on a marker-backed V2 reporting surface.'
      using errcode = '23514';
  end if;

  select source.* into google_source
  from public.client_google_ads_connections source
  where source.id = p_client_google_ads_connection_id
    and source.client_id = p_client_id
    and source.status = 'connected'
    and source.last_verified_at is not null
    and source.last_error_code is null
    and btrim(source.windsor_account_id) ~ '^[0-9[:space:]-]+$'
    and public.normalize_google_ads_customer_id(source.windsor_account_id)
          = p_google_ads_customer_id
    and source.currency = p_currency
    and source.currency ~ '^[A-Z]{3}$'
    and nullif(btrim(coalesce(source.time_zone, '')), '') is not null
  for share;
  if not found then
    raise exception 'The exact connected Google Ads source is not healthy.'
      using errcode = '23514';
  end if;
  canonical_time_zone := btrim(google_source.time_zone);

  select account.* into target_account
  from public.ad_accounts account
  where account.id = p_ad_account_id
    and account.client_id = p_client_id
    and account.google_ads_customer_id = p_google_ads_customer_id
    and account.currency = p_currency
    and account.status = 'active'
    and account.reporting_role in (
      'shopify_anchor', 'google_spend', 'legacy_hybrid'
    )
  for update;
  if not found then
    raise exception 'The exact normalized active ad account is unavailable.'
      using errcode = '23514';
  end if;

  select billing_start.id into exact_billing_start_id
  from public.ad_account_billing_starts billing_start
  where billing_start.ad_account_id = p_ad_account_id
    and billing_start.google_ads_customer_id = p_google_ads_customer_id
    and billing_start.currency = p_currency
    and billing_start.google_time_zone = canonical_time_zone
    and not exists (
      select 1
      from public.ad_account_billing_ends billing_end
      where billing_end.ad_account_id = p_ad_account_id
         or billing_end.billing_start_id = billing_start.id
    )
  for update;
  if not found then
    raise exception 'The exact Google billing start is not open.'
      using errcode = '23514';
  end if;

  if target_binding.shopify_connection_id is not null then
    if target_binding.shopify_anchor_binding_id is not null
      or target_account.reporting_role not in ('shopify_anchor', 'legacy_hybrid')
      or (
        target_account.reporting_role = 'legacy_hybrid'
        and not public.campaign_action_has_legacy_pair_upgrade(
          target_binding.id,
          target_binding.client_id,
          target_binding.ad_account_id,
          target_binding.google_ads_connection_id
        )
      )
    then
      raise exception 'The direct Google binding is not its exact Shopify anchor.'
        using errcode = '23514';
    end if;
    resolved_anchor_binding_id := target_binding.id;
    resolved_anchor_ad_account_id := target_binding.ad_account_id;
  elsif target_binding.shopify_anchor_binding_id is not null then
    select anchor.ad_account_id
      into resolved_anchor_ad_account_id
    from public.client_reporting_bindings anchor
    join public.ad_accounts anchor_account
      on anchor_account.id = anchor.ad_account_id
     and anchor_account.client_id = p_client_id
     and anchor_account.reporting_role = 'shopify_anchor'
    where anchor.id = target_binding.shopify_anchor_binding_id
      and anchor.client_id = p_client_id
      and anchor.status = 'active'
      and anchor.shopify_connection_id is not null
      and exists (
        select 1
        from public.client_asset_mappings mapping
        where mapping.shopify_connection_id = anchor.shopify_connection_id
          and mapping.google_ads_connection_id = p_client_google_ads_connection_id
      )
    for share of anchor, anchor_account;
    if not found or target_account.reporting_role <> 'google_spend' then
      raise exception 'The Google child has no exact active Shopify anchor mapping.'
        using errcode = '23514';
    end if;
    resolved_anchor_binding_id := target_binding.shopify_anchor_binding_id;
  elsif target_account.reporting_role <> 'google_spend' then
    raise exception 'An unanchored Google binding must use a Google spend account.'
      using errcode = '23514';
  end if;

  select policy.* into selected_policy
  from public.campaign_action_policies policy
  where policy.client_reporting_binding_id = p_client_reporting_binding_id
  order by policy.revision desc
  limit 1
  for share;
  if not found
    or not (p_action = any(selected_policy.allowed_actions))
    or (
      p_action = 'budget_changed'
      and p_next_daily_budget_micros > selected_policy.max_daily_budget_micros
    )
  then
    raise exception 'The latest campaign action policy does not authorize this request.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.campaign_action_operations operation
    where operation.client_reporting_binding_id = p_client_reporting_binding_id
      and operation.provider_campaign_id = p_provider_campaign_id
      and operation.status = 'requested'
  ) then
    raise exception 'This bound campaign already has a requested action.'
      using errcode = '23505';
  end if;

  snapshot := jsonb_build_object(
    'schema', 'campaign-action-request-v1',
    'operationId', p_operation_id,
    'idempotencyKey', p_idempotency_key,
    'executionClaimId', p_execution_claim_id,
    'executor', 'agency_google',
    'clientId', p_client_id,
    'reportingCutoverAt', reporting_cutover_at,
    'clientReportingBindingId', p_client_reporting_binding_id,
    'clientReportingBindingStatus', target_binding.status,
    'clientGoogleAdsConnectionId', p_client_google_ads_connection_id,
    'googleSourceStatus', google_source.status,
    'googleSourceLastVerifiedAt', google_source.last_verified_at,
    'googleSourceLastErrorCode', google_source.last_error_code,
    'shopifyAnchorBindingId', resolved_anchor_binding_id,
    'shopifyAnchorAdAccountId', resolved_anchor_ad_account_id,
    'adAccountId', p_ad_account_id,
    'adAccountStatus', target_account.status,
    'adAccountReportingRole', target_account.reporting_role,
    'billingStartId', exact_billing_start_id,
    'billingState', 'open',
    'googleAdsCustomerId', p_google_ads_customer_id,
    'googleTimeZone', canonical_time_zone,
    'currency', p_currency,
    'providerCampaignId', p_provider_campaign_id,
    'campaignName', p_campaign_name,
    'action', p_action,
    'previousStatus', p_previous_status,
    'nextStatus', p_next_status,
    'previousDailyBudgetMicros', p_previous_daily_budget_micros,
    'nextDailyBudgetMicros', p_next_daily_budget_micros,
    'requestedBy', p_actor_id,
    'requestedDetails', p_details,
    'policy', jsonb_build_object(
      'id', selected_policy.id,
      'revision', selected_policy.revision,
      'allowedActions', selected_policy.allowed_actions,
      'maxDailyBudgetMicros', selected_policy.max_daily_budget_micros
    )
  );

  if not public.campaign_action_json_is_safe(snapshot, 16384) then
    raise exception 'The campaign action request snapshot is unsafe.'
      using errcode = '22023';
  end if;

  perform set_config(
    'dropscale.campaign_action_start',
    p_operation_id::text,
    true
  );

  insert into public.campaign_action_operations (
    id,
    idempotency_key,
    execution_claim_id,
    client_id,
    client_reporting_binding_id,
    client_google_ads_connection_id,
    shopify_anchor_binding_id,
    shopify_anchor_ad_account_id,
    ad_account_id,
    billing_start_id,
    campaign_action_policy_id,
    policy_revision,
    google_ads_customer_id,
    google_time_zone,
    currency,
    provider_campaign_id,
    campaign_name,
    action,
    previous_status,
    next_status,
    previous_daily_budget_micros,
    next_daily_budget_micros,
    requested_details,
    request_snapshot,
    request_hash,
    requested_by
  ) values (
    p_operation_id,
    p_idempotency_key,
    p_execution_claim_id,
    p_client_id,
    p_client_reporting_binding_id,
    p_client_google_ads_connection_id,
    resolved_anchor_binding_id,
    resolved_anchor_ad_account_id,
    p_ad_account_id,
    exact_billing_start_id,
    selected_policy.id,
    selected_policy.revision,
    p_google_ads_customer_id,
    canonical_time_zone,
    p_currency,
    p_provider_campaign_id,
    p_campaign_name,
    p_action,
    p_previous_status,
    p_next_status,
    p_previous_daily_budget_micros,
    p_next_daily_budget_micros,
    p_details,
    snapshot,
    md5(snapshot::text),
    p_actor_id
  )
  returning * into started;

  return started;
end
$$;

-- Seal an admitted request after the provider attempt. Current policy,
-- connection health and billing-open state are intentionally not rechecked:
-- none may strand durable provider evidence after a successful start.
create function public.complete_campaign_action(
  p_operation_id uuid,
  p_idempotency_key text,
  p_execution_claim_id uuid,
  p_actor_id uuid,
  p_outcome text,
  p_observed_status text default null,
  p_observed_daily_budget_micros numeric default null,
  p_details jsonb default '{}'::jsonb
)
returns public.campaign_action_operations
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target public.campaign_action_operations%rowtype;
  completed public.campaign_action_operations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the campaign action service can complete an operation.'
      using errcode = '42501';
  end if;

  if p_operation_id is null
    or coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
    or p_execution_claim_id is null
    or p_actor_id is null
    or p_outcome not in ('succeeded', 'failed', 'uncertain')
    or (
      p_observed_status is not null
      and p_observed_status not in ('active', 'paused', 'ended')
    )
    or (
      p_observed_daily_budget_micros is not null
      and (
        p_observed_daily_budget_micros < 1000000
        or p_observed_daily_budget_micros > 1000000000000
        or trunc(p_observed_daily_budget_micros)
             <> p_observed_daily_budget_micros
      )
    )
    or not public.campaign_action_json_is_safe(p_details, 8192)
  then
    raise exception 'Invalid campaign action outcome.' using errcode = '22023';
  end if;

  select operation.* into target
  from public.campaign_action_operations operation
  where operation.id = p_operation_id
  for update;

  if not found then
    raise exception 'The campaign action operation does not exist.'
      using errcode = 'P0002';
  end if;

  if target.idempotency_key is distinct from p_idempotency_key
    or target.execution_claim_id is distinct from p_execution_claim_id
    or target.requested_by is distinct from p_actor_id
  then
    raise exception 'The campaign action operation identity does not match.'
      using errcode = '42501';
  end if;

  if target.status <> 'requested' then
    if target.status is distinct from p_outcome
      or target.observed_status is distinct from p_observed_status
      or target.observed_daily_budget_micros
           is distinct from p_observed_daily_budget_micros
      or target.result_details is distinct from p_details
    then
      raise exception 'Terminal campaign action evidence is immutable.'
        using errcode = '23514';
    end if;
    return target;
  end if;

  if p_outcome = 'succeeded'
    and not (
      (
        target.action = 'budget_changed'
        and p_observed_daily_budget_micros
              = target.next_daily_budget_micros
      )
      or (
        target.action in ('campaign_paused', 'campaign_enabled')
        and p_observed_status = target.next_status
      )
      or (
        target.action = 'campaign_launched'
        and p_observed_status = target.next_status
        and p_observed_daily_budget_micros
              = target.next_daily_budget_micros
      )
    )
  then
    raise exception 'Successful campaign action evidence does not match the request.'
      using errcode = '22023';
  end if;

  perform set_config(
    'dropscale.campaign_action_complete',
    p_operation_id::text,
    true
  );

  update public.campaign_action_operations operation
  set status = p_outcome,
      observed_status = p_observed_status,
      observed_daily_budget_micros = p_observed_daily_budget_micros,
      result_details = p_details,
      completed_at = clock_timestamp()
  where operation.id = p_operation_id
    and operation.status = 'requested'
  returning * into completed;

  if not found then
    raise exception 'The campaign action operation is no longer requested.'
      using errcode = '40001';
  end if;

  return completed;
end
$$;

revoke all on function public.set_campaign_action_policy(
  uuid, text, uuid, uuid, text[], numeric, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.start_campaign_action(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid,
  text, text, numeric, numeric, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.complete_campaign_action(
  uuid, text, uuid, uuid, text, text, numeric, jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.set_campaign_action_policy(
  uuid, text, uuid, uuid, text[], numeric, uuid, text
) to service_role;
grant execute on function public.start_campaign_action(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, uuid,
  text, text, numeric, numeric, jsonb
) to service_role;
grant execute on function public.complete_campaign_action(
  uuid, text, uuid, uuid, text, text, numeric, jsonb
) to service_role;
