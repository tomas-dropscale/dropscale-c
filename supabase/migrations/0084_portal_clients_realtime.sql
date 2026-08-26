-- =============================================================================
-- 0084 - Publish portal_clients so a blocked client leaves immediately.
--
-- The portal gate already refuses a blocked client on every request, because
-- the dashboard layout is force-dynamic and re-reads the row. What it cannot
-- do is reach a tab that is sitting still: someone blocked while looking at
-- their dashboard keeps looking at it until they navigate.
--
-- Same gap, same fix as RoleWatcher (which subscribes to profiles for exactly
-- this reason). The client is already allowed to read their own row through
-- portal_clients_select_self, and Realtime honours that policy — so a client
-- can only ever be told about their OWN block, never anyone else's.
--
-- This is UX, not the security boundary. RLS and the gate remain the boundary;
-- this only removes the wait.
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'portal_clients'
    )
  then
    alter publication supabase_realtime add table public.portal_clients;
  end if;
end
$$;
