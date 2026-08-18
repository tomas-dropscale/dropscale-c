-- Completing 0075: a cancelled (void) invoice must also release its Google
-- ledger claims. invoice_commission_rows has UNIQUE (commission_id) — one
-- claim per ledger row, ever — so the void invoice's claims would forever
-- lock the corrected week's evidence out of the replacement invoice.
--
-- The claim rows guard stays for every live invoice: a claim may only be
-- deleted when its owning invoice is void. The void invoice's own line_items
-- snapshot (immutable) remains the audit trail of what the cancelled charge
-- had claimed.

create or replace function public.guard_invoice_commission_row_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  owning_invoice public.invoices%rowtype;
begin
  if tg_op = 'DELETE' then
    select * into owning_invoice
    from public.invoices
    where id = old.invoice_id;
    if found and owning_invoice.status = 'void' then
      return old;
    end if;
  end if;
  raise exception 'An invoice Google ledger claim is immutable.'
    using errcode = '22023';
end
$$;

-- Voiding now releases the queue item (0075) AND the ledger claims in the
-- same transition.
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
    delete from public.invoice_commission_rows claim
      where claim.invoice_id = new.id;
  end if;
  return new;
end;
$$;
