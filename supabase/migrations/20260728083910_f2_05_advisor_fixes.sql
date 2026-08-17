-- F2 staging advisor follow-up: cover FK lookups used by RLS and cleanup.
set lock_timeout = '5s';
set statement_timeout = '90s';

drop policy if exists conversations_no_direct_access on public.conversations;

create index if not exists conversations_assigned_agent_profile_idx
  on public.conversations (assigned_agent_profile_id)
  where assigned_agent_profile_id is not null;
create index if not exists conversation_topics_parent_topic_idx
  on public.conversation_topics (parent_topic_id)
  where parent_topic_id is not null;
create index if not exists conversation_topic_events_evidence_message_idx
  on public.conversation_topic_events (evidence_message_id)
  where evidence_message_id is not null;
create index if not exists conversation_show_batches_outbound_message_idx
  on public.conversation_show_batches (outbound_message_id);
create index if not exists f2_effect_ledger_conversation_idx
  on public.f2_effect_ledger (conversation_id)
  where conversation_id is not null;
create index if not exists f2_effect_ledger_inbound_message_idx
  on public.f2_effect_ledger (inbound_message_id)
  where inbound_message_id is not null;
create index if not exists f2_effect_ledger_topic_idx
  on public.f2_effect_ledger (topic_id)
  where topic_id is not null;
create index if not exists outbound_effect_ledger_conversation_idx
  on public.outbound_effect_ledger (conversation_id);
create index if not exists outbound_effect_ledger_inbound_message_idx
  on public.outbound_effect_ledger (inbound_message_id)
  where inbound_message_id is not null;

reset statement_timeout;
reset lock_timeout;
