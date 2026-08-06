-- PERSEO P0 recovery: one atomic, idempotent CRM effect for completed intake.
-- This migration is intentionally independent from F2.

begin;

create table if not exists public.perseo_p0_crm_effects (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  lead_id uuid not null references public.leads(id) on delete restrict,
  request_id uuid not null references public.requests(id) on delete restrict,
  campaign_key text,
  result jsonb not null,
  created_at timestamptz not null default now(),
  check (length(idempotency_key) between 16 and 256)
);

create index if not exists perseo_p0_crm_effects_conversation_idx
  on public.perseo_p0_crm_effects (conversation_id, created_at desc);

alter table public.perseo_p0_crm_effects enable row level security;
revoke all on table public.perseo_p0_crm_effects from public, anon, authenticated;
grant select, insert on table public.perseo_p0_crm_effects to service_role;

drop policy if exists perseo_p0_crm_effects_service_role on public.perseo_p0_crm_effects;
create policy perseo_p0_crm_effects_service_role
  on public.perseo_p0_crm_effects
  for all to service_role
  using (true) with check (true);

create or replace function public.perseo_p0_commit_crm_intake(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_idempotency_key text := nullif(trim(p_payload->>'idempotency_key'), '');
  v_conversation_id uuid := nullif(p_payload->>'conversation_id', '')::uuid;
  v_requested_contact_id uuid := nullif(p_payload->>'contact_id', '')::uuid;
  v_requested_lead_id uuid := nullif(p_payload->>'lead_id', '')::uuid;
  v_property_id uuid := nullif(p_payload->>'property_id', '')::uuid;
  v_agent_id uuid := nullif(p_payload->>'assigned_agent_profile_id', '')::uuid;
  v_phone text := nullif(regexp_replace(coalesce(p_payload->>'phone', ''), '[^0-9]', '', 'g'), '');
  v_full_name text := nullif(trim(p_payload->>'full_name'), '');
  v_lead_type public.lead_type := nullif(p_payload->>'lead_type', '')::public.lead_type;
  v_request_type public.request_type;
  v_operation text := nullif(p_payload->>'operation', '');
  v_campaign_key text := nullif(trim(p_payload->>'campaign_key'), '');
  v_campaign_kind text := nullif(trim(p_payload->>'campaign_kind'), '');
  v_contact public.contacts%rowtype;
  v_lead public.leads%rowtype;
  v_request public.requests%rowtype;
  v_property public.properties%rowtype;
  v_pipeline_stage_id uuid;
  v_request_stage_id uuid;
  v_existing_result jsonb;
  v_contact_created boolean := false;
  v_lead_created boolean := false;
  v_request_created boolean := false;
  v_result jsonb;
begin
  if v_idempotency_key is null or length(v_idempotency_key) not between 16 and 256 then
    raise exception using errcode = '22023', message = 'invalid_idempotency_key';
  end if;
  if v_conversation_id is null or v_phone is null or v_agent_id is null then
    raise exception using errcode = '22023', message = 'missing_conversation_phone_or_agent';
  end if;
  if v_operation not in ('sale', 'rent') or v_lead_type is null then
    raise exception using errcode = '22023', message = 'invalid_operation_or_lead_type';
  end if;

  v_request_type := case when v_lead_type = 'supply' then 'offer'::public.request_type else 'demand'::public.request_type end;

  -- Same inbound/webhook serializes across workers. No partial effect can escape this function.
  perform pg_advisory_xact_lock(hashtextextended(v_idempotency_key, 0));

  select result into v_existing_result
  from public.perseo_p0_crm_effects
  where idempotency_key = v_idempotency_key;
  if found then
    return v_existing_result || jsonb_build_object('replayed', true);
  end if;

  perform 1 from public.conversations where id = v_conversation_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'conversation_not_found';
  end if;
  perform 1 from public.agent_profiles where id = v_agent_id;
  if not found then
    raise exception using errcode = '23503', message = 'assigned_agent_not_found';
  end if;

  if v_lead_type = 'supply' and v_property_id is not null then
    raise exception using errcode = '22023', message = 'seller_capture_must_not_inherit_campaign_property';
  end if;

  if v_property_id is not null then
    select * into v_property from public.properties where id = v_property_id for share;
    if not found then
      raise exception using errcode = '23503', message = 'property_not_found';
    end if;
    if v_property.status <> 'active' or not coalesce(v_property.is_public, false)
       or not coalesce(v_property.visible_on_website, false) then
      raise exception using errcode = '22023', message = 'property_not_publishable';
    end if;
    if v_property.operation_type::text not in (v_operation, 'sale_rent') then
      raise exception using errcode = '22023', message = 'property_operation_conflict';
    end if;
  elsif v_campaign_kind = 'property_listing' then
    raise exception using errcode = '22023', message = 'campaign_property_not_verified';
  end if;

  select id into v_pipeline_stage_id
  from public.pipeline_stages
  where is_active and lead_type = v_lead_type::text
  order by stage_order, id
  limit 1;
  if v_pipeline_stage_id is null then
    raise exception using errcode = '23514', message = 'pipeline_stage_missing';
  end if;

  select id into v_request_stage_id
  from public.request_stages
  where is_active and request_type = v_request_type
  order by stage_order, id
  limit 1;
  if v_request_stage_id is null then
    raise exception using errcode = '23514', message = 'request_stage_missing';
  end if;

  if v_requested_contact_id is not null then
    select * into v_contact from public.contacts where id = v_requested_contact_id for update;
    if not found or coalesce(v_contact.whatsapp_normalized, regexp_replace(coalesce(v_contact.whatsapp, ''), '[^0-9]', '', 'g')) <> v_phone then
      raise exception using errcode = '22023', message = 'contact_conversation_mismatch';
    end if;
  else
    select * into v_contact
    from public.contacts
    where not is_archived
      and coalesce(whatsapp_normalized, regexp_replace(coalesce(whatsapp, ''), '[^0-9]', '', 'g')) = v_phone
    order by created_at, id
    limit 1 for update;
  end if;

  if v_contact.id is null then
    insert into public.contacts (
      full_name, phone, whatsapp, phone_normalized, whatsapp_normalized,
      assigned_agent_profile_id, assigned_at, assignment_source,
      created_source, created_channel, is_archived
    ) values (
      v_full_name, v_phone, v_phone, v_phone, v_phone,
      v_agent_id, now(), 'perseo_p0_recovery',
      'perseo_p0_recovery', 'whatsapp', false
    ) returning * into v_contact;
    v_contact_created := true;
  elsif v_contact.assigned_agent_profile_id is distinct from v_agent_id then
    raise exception using errcode = '22023', message = 'contact_agent_conflict';
  end if;

  if v_requested_lead_id is not null then
    select * into v_lead from public.leads where id = v_requested_lead_id for update;
    if not found
       or v_lead.contact_id <> v_contact.id
       or v_lead.lead_type is distinct from v_lead_type
       or v_lead.interested_in_operation::text is distinct from v_operation
       or v_lead.interested_property_id is distinct from v_property_id then
      raise exception using errcode = '22023', message = 'lead_intent_or_contact_conflict';
    end if;
  else
    select * into v_lead
    from public.leads
    where contact_id = v_contact.id
      and lead_type = v_lead_type
      and interested_in_operation::text = v_operation
      and interested_property_id is not distinct from v_property_id
      and is_active and not is_archived
    order by created_at, id
    limit 1 for update;
  end if;

  if v_lead.id is null then
    insert into public.leads (
      contact_id, lead_type, source, status, pipeline_stage_id,
      interested_in_operation, interested_property_id,
      assigned_agent_profile_id, phone, whatsapp, notes_summary,
      campaign_metadata, is_active, is_archived, next_action, next_action_due_at
    ) values (
      v_contact.id, v_lead_type, 'whatsapp', 'new', v_pipeline_stage_id,
      v_operation::public.property_operation_type, v_property_id,
      v_agent_id, v_phone, v_phone, nullif(p_payload->>'notes_summary', ''),
      jsonb_strip_nulls(jsonb_build_object('campaign_key', v_campaign_key, 'campaign_kind', v_campaign_kind)),
      true, false, case when v_lead_type = 'supply' then 'Contactar propietario' else 'Continuar solicitud' end,
      now() + interval '24 hours'
    ) returning * into v_lead;
    v_lead_created := true;
  elsif v_lead.assigned_agent_profile_id is distinct from v_agent_id then
    raise exception using errcode = '22023', message = 'lead_agent_conflict';
  end if;

  select * into v_request
  from public.requests
  where conversation_id = v_conversation_id
    and contact_id = v_contact.id
    and request_type = v_request_type
    and operation_type = v_operation
    and legacy_lead_id = v_lead.id
    and property_id is not distinct from v_property_id
    and is_active
  order by created_at, id
  limit 1 for update;

  if v_request.id is null then
    insert into public.requests (
      request_type, operation_type, status, contact_id,
      assigned_agent_profile_id, source, property_id, conversation_id,
      legacy_lead_id, stage_id, title, discovery_notes, notes_summary,
      budget_min, budget_max, preferred_zones, next_action, next_action_due_at, is_active
    ) values (
      v_request_type, v_operation, 'open', v_contact.id,
      v_agent_id, 'perseo_p0_recovery', v_property_id, v_conversation_id,
      v_lead.id, v_request_stage_id,
      case when v_request_type = 'offer' then 'Captación de propietario' else 'Solicitud inmobiliaria' end,
      nullif(p_payload->>'discovery_notes', ''), nullif(p_payload->>'notes_summary', ''),
      nullif(p_payload->>'budget_min', '')::numeric, nullif(p_payload->>'budget_max', '')::numeric,
      case when nullif(p_payload->>'location_text', '') is null then null else array[p_payload->>'location_text'] end,
      case when coalesce((p_payload->>'wants_visit')::boolean, false) then 'Confirmar visita' else 'Contactar cliente' end,
      now() + interval '24 hours', true
    ) returning * into v_request;
    v_request_created := true;
  end if;

  update public.conversations
  set contact_id = v_contact.id,
      lead_id = v_lead.id,
      assigned_agent_profile_id = v_agent_id,
      updated_at = now()
  where id = v_conversation_id
    and (contact_id is null or contact_id = v_contact.id)
    and (lead_id is null or lead_id = v_lead.id);
  if not found then
    raise exception using errcode = '22023', message = 'conversation_link_conflict';
  end if;

  v_result := jsonb_build_object(
    'contact_id', v_contact.id, 'contact_created', v_contact_created,
    'lead_id', v_lead.id, 'lead_created', v_lead_created,
    'request_id', v_request.id, 'request_created', v_request_created,
    'operation', v_operation, 'lead_type', v_lead_type,
    'property_id', v_property_id, 'assigned_agent_profile_id', v_agent_id,
    'replayed', false
  );

  insert into public.perseo_p0_crm_effects (
    idempotency_key, conversation_id, contact_id, lead_id, request_id, campaign_key, result
  ) values (
    v_idempotency_key, v_conversation_id, v_contact.id, v_lead.id, v_request.id, v_campaign_key, v_result
  );

  return v_result;
end;
$$;

revoke all on function public.perseo_p0_commit_crm_intake(jsonb) from public, anon, authenticated;
grant execute on function public.perseo_p0_commit_crm_intake(jsonb) to service_role;

commit;
