-- Automatic onboarding approval is performed by the system, not by a staff
-- profile. Migration 0063 records that truth in the audit event, but the
-- original 0044 row-shape constraint still required a non-null reviewed_by.

alter table public.client_onboarding_sessions
  drop constraint if exists client_onboarding_review_shape;

alter table public.client_onboarding_sessions
  add constraint client_onboarding_review_shape check (
    (
      status not in ('reviewed', 'active')
      and reviewed_at is null
      and reviewed_by is null
    )
    or (
      status in ('reviewed', 'active')
      and reviewed_at is not null
    )
  );

comment on column public.client_onboarding_sessions.reviewed_by is
  'Staff reviewer profile; null when a verified connection is reviewed automatically by the system.';
