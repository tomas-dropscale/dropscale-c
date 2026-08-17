-- =============================================================================
-- 0072 — let the service role install automatic billing starts.
--
-- ad_account_billing_starts only granted SELECT to service_role: every start
-- used to be written by a SECURITY DEFINER RPC. The automatic-start policy
-- (owner rule 2026-08-17: a bound Google source starts billing without an
-- admin touch) inserts from the Worker's service client, which failed with
-- 42501 on the first live run (Jedwabi). Immutability is untouched — the
-- UPDATE/DELETE guard trigger still rejects every change after the insert.
-- =============================================================================

grant insert on public.ad_account_billing_starts to service_role;
