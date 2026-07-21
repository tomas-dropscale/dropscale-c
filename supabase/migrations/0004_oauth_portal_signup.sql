-- =============================================================================
-- Dropscale IO — portal identity for OAuth sign-ins (Google)
--
-- Why a function instead of the 0002 trigger
--   handle_new_portal_client() keys off a 'portal_signup' flag we put in the
--   signup metadata. That works for email/password because we call signUp()
--   and choose the metadata. With OAuth we don't: raw_user_meta_data is
--   whatever Google returns, and signInWithOAuth() has nowhere to inject a
--   custom claim. So the portal has to say "this person came in through me"
--   after the fact, and that is what this function is for.
--
-- Why it is safe to expose
--   approval_status is hard-coded to 'pending'. Any authenticated user may
--   call it, and the most they can do is create their own pending row, which
--   grants nothing at all — migration 0002 scopes every portal table to
--   approved clients. It never touches an existing row, so it cannot be used
--   to reset someone's rejection or re-approve anybody.
-- =============================================================================

create or replace function public.claim_portal_client()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user auth.users%rowtype;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select approval_status into v_status
  from public.portal_clients
  where id = auth.uid();

  -- Already a portal client (approved, pending or rejected) — say so and stop.
  -- Re-running must never revive a rejected account.
  if found then
    return v_status;
  end if;

  select * into v_user from auth.users where id = auth.uid();

  insert into public.portal_clients (id, full_name, email, avatar_url, approval_status)
  values (
    v_user.id,
    coalesce(
      nullif(trim(v_user.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(v_user.raw_user_meta_data ->> 'name'), ''),
      split_part(v_user.email, '@', 1)
    ),
    v_user.email,
    coalesce(
      nullif(trim(v_user.raw_user_meta_data ->> 'avatar_url'), ''),
      nullif(trim(v_user.raw_user_meta_data ->> 'picture'), '')
    ),
    'pending'
  )
  on conflict (id) do nothing;

  return 'pending';
end;
$$;

revoke all on function public.claim_portal_client() from public, anon;
grant execute on function public.claim_portal_client() to authenticated;
