-- PR-F2-04: close explicit RLS gaps without wiring F2.
-- Staging only until a later, explicit production authorization.
set lock_timeout = '5s';
set statement_timeout = '60s';

do $$
begin
  if to_regclass('public.conversation_referrals') is null then
    raise exception 'f2_04_missing_dependency:public.conversation_referrals';
  end if;
  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.get_my_agent_profile_id()') is null
     or to_regprocedure('public.can_manage_agent_profile(uuid)') is null then
    raise exception 'f2_04_missing_authorization_helpers';
  end if;
end
$$;

alter table public.conversation_referrals enable row level security;

revoke all on table public.conversation_referrals from public, anon, authenticated;
grant select on table public.conversation_referrals to authenticated;
grant select, insert, update, delete on table public.conversation_referrals to service_role;

drop policy if exists conversation_referrals_scoped_select
  on public.conversation_referrals;
drop policy if exists conversation_referrals_service_write
  on public.conversation_referrals;

create policy conversation_referrals_scoped_select
on public.conversation_referrals
for select
to authenticated
using (
  exists (
    select 1
    from public.conversations c
    where c.id = conversation_referrals.conversation_id
      and (
        (select public.is_admin())
        or c.assigned_agent_profile_id = (select public.get_my_agent_profile_id())
        or (
          c.assigned_agent_profile_id is not null
          and (select public.can_manage_agent_profile(c.assigned_agent_profile_id))
        )
      )
  )
);

create policy conversation_referrals_service_write
on public.conversation_referrals
for all
to service_role
using (true)
with check (true);

comment on policy conversation_referrals_scoped_select
on public.conversation_referrals is
  'Assigned agent, in-scope supervisor, or admin may read referral evidence.';

comment on policy conversation_referrals_service_write
on public.conversation_referrals is
  'Internal service writes referral evidence; Data API users cannot mutate it.';

-- Notifications exist in the deployed schema but not in every historical local
-- snapshot. Keep the migration deterministic: harden when present and record a
-- notice when a baseline predates the resource.
do $$
begin
  if to_regclass('public.notifications') is null then
    raise notice 'f2_04_notifications_absent_in_baseline';
    return;
  end if;

  execute 'alter table public.notifications enable row level security';
  execute 'revoke all on table public.notifications from public, anon';
  execute 'revoke insert, delete, truncate, references, trigger on table public.notifications from authenticated';
  execute 'grant select, update on table public.notifications to authenticated';
  execute 'grant select, insert, update, delete on table public.notifications to service_role';

  execute 'drop policy if exists "System can insert notifications" on public.notifications';
  execute 'drop policy if exists "Users see own notifications" on public.notifications';
  execute 'drop policy if exists "Users mark own notifications read" on public.notifications';
  execute 'drop policy if exists notifications_service_write on public.notifications';

  execute $policy$
    create policy "Users see own notifications"
    on public.notifications
    for select
    to authenticated
    using ((select auth.uid()) is not null and user_id = (select auth.uid()))
  $policy$;

  execute $policy$
    create policy "Users mark own notifications read"
    on public.notifications
    for update
    to authenticated
    using ((select auth.uid()) is not null and user_id = (select auth.uid()))
    with check ((select auth.uid()) is not null and user_id = (select auth.uid()))
  $policy$;

  execute $policy$
    create policy notifications_service_write
    on public.notifications
    for all
    to service_role
    using (true)
    with check (true)
  $policy$;
end
$$;

-- The application emitter uses service_role. Do not expose the privileged RPC
-- as a public Data API endpoint.
do $$
declare
  signature regprocedure;
begin
  for signature in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'emit_notification_event'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end
$$;

reset statement_timeout;
reset lock_timeout;
