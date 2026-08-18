-- A voided invoice is a cancelled charge, not a settled week. Owner decision
-- (2026-08-18, Daniel Azevedo's corrected cycle): cancelling an invoice and
-- re-issuing the same period with the right amount is a supported workflow,
-- so the one-non-legacy-invoice-per-client-week key must stop counting void
-- rows. The void row itself stays forever (guard_invoice_commercial_snapshot
-- already forbids deleting any invoice) as the audit trail of the cancelled
-- charge; the replacement row is the period's live invoice.
--
-- The legacy key is untouched: legacy rows are frozen history and none of
-- them is void.

drop index if exists public.invoices_one_nonlegacy_per_client_week_idx;

create unique index invoices_one_nonlegacy_per_client_week_idx
  on public.invoices (client_id, period_start)
  where calculation_version <> 'legacy' and status <> 'void';

-- Voiding an invoice reopens the automation queue item that settled it, so a
-- corrected week flows through the same machinery as a fresh one instead of
-- staying frozen behind a stale "issued" receipt.
create or replace function public.release_billing_automation_item_on_void()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'void' and old.status is distinct from 'void' then
    update public.billing_automation_items item
      set state = 'pending',
          stage = 'discovered',
          invoice_id = null,
          amount_snapshot = null,
          billable_spend_snapshot = null,
          no_charge_reason = null,
          billing_cycle_skip_id = null,
          resolved_at = null,
          blocker_code = null,
          safe_message = null
      where item.invoice_id = new.id
        and item.state = 'issued';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_release_automation_item_on_void on public.invoices;
create trigger invoices_release_automation_item_on_void
  after update of status on public.invoices
  for each row execute function public.release_billing_automation_item_on_void();

-- The automation receipt validator must refuse a voided invoice as "issued":
-- a cancelled charge can never settle a week. Same live definition with one
-- added condition in the linked-invoice rejection.
CREATE OR REPLACE FUNCTION public.record_billing_automation_item_result(p_item_id uuid, p_run_id uuid, p_claim_version bigint, p_state text, p_stage text, p_code text DEFAULT NULL::text, p_invoice_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT NULL::numeric, p_billable_spend numeric DEFAULT NULL::numeric, p_evidence_account_count integer DEFAULT 0)
 RETURNS SETOF billing_automation_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
       or invoice_row.status = 'void'
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
$function$;
