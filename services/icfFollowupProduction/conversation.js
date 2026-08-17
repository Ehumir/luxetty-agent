'use strict';

const { getDefaultAiState } = require('../../conversation/aiState');
const { normalizePhoneNumber, buildPhoneLookupValues } = require('../../utils/helpers');
const { humanLockFromAiState } = require('./helpers');

async function findByLead(supabase, leadId) {
  const { data } = await supabase.from('conversations').select('*').eq('channel','whatsapp').eq('lead_id',leadId).order('last_message_at',{ascending:false,nullsFirst:false}).order('updated_at',{ascending:false}).limit(1).maybeSingle();
  return data || null;
}

async function findReusable(supabase, candidate) {
  if (candidate.contact_id) {
    const { data } = await supabase.from('conversations').select('*').eq('channel','whatsapp').eq('contact_id',candidate.contact_id).order('last_message_at',{ascending:false,nullsFirst:false}).order('updated_at',{ascending:false}).limit(10);
    const safe = (data || []).find((r) => !r.lead_id || r.lead_id === candidate.lead_id);
    if (safe) return safe;
  }
  const phone = normalizePhoneNumber(candidate.whatsapp) || candidate.whatsapp;
  const lookup = buildPhoneLookupValues(phone);
  if (!lookup.length) return null;
  const { data } = await supabase.from('conversations').select('*').eq('channel','whatsapp').in('phone',lookup).order('last_message_at',{ascending:false,nullsFirst:false}).order('updated_at',{ascending:false}).limit(10);
  return (data || []).find((r) => (!r.lead_id || r.lead_id === candidate.lead_id) && (!r.contact_id || r.contact_id === candidate.contact_id)) || null;
}

async function ensureConversation(supabase, candidate) {
  let conv = null;
  if (candidate.conversation_id) {
    const { data } = await supabase.from('conversations').select('*').eq('id',candidate.conversation_id).maybeSingle();
    conv = data || null;
  }
  if (!conv) conv = await findByLead(supabase,candidate.lead_id);
  if (!conv) conv = await findReusable(supabase,candidate);
  const phone = normalizePhoneNumber(candidate.whatsapp) || candidate.whatsapp;

  if (conv) {
    if (humanLockFromAiState(conv.ai_state || {})) return { conversation: conv, blocked: true, reason: 'human_takeover' };
    if (conv.lead_id && conv.lead_id !== candidate.lead_id) conv = null;
    else {
      const patch = {};
      if (!conv.lead_id) patch.lead_id = candidate.lead_id;
      if (!conv.contact_id) patch.contact_id = candidate.contact_id;
      if (phone && conv.phone !== phone) patch.phone = phone;
      if (conv.status === 'closed') patch.status = 'open';
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabase.from('conversations').update(patch).eq('id',conv.id).select('*').single();
        if (error) throw error;
        conv = data;
      }
      return { conversation: conv, blocked: false, created: false };
    }
  }

  const aiState = {
    ...getDefaultAiState(),
    lead_id: candidate.lead_id,
    contact_id: candidate.contact_id || null,
    full_name: candidate.contact_name || null,
    followup_context: { kind:'perseo_icf_daily', lead_id:candidate.lead_id, folio_code:candidate.folio_code || null, initialized_at:new Date().toISOString() },
  };
  const { data, error } = await supabase.from('conversations').insert({
    channel:'whatsapp', phone, status:'open', priority:'medium', ai_state:aiState,
    contact_id:candidate.contact_id || null, lead_id:candidate.lead_id,
    assigned_agent_profile_id:null, last_message_at:null,
  }).select('*').single();
  if (error) throw error;
  return { conversation:data, blocked:false, created:true };
}

async function recheckEligibility(supabase,candidate,conversation) {
  const [v,l,c,p,x] = await Promise.all([
    supabase.from('entity_validations').select('id,resolved_at,status').eq('id',candidate.validation_id).maybeSingle(),
    supabase.from('leads').select('id,is_active,is_archived,intent_confirmed_at,contact_id,assigned_agent_profile_id').eq('id',candidate.lead_id).maybeSingle(),
    supabase.from('contacts').select('id,assigned_agent_profile_id').eq('id',candidate.contact_id).maybeSingle(),
    supabase.from('contact_communication_preferences').select('commercial_followup_allowed,commercial_followup_consent_at,do_not_contact,blocked_channel,invalid_number,whatsapp_status').eq('contact_id',candidate.contact_id).maybeSingle(),
    supabase.from('conversations').select('id,ai_state,lead_id,contact_id').eq('id',conversation.id).maybeSingle(),
  ]);
  if (v.error || !v.data || v.data.resolved_at) return {allowed:false,reason:'validation_closed'};
  if (l.error || !l.data || l.data.is_active === false || l.data.is_archived === true || l.data.intent_confirmed_at) return {allowed:false,reason:'lead_not_open'};
  if (c.error || !c.data || !l.data.assigned_agent_profile_id || !c.data.assigned_agent_profile_id) return {allowed:false,reason:'owner_missing'};
  if (l.data.assigned_agent_profile_id !== c.data.assigned_agent_profile_id) return {allowed:false,reason:'ownership_mismatch'};
  if (p.error || !p.data || p.data.commercial_followup_allowed !== true || !p.data.commercial_followup_consent_at || p.data.do_not_contact === true || p.data.blocked_channel === true || p.data.invalid_number === true || ['invalid','blocked','not_deliverable'].includes(String(p.data.whatsapp_status || ''))) return {allowed:false,reason:'communication_not_allowed'};
  if (x.error || !x.data || humanLockFromAiState(x.data.ai_state || {})) return {allowed:false,reason:'human_takeover'};
  if (x.data.lead_id && x.data.lead_id !== candidate.lead_id) return {allowed:false,reason:'conversation_lead_mismatch'};
  if (x.data.contact_id && x.data.contact_id !== candidate.contact_id) return {allowed:false,reason:'conversation_contact_mismatch'};
  return {allowed:true,lead:l.data,contact:c.data,conversation:x.data};
}

module.exports = { ensureConversation, recheckEligibility };
