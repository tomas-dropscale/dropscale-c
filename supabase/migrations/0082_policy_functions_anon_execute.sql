-- Intermittent hard crashes on admin pages (billing 2026-08-18 19:29 UTC —
-- captured by admin_server_errors — and campaigns 2026-08-19): when the
-- browser session token expires mid-navigation, queries run as `anon`, and
-- any of the 106 RLS policies calling is_admin() (or the legacy-asset one
-- calling legacy_asset_writes_allowed()) fails with "permission denied for
-- function is_admin" instead of cleanly returning no rows. The page renders
-- the generic error instead of redirecting to login.
--
-- Granting EXECUTE to anon is safe: both functions resolve auth.uid(), which
-- is null for anon, so they return false and the policies deny as intended.

grant execute on function public.is_admin() to anon;
grant execute on function public.legacy_asset_writes_allowed() to anon;
