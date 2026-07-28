-- PR-F2-05c: durable ledgers for F2, CDC, and outbound idempotency.
set lock_timeout = '5s';
set statement_timeout = '90s';

create table if not exists public.f2_effect_ledger (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  conversation_id uuid references public.conversations(id) on delete cascade,
  inbound_message_id uuid references public.conversation_messages(id) on delete set null,
  topic_id uuid references public.conversation_topics(id) on delete set null,
  effect_type text not null,
  state text not null
    check (state in ('pending', 'claimed', 'committed', 'retryable', 'unknown', 'cancelled')),
  worker_id text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  result_redacted jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_reindex_effects (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  source_version text not null,
  state text not null
    check (state in (
      'pending', 'claimed', 'chunks_saved', 'embedding_saved',
      'completed', 'retryable', 'inactive'
    )),
  worker_id text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  chunk_ids uuid[] not null default '{}',
  embedding_ids uuid[] not null default '{}',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_type, entity_id, source_version)
);

create table if not exists public.outbound_effect_ledger (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  inbound_message_id uuid references public.conversation_messages(id) on delete set null,
  payload_hash text not null,
  state text not null
    check (state in (
      'intent_recorded', 'claimed', 'provider_unknown', 'sent',
      'confirmed', 'failed_retryable', 'cancelled'
    )),
  provider_message_id text,
  worker_id text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_sequence bigint not null default 0,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.outbound_effect_side_effects (
  id uuid primary key default gen_random_uuid(),
  outbound_effect_id uuid not null references public.outbound_effect_ledger(id) on delete cascade,
  effect_type text not null,
  result_redacted jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (outbound_effect_id, effect_type)
);

create index if not exists f2_effect_ledger_claim_idx
  on public.f2_effect_ledger (state, lease_expires_at)
  where state in ('pending', 'retryable', 'claimed');
create index if not exists knowledge_reindex_effects_claim_idx
  on public.knowledge_reindex_effects (state, lease_expires_at)
  where state in ('pending', 'retryable', 'claimed');
create index if not exists outbound_effect_ledger_claim_idx
  on public.outbound_effect_ledger (state, lease_expires_at)
  where state in ('intent_recorded', 'failed_retryable', 'claimed');
create unique index if not exists outbound_effect_provider_message_unique
  on public.outbound_effect_ledger (provider_message_id)
  where provider_message_id is not null;

alter table public.f2_effect_ledger enable row level security;
alter table public.knowledge_reindex_effects enable row level security;
alter table public.outbound_effect_ledger enable row level security;
alter table public.outbound_effect_side_effects enable row level security;

revoke all on table public.f2_effect_ledger from public, anon, authenticated;
revoke all on table public.knowledge_reindex_effects from public, anon, authenticated;
revoke all on table public.outbound_effect_ledger from public, anon, authenticated;
revoke all on table public.outbound_effect_side_effects from public, anon, authenticated;

grant select, insert, update, delete on table public.f2_effect_ledger to service_role;
grant select, insert, update, delete on table public.knowledge_reindex_effects to service_role;
grant select, insert, update, delete on table public.outbound_effect_ledger to service_role;
grant select, insert, update, delete on table public.outbound_effect_side_effects to service_role;

create policy f2_effect_ledger_service
on public.f2_effect_ledger for all to service_role
using (true) with check (true);
create policy knowledge_reindex_effects_service
on public.knowledge_reindex_effects for all to service_role
using (true) with check (true);
create policy outbound_effect_ledger_service
on public.outbound_effect_ledger for all to service_role
using (true) with check (true);
create policy outbound_effect_side_effects_service
on public.outbound_effect_side_effects for all to service_role
using (true) with check (true);

comment on table public.knowledge_reindex_effects is
  'CDC checkpoint ledger; source_version prevents duplicate chunks/embeddings.';
comment on table public.outbound_effect_ledger is
  'Outbound intent ledger. provider_unknown requires reconciliation before retry.';

reset statement_timeout;
reset lock_timeout;
