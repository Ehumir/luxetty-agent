-- HF-06: terminal, redacted reconstruction of every PERSEO turn.
begin;

create table if not exists public.perseo_p0_turn_traces (
  turn_id uuid primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  inbound_message_id text,
  origin text not null,
  campaign jsonb not null default '{}'::jsonb,
  entity_refs jsonb not null default '{}'::jsonb,
  message_redacted text not null,
  state_before jsonb not null default '{}'::jsonb,
  classification jsonb not null default '{}'::jsonb,
  context_redacted jsonb not null default '{}'::jsonb,
  retrieval jsonb not null default '{}'::jsonb,
  routing jsonb not null default '{}'::jsonb,
  flags jsonb not null default '{}'::jsonb,
  decision jsonb not null default '{}'::jsonb,
  response_redacted text,
  state_after jsonb not null default '{}'::jsonb,
  crm_result jsonb not null default '{}'::jsonb,
  model text,
  prompt_version text not null,
  prompt_hash text not null,
  latency_ms integer not null check (latency_ms >= 0),
  handoff jsonb not null default '{}'::jsonb,
  terminal_result text not null check (terminal_result in ('sent', 'skipped', 'failed', 'duplicate')),
  error jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists perseo_p0_turn_traces_conversation_idx
  on public.perseo_p0_turn_traces (conversation_id, created_at desc);

alter table public.perseo_p0_turn_traces enable row level security;
revoke all on table public.perseo_p0_turn_traces from public, anon, authenticated;
grant select, insert on table public.perseo_p0_turn_traces to service_role;

drop policy if exists perseo_p0_turn_traces_service_role on public.perseo_p0_turn_traces;
create policy perseo_p0_turn_traces_service_role
  on public.perseo_p0_turn_traces
  for all to service_role
  using (true) with check (true);

commit;
