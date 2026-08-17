-- PR-F2-05a: additive F2 topic model for staging.
set lock_timeout = '5s';
set statement_timeout = '90s';

create table if not exists public.conversation_topics (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete restrict,
  lead_id uuid references public.leads(id) on delete set null,
  parent_topic_id uuid references public.conversation_topics(id) on delete set null,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'PAUSED', 'CLOSED', 'ARCHIVED')),
  control_mode text not null default 'AI'
    check (control_mode in ('AI', 'HUMAN', 'MIXED')),
  handoff_state text not null default 'NONE'
    check (handoff_state in (
      'NONE', 'REQUESTED', 'ACCEPTED', 'ACTIVE', 'RETURNED_TO_AI', 'EXPIRED'
    )),
  topic_kind text not null,
  summary_json jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  closure_reason text,
  last_activity_at timestamptz not null default now(),
  paused_at timestamptz,
  closed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists conversation_topics_one_open_per_conversation
  on public.conversation_topics (conversation_id)
  where status = 'OPEN';
create index if not exists conversation_topics_conversation_activity_idx
  on public.conversation_topics (conversation_id, last_activity_at desc);
create index if not exists conversation_topics_contact_idx
  on public.conversation_topics (contact_id)
  where contact_id is not null;
create index if not exists conversation_topics_lead_idx
  on public.conversation_topics (lead_id)
  where lead_id is not null;

create table if not exists public.conversation_topic_events (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.conversation_topics(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  event_type text not null,
  idempotency_key text not null,
  evidence_message_id uuid references public.conversation_messages(id) on delete set null,
  actor_type text not null default 'system'
    check (actor_type in ('system', 'contact', 'agent', 'admin', 'service')),
  from_status text,
  to_status text,
  metadata_redacted jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (topic_id, idempotency_key)
);

create index if not exists conversation_topic_events_topic_created_idx
  on public.conversation_topic_events (topic_id, created_at desc);
create index if not exists conversation_topic_events_conversation_created_idx
  on public.conversation_topic_events (conversation_id, created_at desc);
create unique index if not exists conversation_topic_events_evidence_unique
  on public.conversation_topic_events (topic_id, evidence_message_id, event_type)
  where evidence_message_id is not null;

alter table public.conversation_topics enable row level security;
alter table public.conversation_topic_events enable row level security;

revoke all on table public.conversation_topics from public, anon, authenticated;
revoke all on table public.conversation_topic_events from public, anon, authenticated;
grant select on table public.conversation_topics to authenticated;
grant select on table public.conversation_topic_events to authenticated;
grant select, insert, update, delete on table public.conversation_topics to service_role;
grant select, insert on table public.conversation_topic_events to service_role;

drop policy if exists conversation_topics_scoped_select on public.conversation_topics;
drop policy if exists conversation_topics_service_write on public.conversation_topics;
drop policy if exists conversation_topic_events_scoped_select on public.conversation_topic_events;
drop policy if exists conversation_topic_events_service_append on public.conversation_topic_events;

create policy conversation_topics_scoped_select
on public.conversation_topics for select to authenticated
using (
  exists (
    select 1 from public.conversations c
    where c.id = conversation_topics.conversation_id
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

create policy conversation_topics_service_write
on public.conversation_topics for all to service_role
using (true) with check (true);

create policy conversation_topic_events_scoped_select
on public.conversation_topic_events for select to authenticated
using (
  exists (
    select 1 from public.conversations c
    where c.id = conversation_topic_events.conversation_id
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

create policy conversation_topic_events_service_append
on public.conversation_topic_events for insert to service_role
with check (true);

comment on table public.conversation_topics is
  'F2 additive topic state. Runtime remains legacy-compatible until a later wiring PR.';
comment on table public.conversation_topic_events is
  'Append-only F2 topic audit events with redacted metadata.';

reset statement_timeout;
reset lock_timeout;
