-- F2-04 follow-up: make conversation-backed scope policies evaluable.
-- The existing deny-all policy remains; this adds only scoped SELECT.
set lock_timeout = '5s';
set statement_timeout = '60s';

do $$
begin
  if to_regclass('public.conversations') is null then
    raise exception 'f2_04_missing_dependency:public.conversations';
  end if;
  if to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.get_my_agent_profile_id()') is null
     or to_regprocedure('public.can_manage_agent_profile(uuid)') is null then
    raise exception 'f2_04_missing_authorization_helpers';
  end if;
end
$$;

alter table public.conversations enable row level security;

revoke all on table public.conversations from public, anon, authenticated;
grant select on table public.conversations to authenticated;
grant select, insert, update, delete on table public.conversations to service_role;

drop policy if exists conversations_scoped_select on public.conversations;

create policy conversations_scoped_select
on public.conversations
for select
to authenticated
using (
  (select public.is_admin())
  or assigned_agent_profile_id = (select public.get_my_agent_profile_id())
  or (
    assigned_agent_profile_id is not null
    and (select public.can_manage_agent_profile(assigned_agent_profile_id))
  )
);

comment on policy conversations_scoped_select
on public.conversations is
  'Admin, assigned agent, or in-scope supervisor may read a conversation; all direct authenticated writes remain denied.';

reset statement_timeout;
reset lock_timeout;
