-- =============================================================================
-- 0053 - Durable no-charge receipts for deliberately skipped billing cycles.
--
-- 0036 allowed `no_charge` only when the closed-week Google ledger proved
-- exact zero spend. 0038 later added an admin-attributed decision to forgive a
-- cycle, but did not extend the receipt contract. A skipped cycle with real
-- spend therefore failed after it had been claimed and remained `processing`
-- until its claim expired.
--
-- Keep both reasons explicit. Exact-zero receipts retain the original proof;
-- skipped receipts point at the immutable commercial decision and may retain
-- a positive spend snapshot while the amount owed is zero. No ledger row,
-- invoice or existing receipt is rewritten.
-- =============================================================================

set local lock_timeout = '10s';
set local statement_timeout = '5min';

alter table public.billing_automation_items
  add column no_charge_reason text,
  add column billing_cycle_skip_id uuid
    references public.billing_cycle_skips (id) on delete restrict;

-- Every receipt created before this migration necessarily passed the strict
-- 0036 zero-spend check, so this backfill adds provenance without inference.
update public.billing_automation_items
set no_charge_reason = 'exact_zero'
where state = 'no_charge';

alter table public.billing_automation_items
  drop constraint billing_automation_items_no_charge_check;

alter table public.billing_automation_items
  add constraint billing_automation_items_no_charge_provenance_check check (
    (
      state = 'no_charge'
      and (
        (
          no_charge_reason = 'exact_zero'
          and billing_cycle_skip_id is null
        )
        or (
          no_charge_reason = 'cycle_skipped'
          and billing_cycle_skip_id is not null
        )
      )
    )
    or (
      state <> 'no_charge'
      and no_charge_reason is null
      and billing_cycle_skip_id is null
    )
  ),
  add constraint billing_automation_items_no_charge_check check (
    state <> 'no_charge'
    or (
      invoice_id is null
      and stage = 'complete'
      and blocker_code is null
      and safe_message is null
      and amount_snapshot = 0
      and (
        (
          no_charge_reason = 'exact_zero'
          and billable_spend_snapshot = 0
          and evidence_account_count > 0
        )
        or (
          no_charge_reason = 'cycle_skipped'
          and billable_spend_snapshot >= 0
          and evidence_account_count >= 0
        )
      )
    )
  );

create unique index billing_automation_items_cycle_skip_unique
  on public.billing_automation_items (billing_cycle_skip_id)
  where billing_cycle_skip_id is not null;

comment on column public.billing_automation_items.no_charge_reason is
  'Why no invoice was owed: exact_zero is certified zero Google spend; cycle_skipped is an admin-attributed forgiveness decision.';
comment on column public.billing_automation_items.billing_cycle_skip_id is
  'Immutable provenance for a cycle_skipped no-charge receipt. The referenced decision cannot be removed after settlement.';

-- Recovery is narrower than the ordinary queue claim: it cannot discover,
-- seed or claim general work, and the target run must explicitly have invoice
-- issuance disabled. This is sufficient to recover the expired skip claims
-- created before this migration without arming the invoice worker.
create or replace function public.claim_expired_skipped_billing_automation_items(
  p_run_id uuid,
  p_limit integer default 20
)
returns setof public.billing_automation_items
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can recover skipped automation work.'
      using errcode = '42501';
  end if;
  if p_run_id is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'A non-issuance run and recovery limit from 1 to 100 are required.'
      using errcode = '22023';
  end if;

  perform run.id
  from public.billing_automation_runs run
  where run.id = p_run_id
    and run.status = 'running'
    and not run.issuance_enabled
  for update;
  if not found then
    raise exception 'Skipped-cycle recovery requires an active non-issuance run.'
      using errcode = 'P0001';
  end if;

  return query
  with candidates as (
    select item.id
    from public.billing_automation_items item
    join public.billing_cycle_skips skip
      on skip.client_id = item.client_id
     and skip.period_start = item.period_start
     and skip.period_end = item.period_end
    where item.state = 'processing'
      and item.claim_expires_at <= clock_timestamp()
      and item.invoice_id is null
      and item.no_charge_reason is null
      and item.billing_cycle_skip_id is null
      and item.last_run_id is distinct from p_run_id
    order by item.period_start, item.first_seen_at, item.client_id
    for update of item skip locked
    limit p_limit
  ),
  claimed as (
    update public.billing_automation_items item
    set
      stage = 'preview',
      blocker_code = null,
      safe_message = null,
      amount_snapshot = null,
      billable_spend_snapshot = null,
      evidence_account_count = 0,
      claimed_by_run_id = p_run_id,
      claim_version = item.claim_version + 1,
      claim_expires_at = clock_timestamp() + interval '20 minutes',
      attempt_count = item.attempt_count + 1,
      last_attempted_at = clock_timestamp(),
      last_run_id = p_run_id,
      updated_at = clock_timestamp()
    from candidates
    where item.id = candidates.id
    returning item.*
  ),
  counted as (
    update public.billing_automation_runs run
    set claimed_items = run.claimed_items + (select count(*) from claimed)
    where run.id = p_run_id
      and run.status = 'running'
      and not run.issuance_enabled
    returning run.id
  )
  select claimed.*
  from claimed
  cross join counted;
end
$$;

create or replace function public.record_billing_automation_item_result(
  p_item_id uuid,
  p_run_id uuid,
  p_claim_version bigint,
  p_state text,
  p_stage text,
  p_code text default null,
  p_invoice_id uuid default null,
  p_amount numeric default null,
  p_billable_spend numeric default null,
  p_evidence_account_count integer default 0
)
returns setof public.billing_automation_items
language plpgsql
security definer
set search_path = public
as $$
declare
  current_item public.billing_automation_items%rowtype;
  current_run public.billing_automation_runs%rowtype;
  invoice_row public.invoices%rowtype;
  cycle_skip public.billing_cycle_skips%rowtype;
  selected_message text;
  exact_account_count integer;
  selected_no_charge_reason text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can record automation work.'
      using errcode = '42501';
  end if;
  if p_state not in ('blocked', 'issued', 'no_charge')
     or p_stage not in ('preview', 'google_evidence', 'stripe_issue', 'complete')
     or p_evidence_account_count < 0
     or (p_code is not null and p_code !~ '^[a-z0-9_]{1,80}$') then
    raise exception 'The automation result shape is invalid.' using errcode = '22023';
  end if;

  select * into current_run
  from public.billing_automation_runs run
  where run.id = p_run_id and run.status = 'running'
  for update;
  if not found then
    raise exception 'The automation run is not active.' using errcode = 'P0001';
  end if;

  if p_state = 'issued' and not current_run.issuance_enabled then
    raise exception 'A non-issuance automation run cannot record an issued invoice.'
      using errcode = '42501';
  end if;

  select * into current_item
  from public.billing_automation_items item
  where item.id = p_item_id
  for update;

  if not found
     or current_item.state <> 'processing'
     or current_item.claimed_by_run_id is distinct from p_run_id
     or current_item.claim_version is distinct from p_claim_version then
    raise exception 'The automation item claim was lost.' using errcode = '40001';
  end if;

  if p_state = 'issued' then
    if p_invoice_id is null or p_code is not null or p_stage <> 'complete' then
      raise exception 'An issued item requires one linked invoice and no blocker.'
        using errcode = '22023';
    end if;
    select * into invoice_row
    from public.invoices invoice
    where invoice.id = p_invoice_id;
    if not found
       or invoice_row.client_id <> current_item.client_id
       or invoice_row.period_start <> current_item.period_start
       or invoice_row.period_end <> current_item.period_end
       or invoice_row.issuer_kind not in ('admin', 'automation')
       or (
         invoice_row.status = 'waived'
         and invoice_row.issued_at is null
       )
       or (
         invoice_row.status <> 'waived'
         and invoice_row.stripe_sent_at is null
         and invoice_row.stripe_delivery_assumed_at is null
       )
       or round(invoice_row.amount, 2) is distinct from round(p_amount, 2) then
      raise exception 'The linked invoice is not an issued receipt for this client/week.'
        using errcode = 'P0001';
    end if;
  elsif p_state = 'no_charge' then
    if p_invoice_id is not null
       or p_code is not null
       or p_stage <> 'complete'
       or p_amount is distinct from 0
       or p_billable_spend is null
       or p_billable_spend < 0 then
      raise exception 'No-charge requires a complete zero-amount settlement.'
        using errcode = 'P0001';
    end if;

    -- SHARE conflicts with the removal RPC's UPDATE lock. Either the decision
    -- becomes durable provenance here, or removal wins and this falls back to
    -- the exact-zero path; there is no unreferenced terminal skip receipt.
    select * into cycle_skip
    from public.billing_cycle_skips skip
    where skip.client_id = current_item.client_id
      and skip.period_start = current_item.period_start
      and skip.period_end = current_item.period_end
    for share;

    if cycle_skip.id is not null then
      selected_no_charge_reason := 'cycle_skipped';
    else
      if p_billable_spend is distinct from 0
         or p_evidence_account_count < 1 then
        raise exception 'No-charge without a cycle skip requires exact complete zero-spend proof.'
          using errcode = 'P0001';
      end if;
      exact_account_count := public.billing_automation_exact_zero_account_count(
        current_item.client_id,
        current_item.period_start,
        current_item.period_end
      );
      if exact_account_count <> p_evidence_account_count then
        raise exception 'The no-charge evidence account count changed during settlement.'
          using errcode = '40001';
      end if;
      selected_no_charge_reason := 'exact_zero';
    end if;
  elsif p_code is null then
    raise exception 'Blocked work requires a stable blocker code.'
      using errcode = '22023';
  end if;

  if p_state = 'blocked' then
    selected_message := case p_code
      when 'billing_not_started' then 'An immutable billing start is still required.'
      when 'billing_start_mismatch' then 'The immutable billing start needs review.'
      when 'billing_end_mismatch' then 'The immutable billing end needs review.'
      when 'ledger_missing' then 'Exact closed-week Google evidence is not complete yet.'
      when 'ledger_stale' then 'Closed-week Google evidence needs refreshing.'
      when 'evidence_settling' then 'Sunday Google spend is still settling.'
      when 'recipient_invalid' then 'The client billing details need review.'
      when 'referral_term_mismatch' then 'The manual referral term needs review.'
      when 'stripe_not_configured' then 'Live Stripe billing is not ready.'
      when 'issuance_disabled' then 'Automatic invoice issuance is locked.'
      when 'issue_in_progress' then 'Another invoice worker currently owns this client.'
      when 'preview_failed' then 'The closed week could not be calculated.'
      when 'stripe_issue_failed' then 'Stripe invoice delivery needs retrying.'
      else 'Automatic billing needs review.'
    end;
  end if;

  update public.billing_automation_items item
  set
    state = p_state,
    stage = p_stage,
    blocker_code = case when p_state = 'blocked' then p_code else null end,
    safe_message = case when p_state = 'blocked' then selected_message else null end,
    invoice_id = p_invoice_id,
    amount_snapshot = p_amount,
    billable_spend_snapshot = p_billable_spend,
    evidence_account_count = p_evidence_account_count,
    no_charge_reason = selected_no_charge_reason,
    billing_cycle_skip_id = case
      when selected_no_charge_reason = 'cycle_skipped' then cycle_skip.id
      else null
    end,
    resolved_at = case
      when p_state in ('issued', 'no_charge') then clock_timestamp()
      else null
    end,
    claimed_by_run_id = null,
    claim_expires_at = null,
    last_run_id = p_run_id,
    updated_at = clock_timestamp()
  where item.id = current_item.id;

  update public.billing_automation_runs run
  set
    issued_items = run.issued_items + case when p_state = 'issued' then 1 else 0 end,
    no_charge_items = run.no_charge_items + case when p_state = 'no_charge' then 1 else 0 end,
    blocked_items = run.blocked_items + case when p_state = 'blocked' then 1 else 0 end
  where run.id = p_run_id and run.status = 'running';

  return query
  select item.*
  from public.billing_automation_items item
  where item.id = current_item.id;
end
$$;

create or replace function public.remove_billing_cycle_skip(
  p_client_id uuid,
  p_period_start date,
  p_removed_by uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_skip_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the billing service can remove a billing cycle skip.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_removed_by and profile.role = 'admin'
  ) then
    raise exception 'A verified admin is required to remove a billing cycle skip.'
      using errcode = '42501';
  end if;

  select skip.id into target_skip_id
  from public.billing_cycle_skips skip
  where skip.client_id = p_client_id
    and skip.period_start = p_period_start
  for update;

  if target_skip_id is null then
    return false;
  end if;

  if exists (
    select 1
    from public.billing_automation_items item
    where item.billing_cycle_skip_id = target_skip_id
      and item.state = 'no_charge'
  ) then
    raise exception 'This skipped cycle already has a durable no-charge receipt.'
      using errcode = '22023';
  end if;

  delete from public.billing_cycle_skips
  where id = target_skip_id;

  return true;
end
$$;

revoke all on function public.record_billing_automation_item_result(
  uuid, uuid, bigint, text, text, text, uuid, numeric, numeric, integer
) from public, anon, authenticated;
grant execute on function public.record_billing_automation_item_result(
  uuid, uuid, bigint, text, text, text, uuid, numeric, numeric, integer
) to service_role;

revoke all on function public.claim_expired_skipped_billing_automation_items(
  uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_expired_skipped_billing_automation_items(
  uuid, integer
) to service_role;

revoke all on function public.remove_billing_cycle_skip(uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function public.remove_billing_cycle_skip(uuid, date, uuid)
  to service_role;

notify pgrst, 'reload schema';
