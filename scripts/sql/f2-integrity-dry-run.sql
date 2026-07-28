-- F2 integrity review — read-only candidate discovery.
-- This file intentionally contains SELECT statements only.
-- Results require a named human reviewer before any separate repair is designed.

-- A. Contactless conversations whose linked lead supplies a possible contact.
-- The relationship is evidence for review, not authorization to update.
select
  c.id as conversation_id,
  c.status as conversation_status,
  c.lead_id,
  l.contact_id as proposed_contact_id,
  case
    when l.contact_id is null then 'insufficient_evidence'
    else 'manual_fk_review_required'
  end as recommendation,
  false as auto_repair_authorized
from public.conversations c
left join public.leads l on l.id = c.lead_id
where c.contact_id is null
  and c.lead_id is not null
order by c.created_at;

-- B. Repeated active business signatures.
-- assigned_agent_profile_id is excluded from the business signature so ownership
-- conflicts remain visible in owner_count instead of appearing as separate intent.
select
  contact_id,
  lead_type,
  interested_in_operation,
  interested_property_id,
  count(*) as active_lead_count,
  count(distinct assigned_agent_profile_id) as owner_count,
  min(created_at) as first_created_at,
  max(created_at) as last_created_at,
  array_agg(id order by created_at) as lead_ids,
  'manual_duplicate_review_required' as recommendation,
  false as auto_close_authorized
from public.leads
where is_active is true
  and is_archived is false
  and contact_id is not null
group by
  contact_id,
  lead_type,
  interested_in_operation,
  interested_property_id
having count(*) > 1
order by active_lead_count desc, contact_id;

-- C. Contact-level overview to distinguish multiple valid intents from repeated
-- signatures. Nulls are normalized only for grouping; no business value is inferred.
select
  contact_id,
  count(*) as active_lead_count,
  count(
    distinct concat_ws(
      '|',
      coalesce(lead_type, '<null>'),
      coalesce(interested_in_operation, '<null>'),
      coalesce(interested_property_id::text, '<null>')
    )
  ) as distinct_business_signature_count,
  count(distinct assigned_agent_profile_id) as owner_count,
  'manual_classification_required' as recommendation
from public.leads
where is_active is true
  and is_archived is false
  and contact_id is not null
group by contact_id
having count(*) > 1
order by active_lead_count desc, contact_id;
