'use strict';

const { getDefaultAiState } = require('../conversation/aiState');
const { normalizePhoneNumber, buildPhoneLookupValues, normalizeOutboundMessages } = require('../utils/helpers');
const { saveConversationMessage } = require('./saveConversationMessage');
const {
  sendPerseoAutomatedWhatsApp,
  sendPerseoAutomatedWhatsAppTemplate,
} = require('./perseoAutomatedWhatsApp');
const { resolveAutomatedReplyPolicy } = require('../conversation/perseoGatekeeper');

const FOLLOWUP_KIND = 'perseo_icf_daily';
const DAY_MS = 24 * 60 * 60 * 1000;

function log(logger, event, payload = {}) {
  const fn = logger && typeof logger.info === 'function' ? logger.info.bind(logger) : console.log;
  fn(event, payload);
}

function warn(logger, event, payload = {}) {
  const fn = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : console.warn;
  fn(event, payload);
}

function humanLockFromAiState(aiState = {}) {
  const control = aiState?.ai_control && typeof aiState.ai_control === 'object' ? aiState.ai_control : {};
  return (
    control.attention_mode === 'human' ||
    control.ai_paused === true ||
    aiState.attention_mode === 'human' ||
    aiState.ai_paused === true
  );
}

function isWithinCustomerServiceWindow(lastCustomerMessageAt, now = new Date()) {
  if (!lastCustomerMessageAt) return false;
  const ts = new Date(lastCustomerMessageAt).getTime();
  if (!Number.isFinite(ts)) return false;
  const delta = now.getTime() - ts;
  return delta >= 0 && delta < DAY_MS;
}

async function loadIcfFollowupSettings(supabase) {
  const { data, error } = await supabase
    .from('perseo_icf_followup_settings')
    .select('enabled, cadence_hours, batch_limit, template_name, template_language, free_text_body')
    .eq('id', true)
    .maybeSingle();

  if (error || !data) {
    return {
      enabled: false,
      unavailable: true,
      reason: error?.message || 'settings_missing',
      cadence_hours: 24,
      batch_limit: 50,
      template_name: null,
      template_language: 'es_MX',
      free_text_body: null,
    };
  }
  return data;
}

async function saveConversationEvent(supabase, conversationId, type, payload = {}) {
  if (!conversationId) return;
  const { error } = await supabase.from('conversation_events').insert({
    conversation_id: conversationId,
    type,
    payload,
  });
  if (error) {
    console.warn('[icf-followup] event insert failed', type, error.message);
  }
}

async function findConversationByLead(supabase, leadId) {
  if (!leadId) return null;
  const { data } = await supabase
    .from('conversations')
    .select('*')
    .eq('channel', 'whatsapp')
    .eq('lead_id', leadId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function findReusableConversationByContactOrPhone(supabase, candidate) {
  if (candidate.contact_id) {
    const { data: byContact } = await supabase
      .from('conversations')
      .select('*')
      .eq('channel', 'whatsapp')
      .eq('contact_id', candidate.contact_id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(10);

    const safe = (byContact || []).find(
      (row) => !row.lead_id || row.lead_id === candidate.lead_id,
    );
    if (safe) return safe;
  }

  const normalized = normalizePhoneNumber(candidate.whatsapp) || candidate.whatsapp;
  const lookup = buildPhoneLookupValues(normalized);
  if (!lookup.length) return null;

  const { data: byPhone } = await supabase
    .from('conversations')
    .select('*')
    .eq('channel', 'whatsapp')
    .in('phone', lookup)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(10);

  return (byPhone || []).find(
    (row) => (!row.lead_id || row.lead_id === candidate.lead_id) &&
      (!row.contact_id || row.contact_id === candidate.contact_id),
  ) || null;
}

async function ensureIcfConversation(supabase, candidate, logger = console) {
  let conversation = null;

  if (candidate.conversation_id) {
    const { data } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', candidate.conversation_id)
      .maybeSingle();
    conversation = data || null;
  }

  if (!conversation) conversation = await findConversationByLead(supabase, candidate.lead_id);
  if (!conversation) conversation = await findReusableConversationByContactOrPhone(supabase, candidate);

  const normalizedPhone = normalizePhoneNumber(candidate.whatsapp) || candidate.whatsapp;

  if (conversation) {
    if (humanLockFromAiState(conversation.ai_state || {})) {
      return { conversation, blocked: true, reason: 'human_takeover' };
    }

    if (conversation.lead_id && conversation.lead_id !== candidate.lead_id) {
      conversation = null;
    } else {
      const patch = {};
      if (!conversation.lead_id) patch.lead_id = candidate.lead_id;
      if (!conversation.contact_id && candidate.contact_id) patch.contact_id = candidate.contact_id;
      if (!conversation.assigned_agent_profile_id && candidate.assigned_agent_profile_id) {
        patch.assigned_agent_profile_id = candidate.assigned_agent_profile_id;
      }
      if (normalizedPhone && conversation.phone !== normalizedPhone) patch.phone = normalizedPhone;
      if (conversation.status === 'closed') patch.status = 'open';

      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        const { data: updated, error } = await supabase
          .from('conversations')
          .update(patch)
          .eq('id', conversation.id)
          .select('*')
          .single();
        if (error) throw error;
        conversation = updated;
      }

      return { conversation, blocked: false, created: false };
    }
  }

  const aiState = {
    ...getDefaultAiState(),
    lead_id: candidate.lead_id,
    contact_id: candidate.contact_id || null,
    full_name: candidate.contact_name || null,
    followup_context: {
      kind: FOLLOWUP_KIND,
      lead_id: candidate.lead_id,
      folio_code: candidate.folio_code || null,
      initialized_at: new Date().toISOString(),
    },
  };

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      channel: 'whatsapp',
      phone: normalizedPhone,
      status: 'open',
      priority: 'medium',
      ai_state: aiState,
      contact_id: candidate.contact_id || null,
      lead_id: candidate.lead_id,
      assigned_agent_profile_id: candidate.assigned_agent_profile_id || null,
      last_message_at: null,
    })
    .select('*')
    .single();

  if (error) throw error;

  await saveConversationEvent(supabase, created.id, 'icf_daily_followup_conversation_created', {
    lead_id: candidate.lead_id,
    contact_id: candidate.contact_id || null,
    source: FOLLOWUP_KIND,
  });
  log(logger, 'icf_followup_conversation_created', {
    conversation_id: created.id,
    lead_id: candidate.lead_id,
  });
  return { conversation: created, blocked: false, created: true };
}

async function fetchLastInboundAt(supabase, conversationId) {
  if (!conversationId) return null;
  const { data } = await supabase
    .from('conversation_messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at || null;
}

async function recheckCandidateEligibility(supabase, candidate, conversation) {
  const [validationRes, leadRes, prefRes, convRes] = await Promise.all([
    supabase
      .from('entity_validations')
      .select('id, resolved_at, status')
      .eq('id', candidate.validation_id)
      .maybeSingle(),
    supabase
      .from('leads')
      .select('id, is_active, is_archived, intent_confirmed_at, contact_id, assigned_agent_profile_id')
      .eq('id', candidate.lead_id)
      .maybeSingle(),
    supabase
      .from('contact_communication_preferences')
      .select('commercial_followup_allowed, commercial_followup_consent_at, do_not_contact, blocked_channel, invalid_number, whatsapp_status')
      .eq('contact_id', candidate.contact_id)
      .maybeSingle(),
    supabase
      .from('conversations')
      .select('id, ai_state, lead_id, contact_id, assigned_agent_profile_id')
      .eq('id', conversation.id)
      .maybeSingle(),
  ]);

  if (validationRes.error || !validationRes.data || validationRes.data.resolved_at) {
    return { allowed: false, reason: 'validation_closed' };
  }
  const lead = leadRes.data;
  if (leadRes.error || !lead || lead.is_active === false || lead.is_archived === true || lead.intent_confirmed_at) {
    return { allowed: false, reason: 'lead_not_open' };
  }
  const pref = prefRes.data;
  if (
    prefRes.error || !pref ||
    pref.commercial_followup_allowed !== true ||
    !pref.commercial_followup_consent_at ||
    pref.do_not_contact === true ||
    pref.blocked_channel === true ||
    pref.invalid_number === true ||
    ['invalid', 'blocked', 'not_deliverable'].includes(String(pref.whatsapp_status || ''))
  ) {
    return { allowed: false, reason: 'communication_not_allowed' };
  }
  const currentConversation = convRes.data;
  if (convRes.error || !currentConversation || humanLockFromAiState(currentConversation.ai_state || {})) {
    return { allowed: false, reason: 'human_takeover' };
  }
  if (currentConversation.lead_id && currentConversation.lead_id !== candidate.lead_id) {
    return { allowed: false, reason: 'conversation_lead_mismatch' };
  }
  return { allowed: true, lead, pref, conversation: currentConversation };
}

function buildPersistenceAdapter(supabase) {
  return async function saveOutboundMessages({ conversationId, messages, rawPayload = {} }) {
    const outbound = normalizeOutboundMessages(messages);
    const rows = [];
    for (const messageText of outbound) {
      const row = await saveConversationMessage(supabase, {
        conversationId,
        direction: 'outbound',
        senderType: 'ai_agent',
        messageType: 'text',
        messageText,
        rawPayload,
      });
      if (row?.id) rows.push(row);
    }
    return { outbound, rows };
  };
}

async function attachWamidToPersistedRows(supabase, rows, wamid, metadata = {}) {
  if (!wamid || !Array.isArray(rows) || !rows.length) return;
  for (const row of rows) {
    if (!row?.id) continue;
    const previousMetadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    await supabase
      .from('conversation_messages')
      .update({
        meta_message_id: wamid,
        metadata: { ...previousMetadata, ...metadata, wamid },
      })
      .eq('id', row.id)
      .is('meta_message_id', null);
  }
}

async function listCandidates(supabase, now, limit) {
  const { data, error } = await supabase.rpc('perseo_icf_daily_followup_candidates', {
    p_now: now.toISOString(),
    p_limit: limit,
  });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function runIcfDailyFollowups({
  supabase,
  now = new Date(),
  dryRun = false,
  ignoreEnabled = false,
  limit = null,
  logger = console,
} = {}) {
  if (!supabase) throw new Error('SUPABASE_CLIENT_REQUIRED');

  const settings = await loadIcfFollowupSettings(supabase);
  if (settings.unavailable) {
    return { ok: false, skipped: true, reason: settings.reason, settings_unavailable: true };
  }
  if (!settings.enabled && !ignoreEnabled) {
    return { ok: true, skipped: true, reason: 'icf_followup_disabled' };
  }

  const effectiveLimit = Math.max(1, Math.min(Number(limit || settings.batch_limit || 50), 500));
  const candidates = await listCandidates(supabase, now, effectiveLimit);
  const summary = {
    ok: true,
    dry_run: !!dryRun,
    candidates: candidates.length,
    sent: 0,
    blocked: 0,
    template: 0,
    text: 0,
    errors: 0,
    decisions: [],
  };

  const saveOutboundMessages = buildPersistenceAdapter(supabase);
  const eventAdapter = (conversationId, type, payload) =>
    saveConversationEvent(supabase, conversationId, type, payload);

  for (const candidate of candidates) {
    try {
      const ensured = await ensureIcfConversation(supabase, candidate, logger);
      const conversation = ensured.conversation;
      if (!conversation || ensured.blocked) {
        summary.blocked += 1;
        summary.decisions.push({ lead_id: candidate.lead_id, action: 'blocked', reason: ensured.reason || 'conversation_unavailable' });
        continue;
      }

      const eligibility = await recheckCandidateEligibility(supabase, candidate, conversation);
      if (!eligibility.allowed) {
        summary.blocked += 1;
        summary.decisions.push({ lead_id: candidate.lead_id, action: 'blocked', reason: eligibility.reason });
        continue;
      }

      const to = normalizePhoneNumber(candidate.whatsapp) || candidate.whatsapp;
      const lastInboundAt = await fetchLastInboundAt(supabase, conversation.id);
      const useText = isWithinCustomerServiceWindow(lastInboundAt, now);
      const deliveryKind = useText ? 'text' : 'template';

      const policy = await resolveAutomatedReplyPolicy({
        supabase,
        conversationRow: eligibility.conversation,
        from: to,
      });

      if (!useText && !settings.template_name) {
        summary.blocked += 1;
        summary.decisions.push({ lead_id: candidate.lead_id, action: 'blocked', reason: 'template_not_configured' });
        await saveConversationEvent(supabase, conversation.id, 'icf_daily_followup_blocked_template_missing', {
          lead_id: candidate.lead_id,
          source: FOLLOWUP_KIND,
        });
        continue;
      }

      if (dryRun) {
        summary.decisions.push({
          lead_id: candidate.lead_id,
          conversation_id: conversation.id,
          action: 'would_send',
          delivery_kind: deliveryKind,
          policy_allowed: policy.allowAutomatedReply === true,
          policy_reason: policy.reason_code || null,
        });
        continue;
      }

      const rawPayload = {
        perseo_metadata: {
          automation: FOLLOWUP_KIND,
          lead_id: candidate.lead_id,
          validation_id: candidate.validation_id,
          folio_code: candidate.folio_code || null,
          followup_count_before_send: candidate.followup_count || 0,
        },
      };

      let sendResult;
      if (useText) {
        sendResult = await sendPerseoAutomatedWhatsApp({
          channel: 'ia',
          to,
          messages: [settings.free_text_body],
          conversationId: conversation.id,
          rawPayload,
          policy,
          saveOutboundMessages,
          saveConversationEvent: eventAdapter,
          logEvent: (event, payload) => log(logger, event, payload),
          policyClient: supabase,
        });
      } else {
        sendResult = await sendPerseoAutomatedWhatsAppTemplate({
          channel: 'ia',
          to,
          conversationId: conversation.id,
          templateName: settings.template_name,
          templateLanguage: settings.template_language || 'es_MX',
          templateComponents: [],
          displayText: settings.free_text_body,
          rawPayload,
          policy,
          saveOutboundMessages,
          saveConversationEvent: eventAdapter,
          logEvent: (event, payload) => log(logger, event, payload),
          policyClient: supabase,
        });
      }

      if (!sendResult?.sent || !sendResult?.wamid) {
        summary.blocked += 1;
        summary.decisions.push({
          lead_id: candidate.lead_id,
          action: 'blocked',
          reason: sendResult?.reason_code || 'send_not_confirmed',
        });
        continue;
      }

      await attachWamidToPersistedRows(supabase, sendResult.rows, sendResult.wamid, {
        automation: FOLLOWUP_KIND,
        lead_id: candidate.lead_id,
        delivery_kind: deliveryKind,
      });

      const { data: recorded, error: recordError } = await supabase.rpc('perseo_icf_record_followup_sent', {
        p_lead_id: candidate.lead_id,
        p_conversation_id: conversation.id,
        p_wamid: sendResult.wamid,
        p_delivery_kind: deliveryKind,
      });
      if (recordError || recorded?.ok === false) {
        throw recordError || new Error(recorded?.code || 'followup_record_failed');
      }

      summary.sent += 1;
      summary[deliveryKind] += 1;
      summary.decisions.push({
        lead_id: candidate.lead_id,
        conversation_id: conversation.id,
        action: 'sent',
        delivery_kind: deliveryKind,
        wamid: sendResult.wamid,
      });
    } catch (err) {
      summary.errors += 1;
      warn(logger, 'icf_daily_followup_error', {
        lead_id: candidate.lead_id,
        error: String(err?.message || err),
      });
      summary.decisions.push({
        lead_id: candidate.lead_id,
        action: 'error',
        reason: String(err?.message || err),
      });
    }
  }

  return summary;
}

function normalizeReply(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyIcfFollowupReply(text) {
  const t = normalizeReply(text);
  if (!t) return { kind: 'unknown' };

  const globalOptOut = /^(stop|baja)$/i.test(t) ||
    /\b(no me (contacten|escriban|llamen)|dejen de (contactarme|escribirme|llamarme)|no quiero recibir (mensajes|whatsapp)|no contactar|no me manden mensajes)\b/i.test(t);
  if (globalOptOut) return { kind: 'decline', globalOptOut: true };

  const affirmatives = new Set([
    'si', 'confirmo', 'quiero continuar', 'continuar', 'quiero seguir', 'sigo interesado',
    'me interesa', 'adelante', 'si quiero', 'si continuar', 'si sigo interesado',
  ]);
  if (affirmatives.has(t)) return { kind: 'confirm', globalOptOut: false };

  const declines = new Set([
    'no', 'no gracias', 'ya no', 'ya no me interesa', 'no me interesa',
    'no quiero continuar', 'ya no quiero continuar', 'no quiero el servicio',
    'ya no quiero el servicio',
  ]);
  if (declines.has(t)) return { kind: 'decline', globalOptOut: false };

  return { kind: 'unknown' };
}

async function handleIcfFollowupInbound({ supabase, conversationId, text, logger = console } = {}) {
  if (!supabase || !conversationId) return { handled: false, reason: 'missing_context' };

  const classification = classifyIcfFollowupReply(text);
  if (classification.kind === 'unknown') return { handled: false, reason: 'not_followup_answer' };

  const { data: conversation, error: conversationError } = await supabase
    .from('conversations')
    .select('id, lead_id, contact_id, ai_state')
    .eq('id', conversationId)
    .maybeSingle();
  if (conversationError || !conversation?.lead_id) return { handled: false, reason: 'conversation_without_lead' };

  const { data: state } = await supabase
    .from('followup_reminder_state')
    .select('id, last_sent_at, escalation_level')
    .eq('dedupe_key', `perseo_icf_daily:${conversation.lead_id}`)
    .maybeSingle();
  if (!state?.last_sent_at) return { handled: false, reason: 'no_icf_daily_followup' };

  const { data: validation } = await supabase
    .from('entity_validations')
    .select('id, resolved_at')
    .eq('validation_kind', 'intent_confirmation')
    .eq('entity_type', 'lead')
    .eq('entity_id', conversation.lead_id)
    .maybeSingle();
  if (!validation || validation.resolved_at) return { handled: false, reason: 'validation_not_open' };

  if (classification.kind === 'confirm') {
    const { data, error } = await supabase.rpc('perseo_icf_confirm_from_whatsapp', {
      p_lead_id: conversation.lead_id,
      p_conversation_id: conversationId,
      p_verbatim: text,
      p_interest_level: 'high',
    });
    if (error) throw error;
    log(logger, 'icf_followup_confirmed', {
      conversation_id: conversationId,
      lead_id: conversation.lead_id,
      assigned_agent_profile_id: data?.assigned_agent_profile_id || null,
    });
    return { handled: true, outcome: 'confirmed', suppressAutomatedReply: true, data };
  }

  const { data, error } = await supabase.rpc('perseo_icf_decline_from_whatsapp', {
    p_lead_id: conversation.lead_id,
    p_conversation_id: conversationId,
    p_verbatim: text,
    p_global_opt_out: classification.globalOptOut === true,
  });
  if (error) throw error;
  log(logger, 'icf_followup_declined', {
    conversation_id: conversationId,
    lead_id: conversation.lead_id,
    global_opt_out: classification.globalOptOut === true,
  });
  return {
    handled: true,
    outcome: classification.globalOptOut ? 'global_opt_out' : 'service_declined',
    suppressAutomatedReply: true,
    data,
  };
}

module.exports = {
  FOLLOWUP_KIND,
  DAY_MS,
  humanLockFromAiState,
  isWithinCustomerServiceWindow,
  loadIcfFollowupSettings,
  ensureIcfConversation,
  recheckCandidateEligibility,
  classifyIcfFollowupReply,
  handleIcfFollowupInbound,
  runIcfDailyFollowups,
};
