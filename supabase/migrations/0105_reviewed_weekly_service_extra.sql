-- Owner-approved addition to the 19–25 October Google Ads cycle, issued from
-- 26 October: Lourenço Alexandre, Customer service, EUR 34.80, once only.
-- No invoice is created, sent, charged or changed by this migration.
-- All existing Google evidence, recipient, lease and duplicate guards remain.
begin;

create or replace function public.reviewed_weekly_invoice_extras(
  p_client_id uuid, p_period_start date
) returns jsonb
language sql immutable
set search_path = public
as $$
  select case
    when p_client_id = '5107292f-1bf6-42a4-ba8d-dc1d730d4044'::uuid
     and p_period_start = date '2026-10-19'
    then jsonb_build_array(jsonb_build_object(
      'kind', 'service',
      'extraId', 'lourenco-customer-service-2026-10-26',
      'label', 'Customer service',
      'amount', 34.80,
      'accountId', null
    ))
    else '[]'::jsonb
  end
$$;

create or replace function public.assert_reviewed_weekly_invoice_extras(
  p_client_id uuid, p_period_start date, p_line_items jsonb
) returns void
language plpgsql
set search_path = public
as $$
declare
  requested jsonb;
begin
  select coalesce(jsonb_agg(line order by line->>'extraId'), '[]'::jsonb)
    into requested
  from jsonb_array_elements(p_line_items) line
  where line->>'kind' = 'service';

  -- Compare the complete line: wrong amounts, labels, account associations,
  -- extra identifiers, missing lines and duplicate supplements all fail closed.
  if requested is distinct from public.reviewed_weekly_invoice_extras(
    p_client_id, p_period_start
  ) then
    raise exception 'Service extras do not match the explicitly approved client and billing cycle.'
      using errcode = '22023';
  end if;
end
$$;

revoke all on function public.reviewed_weekly_invoice_extras(uuid,date)
  from public, anon, authenticated;
revoke all on function public.assert_reviewed_weekly_invoice_extras(uuid,date,jsonb)
  from public, anon, authenticated;
grant execute on function public.reviewed_weekly_invoice_extras(uuid,date)
  to service_role;
grant execute on function public.assert_reviewed_weekly_invoice_extras(uuid,date,jsonb)
  to service_role;

-- Patch only the allowed kinds and the new exact supplement validation.
-- Use the live function so later billing fixes (including 0104) are preserved.
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.create_manual_referral_invoice(uuid,date,date,numeric,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure
  );
  kinds text := 'not in (''fee'', ''rev_share'', ''arrears'')';
  fee_anchor text := E'  select coalesce(jsonb_agg(line), ''[]''::jsonb)\n    into fee_lines';
  extra_guard text := E'  perform public.assert_reviewed_weekly_invoice_extras(p_client_id, p_period_start, p_line_items);\n\n';
begin
  definition := replace(definition, E'\r\n', E'\n');
  if strpos(definition, extra_guard) = 0 then
    if strpos(definition, kinds) = 0 or strpos(definition, fee_anchor) = 0 then
      raise exception '0105: billing validation changed; review this migration before applying it.';
    end if;
    definition := replace(definition, kinds,
      'not in (''fee'', ''rev_share'', ''arrears'', ''service'')');
    definition := replace(definition, fee_anchor, extra_guard || fee_anchor);
    execute definition;
  elsif strpos(definition, 'not in (''fee'', ''rev_share'', ''arrears'', ''service'')') = 0 then
    raise exception '0105: existing service supplement validation is inconsistent.';
  end if;
end
$migration$;

notify pgrst, 'reload schema';
commit;
