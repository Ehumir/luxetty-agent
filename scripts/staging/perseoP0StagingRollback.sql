-- Remove only the anonymous P0 rehearsal fixtures. Recovery schema remains intact.
begin;
delete from public.perseo_p0_turn_traces where inbound_message_id like 'anonymous-inbound-%';
delete from public.perseo_p0_crm_effects
where idempotency_key like 'p0-staging-fixture-%'
   or idempotency_key = 'p0-concurrent-workers-0001';
delete from public.requests where conversation_id::text like 'c0000000-0000-4000-8000-%';
delete from public.conversations where id::text like 'c0000000-0000-4000-8000-%';
delete from public.leads where phone like '52810000%';
delete from public.contacts where phone like '52810000%';
delete from public.properties where id::text like 'b0000000-0000-4000-8000-%';
delete from public.agent_profiles where id = 'a0000000-0000-4000-8000-000000000001';
commit;

select
  (select count(*) from public.perseo_p0_turn_traces where inbound_message_id like 'anonymous-inbound-%') as traces_left,
  (select count(*) from public.perseo_p0_crm_effects where idempotency_key like 'p0-staging-fixture-%') as effects_left,
  (select count(*) from public.conversations where id::text like 'c0000000-0000-4000-8000-%') as conversations_left,
  (select count(*) from public.contacts where phone like '52810000%') as contacts_left,
  (select count(*) from public.leads where phone like '52810000%') as leads_left;
