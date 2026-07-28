-- COS flags are runtime configuration, not an end-user Data API surface.
alter table public.cos_feature_flags enable row level security;
alter table public.cos_feature_flags force row level security;
revoke all on table public.cos_feature_flags from anon, authenticated;

comment on table public.cos_feature_flags is
  'Service-role-only COS runtime configuration. Not exposed to anon/authenticated Data API actors.';
