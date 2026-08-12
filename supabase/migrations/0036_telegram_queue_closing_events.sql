-- =============================================================================
-- 0036 - Announce the closing half of the approval queue, and by whom.
--
-- 0034 and 0035 report work arriving. This reports it being finished: a client
-- approved or rejected, a store verified and put into billing.
--
-- That reverses the rule the earlier migrations set — "an UPDATE is usually the
-- team's own approval, and being told what you just did trains you to ignore
-- the channel". The reasoning holds for the person who clicked; it does not
-- hold for everyone else. On a shared queue, "Cliente aprovado por Tomás" is
-- what stops two people working the same item, and it doubles as a record of
-- who decided what.
--
-- Names are not resolved here. The row carries uuids and the route looks them
-- up, so this stays a plain payload and the formatting stays testable.
--
-- -----------------------------------------------------------------------------
-- BEFORE RUNNING: replace __NOTIFY_SECRET__, or let
--   node scripts/telegram-webhooks-sql.mjs
-- print this with the secret already substituted from .env.local.
-- =============================================================================

drop trigger if exists telegram_notify_portal_clients_decided on public.portal_clients;
drop trigger if exists telegram_notify_billing_starts on public.ad_account_billing_starts;

-- Approved or rejected. Guarded on the column actually moving: portal_clients
-- is written for unrelated reasons (avatar, referral code, Stripe customer) and
-- none of those are decisions.
create trigger telegram_notify_portal_clients_decided
  after update on public.portal_clients
  for each row
  when (old.approval_status is distinct from new.approval_status)
  execute function public.notify_admin_telegram();

-- "Verify Google & start tracking" — the team confirmed agency access and
-- captured Google's opening counter. Reported on the billing-start row rather
-- than on ad_accounts.status, because this is the table that records WHO did it
-- (reviewed_by), and because the captured counter is the irreversible part.
create trigger telegram_notify_billing_starts
  after insert on public.ad_account_billing_starts
  for each row execute function public.notify_admin_telegram();
