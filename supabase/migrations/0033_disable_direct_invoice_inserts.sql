-- =============================================================================
-- 0033 - Invoice creation is RPC-only after the manual-billing cutover.
--
-- The legacy deployment still exposes an admin-only endpoint whose service-role
-- client inserts an invoice directly and then sends it to Stripe. Automatic
-- cron issuance is already paused, but a direct call to that old endpoint must
-- also fail closed during the interval between the database and application
-- deployments.
--
-- V3 creation remains available through create_manual_referral_invoice(), a
-- SECURITY DEFINER function that validates the closed week, Google boundaries,
-- immutable referral term, recipient and exact ledger rows before its owner
-- inserts the commercial snapshot. Revoking caller table INSERT therefore
-- closes the legacy bypass without affecting the reviewed V3 path.
-- =============================================================================

revoke insert on table public.invoices
  from public, anon, authenticated, service_role;

comment on table public.invoices is
  'Financial snapshots. New rows are created only by the validated manual-billing SECURITY DEFINER RPC; direct browser or service-role inserts are forbidden.';

