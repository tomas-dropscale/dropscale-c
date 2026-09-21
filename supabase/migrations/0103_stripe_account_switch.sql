-- 0103 — move billing to a new Stripe account.
--
-- Stripe Customers belong to one account. The 13 clients below were bound to a
-- customer of the old account (Jensen Nord) at their first issued invoice, and
-- 0028's guard trigger forbids replacing OR clearing that binding for every
-- role, service_role included. With the new key deployed, issuing for any of
-- them would fail with "No such customer" on every retry, and nothing in the
-- app can heal it. This archives the old ids and clears the binding, so the
-- next issue creates a customer in the new account exactly as a first invoice
-- does (pushToStripe → createCustomer, src/lib/billing/invoices.ts).
--
-- Run ONCE, by an operator, in the Supabase SQL Editor, and only in this order:
--   1. every invoice in status open/draft/uncollectible that carries a
--      stripe_invoice_id has been paid or voided in the OLD account, and the
--      webhook or the 23:55 reconcile has written that state locally
--      (the first guard below refuses otherwise);
--   2. STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on the Worker already point
--      at the NEW account, and its webhook endpoint exists;
--   3. no invoice has been issued under the new key yet — a client bound after
--      2026-09-21 would carry a NEW-account customer, and the second guard
--      refuses to clear anything it did not capture on that date.
-- The ids are listed explicitly for that reason: this must never become
-- "clear every non-null binding".

begin;

create table if not exists public.portal_client_stripe_customer_archive (
  client_id uuid not null references public.portal_clients(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_account_label text not null,
  archived_at timestamptz not null default now(),
  primary key (client_id, stripe_customer_id)
);
comment on table public.portal_client_stripe_customer_archive is
  'Stripe customer ids a client was bound to in a previous Stripe account. History only; nothing reads it.';
alter table public.portal_client_stripe_customer_archive enable row level security;
revoke all on public.portal_client_stripe_customer_archive from anon, authenticated;

do $$
declare
  captured_on_2026_09_21 constant uuid[] := array[
    '95a3a98b-8b7b-452b-bc1d-c7e509300629', -- Alexandre Caleiro
    '024b241f-0f1d-4653-ad55-6adb270fef65', -- Daniel Azevedo
    'bf7c1c95-244b-47d1-a00d-c6ee1ae415bf', -- David e João
    'cd2d0f82-db40-40c1-b884-f777263e04ff', -- Diogo Barbosa
    '927cbac3-8121-456b-9d19-1e7d5c62184a', -- Diogo e Patricia
    '3f397ae5-a440-428d-acac-d39375d3aef8', -- Edgar e Rodrigo
    '5107292f-1bf6-42a4-ba8d-dc1d730d4044', -- Lourenço Alexandre
    '9f3ab2ab-8c46-474c-ae40-898c8d1f85c5', -- Luis Faria
    '0d0b1a03-5cf0-431b-a014-544003cdb8b8', -- Margarida e André
    'bd40d261-c43c-414a-aa82-ec3a1c3c0d77', -- Martim Antunes
    '85623d69-ff00-4c26-bbff-14aa7c794a1d', -- Miguel Casal
    '6d391e3a-9135-4274-a311-33adfc2bad06', -- Paulo & João
    '9734f0a0-aecb-470e-8bce-603b492323af'  -- Tomas e Tomas
  ];
  still_open integer;
  not_captured integer;
  cleared integer;
begin
  select count(*) into still_open
    from public.invoices
   where status in ('open', 'draft', 'uncollectible')
     and stripe_invoice_id is not null;
  if still_open > 0 then
    raise exception
      'Refusing: % invoice(s) are still open/draft/uncollectible in the old Stripe account. Settle or void them there first, and wait for the webhook or the 23:55 reconcile to record it.',
      still_open;
  end if;

  select count(*) into not_captured
    from public.portal_clients
   where stripe_customer_id is not null
     and id <> all (captured_on_2026_09_21);
  if not_captured > 0 then
    raise exception
      'Refusing: % client(s) carry a Stripe customer that was not captured on 2026-09-21. An invoice was probably issued under the new key already; review those rows before clearing anything.',
      not_captured;
  end if;

  insert into public.portal_client_stripe_customer_archive
    (client_id, stripe_customer_id, stripe_account_label)
  select id, stripe_customer_id, 'Jensen Nord (old account), switched 2026-09'
    from public.portal_clients
   where id = any (captured_on_2026_09_21)
     and stripe_customer_id is not null
  on conflict do nothing;

  alter table public.portal_clients disable trigger portal_clients_guard_stripe_identity;
  update public.portal_clients
     set stripe_customer_id = null
   where id = any (captured_on_2026_09_21)
     and stripe_customer_id is not null;
  get diagnostics cleared = row_count;
  alter table public.portal_clients enable trigger portal_clients_guard_stripe_identity;

  raise notice 'Archived and cleared % Stripe customer binding(s).', cleared;
end $$;

commit;
