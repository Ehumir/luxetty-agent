-- PR-F2-05b: immutable property show batches for deterministic references.
set lock_timeout = '5s';
set statement_timeout = '90s';

create table if not exists public.conversation_show_batches (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.conversation_topics(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  outbound_message_id uuid not null references public.conversation_messages(id) on delete restrict,
  idempotency_key text not null unique,
  shown_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (topic_id, outbound_message_id)
);

create table if not exists public.conversation_show_batch_items (
  id uuid primary key default gen_random_uuid(),
  show_batch_id uuid not null references public.conversation_show_batches(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete restrict,
  rank smallint not null check (rank > 0),
  display_snapshot_redacted jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (show_batch_id, property_id),
  unique (show_batch_id, rank)
);

create index if not exists conversation_show_batches_topic_shown_idx
  on public.conversation_show_batches (topic_id, shown_at desc);
create index if not exists conversation_show_batches_conversation_shown_idx
  on public.conversation_show_batches (conversation_id, shown_at desc);
create index if not exists conversation_show_batch_items_property_idx
  on public.conversation_show_batch_items (property_id);

alter table public.conversation_show_batches enable row level security;
alter table public.conversation_show_batch_items enable row level security;

revoke all on table public.conversation_show_batches from public, anon, authenticated;
revoke all on table public.conversation_show_batch_items from public, anon, authenticated;
grant select on table public.conversation_show_batches to authenticated;
grant select on table public.conversation_show_batch_items to authenticated;
grant select, insert, update, delete on table public.conversation_show_batches to service_role;
grant select, insert, update, delete on table public.conversation_show_batch_items to service_role;

drop policy if exists conversation_show_batches_scoped_select on public.conversation_show_batches;
drop policy if exists conversation_show_batches_service_write on public.conversation_show_batches;
drop policy if exists conversation_show_batch_items_scoped_select on public.conversation_show_batch_items;
drop policy if exists conversation_show_batch_items_service_write on public.conversation_show_batch_items;

create policy conversation_show_batches_scoped_select
on public.conversation_show_batches for select to authenticated
using (
  exists (
    select 1 from public.conversations c
    where c.id = conversation_show_batches.conversation_id
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

create policy conversation_show_batches_service_write
on public.conversation_show_batches for all to service_role
using (true) with check (true);

create policy conversation_show_batch_items_scoped_select
on public.conversation_show_batch_items for select to authenticated
using (
  exists (
    select 1
    from public.conversation_show_batches b
    join public.conversations c on c.id = b.conversation_id
    where b.id = conversation_show_batch_items.show_batch_id
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

create policy conversation_show_batch_items_service_write
on public.conversation_show_batch_items for all to service_role
using (true) with check (true);

comment on column public.conversation_show_batch_items.display_snapshot_redacted is
  'Display evidence only; never authoritative for live price, URL or availability.';

reset statement_timeout;
reset lock_timeout;
