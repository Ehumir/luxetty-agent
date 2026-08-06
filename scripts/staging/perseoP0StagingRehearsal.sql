-- Representative, anonymous PERSEO P0 staging rehearsal.
-- Run only in the isolated P0 staging project after the two recovery migrations.

begin;

insert into public.agent_profiles (id, display_name)
values ('a0000000-0000-4000-8000-000000000001', 'Asesor staging P0')
on conflict (id) do nothing;

insert into public.properties (
  id, title, operation_type, status, is_public, visible_on_website,
  price, currency_code, zone, agent_profile_id
) values
  ('b0000000-0000-4000-8000-000000000001', 'Casa verificada Cumbres', 'sale', 'active', true, true, 4200000, 'MXN', 'Cumbres', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000002', 'Casa verificada en renta', 'rent', 'active', true, true, 40000, 'MXN', 'Cumbres', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000003', 'Propiedad no publicada', 'sale', 'active', false, false, 3000000, 'MXN', 'Poniente', 'a0000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

insert into public.conversations (id, phone, ai_state, status)
select
  ('c0000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
  '52810000' || lpad(gs::text, 4, '0'),
  jsonb_build_object('fixture', 'C' || lpad(gs::text, 2, '0')),
  'open'
from generate_series(1, 20) gs
on conflict (id) do nothing;

do $$
declare
  i integer;
  v_operation text;
  v_lead_type text;
  v_campaign_kind text;
  v_property_id uuid;
  v_result jsonb;
begin
  for i in 1..20 loop
    v_lead_type := case when i in (3, 7, 11, 16) then 'supply' else 'demand' end;
    v_operation := case
      when v_lead_type = 'supply' then 'sale'
      when i in (1, 4, 6, 9, 13, 15, 18, 20) then 'rent'
      else 'sale'
    end;
    v_campaign_kind := case
      when v_lead_type = 'supply' then 'owner_capture'
      when i in (2, 5, 8, 12, 14, 17, 19) then 'property_listing'
      else 'natural'
    end;
    v_property_id := case
      when v_campaign_kind = 'property_listing' and v_operation = 'sale'
        then 'b0000000-0000-4000-8000-000000000001'::uuid
      when v_campaign_kind = 'property_listing' and v_operation = 'rent'
        then 'b0000000-0000-4000-8000-000000000002'::uuid
      else null
    end;

    v_result := public.perseo_p0_commit_crm_intake(jsonb_build_object(
      'idempotency_key', 'p0-staging-fixture-' || lpad(i::text, 2, '0'),
      'conversation_id', ('c0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      'phone', '52810000' || lpad(i::text, 4, '0'),
      'full_name', 'Cliente anónimo ' || i,
      'assigned_agent_profile_id', 'a0000000-0000-4000-8000-000000000001',
      'lead_type', v_lead_type,
      'operation', v_operation,
      'campaign_key', 'anonymous-campaign-' || i,
      'campaign_kind', v_campaign_kind,
      'property_id', v_property_id,
      'location_text', case when i % 2 = 0 then 'Cumbres' else 'Zona Poniente' end,
      'budget_max', case when v_operation = 'rent' then '40000' else '4500000' end,
      'wants_visit', i in (8, 12, 19)
    ));

    if (v_result->>'operation') is distinct from v_operation
       or (v_result->>'lead_type') is distinct from v_lead_type then
      raise exception 'fixture_%_intent_not_preserved', i;
    end if;

    insert into public.perseo_p0_turn_traces (
      turn_id, conversation_id, inbound_message_id, origin, campaign,
      entity_refs, message_redacted, state_before, classification,
      context_redacted, retrieval, routing, flags, decision,
      response_redacted, state_after, crm_result, model,
      prompt_version, prompt_hash, latency_ms, handoff, terminal_result
    ) values (
      ('d0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      ('c0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      'anonymous-inbound-' || i,
      v_campaign_kind,
      jsonb_build_object('key_hash', md5('anonymous-campaign-' || i)),
      jsonb_build_object('contact_id', v_result->>'contact_id', 'lead_id', v_result->>'lead_id', 'request_id', v_result->>'request_id', 'property_id', v_result->>'property_id'),
      '[MENSAJE REDACTADO]',
      jsonb_build_object('operation', v_operation),
      jsonb_build_object('intent', case when v_lead_type = 'supply' then 'seller_capture' else 'property_search' end, 'operation', v_operation),
      jsonb_build_object('zone', case when i % 2 = 0 then 'Cumbres' else 'Zona Poniente' end),
      jsonb_build_object('used', false, 'reason', 'deterministic_p0_path'),
      jsonb_build_object('selected', 'legacy_p0_recovery'),
      jsonb_build_object('PERSEO_P0_CRM_RECOVERY_ENABLED', true, 'PERSEO_P0_TURN_TRACE_ENABLED', true),
      jsonb_build_object('kind', 'crm_intake_committed'),
      case
        when i in (8, 12, 19) then 'Gracias, ya recibí tu solicitud de visita. El asesor responsable confirmará disponibilidad y horario contigo.'
        else 'Gracias, ya recibí tus datos. Continuaremos en español con la información registrada.'
      end,
      jsonb_build_object('status', case when i in (8, 12, 19) then 'HUMAN_WAITING' else 'ACTIVE' end),
      v_result,
      'deterministic', 'perseo-p0-v1', md5('perseo-p0-v1'), 10,
      jsonb_build_object('performed', i in (8, 12, 19), 'actor', case when i in (8, 12, 19) then 'perseo' else null end),
      'sent'
    ) on conflict (turn_id) do nothing;
  end loop;
end
$$;

-- Every replay must return the same logical records and create no duplicate.
do $$
declare
  i integer;
  v_result jsonb;
  v_operation text;
  v_lead_type text;
  v_campaign_kind text;
  v_property_id uuid;
begin
  for i in 1..20 loop
    v_lead_type := case when i in (3, 7, 11, 16) then 'supply' else 'demand' end;
    v_operation := case
      when v_lead_type = 'supply' then 'sale'
      when i in (1, 4, 6, 9, 13, 15, 18, 20) then 'rent'
      else 'sale'
    end;
    v_campaign_kind := case
      when v_lead_type = 'supply' then 'owner_capture'
      when i in (2, 5, 8, 12, 14, 17, 19) then 'property_listing'
      else 'natural'
    end;
    v_property_id := case
      when v_campaign_kind = 'property_listing' and v_operation = 'sale'
        then 'b0000000-0000-4000-8000-000000000001'::uuid
      when v_campaign_kind = 'property_listing' and v_operation = 'rent'
        then 'b0000000-0000-4000-8000-000000000002'::uuid
      else null
    end;
    v_result := public.perseo_p0_commit_crm_intake(jsonb_build_object(
      'idempotency_key', 'p0-staging-fixture-' || lpad(i::text, 2, '0'),
      'conversation_id', ('c0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      'phone', '52810000' || lpad(i::text, 4, '0'),
      'assigned_agent_profile_id', 'a0000000-0000-4000-8000-000000000001',
      'lead_type', v_lead_type, 'operation', v_operation,
      'campaign_kind', v_campaign_kind, 'property_id', v_property_id
    ));
    if v_result is null or (v_result->>'replayed')::boolean is not true then
      raise exception 'fixture_%_retry_not_idempotent', i;
    end if;
  end loop;
end
$$;

-- Representative partial failures must be atomic and fail closed.
do $$
declare
  v_before bigint;
begin
  select count(*) into v_before from public.perseo_p0_crm_effects;

  begin
    perform public.perseo_p0_commit_crm_intake(jsonb_build_object(
      'idempotency_key', 'p0-invalid-property-0001',
      'conversation_id', 'c0000000-0000-4000-8000-000000000001',
      'phone', '528100000001',
      'assigned_agent_profile_id', 'a0000000-0000-4000-8000-000000000001',
      'lead_type', 'demand', 'operation', 'sale',
      'campaign_kind', 'property_listing',
      'property_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    ));
    raise exception 'missing_property_was_not_rejected';
  exception when foreign_key_violation then null;
  end;

  begin
    perform public.perseo_p0_commit_crm_intake(jsonb_build_object(
      'idempotency_key', 'p0-unpublished-property-01',
      'conversation_id', 'c0000000-0000-4000-8000-000000000002',
      'phone', '528100000002',
      'assigned_agent_profile_id', 'a0000000-0000-4000-8000-000000000001',
      'lead_type', 'demand', 'operation', 'sale',
      'campaign_kind', 'property_listing',
      'property_id', 'b0000000-0000-4000-8000-000000000003'
    ));
    raise exception 'unpublished_property_was_not_rejected';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform public.perseo_p0_commit_crm_intake(jsonb_build_object(
      'idempotency_key', 'p0-seller-contamination-01',
      'conversation_id', 'c0000000-0000-4000-8000-000000000003',
      'phone', '528100000003',
      'assigned_agent_profile_id', 'a0000000-0000-4000-8000-000000000001',
      'lead_type', 'supply', 'operation', 'sale',
      'campaign_kind', 'owner_capture',
      'property_id', 'b0000000-0000-4000-8000-000000000002'
    ));
    raise exception 'seller_campaign_contamination_was_not_rejected';
  exception when invalid_parameter_value then null;
  end;

  if (select count(*) from public.perseo_p0_crm_effects) <> v_before then
    raise exception 'partial_failure_left_a_crm_effect';
  end if;
end
$$;

commit;

select
  (select count(*) from public.perseo_p0_crm_effects where idempotency_key like 'p0-staging-fixture-%') as logical_effects,
  (select count(distinct contact_id) from public.perseo_p0_crm_effects where idempotency_key like 'p0-staging-fixture-%') as contacts,
  (select count(distinct lead_id) from public.perseo_p0_crm_effects where idempotency_key like 'p0-staging-fixture-%') as leads,
  (select count(distinct request_id) from public.perseo_p0_crm_effects where idempotency_key like 'p0-staging-fixture-%') as requests,
  (select count(*) from public.perseo_p0_turn_traces where inbound_message_id like 'anonymous-inbound-%') as terminal_traces,
  (select count(*) from public.perseo_p0_turn_traces where response_redacted !~* '(gracias|recib[ií]|continuaremos|asesor|solicitud|disponibilidad|horario|datos|español)') as non_spanish_responses;
